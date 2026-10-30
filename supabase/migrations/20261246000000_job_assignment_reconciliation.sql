-- ============================================================================
-- R5 — coherent, TRANSACTIONAL job-assignment model (apply-held).
-- ============================================================================
-- Two SECURITY DEFINER RPCs give the owner/admin assignment flows a single,
-- transactional model that keeps jobs.assigned_to (the legacy "primary") and
-- job_assignments (the crew) consistent — no independent writes that can drift.
-- Founder-confirmed semantics:
--   • Reassigning the PRIMARY (set_job_primary_assignment) must NOT remove the
--     previous primary from the crew — they stay an assigned crew member until
--     EXPLICITLY removed. So before the primary changes, the outgoing primary is
--     preserved as a job_assignments row.
--   • EXPLICIT removal (remove_job_worker) revokes EVERY assignment path: the
--     job_assignments row is deleted AND jobs.assigned_to is nulled if it points
--     at the removed worker. No stale assignment may preserve access.
-- Both run in one transaction (plpgsql), are org-pinned, and are admin-only.
--
-- AUTHZ: the canonical membership guard (current_org_ids() + 42501 — so the
-- secdef-org-rpc guard auto-passes) plus an is_org_admin() check (owner/admin
-- only, matching updateJob's authority). service_role (server jobs) bypasses the
-- guard. job_assignments is service-role-only, so these DEFINER functions are
-- the only authenticated-reachable write path to it — intentional + gated.
--
-- These are the write authority used by createJob/updateJob (primary) and the
-- multi-worker crew panel (secondary add via a plain upsert; removal via
-- remove_job_worker). Idempotent: OR REPLACE.
-- ROLLBACK: drop function set_job_primary_assignment(uuid,uuid,uuid);
--           drop function remove_job_worker(uuid,uuid,uuid);
-- ============================================================================

create or replace function public.set_job_primary_assignment(
  p_job_id uuid,
  p_org_id uuid,
  p_assigned_to uuid
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_old_primary uuid;
begin
  -- membership guard (canonical: current_org_ids + 42501).
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  -- admin-only (owner/admin), matching the jobs UPDATE policy authority.
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org_id) then
    raise exception 'Forbidden: only owners/admins may change assignments' using errcode = '42501';
  end if;

  select assigned_to into v_old_primary
  from public.jobs where id = p_job_id and org_id = p_org_id;
  if not found then
    raise exception 'Job not found in this org' using errcode = 'P0002';
  end if;

  -- The new primary (when set) must be a member of the job's org.
  if p_assigned_to is not null
     and not exists (
       select 1 from public.memberships where org_id = p_org_id and user_id = p_assigned_to
     ) then
    raise exception 'Assignee is not a member of this org' using errcode = '23514';
  end if;

  -- RULE 1: preserve the OUTGOING primary on the crew when the primary changes,
  -- so reassigning the lead never silently drops the previous lead's access.
  if v_old_primary is not null and v_old_primary is distinct from p_assigned_to then
    insert into public.job_assignments (org_id, job_id, user_id, assigned_by)
    values (p_org_id, p_job_id, v_old_primary, auth.uid())
    on conflict (job_id, user_id) do nothing;
  end if;

  -- Set the primary, and ensure the new primary is on the crew — atomically.
  update public.jobs set assigned_to = p_assigned_to
  where id = p_job_id and org_id = p_org_id;

  if p_assigned_to is not null then
    insert into public.job_assignments (org_id, job_id, user_id, assigned_by)
    values (p_org_id, p_job_id, p_assigned_to, auth.uid())
    on conflict (job_id, user_id) do nothing;
  end if;
end;
$$;

create or replace function public.remove_job_worker(
  p_job_id uuid,
  p_org_id uuid,
  p_user_id uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org_id) then
    raise exception 'Forbidden: only owners/admins may change assignments' using errcode = '42501';
  end if;

  -- RULE 2: explicit removal revokes EVERY path, atomically.
  delete from public.job_assignments
  where job_id = p_job_id and org_id = p_org_id and user_id = p_user_id;

  update public.jobs set assigned_to = null
  where id = p_job_id and org_id = p_org_id and assigned_to = p_user_id;
end;
$$;
