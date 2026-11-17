-- Optional structural rollback. Review and approve separately; never run automatically.
-- Preferred operational rollback leaves migration 003 in place and preserves security.
-- This script refuses to delete sessions or idempotency history. Export/archive those
-- records under a separately approved retention plan before any structural rollback.
begin;
lock table public.cloud_admin_sessions, public.cloud_provision_requests in access exclusive mode;
do $$ begin
  if exists (select 1 from public.cloud_admin_sessions)
     or exists (select 1 from public.cloud_provision_requests)
     or exists (select 1 from public.cloud_pharmacies where archived_at is not null) then
    raise exception 'Rollback stopped: session, provisioning, or archive history must be preserved; use application rollback with schema retained';
  end if;
end $$;
drop trigger cloud_accounts_revoke_sessions_after_write on public.cloud_accounts;
drop trigger cloud_accounts_integrity_before_write on public.cloud_accounts;
drop function public.cloud_accounts_revoke_sessions_after_write();
drop function public.cloud_accounts_integrity_before_write();
drop function public.manage_cloud_shop(bigint,text,text,jsonb);
drop function public.create_cloud_shop_idempotent(bigint,text,text,text,text,text,text,timestamptz,boolean,text,text);
drop table public.cloud_admin_sessions;
drop table public.cloud_provision_requests;
drop table public.cloud_schema_versions;
drop index if exists public.cloud_accounts_shop_username_guard;
alter table public.cloud_accounts drop constraint cloud_accounts_pharmacy_match_check;
alter table public.cloud_accounts drop constraint cloud_accounts_pharmacy_shop_fk;
alter table public.cloud_accounts drop column pharmacy_shop_id, drop column session_version;
alter table public.cloud_pharmacies drop constraint cloud_pharmacies_archive_state_check;
alter table public.cloud_pharmacies drop constraint cloud_pharmacies_archived_by_fk;
alter table public.cloud_pharmacies drop column archived_at, drop column archived_by, drop column status_before_archive;
-- The compatible legacy create_cloud_shop signature remains available.
notify pgrst, 'reload schema';
commit;
