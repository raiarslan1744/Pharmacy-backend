begin;

create function public.create_cloud_shop(
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
set search_path = pg_catalog, public
as $$
begin
  if p_shop_id is null or length(btrim(p_shop_id)) = 0
     or p_name is null or length(btrim(p_name)) = 0
     or p_address is null or length(btrim(p_address)) = 0
     or p_username is null or length(btrim(p_username)) = 0
     or p_password_hash is null
     or p_password_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$'
     or p_is_lifetime is null
     or (not p_is_lifetime and p_license_expiry_date is null) then
    raise exception using errcode = '22023', message = 'Invalid cloud shop input';
  end if;

  insert into public.cloud_pharmacies (
    shop_id, name, address, phone, status, is_lifetime,
    license_expiry_date, updated_at
  ) values (
    btrim(p_shop_id), btrim(p_name), btrim(p_address), coalesce(p_phone, ''),
    'active', p_is_lifetime,
    case when p_is_lifetime then null else p_license_expiry_date end,
    now()
  );

  insert into public.cloud_accounts (
    shop_id, username, password_hash, role, active
  ) values (
    btrim(p_shop_id), btrim(p_username), p_password_hash, 'admin', true
  );

  return jsonb_build_object(
    'shopId', btrim(p_shop_id),
    'name', btrim(p_name),
    'address', btrim(p_address),
    'phone', coalesce(p_phone, ''),
    'username', btrim(p_username),
    'role', 'admin',
    'status', 'active',
    'isLifetime', p_is_lifetime,
    'licenseExpiryDate', case when p_is_lifetime then null else p_license_expiry_date end
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'Shop ID or username already exists for this shop';
end;
$$;

revoke all on function public.create_cloud_shop(text, text, text, text, timestamptz, boolean, text, text) from public, anon, authenticated;
grant execute on function public.create_cloud_shop(text, text, text, text, timestamptz, boolean, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
