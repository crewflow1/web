-- ============================================================================
-- R5 Phase 3 (remainder, slice 2) — blueprint domain assignment-aware SELECT.
-- ============================================================================
-- blueprints (drawings), blueprint_markup (annotations) and blueprint_pins
-- (snag/note locations) all carry a denormalised job_id, so staff should see
-- them only for jobs they are assigned to; owners/admins keep full org access.
-- Standard Phase 3 pattern.
--
-- WRITE-PATH SELF-CONSISTENCY: members place/move markup + pins (and the
-- create_blueprint_pin_with_snag RPC runs as the member). A member can only
-- reach a blueprint through a job they can see — under the already-live Phase 2
-- jobs narrowing that is an ASSIGNED job — so every row a member creates/moves
-- has an assigned job_id and remains visible to them (RETURNING reads succeed).
-- The pin RPC returns a pin whose job is the assigned job → visible. No
-- legitimate member workflow breaks; a member simply cannot act on a
-- non-assigned job's blueprint (which they could not see anyway).
--
-- INSERT/UPDATE/DELETE unchanged. ROLLBACK: recreate each with the plain
-- org-only predicate.
-- ============================================================================

drop policy if exists "blueprints: members select" on public.blueprints;
create policy "blueprints: members select" on public.blueprints
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

drop policy if exists "blueprint_markup: members select" on public.blueprint_markup;
create policy "blueprint_markup: members select" on public.blueprint_markup
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

drop policy if exists "blueprint_pins: members select" on public.blueprint_pins;
create policy "blueprint_pins: members select" on public.blueprint_pins
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );
