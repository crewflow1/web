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

  -- SERIALIZE all assignment mutations on this job. Without this, a concurrent
  -- set_job_primary_assignment (W→X) and remove_job_worker(W) can interleave so
  -- that the removal's "null assigned_to where = W" and crew-delete both miss
  -- (the set has already moved the primary to X and re-inserted W's crew row),
  -- leaving the explicitly-removed W on the crew — a RULE 2 violation. A
  -- transaction-scoped advisory lock, namespaced to ('job_assignment', job),
  -- makes every mutation on a job run start-to-finish before the next begins.
  -- Released automatically at commit/rollback.
  perform pg_advisory_xact_lock(hashtext('job_assignment'), hashtext(p_job_id::text));

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
  -- so reassigning the lead never silently drops the previous lead's access —
  -- but only if they are STILL a member of the org (never resurrect a former
  -- primary whose membership was since revoked; that would contradict the
  -- "assignees are org members" invariant the new-primary check also enforces).
  if v_old_primary is not null and v_old_primary is distinct from p_assigned_to
     and exists (
       select 1 from public.memberships where org_id = p_org_id and user_id = v_old_primary
     ) then
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

  -- Serialize against set_job_primary_assignment on the SAME job (see the note
  -- there) so a concurrent reassignment cannot re-add this worker after we
  -- remove them. Same namespaced, transaction-scoped advisory lock.
  perform pg_advisory_xact_lock(hashtext('job_assignment'), hashtext(p_job_id::text));

  -- Loud contract (matches set_job_primary_assignment): a wrong org makes this a
  -- no-op silently, so refuse a job that is not in this org rather than report a
  -- false "removed".
  if not exists (select 1 from public.jobs where id = p_job_id and org_id = p_org_id) then
    raise exception 'Job not found in this org' using errcode = 'P0002';
  end if;

  -- RULE 2: explicit removal revokes EVERY path, atomically.
  delete from public.job_assignments
  where job_id = p_job_id and org_id = p_org_id and user_id = p_user_id;

  update public.jobs set assigned_to = null
  where id = p_job_id and org_id = p_org_id and assigned_to = p_user_id;
end;
$$;

-- add_job_worker — add a SECONDARY crew member (not the primary). This is the
-- locked counterpart of the crew-panel's "Add worker": it MUST take the same
-- per-job advisory lock as set_job_primary_assignment / remove_job_worker, or an
-- unlocked upsert racing a concurrent remove_job_worker could re-insert a worker
-- the admin just explicitly removed (review finding F1 — add-vs-remove was
-- last-writer-wins because the add path bypassed the lock). With all three
-- mutators serialized on hashtext('job_assignment', job), an add that loses the
-- race to a remove is simply ordered after it and the remove stands.
create or replace function public.add_job_worker(
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

  perform pg_advisory_xact_lock(hashtext('job_assignment'), hashtext(p_job_id::text));

  if not exists (select 1 from public.jobs where id = p_job_id and org_id = p_org_id) then
    raise exception 'Job not found in this org' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.memberships where org_id = p_org_id and user_id = p_user_id
  ) then
    raise exception 'Worker is not a member of this org' using errcode = '23514';
  end if;

  insert into public.job_assignments (org_id, job_id, user_id, assigned_by)
  values (p_org_id, p_job_id, p_user_id, auth.uid())
  on conflict (job_id, user_id) do nothing;
end;
$$;
