begin;

-- Add management account activity and safe absolute-state retries without editing migration 003.
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
  elsif p_action = 'account' then
    if v_shop.archived_at is not null then
      raise exception using errcode = 'PZ003', message = 'Restore the shop before managing its account';
    end if;
    if pg_catalog.jsonb_typeof(p_payload -> 'active') is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'Account activity must be a boolean';
    end if;
    select count(*) into v_admin_count from public.cloud_accounts a
      where a.shop_id = p_shop_id and a.role = 'admin';
    if v_admin_count <> 1 then
      raise exception using errcode = 'PZ005', message = 'Shop must have exactly one Shop Admin for account management';
    end if;
    update public.cloud_accounts set active = (p_payload ->> 'active')::boolean
      where shop_id = p_shop_id and role = 'admin';
  elsif p_action = 'status' then
    v_status := p_payload ->> 'status';
    if v_shop.archived_at is not null or v_status is null or v_status not in ('active', 'suspended') then
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
    if v_shop.archived_at is not null then
      v_status := v_shop.status_before_archive;
      if v_status = 'active' and not v_shop.is_lifetime
         and (v_shop.license_expiry_date is null or v_shop.license_expiry_date <= pg_catalog.now()) then
        v_status := 'suspended';
      end if;
      update public.cloud_pharmacies set archived_at = null, archived_by = null,
        status_before_archive = null, status = v_status, updated_at = pg_catalog.now()
        where shop_id = p_shop_id returning * into v_shop;
    end if;
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

insert into public.cloud_schema_versions(version) values (4) on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;
