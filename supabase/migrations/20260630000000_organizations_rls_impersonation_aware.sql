-- CrewFlow HQ-10.2 — make the organizations SELECT policy impersonation-aware.
--
-- BUG-05 root cause
-- -----------------
--   HQ-10.1 (20260614000000_impersonation_rls_aware.sql) updated
--   current_org_ids() to UNION in the active impersonation target, and
--   every tenant table (jobs, quotes, invoices, customers, …) reads RLS
--   through that helper — so their policies became impersonation-aware
--   automatically.
--
--   The organizations table's own SELECT policy was the ONE exception:
--   it still used a hand-rolled membership subquery
--       id in (select org_id from public.memberships where user_id = auth.uid())
--   instead of current_org_ids(). So an impersonating super-admin could
--   not read the TARGET org's row → loadOrgContextForImpersonation()
--   returned null → getOrgForUser() silently fell back to the operator's
--   OWN org. Net effect: the banner said "impersonating Customer A" while
--   every data surface — and crucially every WRITE via ctx.org.id — used
--   the operator's own org. The tenant context never actually switched.
--
-- Fix
-- ---
--   Recreate the policy to read through current_org_ids(), matching every
--   other tenant table.
--
-- Why this is safe for customers
-- ------------------------------
--   For a non-super-admin, current_org_ids() == "org_ids the user is a
--   member of" — identical to the old subquery — so the visible set does
--   not change at all for normal customers. The ONLY delta is that an
--   ACTIVE impersonation session (which only a super-admin can create;
--   customers cannot, the table is RLS-with-no-policies) now also grants
--   read of the target org row, letting the context switch land as the
--   banner already claims.
--
-- Security
-- --------
--   * current_org_ids() is SECURITY DEFINER and already enforces the
--     impersonation 24h cap + ended_at IS NULL gate inline, so Exit /
--     Force-end revokes access immediately.
--   * No new privilege is introduced here — organizations merely catches
--     up to the policy posture the rest of the schema has had since
--     20260614000000.

drop policy if exists "Users can read organizations they belong to" on public.organizations;
create policy "Users can read organizations they belong to"
on public.organizations
for select
to authenticated
using (
  id in (select public.current_org_ids())
);
