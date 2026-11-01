-- ============================================================================
-- R5 Phase 3 (remainder, slice 5) — worker_acknowledgements self-scope.
-- ============================================================================
-- worker_acknowledgements are PERSONAL safety sign-off records captured from
-- EXTERNAL workers via the worker-portal token flow. Column shape confirms the
-- acknowledging worker is NOT an app user: `subject_id` is the acknowledged
-- DOCUMENT (a toolbox_talk / risk_assessment / permit, per subject_type), the
-- worker is identified only by the token (worker_signoff_tokens.worker_name) +
-- the typed signed_name. There is NO app-user "self" column on this table.
--
-- Founder rule: workers may access their own acks + relevant assigned-job safety
-- REQUIREMENTS, but NOT other workers' private records. That decomposes as:
--   • a worker reads/creates their OWN ack through the PORTAL (token, served by
--     the service-role client — bypasses RLS, unaffected by this policy);
--   • the safety REQUIREMENTS (toolbox_talks/risk_assessments/permits/ITPs) are
--     separate tables already narrowed to the assigned job (Phase 3 slices 1–2);
--   • the private ack RECORDS, read in-app, are therefore owner/ADMIN-ONLY — a
--     non-admin staff user has no "own" ack here and must not read another
--     worker's private record. (There is no app-user column to self-scope on.)
--
--   SELECT: org member AND is_org_admin(org_id)
--
-- INSERT/UPDATE/DELETE unchanged (portal capture is service-role). If a future
-- role legitimately needs scoped in-app read, add an explicit branch here.
-- ROLLBACK: recreate with the plain org-only predicate.
-- ============================================================================

drop policy if exists worker_ack_select on public.worker_acknowledgements;
create policy worker_ack_select on public.worker_acknowledgements
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and public.is_org_admin(org_id)
  );
