-- P4 Job Documents — hide private-document audit rows from non-admins.
-- Private-doc events are logged with an action prefixed 'job_document.private.'.
-- The existing activity_log SELECT policy is org-member-wide, which would leak
-- private filenames/metadata to staff via the activity feed. Amend it so only
-- owner/admin can see those rows.
--
-- Verified against prod 2026-06-04: 'activity_log: members can select' is the
-- ONLY SELECT policy on public.activity_log — PERMISSIVE, role authenticated,
-- using (org_id in (select current_org_ids())), no WITH CHECK. We recreate it
-- verbatim and append the private-document filter.

drop policy if exists "activity_log: members can select" on public.activity_log;
create policy "activity_log: members can select"
  on public.activity_log for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (
      action not like 'job_document.private.%'
      or public.is_org_admin(org_id)
    )
  );
