begin;
create table public.cloud_pharmacies (
  shop_id text primary key check (length(shop_id) > 0),
  name text not null check (length(name) > 0),
  address text not null,
  phone text not null default '',
  status text not null default 'active' check (status in ('active','suspended')),
  is_lifetime boolean not null default false,
  license_expiry_date timestamptz,
  updated_at timestamptz not null default now()
);
create table public.cloud_accounts (
  id bigint generated always as identity primary key,
  shop_id text not null default '',
  username text not null check (length(username) > 0),
  password_hash text not null,
  role text not null check (role in ('superAdmin','admin','employee')),
  active boolean not null default true,
  unique(shop_id, username),
  check ((role = 'superAdmin' and shop_id = '') or (role <> 'superAdmin' and shop_id <> ''))
);
alter table public.cloud_pharmacies enable row level security;
alter table public.cloud_accounts enable row level security;
revoke all on public.cloud_accounts, public.cloud_pharmacies from anon, authenticated;
grant all on public.cloud_accounts, public.cloud_pharmacies to service_role;
grant usage, select on sequence public.cloud_accounts_id_seq to service_role;
commit;
