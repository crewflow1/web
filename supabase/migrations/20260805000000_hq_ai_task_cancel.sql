-- CrewFlow HQ — The Generic Task Engine, cancellation (CEO Directive #013 / D-03).
--
-- D-03 graduates the RunContext Runtime Contract (Architecture-Freeze contract #4)
-- from Partial to Established. RunContext is the per-invocation envelope the runner
-- assembles and hands a handler as its sole argument; ADR 0007 settles its shape.
-- One field it must expose is a read-only AbortSignal (`ctx.signal`) so a handler can
-- cooperate with cancellation it does NOT own. This migration supplies the single
-- substrate primitive that signal needs: a durable, audited way to cancel a task.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Binding a reserved seam, not building a new one (ADR 0007, Decision 10)
-- ───────────────────────────────────────────────────────────────────────────
-- The Task Engine was BORN cancellation-ready and left it inert. PR-A (20260802…)
-- already:
--   • put 'cancelled' in the status CHECK (a reserved enum value, never reached);
--   • wired pending→cancelled and running→cancelled into the BEFORE guard's legal-
--     transition set, and froze 'cancelled' as a terminal, immutable state;
--   • auto-stamps finished_at for a row entering 'cancelled'.
-- PR-B (20260803…) reserved the verb in words — its header records cancel as
-- "(no entry point in PR-A; task.cancelled is registered when a cancel function
-- lands, never as dead vocabulary)". This migration is that landing. The net schema
-- delta is therefore ONE function — zero new columns, zero enum changes, zero guard
-- edits. The state machine the guard already enforces is merely given its eighth,
-- final entry point. This is the "binding, not building" thesis of D-03 made
-- concrete: #012 reserved the seam; #013 binds it.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why cancel is NOT lease-guarded (unlike heartbeat/checkpoint/complete/fail)
-- ───────────────────────────────────────────────────────────────────────────
-- complete/fail/checkpoint/heartbeat are worker-authored: the worker holds the lease
-- and proves it (lease_owner = p_lease_owner). Cancel is the opposite — it is an
-- action taken ON a task from OUTSIDE its worker: by an operator, a parent task, or
-- the OS supervising a budget/deadline. A pending task has no lease owner at all, and
-- an operator cancelling a running task cannot (and must not need to) know the
-- worker's opaque lease token. So cancel targets the task by id + cancellable status,
-- never by lease. It is the only entry point that legitimately reaches a row the
-- caller does not hold the lease on, which is exactly why it carries an explicit
-- actor (p_actor_type / p_actor_id) for the audit instead of inferring one from a
-- lease the caller doesn't have.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Cooperative cancellation — this function does the DURABLE half; the SDK runner
-- does the in-process half, with NO extra database round-trip
-- ───────────────────────────────────────────────────────────────────────────
-- Cancellation is cooperative, not preemptive. This function performs the durable,
-- audited state change: pending|running → cancelled, clearing the lease. It does NOT
-- reach into the running worker — nothing in Postgres can. The in-process half lives
-- in the SDK runner (server/sdk/tasks.ts) and reuses the seam ALREADY present:
-- clearing lease_owner here means the worker's very next hq_ai_task_heartbeat — whose
-- WHERE clause requires status='running' AND lease_owner=<token> — matches zero rows
-- and returns false. The runner already heartbeats on a timer; on the first false it
-- aborts the handler's AbortController, which is what ctx.signal exposes. So a handler
-- that awaits ctx.signal observes cancellation within one heartbeat interval, and the
-- lease+reaper remains the backstop for a handler that ignores it (no regression).
-- No new polling query is added; cancellation rides the liveness check that exists.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Idempotency & safety
-- ───────────────────────────────────────────────────────────────────────────
-- The cancellable set is exactly {pending, running}. An already-terminal task
-- (completed/failed/cancelled) does not match the WHERE, so the function returns
-- {ok:false, reason:'not_cancellable'} WITHOUT attempting an UPDATE — it never trips
-- the guard's terminal-immutability exception, so a double-cancel is a quiet no-op,
-- not an error. SECURITY DEFINER + pinned empty search_path + service-role-only
-- EXECUTE, identical to every other entry point.
--
-- It is RLS:hq infrastructure: no tenant table is touched (provably additive). The
-- verb namespace stays the registry's — emitting 'task.cancelled' is valid ONLY
-- because D-03's companion edit registers it in lib/events/registry.ts; the spine
-- security test pins that this migration emits only verbs the registry declares.

-- ===========================================================================
-- hq_ai_task_cancel — the EIGHTH and final entry point (Volume XII §11.1).
--
--   cancel : pending | running → cancelled (terminal)   actor: caller-declared
--
-- Mirrors the fail/complete house style (jsonb envelope; select-for-update so the
-- pre-cancel status is captured for the audit; lease cleared on the way out). Emits
-- exactly one task.cancelled via the shared hq_ai_task_emit mapping primitive.
-- ===========================================================================
create or replace function public.hq_ai_task_cancel(
  p_task_id    uuid,
  p_reason     text default null,
  p_actor_type text default 'system',
  p_actor_id   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.hq_ai_tasks;
  v_prev text;
begin
  -- Lock the row and decide cancellability in one read. Only live work is
  -- cancellable; a terminal row simply isn't found (idempotent no-op below).
  select * into v_row
  from public.hq_ai_tasks
  where id = p_task_id and status in ('pending','running')
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_cancellable');
  end if;

  v_prev := v_row.status;

  -- Durable transition to the terminal 'cancelled' state. Clearing the lease is what
  -- makes the running worker's next heartbeat return false (the cooperative-cancel
  -- seam). finished_at is set explicitly to match complete/fail; the guard would
  -- also stamp it, but the house style is to be explicit at the call site.
  update public.hq_ai_tasks
  set status           = 'cancelled',
      error_message    = coalesce(left(p_reason, 4000), error_message),
      finished_at      = now(),
      lease_owner      = null,
      lease_expires_at = null
  where id = p_task_id
  returning * into v_row;

  -- One canonical audit event. Actor is caller-declared (an operator/parent/OS acting
  -- on the task from outside its worker), defaulting to 'system'. prev_status records
  -- whether a queued or an in-flight task was cancelled — the one fact lost once the
  -- row is terminal.
  perform public.hq_ai_task_emit(
    v_row, 'task.cancelled',
    coalesce(nullif(p_actor_type, ''), 'system'),
    p_actor_id, 'warn',
    jsonb_build_object('status', 'cancelled',
                       'reason', coalesce(p_reason, 'cancelled'),
                       'prev_status', v_prev,
                       'retry_count', v_row.retry_count)
  );

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- ===========================================================================
-- Lock down EXECUTE — service-role only (P5), like every entry point.
-- ===========================================================================
revoke all on function public.hq_ai_task_cancel(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.hq_ai_task_cancel(uuid, text, text, text) to service_role;

-- Documentation only follows.
comment on function public.hq_ai_task_cancel(uuid, text, text, text) is
  'CrewFlow HQ Generic Task Engine (D-03): the cancel entry point. pending|running -> cancelled (terminal), clearing the lease so the worker''s next heartbeat returns false (cooperative cancellation). Not lease-guarded — cancel acts on a task from outside its worker. Idempotent (already-terminal -> not_cancellable). Emits one task.cancelled; service-role only.';
