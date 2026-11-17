-- D-17 — creating a job is restricted to owners / admins, or a member explicitly
-- granted `jobs:create`.
--
-- WHY
-- ---
-- The founder ruling (D-17) restricts job creation to owners / admins or explicitly
-- authorised users. The application already said so (/jobs/new requires jobs:create),
-- but the database still carried the original "jobs: members can insert" policy
-- (20260515150000), which admits ANY member of the org. A staff member could therefore
-- create jobs straight through the Data API with their own session.
--
-- HOW
-- ---
-- Replace the permissive member INSERT policy with
--     is_org_admin(org_id) OR has_org_capability(org_id, 'jobs', 'create')
-- — the same shape the operations tables use (20261346000000). is_org_admin covers
-- owners / admins (and HQ impersonation); has_org_capability is the SECURITY DEFINER
-- mirror of lib/auth/capability-rules canWith (owner always; an admin with the grant;
-- staff never — a stray grant row on a staff membership is ignored; held org: no write).
--
-- Unchanged, and still required (RESTRICTIVE, ANDed): "jobs: held org read-only insert"
-- (org_is_writable). SELECT / UPDATE / DELETE policies are untouched.
--
-- Paths that keep working:
--   * service-role writers bypass RLS: the public-link quote accept, document imports
--     (commitImport — owner/admin-gated), first-run sample data, HQ provisioning, the
--     key-authenticated /api/v1/jobs POST.
--   * ensure_accepted_quote_artifacts is SECURITY INVOKER: the in-app accept runs as the
--     owner / an admin holding quotes:approve, both of whom pass is_org_admin.
--
-- Idempotent: drops both the old and the new policy name before creating the new one.
--
-- ROLLBACK (restores the exact pre-20261365000000 policy):
--   drop policy if exists "jobs: admin or job creator can insert" on public.jobs;
--   create policy "jobs: members can insert" on public.jobs for insert to authenticated
--   with check (org_id in (select public.current_org_ids()));

drop policy if exists "jobs: members can insert" on public.jobs;
drop policy if exists "jobs: admin or job creator can insert" on public.jobs;

create policy "jobs: admin or job creator can insert" on public.jobs
  for insert to authenticated
  with check (
    public.is_org_admin(org_id)
    or public.has_org_capability(org_id, 'jobs', 'create')
  );
