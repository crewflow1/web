-- STAGED — DO NOT APPLY WITHOUT SEPARATE APPROVAL. Never executed anywhere.
--
-- Removes CrewFlow's minimised billing records of deleted companies once their
-- retention date has passed. IRREVERSIBLE. Service-role only; not scheduled.
-- Returns the number of rows removed. The tombstones in
-- privacy_deletion_requests are NOT touched (they hold no personal data).
create or replace function public.privacy_purge_expired_retained_billing(p_today date default current_date)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_n bigint;
begin
  perform public._privacy_require_service_role('privacy_purge_expired_retained_billing');
  if p_today > current_date then
    raise exception 'privacy_purge_expired_retained_billing: cannot purge ahead of today' using errcode = 'check_violation';
  end if;
  delete from public.privacy_retained_billing_records where retention_until < p_today;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.privacy_purge_expired_retained_billing(date) from public;
revoke execute on function public.privacy_purge_expired_retained_billing(date) from anon, authenticated;
grant  execute on function public.privacy_purge_expired_retained_billing(date) to service_role;
-- Also required when this is applied: `grant delete on public.privacy_retained_billing_records to service_role;`
-- (the table currently grants select + insert only, so nothing can remove a row today).
