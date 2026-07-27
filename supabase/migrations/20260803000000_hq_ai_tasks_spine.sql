-- CrewFlow HQ — The Generic Task Engine, spine emission (CEO Directive #012 / D-02, PR-B).
--
-- PR-A (20260802000000) shipped the queue, the guard, and the seven entry points —
-- with NOTHING routed to it and NO spine event. This migration brings the reserved
-- task.* verbs to life: every WIRED lifecycle transition now emits ONE canonical
-- Event Spine event, in the SAME transaction as the state change. Nothing else
-- changes — the schema, the guard, the lease, and the dequeue are untouched.
--
-- ───────────────────────────────────────────────────────────────────────────
-- The reuse audit (Engineering Rule 1: reuse before build)
-- ───────────────────────────────────────────────────────────────────────────
-- The emission primitive ALREADY EXISTS: hq_emit_event (20260720000000) is the
-- single validated spine write — SECURITY DEFINER, service-role only, with the
-- envelope CHECKs that reject a malformed event. Every shipped engine (Approval,
-- Draft, Communication) emits through it in-transaction (the transactional-outbox
-- idiom). This migration mints NO new write path and NO new event-id machinery; it
-- only maps task transitions onto the verbs the registry already declares (PR-B's
-- companion edit to lib/events/registry.ts adds the five-verb task.* group).
--
-- The verb namespace is the registry's, not the DB's: hq_events enforces the
-- envelope shape, while VERB validity is enforced at the producer by the TypeScript
-- registry + a contract test (the spine's "one source of event names"). PR-B's
-- security test pins that this migration emits ONLY verbs the registry registers.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why emit FROM THE FUNCTIONS, not from an AFTER trigger (ADR-0005)
-- ───────────────────────────────────────────────────────────────────────────
-- The Approval/Draft/Comms engines emit from an AFTER trigger because every one of
-- their transitions maps 1:1 from the row's new state to a verb + actor the trigger
-- can read off the row. The Task Engine cannot: two of its transitions are
-- AMBIGUOUS at the row level —
--   • running → pending happens for a worker-reported retryable failure (actor: the
--     employee/worker; reason: its error) AND for a reaper recovering an expired
--     lease (actor: the SYSTEM; reason: lease_expired). Both land on the same row
--     shape; an AFTER trigger cannot tell which, nor recover the honest actor (the
--     lease owner is nulled by both paths).
--   • running → failed is likewise worker-reported OR retries-exhausted-by-reaper.
-- Only the entry-point FUNCTION knows which operation it is. PR-A already made the
-- functions "the one way an employee touches the queue" (a function-entry-point
-- engine, by design — see PR-A's header). So emission belongs where the sanctioned
-- operation is: each function emits its own precise verb + honest actor + reason.
-- The BEFORE guard remains the invariant backstop (it makes illegal transitions and
-- terminal mutation impossible even for a raw service-role UPDATE); the emitter is
-- the AUDIT of the front-door operation. The engine is written ONLY through these
-- functions, so there is no sanctioned non-emitting path (PR-B's security test pins
-- that no application code raw-writes the queue). The rejected alternative —
-- signalling the trigger via a session GUC or a discriminator column — is
-- action-at-a-distance that is harder to audit than a direct emit at the call site.
--
-- ───────────────────────────────────────────────────────────────────────────
-- The verb map (one verb per WIRED transition; past tense; ADR-0005)
-- ───────────────────────────────────────────────────────────────────────────
--   create            → task.created    (info)     actor: creator
--   claim             → task.claimed    (info)     actor: worker/employee
--   complete          → task.completed  (success)  actor: worker/employee
--   fail  retryable   → task.retried    (warn)     actor: worker;  reason=worker_error
--   fail  terminal    → task.failed     (warn)     actor: worker;  reason=worker_error
--   reap  retryable   → task.retried    (warn)     actor: system;  reason=lease_expired
--   reap  exhausted   → task.failed     (warn)     actor: system;  reason=lease_expired
--   heartbeat         → (none — liveness, not a fact; would drown the spine)
--   checkpoint        → (none — internal resumption state; evented only if a
--                        consumer ever needs it, a later decision)
--   cancel            → (no entry point in PR-A; task.cancelled is registered when a
--                        cancel function lands, never as dead vocabulary)
-- task.retried/task.failed each cover two paths, told apart by actor + payload.reason
-- — the precision the function-emission choice buys that a trigger could not.
--
-- Actor mapping is v1: an assigned task acts as its ai_employee, else 'system'; the
-- worker/lease token and dead-lease owner travel in the payload. Threading the SDK's
-- real RunContext identity onto actor_id is D-04 / #014 (runtime-identity), not PR-B.
-- correlation_id (already on every row) threads a task's whole lifecycle into one
-- spine trace; object is ('ai_task', id); target is the polymorphic (subject_kind,
-- subject_id). Payloads are small, non-PII identifiers + state (Ch.04) — never the
-- task payload/result prose, which stays in the RLS:hq row.

-- ===========================================================================
-- 1. hq_ai_task_emit — the ONE task→spine mapping primitive.
--
-- A private helper every entry point calls, so the envelope (object/target/
-- correlation + the standard identity payload) is written in exactly one place. It
-- reads ONLY WRITE-ONCE identity off the row (id, correlation_id, subject, task_type,
-- assignee, origin, priority); all MUTABLE detail (status, retry_count, reason, …)
-- is supplied by the caller in p_extra, so a pre-update row snapshot (as the reaper
-- holds) can never emit a stale status. SECURITY DEFINER + pinned empty search_path
-- + service-role-only EXECUTE, like every spine function.
-- ===========================================================================
create or replace function public.hq_ai_task_emit(
  p_task       public.hq_ai_tasks,
  p_verb       text,
  p_actor_type text,
  p_actor_id   text,
  p_severity   text,
  p_extra      jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.hq_emit_event(
    p_actor_type     => p_actor_type,
    p_actor_id       => coalesce(p_actor_id, 'system'),
    p_verb           => p_verb,
    p_object_type    => 'ai_task',
    p_object_id      => p_task.id::text,
    p_correlation_id => p_task.correlation_id,
    p_target_type    => case when p_task.subject_id is not null then p_task.subject_kind else null end,
    p_target_id      => p_task.subject_id::text,
    p_severity       => p_severity,
    p_payload        => jsonb_build_object(
                          'task_id',              p_task.id,
                          'task_type',            p_task.task_type,
                          'subject_kind',         p_task.subject_kind,
                          'subject_id',           p_task.subject_id,
                          'assigned_employee_id', p_task.assigned_employee_id,
                          'priority',             p_task.priority,
                          'origin',               p_task.origin
                        ) || coalesce(p_extra, '{}'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- 2. The emitting entry points — PR-A's bodies, now each emitting its transition.
--
-- create-or-replace KEEPS each function's identity (name + arg types) byte-for-byte,
-- so the EXECUTE grants from PR-A are preserved; §3 re-affirms them so this
-- migration's trust posture is self-contained. heartbeat and checkpoint are NOT
-- redefined — they emit nothing (liveness / internal resumption) and stay exactly as
-- PR-A shipped them.
-- ===========================================================================

-- 2.1 create — emits task.created on a genuine insert (never on a dedupe hit or a
--     lost dedupe race, where no new work was enqueued).
create or replace function public.hq_ai_task_create(
  p_task_type            text,
  p_payload              jsonb       default '{}'::jsonb,
  p_subject_kind         text        default 'none',
  p_subject_id           uuid        default null,
  p_priority             text        default 'normal',
  p_max_retries          integer     default 3,
  p_scheduled_at         timestamptz default null,
  p_dedupe_key           text        default null,
  p_assigned_employee_id uuid        default null,
  p_required_capability  text        default null,
  p_parent_task_id       uuid        default null,
  p_depends_on           uuid[]      default null,
  p_correlation_id       uuid        default null,
  p_origin               text        default 'manual',
  p_created_by           text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     public.hq_ai_tasks;
  v_created boolean := false;
begin
  if p_dedupe_key is not null then
    select * into v_row
    from public.hq_ai_tasks
    where dedupe_key = p_dedupe_key and status in ('pending','running')
    limit 1;
    if found then
      return jsonb_build_object('ok', true, 'task', to_jsonb(v_row), 'deduped', true);
    end if;
  end if;

  begin
    insert into public.hq_ai_tasks (
      task_type, payload, subject_kind, subject_id, priority, max_retries,
      scheduled_at, dedupe_key, assigned_employee_id, required_capability,
      parent_task_id, depends_on, correlation_id, origin, created_by, status
    ) values (
      p_task_type, coalesce(p_payload, '{}'::jsonb), coalesce(p_subject_kind, 'none'),
      p_subject_id, coalesce(p_priority, 'normal'), coalesce(p_max_retries, 3),
      p_scheduled_at, p_dedupe_key, p_assigned_employee_id, p_required_capability,
      p_parent_task_id, p_depends_on, coalesce(p_correlation_id, gen_random_uuid()),
      coalesce(p_origin, 'manual'), p_created_by, 'pending'
    )
    returning * into v_row;
    v_created := true;
  exception when unique_violation then
    -- A concurrent create won the dedupe race; return the live row it inserted.
    select * into v_row
    from public.hq_ai_tasks
    where dedupe_key = p_dedupe_key and status in ('pending','running')
    limit 1;
  end;

  if v_created then
    perform public.hq_ai_task_emit(
      v_row, 'task.created',
      case when v_row.assigned_employee_id is not null then 'ai_employee' else 'system' end,
      coalesce(v_row.assigned_employee_id::text, nullif(v_row.created_by, ''), 'system'),
      'info',
      jsonb_build_object('status', 'pending', 'created_by', v_row.created_by,
                         'scheduled_at', v_row.scheduled_at)
    );
  end if;

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 2.2 claim — emits task.claimed on a successful lease (never on an empty queue).
create or replace function public.hq_ai_task_claim(
  p_task_type    text,
  p_lease_owner  text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id  uuid;
  v_row public.hq_ai_tasks;
begin
  select id into v_id
  from public.hq_ai_tasks
  where task_type = p_task_type
    and status = 'pending'
    and (scheduled_at is null or scheduled_at <= now())
  order by priority_rank asc, scheduled_at asc nulls first, created_at asc
  for update skip locked
  limit 1;

  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  update public.hq_ai_tasks
  set status           = 'running',
      lease_owner      = p_lease_owner,
      lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds)),
      heartbeat_at     = now(),
      claimed_at       = now(),
      started_at       = coalesce(started_at, now())
  where id = v_id
  returning * into v_row;

  perform public.hq_ai_task_emit(
    v_row, 'task.claimed',
    case when v_row.assigned_employee_id is not null then 'ai_employee' else 'system' end,
    coalesce(v_row.assigned_employee_id::text, v_row.lease_owner, 'system'),
    'info',
    jsonb_build_object('status', 'running', 'lease_owner', v_row.lease_owner,
                       'lease_expires_at', v_row.lease_expires_at,
                       'retry_count', v_row.retry_count)
  );

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 2.3 complete — emits task.completed on a successful finish (lease-guarded; the
--     worker token is p_lease_owner, as v_row's lease is cleared by the update).
create or replace function public.hq_ai_task_complete(
  p_task_id     uuid,
  p_lease_owner text,
  p_result      jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.hq_ai_tasks;
begin
  update public.hq_ai_tasks
  set status           = 'completed',
      result           = coalesce(p_result, result),
      finished_at      = now(),
      lease_owner      = null,
      lease_expires_at = null
  where id = p_task_id and status = 'running' and lease_owner = p_lease_owner
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;

  perform public.hq_ai_task_emit(
    v_row, 'task.completed',
    case when v_row.assigned_employee_id is not null then 'ai_employee' else 'system' end,
    coalesce(v_row.assigned_employee_id::text, p_lease_owner, 'system'),
    'success',
    jsonb_build_object('status', 'completed', 'lease_owner', p_lease_owner,
                       'retry_count', v_row.retry_count)
  );

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 2.4 fail — emits task.retried on a retryable re-queue, or task.failed on terminal
--     failure. Worker-reported, so actor is the worker; reason=worker_error.
create or replace function public.hq_ai_task_fail(
  p_task_id     uuid,
  p_lease_owner text,
  p_error       text,
  p_retryable   boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     public.hq_ai_tasks;
  v_backoff integer;
  v_actor   text;
begin
  select * into v_row
  from public.hq_ai_tasks
  where id = p_task_id and status = 'running' and lease_owner = p_lease_owner
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;

  v_actor := coalesce(v_row.assigned_employee_id::text, p_lease_owner, 'system');

  if p_retryable and v_row.retry_count < v_row.max_retries then
    v_backoff := least(3600, (30 * power(2, v_row.retry_count))::integer);
    update public.hq_ai_tasks
    set status           = 'pending',
        retry_count      = retry_count + 1,
        error_message    = left(p_error, 4000),
        lease_owner      = null,
        lease_expires_at = null,
        heartbeat_at     = null,
        scheduled_at     = now() + make_interval(secs => v_backoff)
    where id = p_task_id
    returning * into v_row;

    perform public.hq_ai_task_emit(
      v_row, 'task.retried',
      case when v_row.assigned_employee_id is not null then 'ai_employee' else 'system' end,
      v_actor, 'warn',
      jsonb_build_object('status', 'pending', 'reason', 'worker_error',
                         'error', left(p_error, 500), 'retry_count', v_row.retry_count,
                         'next_run_at', v_row.scheduled_at)
    );
  else
    update public.hq_ai_tasks
    set status           = 'failed',
        error_message    = left(p_error, 4000),
        finished_at      = now(),
        lease_owner      = null,
        lease_expires_at = null
    where id = p_task_id
    returning * into v_row;

    perform public.hq_ai_task_emit(
      v_row, 'task.failed',
      case when v_row.assigned_employee_id is not null then 'ai_employee' else 'system' end,
      v_actor, 'warn',
      jsonb_build_object('status', 'failed', 'reason', 'worker_error',
                         'error', left(p_error, 500), 'retry_count', v_row.retry_count)
    );
  end if;

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 2.5 reap — recovers expired-lease tasks. Each is a SYSTEM action (the worker died);
--     emits task.retried (reason=lease_expired) if retries remain, else task.failed.
--     The reaper holds a PRE-update snapshot (v_row), so status/retry_count for the
--     event are passed explicitly in p_extra — never read off the stale row.
create or replace function public.hq_ai_task_reap(
  p_task_type text    default null,
  p_limit     integer default 50
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     public.hq_ai_tasks;
  v_count   integer := 0;
  v_backoff integer;
begin
  for v_row in
    select * from public.hq_ai_tasks
    where status = 'running'
      and lease_expires_at is not null
      and lease_expires_at < now()
      and (p_task_type is null or task_type = p_task_type)
    order by lease_expires_at asc
    for update skip locked
    limit greatest(1, p_limit)
  loop
    if v_row.retry_count < v_row.max_retries then
      v_backoff := least(3600, (30 * power(2, v_row.retry_count))::integer);
      update public.hq_ai_tasks
      set status           = 'pending',
          retry_count      = retry_count + 1,
          error_message    = 'lease expired (worker timed out)',
          lease_owner      = null,
          lease_expires_at = null,
          heartbeat_at     = null,
          scheduled_at     = now() + make_interval(secs => v_backoff)
      where id = v_row.id;

      perform public.hq_ai_task_emit(
        v_row, 'task.retried', 'system', 'system', 'warn',
        jsonb_build_object('status', 'pending', 'reason', 'lease_expired',
                           'dead_lease_owner', v_row.lease_owner,
                           'retry_count', v_row.retry_count + 1,
                           'next_run_at', now() + make_interval(secs => v_backoff))
      );
    else
      update public.hq_ai_tasks
      set status           = 'failed',
          error_message    = 'lease expired (max retries exhausted)',
          finished_at      = now(),
          lease_owner      = null,
          lease_expires_at = null
      where id = v_row.id;

      perform public.hq_ai_task_emit(
        v_row, 'task.failed', 'system', 'system', 'warn',
        jsonb_build_object('status', 'failed', 'reason', 'lease_expired',
                           'dead_lease_owner', v_row.lease_owner,
                           'retry_count', v_row.retry_count)
      );
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ===========================================================================
-- 3. Lock down EXECUTE — service-role only (P5). The helper is new; the five
--    entry points keep their PR-A grants across create-or-replace, re-affirmed here
--    so this migration's trust posture stands on its own.
-- ===========================================================================
revoke all on function public.hq_ai_task_emit(public.hq_ai_tasks, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.hq_ai_task_emit(public.hq_ai_tasks, text, text, text, text, jsonb) to service_role;

revoke all on function public.hq_ai_task_create(text, jsonb, text, uuid, text, integer, timestamptz, text, uuid, text, uuid, uuid[], uuid, text, text) from public, anon, authenticated;
grant execute on function public.hq_ai_task_create(text, jsonb, text, uuid, text, integer, timestamptz, text, uuid, text, uuid, uuid[], uuid, text, text) to service_role;

revoke all on function public.hq_ai_task_claim(text, text, integer) from public, anon, authenticated;
grant execute on function public.hq_ai_task_claim(text, text, integer) to service_role;

revoke all on function public.hq_ai_task_complete(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.hq_ai_task_complete(uuid, text, jsonb) to service_role;

revoke all on function public.hq_ai_task_fail(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.hq_ai_task_fail(uuid, text, text, boolean) to service_role;

revoke all on function public.hq_ai_task_reap(text, integer) from public, anon, authenticated;
grant execute on function public.hq_ai_task_reap(text, integer) to service_role;

-- Documentation only follows.
comment on function public.hq_ai_task_emit(public.hq_ai_tasks, text, text, text, text, jsonb) is
  'CrewFlow HQ Generic Task Engine (D-02, PR-B): the single task→Event Spine mapping. Emits one canonical event per WIRED transition, in-transaction, via hq_emit_event. Called only by the hq_ai_task_* entry points; service-role only.';
