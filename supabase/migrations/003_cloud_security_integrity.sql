begin;

-- Refuse to guess how to associate legacy accounts. The exception reports a
-- bounded sample of orphaned account IDs and Shop IDs without changing data.
do $$
declare
  orphan_count bigint;
  orphan_sample text;
begin
  select count(*) into orphan_count
  from public.cloud_accounts a
  left join public.cloud_pharmacies p on p.shop_id = a.shop_id
  where a.role <> 'superAdmin'
    and (a.shop_id is null or btrim(a.shop_id) = '' or p.shop_id is null);

  if orphan_count > 0 then
    select string_agg(format('account=%s shop_id=%s', x.id, coalesce(x.shop_id, '<null>')), '; ')
      into orphan_sample
    from (
      select a.id, a.shop_id
      from public.cloud_accounts a
      left join public.cloud_pharmacies p on p.shop_id = a.shop_id
      where a.role <> 'superAdmin'
        and (a.shop_id is null or btrim(a.shop_id) = '' or p.shop_id is null)
      order by a.id
      limit 20
    ) x;
    raise exception 'Migration 003 stopped: % non-Super-Admin cloud account(s) do not map to an existing pharmacy.', orphan_count
      using detail = coalesce(orphan_sample, 'No sample available.'), hint = 'Review and manually associate each account with its confirmed permanent Shop ID; do not guess.';
  end if;
end;
$$;

do $$
declare bad text;
begin
  select string_agg(format('shop=%s username=%s count=%s', shop_id, username, n), '; ') into bad
  from (select shop_id, username, count(*) n from public.cloud_accounts
    group by shop_id, username having count(*) > 1 limit 20) x;
  if bad is not null then raise exception 'Migration 003 stopped: duplicate cloud identities: %', bad; end if;
end;
$$;
create unique index if not exists cloud_accounts_shop_username_guard
  on public.cloud_accounts(shop_id, username);

alter table public.cloud_accounts
  add column if not exists pharmacy_shop_id text,
  add column if not exists session_version bigint not null default 1;

-- Reject incompatible partial backfills rather than overwrite associations.
do $$
declare bad text;
begin
  select string_agg(id::text, ', ') into bad from (
    select id from public.cloud_accounts where
      (role = 'superAdmin' and (shop_id <> '' or pharmacy_shop_id is not null))
      or (role <> 'superAdmin' and pharmacy_shop_id is not null and pharmacy_shop_id <> shop_id)
    order by id limit 20
  ) x;
  if bad is not null then
    raise exception 'Migration 003 stopped: inconsistent account associations, IDs: %', bad;
  end if;
end;
$$;

-- Keep the legacy shop_id column and its empty-string Super Admin convention so
-- a backend rollback to the prior API remains compatible. The new FK is the
-- authoritative relational association for shop accounts.
update public.cloud_accounts
set pharmacy_shop_id = shop_id
where role <> 'superAdmin' and pharmacy_shop_id is null;
update public.cloud_accounts
set pharmacy_shop_id = null
where role = 'superAdmin';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.cloud_accounts'::regclass
      and conname = 'cloud_accounts_pharmacy_shop_fk'
  ) then
    alter table public.cloud_accounts
      add constraint cloud_accounts_pharmacy_shop_fk
      foreign key (pharmacy_shop_id)
      references public.cloud_pharmacies(shop_id)
      on update restrict on delete restrict
      not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.cloud_accounts'::regclass
      and conname = 'cloud_accounts_pharmacy_match_check'
  ) then
    alter table public.cloud_accounts
      add constraint cloud_accounts_pharmacy_match_check
      check (
        (role = 'superAdmin' and shop_id = '' and pharmacy_shop_id is null)
        or
        (role <> 'superAdmin' and shop_id <> '' and pharmacy_shop_id is not null and pharmacy_shop_id = shop_id)
      ) not valid;
  end if;
end;
$$;

alter table public.cloud_accounts validate constraint cloud_accounts_pharmacy_shop_fk;
alter table public.cloud_accounts validate constraint cloud_accounts_pharmacy_match_check;
create index if not exists cloud_accounts_pharmacy_shop_idx
  on public.cloud_accounts(pharmacy_shop_id);

