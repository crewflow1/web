-- RAMS hazards and permit conditions follow the visibility of their parent document
-- (least-privilege enforcement — UI workstream replay finding: staff could POST
-- addHazard / addPermitCondition for a document the page refuses to show them).
--
-- THE HOLE
-- --------
-- risk_assessments and permits_to_work are scoped for a non-admin to the jobs they are
-- assigned to (…_select: is_org_admin(org_id) OR job_id IN my_assigned_job_ids()).
-- Their CHILD tables were not: risk_assessment_hazards and permit_conditions admit any
-- org member for SELECT / INSERT / UPDATE / DELETE. So a `staff` member who cannot open
-- a RAMS or permit (the page answers not-found) could still — by replaying the server
-- action or straight at PostgREST, knowing only the parent id — read its hazards and
-- conditions, add a hazard or a condition to it, edit them, or delete them.
--
-- THE FIX
-- -------
-- One RESTRICTIVE policy per child table, for ALL commands: the parent row must be
-- readable by the caller. The sub-select runs under the caller's own RLS on the parent,
-- so the child inherits exactly the parent's rule — an owner/admin sees and writes
-- everything in their org; a staff member only on documents of their assigned jobs.
-- Member-level authoring on a visible document (an existing, tested decision —
-- rls/health-safety lifecycle "first delivery stays member-level") is unchanged.
-- service_role (worker sign-off links, PDFs, generators) bypasses RLS.
--
-- data-api:exempt: policy-only change; adds no table and no grant.
-- Additive, idempotent.
--
-- Safe to apply before the code deploys: yes. Production precondition: none.
-- Rollback: drop policy "<table>: parent must be readable" on public.<table>;

drop policy if exists "risk_assessment_hazards: parent must be readable" on public.risk_assessment_hazards;
create policy "risk_assessment_hazards: parent must be readable"
  on public.risk_assessment_hazards
  as restrictive for all to authenticated
  using (exists (select 1 from public.risk_assessments ra where ra.id = risk_assessment_id))
  with check (exists (select 1 from public.risk_assessments ra where ra.id = risk_assessment_id));

drop policy if exists "permit_conditions: parent must be readable" on public.permit_conditions;
create policy "permit_conditions: parent must be readable"
  on public.permit_conditions
  as restrictive for all to authenticated
  using (exists (select 1 from public.permits_to_work p where p.id = permit_id))
  with check (exists (select 1 from public.permits_to_work p where p.id = permit_id));
