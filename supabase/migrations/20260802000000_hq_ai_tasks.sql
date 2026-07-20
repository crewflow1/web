-- CrewFlow HQ — The Generic Task Engine, core (CEO Directive #012 / D-02, PR-A).
--
-- D-02 is the first step of the architectural spine the CEO ratified: a Generic
-- Task Engine that EVERY AI employee inherits, before the AI SDK / RunContext wraps
-- it. It is NOT an Outreach feature, a Sales feature, or a per-employee runner. It
-- is shared operating-system infrastructure: one durable, crash-safe, audited work
-- queue that employee #42 inherits exactly as employee #3 does.
--
-- ───────────────────────────────────────────────────────────────────────────
-- The reuse audit (Engineering Rule 1: reuse before build)
-- ───────────────────────────────────────────────────────────────────────────
-- The AI work queue ALREADY EXISTS in everything but its name. hq_sales_ai_tasks
-- (20260714000001) is described in its OWN header as "the AI Task Queue foundation",
-- and 20260716000000 calls it "the GENERIC AI work queue". Three workloads ride it
-- today — the sales pipeline, research_company, and lead-qualification — keyed only
-- by task_type. What it lacks is (a) an employee-agnostic identity (it is sales-
-- named, FK-bound to hq_sales_companies/contacts), and (b) crash recovery: today a
-- dead worker is detected by a blunt 5-minute wall clock in TypeScript
-- (STUCK_RUNNING_MS), and the claim is a TypeScript conditional UPDATE with a benign
-- read-then-write race.
--
-- So this migration GENERALISES the proven queue rather than inventing a new one:
--   • the columns, the priority_rank formula, the dedupe partial-unique index, and
--     the RLS:hq posture are carried over verbatim from hq_sales_ai_tasks;
--   • company_id/contact_id (sales-specific FKs) become a polymorphic
--     (subject_kind, subject_id) pair, so any employee addresses any subject;
--   • the one genuinely new capability — a lease + heartbeat + reaper — is added,
--     because that is the only thing Volume XII §3 marks "to build" that the two
--     live employees actually need.
--
-- The atomic-dequeue primitive is NOT invented here either: FOR UPDATE SKIP LOCKED
-- is already the proven concurrency control of the Event Spine drainer
-- (20260720020000) and the memory embedding workers (20260725000000). This engine
-- brings that same primitive to task claiming, where today there is only a
-- TypeScript conditional UPDATE.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why a FUNCTION-entry-point engine (not a trigger engine like Approvals)
-- ───────────────────────────────────────────────────────────────────────────
-- The Approval Engine (20260730000000) enforces its state machine with a BEFORE
-- trigger over plain UPDATEs, because every approval operation targets a KNOWN row.
-- The Task Engine cannot: its core operation is "pick WHICH runnable row to claim"
-- — an atomic dequeue (FOR UPDATE SKIP LOCKED) that no row-level trigger can express.
-- So the sanctioned API is a set of SECURITY DEFINER functions (Volume XII §11.1):
-- create / claim / heartbeat / checkpoint / complete / fail / reap. They are the one
-- way an employee touches the queue.
--
-- A BEFORE trigger still guards the state machine as DEFENCE IN DEPTH. The service
-- reaches this table through the service-role admin client, which BYPASSES RLS — so
-- a guarantee that lived only in the functions could be bypassed by a raw UPDATE
-- (exactly what the current sales runners do: `update({status:'running'})`). The
-- guard makes illegal transitions, terminal-row mutation, and rewriting what a task
-- IS structurally impossible regardless of caller — the same lesson the Approval
-- and Draft engines learned (gate in the path the admin client still travels).
--
-- ───────────────────────────────────────────────────────────────────────────
-- Scope of PR-A (thinnest correct slice)
-- ───────────────────────────────────────────────────────────────────────────
-- PR-A ships the TABLE, the GUARD, and the SEVEN ENTRY POINTS, with RLS:hq and
-- service-role-only EXECUTE. NOTHING routes to it yet (the two live runners still
-- use hq_sales_ai_tasks; they migrate in PR-E/PR-F). The canonical task.* Event
-- Spine verbs and the emitter are PR-B. The TypeScript runner abstraction is PR-C.
-- The bound_task_id FK from Shared Memory is PR-D.
--
-- Columns the later spine directives will need are placed now as INERT, nullable
-- SEAMS (DAG: parent_task_id/depends_on; Approval-lifecycle: approval_status;
-- Verification: verification; Capability Registry: required_capability; Cost/Budget:
-- cost_micros; Health/SLA: deadline_at). They are reserved so those directives
-- EXTEND this table rather than re-migrate it — they carry no behaviour in D-02.
--
-- It is RLS:hq (RLS enabled, ZERO policies → service-role only; every JWT client —
-- anon/authenticated — is denied). No tenant table is touched (provably additive).

-- ===========================================================================
-- 1. hq_ai_tasks — the generic, employee-agnostic AI work queue.
-- ===========================================================================
create table if not exists public.hq_ai_tasks (
  id                uuid        primary key default gen_random_uuid(),

  -- WHAT KIND of work. Free-form so a future employee brings a new task_type
  -- without a schema change (the same openness hq_sales_ai_tasks relied on for
  -- nullable company_id). The runner registry — not the DB — knows the handlers.
  task_type         text        not null,

  -- WHO it is assigned to (optional explicit assignment). SET NULL keeps a task's
  -- history if the employee row is removed. Capability-based routing is a SEAM.
  assigned_employee_id uuid     references public.ai_employees(id) on delete set null,
  required_capability  text,                       -- SEAM (Capability Registry); unenforced

  -- WHAT it is about — polymorphic, replacing sales' company_id/contact_id. No FK
  -- by design: the engine is generic over subject kinds it cannot enumerate. The
  -- lost referential integrity is the accepted cost of genericity (ADR-0004, R2).
  subject_kind      text        not null default 'none',
  subject_id        uuid,

  -- The deterministic lifecycle. WIRED in D-02: pending → running → completed |
  -- failed | cancelled (and running → pending on retry/reap). The remaining values
  -- are RESERVED SEAMS for later directives (blocked: DAG; claimed: assignment
  -- hand-off; waiting_approval: Approval-lifecycle; verifying: Verification) so the
  -- enum never needs a breaking re-migration. The guard wires only the D-02 moves.
  status            text        not null default 'pending'
                      check (status in (
                        'pending','running','completed','failed','cancelled',
                        'blocked','claimed','waiting_approval','verifying'
                      )),

  -- Priority + an index-ordered numeric rank (urgent first). Carried verbatim from
  -- hq_sales_ai_tasks so a migrated task dequeues in exactly the same order.
  priority          text        not null default 'normal'
                      check (priority in ('low','normal','high','urgent')),
  priority_rank     integer     generated always as (
                        case priority
                          when 'urgent' then 0
                          when 'high'   then 1
                          when 'normal' then 2
                          when 'low'    then 3
                          else 2
                        end
                      ) stored,

  -- Retry accounting (carried from sales). Backoff is computed by the fail/reap
  -- functions; the sales table had the columns but no backoff.
  retry_count       integer     not null default 0 check (retry_count >= 0),
  max_retries       integer     not null default 3 check (max_retries >= 0),

  -- The lease — the NET-NEW crash-recovery capability. A claim stamps lease_owner
  -- (an opaque worker token, NOT a user identity) and lease_expires_at; the worker
  -- extends it by heartbeat; the reaper recovers any running row whose lease has
  -- expired. This replaces the 5-minute wall clock with worker-declared liveness.
  lease_owner       text,
  lease_expires_at  timestamptz,
  heartbeat_at      timestamptz,

  -- DAG shape — SEAMS for a later directive. Write-once (a task's dependencies are
  -- part of what it IS). No behaviour in D-02.
  parent_task_id    uuid        references public.hq_ai_tasks(id) on delete set null,
  depends_on        uuid[],

  -- Lifecycle timing. scheduled_at defers a pending task (null = run asap); the
  -- claim filters on it. deadline_at is a SEAM (SLA/Health).
  scheduled_at      timestamptz,
  claimed_at        timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  deadline_at       timestamptz,                   -- SEAM (Health/SLA)

  -- Structured input / output. payload is write-once (what the worker was asked to
  -- do); result is the worker's output, updated by checkpoint/complete.
  payload           jsonb       not null default '{}'::jsonb,
  result            jsonb,
  verification      jsonb,                         -- SEAM (Verification)
  approval_status   text,                          -- SEAM (Approval-lifecycle)
  cost_micros       bigint,                        -- SEAM (Cost/Budget)
  cost_budget_micros bigint,                       -- SEAM (Cost/Budget)
  error_message     text        check (error_message is null or char_length(error_message) <= 4000),

  -- Provenance (P1/P2). correlation_id threads a task's whole lifecycle into one
  -- spine trace (PR-B reads it); a caller may supply it to weave the task into a
  -- larger intent, else a fresh trace begins. dedupe_key prevents double-queueing
  -- the same unit of work while it is still live (partial-unique index below).
  correlation_id    uuid        not null default gen_random_uuid(),
  dedupe_key        text        check (dedupe_key is null or char_length(dedupe_key) <= 200),
  origin            text        not null default 'manual',
  created_by        text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT
-- client is denied. The engine is HQ infrastructure; tenants never see it.
alter table public.hq_ai_tasks enable row level security;

-- The dequeue index: a single employee's pending work, highest priority, earliest
-- first — the exact shape hq_ai_task_claim() scans, now keyed by task_type so the
-- multi-employee queue dequeues per type.
create index if not exists hq_ai_tasks_queue_idx
  on public.hq_ai_tasks (task_type, status, priority_rank, scheduled_at nulls first, created_at);
-- The reaper scan: running rows ordered by lease expiry.
create index if not exists hq_ai_tasks_lease_idx
  on public.hq_ai_tasks (lease_expires_at)
  where status = 'running';
create index if not exists hq_ai_tasks_subject_idx
  on public.hq_ai_tasks (subject_kind, subject_id)
  where subject_id is not null;
create index if not exists hq_ai_tasks_assigned_idx
  on public.hq_ai_tasks (assigned_employee_id)
  where assigned_employee_id is not null;
create index if not exists hq_ai_tasks_parent_idx
  on public.hq_ai_tasks (parent_task_id)
  where parent_task_id is not null;
create index if not exists hq_ai_tasks_correlation_idx
  on public.hq_ai_tasks (correlation_id);
create index if not exists hq_ai_tasks_created_idx
  on public.hq_ai_tasks (created_at desc);
-- One LIVE task per dedupe_key — re-queueing after a task finishes is allowed.
create unique index if not exists hq_ai_tasks_dedupe_idx
  on public.hq_ai_tasks (dedupe_key)
  where dedupe_key is not null and status in ('pending','running');

-- ===========================================================================
-- 2. The transition guard — the deterministic state machine, enforced in SQL.
--
-- A BEFORE INSERT/UPDATE trigger that NO caller (not even the service-role admin
-- client) can bypass. It makes illegal transitions, mutation of a terminal row,
-- and rewriting what a task IS structurally impossible — and auto-stamps updated_at
-- and finished_at so they are reliable regardless of what a caller passes. The
-- entry-point functions below produce only legal transitions; this guard is the
-- backstop that holds even against a raw UPDATE.
--
-- The deterministic state machine (WIRED transitions):
--   born        : (insert)                         → pending
--   claim       : pending                          → running
--   checkpoint  : running                          → running   (result updated)
--   heartbeat   : running                          → running   (lease extended)
--   complete    : running                          → completed (terminal)
--   fail        : running                          → failed     (terminal)
--   retry/reap  : running                          → pending    (re-queued)
--   cancel      : pending | running                → cancelled  (terminal)
-- Terminal (completed/failed/cancelled) rows are frozen forever.
-- ===========================================================================
create or replace function public.hq_ai_tasks_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- A task is always BORN pending. Deferral is scheduled_at, not a birth state.
    if new.status <> 'pending' then
      raise exception 'hq_ai_tasks: a new task must start in status pending, got %', new.status
        using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- tg_op = 'UPDATE' from here.

  -- (a) Terminal states are immutable — the permanent record of the outcome.
  if old.status in ('completed','failed','cancelled') then
    raise exception 'hq_ai_tasks %: status % is terminal and immutable', old.id, old.status
      using errcode = 'restrict_violation';
  end if;

  -- (b) What a task IS is write-once. Only its progress may change, never its
  --     identity, input, subject, DAG shape, or trace.
  if new.task_type      is distinct from old.task_type
     or new.subject_kind is distinct from old.subject_kind
     or new.subject_id   is distinct from old.subject_id
     or new.payload      is distinct from old.payload
     or new.parent_task_id is distinct from old.parent_task_id
     or new.depends_on   is distinct from old.depends_on
     or new.correlation_id is distinct from old.correlation_id
     or new.dedupe_key   is distinct from old.dedupe_key
     or new.origin       is distinct from old.origin
     or new.created_by   is distinct from old.created_by
     or new.created_at   is distinct from old.created_at then
    raise exception 'hq_ai_tasks %: the task definition fields are write-once', old.id
      using errcode = 'restrict_violation';
  end if;

  -- (c) Legal transitions only. old.status is active here (pending|running). A
  --     same-status update (checkpoint/heartbeat) is allowed; everything else is a
  --     named, enumerated move.
  if not (
       (old.status = new.status)
    or (old.status = 'pending' and new.status in ('running','cancelled'))
    or (old.status = 'running' and new.status in ('completed','failed','pending','cancelled'))
  ) then
    raise exception 'hq_ai_tasks %: illegal transition % -> %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- (d) Auto-stamp so timestamps are deterministic, not caller-trust.
  new.updated_at := now();
  if new.status in ('completed','failed','cancelled') and new.finished_at is null then
    new.finished_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists hq_ai_tasks_guard_ins on public.hq_ai_tasks;
create trigger hq_ai_tasks_guard_ins
  before insert on public.hq_ai_tasks
  for each row execute function public.hq_ai_tasks_guard();

drop trigger if exists hq_ai_tasks_guard_upd on public.hq_ai_tasks;
create trigger hq_ai_tasks_guard_upd
  before update on public.hq_ai_tasks
  for each row execute function public.hq_ai_tasks_guard();

-- ===========================================================================
-- 3. The entry points — the sanctioned API (Volume XII §11.1).
--
-- Each is SECURITY DEFINER with a pinned empty search_path and fully schema-
-- qualified, so it is the ONE way an employee touches the queue and cannot be
-- reached by any JWT role. EXECUTE is revoked from public/anon/authenticated and
-- granted only to service_role. None emits a spine event yet — that is PR-B.
-- ===========================================================================

-- 3.1 create — enqueue a task. Idempotent over a live dedupe_key: if a pending or
--     running task with the same key exists, it is returned rather than duplicated
--     (the partial-unique index is the hard backstop under concurrency). Returns a
--     jsonb envelope {ok:true, task:{…}} — the house style of the reference engine
--     (Shared Memory's claim/complete/fail), so a "no row" outcome is never a
--     composite of all-null columns over PostgREST.
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
  v_row public.hq_ai_tasks;
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
  exception when unique_violation then
    -- A concurrent create won the dedupe race; return the live row it inserted.
    select * into v_row
    from public.hq_ai_tasks
    where dedupe_key = p_dedupe_key and status in ('pending','running')
    limit 1;
  end;

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 3.2 claim — the atomic dequeue. FOR UPDATE SKIP LOCKED guarantees concurrent
--     workers each take a DISTINCT runnable row (the race the TypeScript
--     conditional UPDATE left open). Sets the lease. Returns {ok:true, task:{…}}
--     on a claim, or {ok:false, reason:'empty'} when the queue is empty — an
--     explicit "nothing to do" the worker can branch on.
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

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 3.3 heartbeat — extend the lease. Returns false if the lease was lost (reaped or
--     re-claimed), which tells the worker to abort cleanly.
create or replace function public.hq_ai_task_heartbeat(
  p_task_id       uuid,
  p_lease_owner   text,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.hq_ai_tasks
  set heartbeat_at     = now(),
      lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds))
  where id = p_task_id and status = 'running' and lease_owner = p_lease_owner;
  return found;
end;
$$;

-- 3.4 checkpoint — persist a partial result mid-run (so a re-run resumes from the
--     last good state). Lease-guarded. Returns false if the lease was lost.
create or replace function public.hq_ai_task_checkpoint(
  p_task_id     uuid,
  p_lease_owner text,
  p_result      jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.hq_ai_tasks
  set result = p_result
  where id = p_task_id and status = 'running' and lease_owner = p_lease_owner;
  return found;
end;
$$;

-- 3.5 complete — finish successfully. Lease-guarded; clears the lease. Returns
--     {ok:true, task:{…}}, or {ok:false, reason:'lease_lost'} if the lease was lost
--     or the task is already terminal (the worker should stop, not retry).
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
  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 3.6 fail — record a failure. If retryable AND retries remain, re-queue to pending
--     with exponential backoff (30s · 2^retry_count, capped at 1h); else mark
--     failed (terminal). Lease-guarded. Returns {ok:true, task:{…}} with the new
--     state, or {ok:false, reason:'lease_lost'} if the lease was lost.
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
begin
  select * into v_row
  from public.hq_ai_tasks
  where id = p_task_id and status = 'running' and lease_owner = p_lease_owner
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;

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
  else
    update public.hq_ai_tasks
    set status           = 'failed',
        error_message    = left(p_error, 4000),
        finished_at      = now(),
        lease_owner      = null,
        lease_expires_at = null
    where id = p_task_id
    returning * into v_row;
  end if;

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

-- 3.7 reap — recover tasks whose lease has expired (the worker died or stalled).
--     Each is treated as a retryable failure: re-queued with backoff if retries
--     remain, else failed. Returns the number of tasks reaped. FOR UPDATE SKIP
--     LOCKED so an overlapping reaper run never double-processes a row.
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
    else
      update public.hq_ai_tasks
      set status           = 'failed',
          error_message    = 'lease expired (max retries exhausted)',
          finished_at      = now(),
          lease_owner      = null,
          lease_expires_at = null
      where id = v_row.id;
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ===========================================================================
-- 4. Lock down EXECUTE — service-role only, on every entry point (P5).
-- ===========================================================================
revoke all on function public.hq_ai_task_create(text, jsonb, text, uuid, text, integer, timestamptz, text, uuid, text, uuid, uuid[], uuid, text, text) from public, anon, authenticated;
grant execute on function public.hq_ai_task_create(text, jsonb, text, uuid, text, integer, timestamptz, text, uuid, text, uuid, uuid[], uuid, text, text) to service_role;

revoke all on function public.hq_ai_task_claim(text, text, integer) from public, anon, authenticated;
grant execute on function public.hq_ai_task_claim(text, text, integer) to service_role;

revoke all on function public.hq_ai_task_heartbeat(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.hq_ai_task_heartbeat(uuid, text, integer) to service_role;

revoke all on function public.hq_ai_task_checkpoint(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.hq_ai_task_checkpoint(uuid, text, jsonb) to service_role;

revoke all on function public.hq_ai_task_complete(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.hq_ai_task_complete(uuid, text, jsonb) to service_role;

revoke all on function public.hq_ai_task_fail(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.hq_ai_task_fail(uuid, text, text, boolean) to service_role;

revoke all on function public.hq_ai_task_reap(text, integer) from public, anon, authenticated;
grant execute on function public.hq_ai_task_reap(text, integer) to service_role;

-- Documentation only follows: nothing below this line changes schema or behaviour.
comment on table public.hq_ai_tasks is
  'CrewFlow HQ Generic Task Engine (D-02): employee-agnostic, crash-safe AI work queue. RLS:hq, service-role only. Lifecycle is driven exclusively through the hq_ai_task_* SECURITY DEFINER entry points.';