alter table public.cloud_pharmacies
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by bigint,
  add column if not exists status_before_archive text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.cloud_pharmacies'::regclass
      and conname = 'cloud_pharmacies_archived_by_fk'
  ) then
    alter table public.cloud_pharmacies
      add constraint cloud_pharmacies_archived_by_fk
      foreign key (archived_by) references public.cloud_accounts(id)
      on delete set null not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.cloud_pharmacies'::regclass
      and conname = 'cloud_pharmacies_archive_state_check'
  ) then
    alter table public.cloud_pharmacies
      add constraint cloud_pharmacies_archive_state_check
      check (
        (archived_at is null and status_before_archive is null)
        or
        (archived_at is not null and status = 'suspended'
          and status_before_archive in ('active', 'suspended'))
      ) not valid;
  end if;
end;
$$;
alter table public.cloud_pharmacies validate constraint cloud_pharmacies_archived_by_fk;
alter table public.cloud_pharmacies validate constraint cloud_pharmacies_archive_state_check;
create index if not exists cloud_pharmacies_archived_idx
  on public.cloud_pharmacies(archived_at, shop_id);

create table if not exists public.cloud_admin_sessions (
  session_id uuid primary key,
  account_id bigint not null references public.cloud_accounts(id) on delete cascade,
  credential_version bigint not null,
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists cloud_admin_sessions_account_idx
  on public.cloud_admin_sessions(account_id, created_at desc);
create index if not exists cloud_admin_sessions_expiry_idx
  on public.cloud_admin_sessions(expires_at);

create table if not exists public.cloud_provision_requests (
  actor_id bigint not null references public.cloud_accounts(id) on delete restrict,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  response_body jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  primary key (actor_id, idempotency_key_hash),
  check ((response_body is null and completed_at is null)
      or (response_body is not null and completed_at is not null))
);
create index if not exists cloud_provision_requests_created_idx
  on public.cloud_provision_requests(created_at);

create table if not exists public.cloud_schema_versions (
  version integer primary key,
  applied_at timestamptz not null default pg_catalog.now()
);
insert into public.cloud_schema_versions(version) values (3)
on conflict (version) do nothing;

alter table public.cloud_admin_sessions enable row level security;
alter table public.cloud_provision_requests enable row level security;
alter table public.cloud_schema_versions enable row level security;
revoke all on public.cloud_admin_sessions, public.cloud_provision_requests,
  public.cloud_schema_versions from public, anon, authenticated;
grant all on public.cloud_admin_sessions, public.cloud_provision_requests,
  public.cloud_schema_versions to service_role;

-- Maintain the permanent account-to-shop association even for an older backend
-- that inserts only legacy shop_id. Shop IDs cannot be changed after creation.
create or replace function public.cloud_accounts_integrity_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.shop_id is distinct from new.shop_id then
    raise exception using errcode = '23514', message = 'A cloud account Shop ID is permanent';
  end if;

  if new.role = 'superAdmin' then
    if new.shop_id <> '' or new.pharmacy_shop_id is not null then
      raise exception using errcode = '23514', message = 'A Super Admin cannot be associated with a pharmacy';
    end if;
    new.pharmacy_shop_id := null;
  else
    if new.shop_id is null or pg_catalog.btrim(new.shop_id) = '' then
      raise exception using errcode = '23514', message = 'A shop account requires a permanent Shop ID';
    end if;
    if new.pharmacy_shop_id is not null and new.pharmacy_shop_id <> new.shop_id then
      raise exception using errcode = '23514', message = 'Account Shop ID does not match its pharmacy association';
    end if;
    new.pharmacy_shop_id := new.shop_id;
  end if;

  if tg_op = 'UPDATE' then
    new.session_version := old.session_version + case when
      old.username is distinct from new.username
      or old.password_hash is distinct from new.password_hash
      or old.active is distinct from new.active
      or old.role is distinct from new.role
      then 1 else 0 end;
  else
    new.session_version := 1;
  end if;
  return new;
end;
$$;
revoke all on function public.cloud_accounts_integrity_before_write() from public, anon, authenticated;
grant execute on function public.cloud_accounts_integrity_before_write() to service_role;
drop trigger if exists cloud_accounts_integrity_before_write on public.cloud_accounts;
create trigger cloud_accounts_integrity_before_write
before insert or update on public.cloud_accounts
for each row execute function public.cloud_accounts_integrity_before_write();

create or replace function public.cloud_accounts_revoke_sessions_after_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.session_version <> old.session_version then
    update public.cloud_admin_sessions
    set revoked_at = coalesce(revoked_at, pg_catalog.now())
    where account_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
revoke all on function public.cloud_accounts_revoke_sessions_after_write() from public, anon, authenticated;
grant execute on function public.cloud_accounts_revoke_sessions_after_write() to service_role;
drop trigger if exists cloud_accounts_revoke_sessions_after_write on public.cloud_accounts;
create trigger cloud_accounts_revoke_sessions_after_write
after update on public.cloud_accounts
for each row execute function public.cloud_accounts_revoke_sessions_after_write();

-- Preserve the prior API signature for rollback compatibility. The new server
-- uses the idempotent function below; this legacy RPC remains service_role-only.
create or replace function public.create_cloud_shop(
  p_shop_id text,
  p_name text,
  p_address text,
  p_phone text,
  p_license_expiry_date timestamptz,
  p_is_lifetime boolean,
  p_username text,
  p_password_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_shop_id is null or pg_catalog.length(pg_catalog.btrim(p_shop_id)) = 0
     or p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) = 0
     or p_address is null or pg_catalog.length(pg_catalog.btrim(p_address)) = 0
     or p_username is null or pg_catalog.length(pg_catalog.btrim(p_username)) = 0
     or p_password_hash is null
     or p_password_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$'
     or p_is_lifetime is null
     or (not p_is_lifetime and (p_license_expiry_date is null or p_license_expiry_date <= pg_catalog.now())) then
    raise exception using errcode = '22023', message = 'Invalid cloud shop input';
  end if;

  insert into public.cloud_pharmacies (
    shop_id, name, address, phone, status, is_lifetime,
    license_expiry_date, updated_at
  ) values (
    pg_catalog.btrim(p_shop_id), pg_catalog.btrim(p_name), pg_catalog.btrim(p_address),
    coalesce(p_phone, ''), 'active', p_is_lifetime,
    case when p_is_lifetime then null else p_license_expiry_date end,
    pg_catalog.now()
  );
  insert into public.cloud_accounts (shop_id, username, password_hash, role, active)
  values (pg_catalog.btrim(p_shop_id), pg_catalog.btrim(p_username), p_password_hash, 'admin', true);

  return pg_catalog.jsonb_build_object(
    'shopId', pg_catalog.btrim(p_shop_id), 'name', pg_catalog.btrim(p_name),
    'address', pg_catalog.btrim(p_address), 'phone', coalesce(p_phone, ''),
    'username', pg_catalog.btrim(p_username), 'role', 'admin', 'status', 'active',
    'isLifetime', p_is_lifetime,
    'licenseExpiryDate', case when p_is_lifetime then null else p_license_expiry_date end
  );
end;
$$;
revoke all on function public.create_cloud_shop(text, text, text, text, timestamptz, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.create_cloud_shop(text, text, text, text, timestamptz, boolean, text, text)
  to service_role;

create or replace function public.manage_cloud_shop(
  p_actor_id bigint,
  p_shop_id text,
  p_action text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.cloud_pharmacies%rowtype;
  v_admin public.cloud_accounts%rowtype;
  v_admin_count integer;
  v_name text;
  v_address text;
  v_phone text;
  v_username text;
  v_password_hash text;
  v_lifetime boolean;
  v_expiry timestamptz;
  v_status text;
begin
  if p_actor_id is null or p_shop_id is null or pg_catalog.btrim(p_shop_id) = ''
     or p_action is null or p_payload is null then
    raise exception using errcode = '22023', message = 'Invalid cloud shop operation';
  end if;
  if not exists (
    select 1 from public.cloud_accounts a
    where a.id = p_actor_id and a.role = 'superAdmin' and a.active = true and a.shop_id = ''
  ) then
    raise exception using errcode = '42501', message = 'Active Super Admin required';
  end if;

  select * into v_shop from public.cloud_pharmacies
  where shop_id = p_shop_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Cloud shop not found';
  end if;

  if p_action = 'update' then
    if v_shop.archived_at is not null then
      raise exception using errcode = 'PZ003', message = 'Archived shops must be restored before editing';
    end if;
    v_name := pg_catalog.btrim(coalesce(p_payload ->> 'name', ''));
    v_address := pg_catalog.btrim(coalesce(p_payload ->> 'address', ''));
    v_phone := pg_catalog.btrim(coalesce(p_payload ->> 'phone', ''));
    v_username := pg_catalog.btrim(coalesce(p_payload ->> 'username', ''));
    v_password_hash := nullif(p_payload ->> 'passwordHash', '');
    if v_name = '' or pg_catalog.length(v_name) > 255
       or v_address = '' or pg_catalog.length(v_address) > 1024
       or pg_catalog.length(v_phone) > 64 or v_username = ''
       or pg_catalog.length(v_username) > 128
       or (v_password_hash is not null and v_password_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$') then
      raise exception using errcode = '22023', message = 'Invalid cloud shop details';
    end if;
    select count(*) into v_admin_count from public.cloud_accounts a
      where a.shop_id = p_shop_id and a.role = 'admin';
    if v_admin_count <> 1 then
      raise exception using errcode = 'PZ005', message = 'Shop must have exactly one Shop Admin for credential edits';
    end if;
    select * into v_admin from public.cloud_accounts a
      where a.shop_id = p_shop_id and a.role = 'admin' for update;
    update public.cloud_pharmacies set name = v_name, address = v_address,
      phone = v_phone, updated_at = pg_catalog.now()
      where shop_id = p_shop_id returning * into v_shop;
    update public.cloud_accounts set username = v_username,
      password_hash = coalesce(v_password_hash, password_hash)
      where id = v_admin.id returning * into v_admin;
  elsif p_action = 'status' then
    v_status := p_payload ->> 'status';
    if v_shop.archived_at is not null or v_status not in ('active', 'suspended') then
      raise exception using errcode = 'PZ003', message = 'Archived shops cannot change status';
    end if;
    if v_status = 'active' and not v_shop.is_lifetime
       and (v_shop.license_expiry_date is null or v_shop.license_expiry_date <= pg_catalog.now()) then
      raise exception using errcode = 'PZ002', message = 'An expired or missing license must be renewed before activation';
    end if;
    update public.cloud_pharmacies set status = v_status, updated_at = pg_catalog.now()
      where shop_id = p_shop_id returning * into v_shop;
  elsif p_action = 'license' then
    v_lifetime := (p_payload ->> 'isLifetime')::boolean;
    v_expiry := nullif(p_payload ->> 'licenseExpiryDate', '')::timestamptz;
    if v_shop.archived_at is not null then
      raise exception using errcode = 'PZ003', message = 'Archived shops must be restored before license renewal';
    end if;
    if v_lifetime is null or (not v_lifetime and (v_expiry is null or v_expiry <= pg_catalog.now())) then
      raise exception using errcode = '22023', message = 'A future expiry date or lifetime license is required';
    end if;
    update public.cloud_pharmacies set is_lifetime = v_lifetime,
      license_expiry_date = case when v_lifetime then null else v_expiry end,
      status = 'active', updated_at = pg_catalog.now()
      where shop_id = p_shop_id returning * into v_shop;
  elsif p_action = 'archive' then
    if p_payload ->> 'confirmationShopId' is distinct from p_shop_id then
      raise exception using errcode = '22023', message = 'The Shop ID confirmation did not match';
    end if;
    if v_shop.archived_at is null then
      update public.cloud_pharmacies set status_before_archive = status,
        archived_at = pg_catalog.now(), archived_by = p_actor_id,
        status = 'suspended', updated_at = pg_catalog.now()
        where shop_id = p_shop_id returning * into v_shop;
    end if;
  elsif p_action = 'restore' then
    if p_payload ->> 'confirmationShopId' is distinct from p_shop_id then
      raise exception using errcode = '22023', message = 'The Shop ID confirmation did not match';
    end if;
    if v_shop.archived_at is null then
      raise exception using errcode = 'PZ003', message = 'Cloud shop is not archived';
    end if;
    v_status := v_shop.status_before_archive;
    if v_status = 'active' and not v_shop.is_lifetime
       and (v_shop.license_expiry_date is null or v_shop.license_expiry_date <= pg_catalog.now()) then
      v_status := 'suspended';
    end if;
    update public.cloud_pharmacies set archived_at = null, archived_by = null,
      status_before_archive = null, status = v_status, updated_at = pg_catalog.now()
      where shop_id = p_shop_id returning * into v_shop;
  else
    raise exception using errcode = '22023', message = 'Unsupported cloud shop operation';
  end if;

  select * into v_admin from public.cloud_accounts a
    where a.shop_id = p_shop_id and a.role = 'admin' order by a.id limit 1;
  return pg_catalog.jsonb_build_object(
    'shopId', v_shop.shop_id,
    'name', v_shop.name,
    'address', v_shop.address,
    'phone', v_shop.phone,
    'status', v_shop.status,
    'isLifetime', v_shop.is_lifetime,
    'licenseExpiryDate', v_shop.license_expiry_date,
    'archived', (v_shop.archived_at is not null),
    'username', v_admin.username,
    'adminActive', v_admin.active,
    'updatedAt', v_shop.updated_at
  );
end;
$$;
revoke all on function public.manage_cloud_shop(bigint, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.manage_cloud_shop(bigint, text, text, jsonb)
  to service_role;

create or replace function public.create_cloud_shop_idempotent(
  p_actor_id bigint,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_shop_id text,
  p_name text,
  p_address text,
  p_phone text,
  p_license_expiry_date timestamptz,
  p_is_lifetime boolean,
  p_username text,
  p_password_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.cloud_provision_requests%rowtype;
  v_shop jsonb;
  v_inserted integer;
begin
  if p_actor_id is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
     or p_idempotency_key_hash is null or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_shop_id is null or pg_catalog.length(pg_catalog.btrim(p_shop_id)) = 0
     or pg_catalog.length(p_shop_id) > 128
     or p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) = 0
     or pg_catalog.length(p_name) > 255
     or p_address is null or pg_catalog.length(pg_catalog.btrim(p_address)) = 0
     or pg_catalog.length(p_address) > 1024
     or pg_catalog.length(coalesce(p_phone, '')) > 64
     or p_username is null or pg_catalog.length(pg_catalog.btrim(p_username)) = 0
     or pg_catalog.length(p_username) > 128
     or p_password_hash is null
     or p_password_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$'
     or p_is_lifetime is null
     or (not p_is_lifetime and p_license_expiry_date is null) then
    raise exception using errcode = '22023', message = 'Invalid cloud shop input';
  end if;

  if not exists (
    select 1 from public.cloud_accounts a
    where a.id = p_actor_id and a.role = 'superAdmin' and a.active = true and a.shop_id = ''
  ) then
    raise exception using errcode = '42501', message = 'Active Super Admin required';
  end if;

  insert into public.cloud_provision_requests(actor_id, idempotency_key_hash, request_hash)
  values (p_actor_id, p_idempotency_key_hash, p_request_hash)
  on conflict (actor_id, idempotency_key_hash) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into v_existing
    from public.cloud_provision_requests
    where actor_id = p_actor_id and idempotency_key_hash = p_idempotency_key_hash
    for update;
    if v_existing.request_hash <> p_request_hash then
      raise exception using errcode = '22023', message = 'Idempotency key was already used with a different request';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = '40001', message = 'Provisioning request is still being processed';
    end if;
    return v_existing.response_body;
  end if;

  if not p_is_lifetime and p_license_expiry_date <= pg_catalog.now() then
    raise exception using errcode = '22023', message = 'License expiry must be in the future';
  end if;

  insert into public.cloud_pharmacies (
    shop_id, name, address, phone, status, is_lifetime,
    license_expiry_date, updated_at
  ) values (
    pg_catalog.btrim(p_shop_id), pg_catalog.btrim(p_name), pg_catalog.btrim(p_address),
    coalesce(p_phone, ''), 'active', p_is_lifetime,
    case when p_is_lifetime then null else p_license_expiry_date end,
    pg_catalog.now()
  );
  insert into public.cloud_accounts (shop_id, username, password_hash, role, active)
  values (pg_catalog.btrim(p_shop_id), pg_catalog.btrim(p_username), p_password_hash, 'admin', true);

  v_shop := pg_catalog.jsonb_build_object(
    'shopId', pg_catalog.btrim(p_shop_id), 'name', pg_catalog.btrim(p_name),
    'address', pg_catalog.btrim(p_address), 'phone', coalesce(p_phone, ''),
    'username', pg_catalog.btrim(p_username), 'role', 'admin', 'status', 'active',
    'isLifetime', p_is_lifetime,
    'licenseExpiryDate', case when p_is_lifetime then null else p_license_expiry_date end
  );
  update public.cloud_provision_requests
  set response_body = v_shop, completed_at = pg_catalog.now()
  where actor_id = p_actor_id and idempotency_key_hash = p_idempotency_key_hash;
  return v_shop;
end;
$$;
revoke all on function public.create_cloud_shop_idempotent(bigint, text, text, text, text, text, text, timestamptz, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.create_cloud_shop_idempotent(bigint, text, text, text, text, text, text, timestamptz, boolean, text, text)
  to service_role;

notify pgrst, 'reload schema';
commit;
