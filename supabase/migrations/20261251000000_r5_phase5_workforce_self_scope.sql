-- ============================================================================
-- R5 Phase 5 — workforce self-scoping (rota_entries, time_entries).
-- ============================================================================
-- A staff member may read only their OWN rota and time entries; owners/admins
-- read everyone's. This is the authoritative rule for time_entries even though
-- it is also job-linked — a worker's clock/rota is personal data, not job data.
-- SELECT narrows to: is_org_admin(org_id) OR user_id = auth.uid().
-- INSERT/UPDATE/DELETE are unchanged (a worker already writes their own entries;
-- the existing write policies/triggers govern that).
--
-- LOCKOUT ANALYSIS: owners/admins keep full visibility via is_org_admin(); a
-- staff member always matches their own rows via user_id = auth.uid(). No role
-- loses access to their own data.
-- ROLLBACK: recreate each policy with `using (org_id in (select current_org_ids()))`.
-- ============================================================================

drop policy if exists "rota: members select" on public.rota_entries;
create policy "rota: members select" on public.rota_entries
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or user_id = auth.uid())
  );

drop policy if exists "time_entries: members select" on public.time_entries;
create policy "time_entries: members select" on public.time_entries
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or user_id = auth.uid())
  );
