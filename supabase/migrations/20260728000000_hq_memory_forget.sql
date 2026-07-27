-- ---------------------------------------------------------------------------
-- CrewFlow HQ — Shared Memory: the AI `forget()` primitive
-- (CEO Directive 009 Module 1, PR6 — SDK Integration; Bible Volume X §12.2/§14).
--
-- The `ctx.memory` SDK surface (server/sdk/memory.ts) exposes five verbs;
-- four of them (recall / remember / resolve / search) compose primitives that
-- already exist. The fifth — `forget(id, reason)` — did not have a faithful
-- backing primitive, so this migration adds exactly one.
--
-- WHY a new primitive (and not hq_memory_archive). `hq_memory_archive` (PR5,
-- §10) is the *mechanical eviction* primitive the lifecycle worker calls: it is
-- class-guarded (working/episodic only), takes NO employee, and does NOT version
-- — because eviction is housekeeping, not an authored act. `forget()` is the
-- opposite: a DELIBERATE act by an employee on memory IT OWNS. The Bible §14
-- contract is precise — "forget() archives + versions; memory is an audit
-- subject" and "no hard deletes". So forget must (a) be permission-checked, (b)
-- snapshot a version, (c) be audited, (d) never DELETE.
--
-- OWNERSHIP IS THE GUARD (no separate class guard needed). An AI employee only
-- ever *owns* private / episodic / working memory — `rememberMemory` derives
-- `owner_employee_id` only for those (§6); shared, durable company knowledge is
-- owner-less (the company brain) and is therefore structurally un-forgettable by
-- an employee here. Retracting shared knowledge is a Module 4 approval-gated
-- transition, never an autonomous forget. So `owner_employee_id = p_employee_id`
-- both authorises the act AND protects the durable company brain in one check —
-- the same defence-in-depth posture as every other §12 entry point (the SDK
-- checks too; this SQL re-asserts so a buggy SDK can't get past P5).
--
-- THE PULSE stays quiet. Forgetting is not a business event: there is no
-- `memory.forgotten` verb in the frozen registry (XI), exactly as expiry /
-- archival / eviction emit nothing. The per-memory `archived` audit row (with
-- `ai_employee_id` set, which distinguishes a deliberate forget from a
-- mechanical eviction whose actor is null) is the audit truth.
--
-- IDEMPOTENT. The `status = 'active'` guard means a re-forget is a no-op that
-- reports `already_inactive`, never a second archival or a second version.
-- ---------------------------------------------------------------------------

create or replace function public.hq_memory_forget(
  p_employee_id uuid,
  p_memory_id   uuid,
  p_reason      text default 'forgotten'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner      uuid;
  v_status     text;
  v_old_version integer;
  v_new_version integer;
begin
  -- Look up the subject once so we can return a precise reason. A missing row
  -- and a not-owned row are different refusals; collapsing them would let a
  -- caller probe existence by reason, so we separate them deliberately.
  select m.owner_employee_id, m.status, m.version
    into v_owner, v_status, v_old_version
  from public.hq_memories m
  where m.id = p_memory_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Permission, re-asserted in SQL (defence in depth, P5). An employee may
  -- forget ONLY memory it owns. Owner-less company knowledge and another
  -- employee's private experience are both refused here.
  if v_owner is distinct from p_employee_id then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  if v_status is distinct from 'active' then
    -- Already archived/superseded/draft — idempotent no-op, not an error.
    return jsonb_build_object('ok', false, 'reason', 'already_inactive');
  end if;

  update public.hq_memories m
     set status  = 'archived',
         version = m.version + 1
   where m.id = p_memory_id
     and m.status = 'active'
     and m.owner_employee_id = p_employee_id
  returning m.version into v_new_version;

  if v_new_version is null then
    -- Lost a race with a concurrent transition; treat as already inactive.
    return jsonb_build_object('ok', false, 'reason', 'already_inactive');
  end if;

  -- Version snapshot (Bible §14: forget archives + versions). Mirrors the
  -- snapshot shape every other write path uses, so the history table stays
  -- uniform regardless of which verb produced the row.
  insert into public.hq_memory_versions (
    memory_id, version, title, summary, body, memory_type, department,
    importance, tags, status, edited_by_email
  )
  select id, version, title, summary, body, memory_type, department,
         importance, tags, status, null
  from public.hq_memories
  where id = p_memory_id;

  -- Audit as 'archived' with the acting employee stamped — this is what
  -- separates a deliberate forget (ai_employee_id present) from a mechanical
  -- eviction (ai_employee_id null) in the SAME transition bucket. No Pulse.
  insert into public.hq_memory_events (memory_id, event_type, ai_employee_id, detail)
  values (
    p_memory_id, 'archived', p_employee_id,
    jsonb_build_object(
      'action', 'forget',
      'reason', coalesce(nullif(btrim(p_reason), ''), 'forgotten'),
      'from_version', v_old_version,
      'to_version', v_new_version
    )
  );

  return jsonb_build_object(
    'ok', true, 'memory_id', p_memory_id, 'version', v_new_version
  );
end;
$$;

revoke all on function public.hq_memory_forget(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hq_memory_forget(uuid, uuid, text) to service_role;
