# Task Engine — The Task Lifecycle

> **Status:** Engineering reference, **reconciled with the code**. Not an ADR (it
> records no decision — [ADR 0004](../decisions/0004-generic-task-engine.md) does
> that); not architecture-only (Volume XII
> [`volume-12-task-engine.md`](./volume-12-task-engine.md) does that). This file
> is the **canonical, readable description of how a task actually lives and dies**
> in the Generic Task Engine as shipped — so an engineer (or a future AI employee
> author) can understand the engine **without reading the SQL or the migration**.
>
> **Built shape, honestly marked.** Everything below describes the engine as it
> exists after **PR-A** (CEO Directive **#012 / D-02**;
> `supabase/migrations/20260802000000_hq_ai_tasks.sql`). Where a behaviour is a
> **reserved seam** — present in the schema but not yet wired, or arriving in a
> later PR (spine emission in PR-B, the SDK runner in PR-C, the Memory binding in
> PR-D) — it is labelled **‹reserved›** or **‹PR-B…›** inline. Nothing here is
> aspirational without that mark. When a later PR wires a seam, it updates this
> file in the same change (the Bible's *document-before-you-build*, run forward).
>
> Issued under D-02 as the engineering specification the CEO required before PR-B.

---

## 0. The engine in one screen

A **task** is the atom of AI work: *research this company, qualify this lead,
embed this memory, sweep these SLAs*. The Generic Task Engine is one durable,
crash-safe, audited queue (`hq_ai_tasks`) that **every** AI employee inherits and
runs work through — employee #42 exactly as employee #3.

You touch it through **seven SQL entry points** and nothing else. There is no
table access: the table is `RLS:hq` (RLS on, zero policies → only the Postgres
`service_role` can reach it), and each entry point is a `SECURITY DEFINER`
function whose `EXECUTE` is granted to `service_role` alone. An AI employee never
holds a database handle; it asks the SDK, the SDK calls one audited function, the
function enforces the rules inside the database. (This is substrate doctrine P5;
the SDK facet that will wrap these calls is PR-C.)

```
                         create()
                            │
                            ▼
   ┌──────────────────── (pending) ──────────────────┐
   │                        │                          │ cancel ‹guard-legal›
   │                    claim()  ── nothing ready ──▶ stays pending
   │                        ▼                          │
   │                    (running) ──────────────────── ┤
   │            heartbeat()/checkpoint() keep it here   │
   │       ┌────────────────┼───────────────┐          │
   │  complete()        fail(retryable)   fail(terminal)│
   │       │            or lease reaped    or retries   │
   │       ▼                │   expired     exhausted   ▼
   │  (completed)           ▼                │     (cancelled)
   │   ✦ terminal      back to (pending)      ▼
   │                    with backoff     (failed) ✦ terminal
   │                        │
   └────────────────────────┘  re-claimed when scheduled_at ≤ now
```

**Wired states (PR-A):** `pending` · `running` · `completed` ✦ · `failed` ✦ ·
`cancelled` ✦  (✦ = terminal, frozen forever).
**Reserved states (in the `status` enum, not yet wired):** `blocked` (DAG) ·
`claimed` (assignment hand-off) · `scheduled` (deferral is `scheduled_at` on a
`pending` row today) · `waiting_approval` (approval lifecycle) · `verifying`
(verification). They exist in the schema so the directives that wire them
*extend* the enum rather than re-migrate it — see §8.

---

## 1. The seven entry points at a glance

Every lifecycle below is some sequence of these. Each is `SECURITY DEFINER`,
`set search_path = ''`, `EXECUTE` revoked from `public`/`anon`/`authenticated`
and granted to `service_role` only.

| # | Function | What it does | Returns | Spine verb it will emit ‹PR-B› |
|---|----------|--------------|---------|-------------------------------|
| 1 | `hq_ai_task_create` | Enqueue a task (idempotent over a live `dedupe_key`). | `jsonb` `{ok, task, deduped?}` | `task.created` |
| 2 | `hq_ai_task_claim` | **Atomic dequeue** of the next ready task of a type; sets the lease. | `jsonb` `{ok, task}` or `{ok:false, reason:'empty'}` | `task.claimed` |
| 3 | `hq_ai_task_heartbeat` | Extend the lease (prove the worker is alive). | `boolean` (`false` = lease lost) | — (heartbeats are not events) |
| 4 | `hq_ai_task_checkpoint` | Persist partial `result` mid-run. | `boolean` (`false` = lease lost) | ‹reserved› `task.checkpointed` |
| 5 | `hq_ai_task_complete` | Finish successfully; clear the lease. | `jsonb` `{ok, task}` or `{ok:false, reason:'lease_lost'}` | `task.completed` |
| 6 | `hq_ai_task_fail` | Record a failure: retry-with-backoff or fail terminally. | `jsonb` `{ok, task}` or `{ok:false, reason:'lease_lost'}` | `task.retried` / `task.failed` |
| 7 | `hq_ai_task_reap` | Recover tasks whose lease expired (the worker died). | `integer` (count reaped) | `task.retried` / `task.failed` |

> **Why a `jsonb {ok,…}` envelope and not the row?** A function declared
> `returns hq_ai_tasks` serialises a *no-row* outcome as an object of all-null
> columns over PostgREST — a silent footgun. The worker RPCs therefore return an
> explicit envelope: `{ok:true, task:{…}}` on success, `{ok:false, reason:'…'}`
> on a benign miss (`'empty'` queue, `'lease_lost'`). The caller branches on
> `reason`, never on a null. (Same convention as the Shared Memory engine.)

> **`task.*` verbs are not registered yet.** `lib/events/registry.ts` has no
> `task.` namespace today — adding verbs is an edit to that file **plus an ADR**
> (the registry is the single source of event names). PR-B registers the set and
> emits each verb **in the same transaction as the status write** (the
> transactional-outbox rule, substrate P1). The verb names in the table above are
> the *intended* set PR-B will ratify; treat them as illustrative until PR-B lands.

---

## 2. The state machine, enforced in SQL (not trusted to callers)

Every transition below is allowed only if a **`BEFORE INSERT/UPDATE` guard
trigger** (`hq_ai_tasks_guard`) permits it. The guard matters because the service
runs as `service_role`, which **bypasses RLS** — a guarantee that lived only in
the entry-point functions could be sidestepped by a raw `UPDATE`. The guard makes
four things structurally impossible for *any* caller, including the admin client:

1. **Born pending.** An `INSERT` with any status other than `pending` is rejected
   (`check_violation`). A task always starts at `pending`; deferral is a future
   `scheduled_at`, not a different birth state.
2. **Terminal is immutable.** Any `UPDATE` of a row already `completed`/`failed`/
   `cancelled` is rejected (`restrict_violation`). The outcome is a permanent
   record.
3. **The definition is write-once.** `task_type`, `subject_kind`, `subject_id`,
   `payload`, `parent_task_id`, `depends_on`, `correlation_id`, `dedupe_key`,
   `origin`, `created_by`, `created_at` can never change after insert. Only a
   task's *progress* moves — never *what it is*.
4. **Legal transitions only.** A same-status update is allowed (that is a
   heartbeat or a checkpoint); otherwise the move must be one of:
   `pending → running | cancelled` or
   `running → completed | failed | pending | cancelled`.
   Anything else (e.g. `pending → completed`) is rejected (`check_violation`).

The guard also **auto-stamps** `updated_at` on every write and `finished_at` when
a row first becomes terminal — so timestamps are deterministic, not caller-trust.

The entry-point functions are written to produce only legal transitions; the
guard is the backstop that holds even if someone reaches for raw SQL.

---

## 3. Lifecycle 1 — Normal execution

The common path: a task is created, claimed, runs (heartbeating, optionally
checkpointing), and completes.

```
  (pending) ── claim() ──▶ (running) ── checkpoint()* ──▶ (running) ── complete() ──▶ (completed) ✦
                              ▲   │                                                        emits task.completed ‹PR-B›
                  heartbeat() └───┘  (lease kept alive throughout)
```

Step sequence: **[T0 create] → [T1 claim] → [T2 heartbeat]\* + [T3 checkpoint]\* →
[T4 complete]**. Each transition is detailed once in §7 (the transition
reference). In prose:

1. Some trigger enqueues the task (`create`, §7 T0) — it is born `pending`.
2. A runner of the matching `task_type` claims it (`claim`, §7 T1). The claim is
   the atomic dequeue; it stamps the lease and moves the row to `running`.
3. While running, the runner **heartbeats** on an interval to keep the lease
   (§7 T2), and may **checkpoint** partial output into `result` (§7 T3) so a
   later recovery resumes instead of restarting.
4. The runner finishes and calls **complete** (§7 T4): the row becomes
   `completed` ✦, the lease is cleared, the final `result` envelope is stored.

---

## 4. Lifecycle 2 — Retry execution

A task fails in a way that is worth retrying, waits out an exponential backoff,
and runs again.

```
  (pending) ─ claim() ─▶ (running) ─ fail(retryable=true, retries left) ─▶ (pending)
                                                                              │  scheduled_at = now()+backoff
                                                  re-claimable only once ◀────┘  (claim filters scheduled_at ≤ now)
                                                  scheduled_at ≤ now
        … claim() ─▶ (running) ─ complete() ─▶ (completed) ✦
```

Step sequence: **[T0 create] → [T1 claim] → [T5 fail-retryable] → (backoff window)
→ [T1 claim] → [T4 complete]**.

The key mechanic: a retryable failure does **not** spin. `fail` re-queues the
task to `pending`, increments `retry_count`, **and sets `scheduled_at =
now() + backoff`**. Because `claim` only considers rows whose `scheduled_at` is
null or already past, the task is invisible to claimers until the backoff
elapses. Backoff is `least(3600, 30 · 2^retry_count)` seconds — 30s, 60s, 120s,
… capped at one hour (see §7 T5). `started_at` is preserved across retries (it
marks the task's first start); `claimed_at` updates on each claim.

---

## 5. Lifecycle 3 — Lease expiry & crash recovery

The one genuinely new capability over the old sales queue: a worker that **dies**
mid-run does not strand its task. The lease, not a wall clock, decides liveness.

```
  (running, lease_expires_at = T) ── worker crashes, stops heartbeating ──▶ lease passes T
                                                                                   │
                                          reaper sweep: hq_ai_task_reap() ─────────┘
                                                  │ retries left?
                              ┌──── yes ──────────┴───────── no ─────┐
                              ▼                                      ▼
                        (pending) + backoff                    (failed) ✦
                        re-claimable later                     emits task.failed ‹PR-B›
```

Step sequence: **[T1 claim] → (worker dies) → [T7 reap] → (pending + backoff) →
[T1 claim] …** (or `[T8 reap-exhausted] → failed ✦` if no retries remain).

While a task runs, the worker **heartbeats** (§7 T2): each heartbeat pushes
`lease_expires_at` forward. A live worker on a long task keeps the lease
indefinitely; a **crashed** worker stops, and the lease lapses. A **reaper** — a
periodic sweep that will run as a scheduled task once the scheduler lands; today
`hq_ai_task_reap` is callable directly — finds `running` rows whose
`lease_expires_at < now()` and treats each as a retryable failure: re-queued with
backoff if retries remain (§7 T7), else failed terminally (§7 T8). This is the
**at-least-once** guarantee: no task is lost to a dead worker; it is reclaimed and
retried. Combined with idempotent steps and checkpointing (§6), re-running is
safe.

A worker that wakes up *after* being reaped discovers it on its next
`heartbeat`/`checkpoint`/`complete`/`fail` call: the lease guard
(`lease_owner = p_lease_owner`) no longer matches, so the call returns
`false` / `{ok:false, reason:'lease_lost'}`, and the stale worker aborts cleanly
instead of double-completing.

---

## 6. Lifecycle 4 — Terminal failure

A task that cannot succeed — an unrecoverable error, or retries exhausted — ends
`failed`, permanently.

```
  (running) ── fail(retryable=false) ───────────────▶ (failed) ✦
  (running) ── fail(retryable=true, retries exhausted) ▶ (failed) ✦
                                                          emits task.failed ‹PR-B›
```

Step sequence: **[T1 claim] → [T6 fail-terminal]** (directly, for a
non-retryable error), or the retry loop of §4 reaching its limit and the last
`fail`/`reap` taking the terminal branch.

Two ways in: the runner declares the failure **non-retryable** (`p_retryable =
false` — a malformed payload, a permanent rejection), or it is retryable but
`retry_count` has reached `max_retries` (default 3). Either way the row becomes
`failed` ✦ with the error recorded in `error_message`, the lease cleared, and
`finished_at` stamped. `failed` is terminal: the guard freezes the row. There is
no automatic resurrection — a failed task is a fact, surfaced for triage.

---

## 7-prelude: Lifecycle 5 — Cancellation

A task that is no longer wanted — superseded, withdrawn — moves to `cancelled`.

```
  (pending)  ──┐
  (running)  ──┼── cancel ──▶ (cancelled) ✦   ‹guard-legal in PR-A; no entry point yet›
  (scheduled)──┘                              (a deferred task is a pending row with a future scheduled_at)
```

**Honest status (PR-A):** the **guard permits** `pending → cancelled` and
`running → cancelled`, so the state machine is ready for cancellation — but PR-A
ships **no `hq_ai_task_cancel` entry point and no `task.cancelled` verb**.
Cancellation is therefore a *structurally-supported but not-yet-exposed*
operation: a later PR adds the sanctioned function (clear the lease, stamp
`finished_at`, emit `task.cancelled`) and, with the DAG seam, the rule that
cancelling a parent cancels its incomplete subtree (Volume XII §6). Until then,
no caller can legally cancel through the sanctioned API. (`scheduled` is itself a
reserved state; a deferred task today is a `pending` row carrying a future
`scheduled_at`.)

---

## 7. Transition reference — the seven fields, per transition

Each distinct transition, documented once with the fields the specification
requires: **Trigger · Preconditions · SQL entry point · State changes · Event
Spine behaviour · Memory implications · Future SDK interaction**. The lifecycles
in §§3–7-prelude are sequences of these.

> Across **all** transitions, two fields read the same today and are stated once
> here rather than repeated:
> - **Event Spine behaviour — PR-A emits nothing.** No entry point calls
>   `hq_emit_event` yet. Each row below names the verb **PR-B** will emit, in the
>   same transaction as the status write. Until PR-B, "spine behaviour" is
>   *silent*.
> - **Memory implications** depend on the SDK runner (PR-C) and the Memory⇄task
>   binding (PR-D, the `bound_task_id` FK from `hq_memories`). The notes below
>   describe the *intended* binding so the contract is clear; in PR-A the engine
>   touches no memory itself.

### T0 — create → `pending`  (a task is born)

- **Trigger:** any subsystem enqueuing work — a human action, an event consumer,
  a schedule tick, another task fanning out a child.
- **Preconditions:** none structural beyond a `task_type`. If a `dedupe_key` is
  supplied and a `pending`/`running` task already carries it, that live task is
  returned instead of inserting a duplicate (idempotent enqueue; a partial-unique
  index is the hard backstop under a concurrent race).
- **SQL entry point:** `hq_ai_task_create(p_task_type, p_payload, p_subject_kind,
  p_subject_id, p_priority, p_max_retries, p_scheduled_at, p_dedupe_key,
  p_assigned_employee_id, p_required_capability, p_parent_task_id, p_depends_on,
  p_correlation_id, p_origin, p_created_by)`.
- **State changes:** new row at `status = 'pending'`; `correlation_id` defaulted
  if not supplied (a fresh trace) or inherited (woven into a larger saga);
  `priority_rank` computed from `priority`. The guard stamps `updated_at`.
- **Event Spine behaviour:** ‹PR-B› `task.created`.
- **Memory implications:** none at creation. The `payload` is the input spec, not
  knowledge; nothing is recalled or asserted yet.
- **Future SDK interaction:** ‹PR-C› `ctx.tasks.create(spec)` — any employee or
  subsystem enqueues without touching SQL; the SDK stamps the ambient
  `correlation_id` automatically (substrate P2), so employees never set the trace
  by hand.

### T1 — `pending` → `running`  (atomic claim, lease acquired)

- **Trigger:** a runner polling for work of a given `task_type`.
- **Preconditions:** a `pending` task of that type exists whose `scheduled_at` is
  null or already past. Concurrent claimers are serialised by
  `FOR UPDATE SKIP LOCKED` — each takes a **distinct** row, none blocks.
- **SQL entry point:** `hq_ai_task_claim(p_task_type, p_lease_owner,
  p_lease_seconds = 300)`. Returns `{ok:false, reason:'empty'}` when nothing is
  ready.
- **State changes:** `status → 'running'`; `lease_owner = p_lease_owner` (an
  opaque worker token, **not** a user identity); `lease_expires_at = now() +
  p_lease_seconds`; `heartbeat_at = now()`; `claimed_at = now()`; `started_at =
  coalesce(started_at, now())` (preserved across re-claims). Note the wired path
  goes straight to `running`; the discrete `claimed` state is a reserved seam for
  a future assignment hand-off.
- **Event Spine behaviour:** ‹PR-B› `task.claimed`.
- **Memory implications:** ‹PR-C/PR-D› at claim the runner builds a `RunContext`
  bound to this task; working-memory the handler writes will auto-bind to it
  (`bound_task_id`), and memories it recalls accumulate as `evidence[]` for the
  output envelope — *with zero handler code* (the binding the Memory SDK facet
  already anticipates).
- **Future SDK interaction:** ‹PR-C› the `run()` loop performs the claim; the
  employee author never calls `claim` directly — they write only the `handler`,
  and the loop hands it the claimed task plus its `ctx`.

### T2 — `running` → `running`  (heartbeat — extend the lease)

- **Trigger:** the runner's heartbeat interval firing while a task is in flight.
- **Preconditions:** the row is still `running` **and** still owned by this worker
  (`lease_owner = p_lease_owner`). If the worker was already reaped or the task
  re-claimed, the guard fails the match.
- **SQL entry point:** `hq_ai_task_heartbeat(p_task_id, p_lease_owner,
  p_lease_seconds = 300)`. Returns `false` if the lease was lost.
- **State changes:** `heartbeat_at = now()`; `lease_expires_at` pushed forward.
  Status unchanged (a same-status update, which the guard explicitly allows).
- **Event Spine behaviour:** none — heartbeats are liveness, not facts worth an
  event (they would drown the spine). The lease *is* the record.
- **Memory implications:** none.
- **Future SDK interaction:** ‹PR-C› **automatic** — the `run()` loop heartbeats
  in the background on a timer; the handler never thinks about it. A `false`
  return aborts the handler (the lease is gone; keep no zombie running).

### T3 — `running` → `running`  (checkpoint — persist partial progress)

- **Trigger:** the runner finishing a sub-step whose output is worth not redoing.
- **Preconditions:** `running` and lease-owned (as T2).
- **SQL entry point:** `hq_ai_task_checkpoint(p_task_id, p_lease_owner,
  p_result)`. Returns `false` if the lease was lost.
- **State changes:** `result = p_result`. Status unchanged.
- **Event Spine behaviour:** ‹reserved› `task.checkpointed` is a candidate verb,
  but checkpoints may be intentionally *not* evented to avoid noise — PR-B decides.
- **Memory implications:** the checkpoint records *task* progress in `result`; it
  is distinct from memory writes. Side effects the handler already committed
  (e.g. a memory assertion keyed by dedupe) stay committed and are idempotent, so
  a post-recovery resume that repeats a step is a no-op.
- **Future SDK interaction:** ‹PR-C› `ctx.checkpoint(partialResult)` inside the
  handler.

### T4 — `running` → `completed` ✦  (success)

- **Trigger:** the handler returning successfully.
- **Preconditions:** `running` and lease-owned. If the lease was lost (reaped or
  re-claimed) the complete is refused — the stale worker must not finalise a task
  someone else now owns.
- **SQL entry point:** `hq_ai_task_complete(p_task_id, p_lease_owner, p_result)`.
  Returns `{ok:false, reason:'lease_lost'}` if the guard match fails.
- **State changes:** `status → 'completed'` ✦; `result = coalesce(p_result,
  result)` (a final envelope, or the last checkpoint); `finished_at = now()`;
  lease cleared. The guard then freezes the row forever.
- **Event Spine behaviour:** ‹PR-B› `task.completed` — and this is the verb that
  later **unblocks DAG dependents** (a `task.completed` consumer re-evaluates
  tasks whose `depends_on` includes this id; Volume XII §6). That consumer is a
  later PR; the verb is emitted from PR-B.
- **Memory implications:** ‹PR-C/PR-D› the `result` is the durable P3 output
  envelope; recalled `evidence[]` is drained into it by the RunContext. Knowledge
  the task asserted to Shared Memory is already persisted and now stands as the
  employee's durable memory, linked back to this task.
- **Future SDK interaction:** ‹PR-C› the handler simply **returns an
  `AIOutputEnvelope`**; the loop calls `complete` with it. The throw-based ABI
  means a *return* is success, a *throw* is failure (T5/T6).

### T5 — `running` → `pending`  (retryable failure → backoff)

- **Trigger:** the handler raising a **retryable** error (a transient fault — a
  timeout, a rate-limit, a flaky dependency).
- **Preconditions:** `running` and lease-owned; `p_retryable = true` **and**
  `retry_count < max_retries`.
- **SQL entry point:** `hq_ai_task_fail(p_task_id, p_lease_owner, p_error,
  p_retryable = true)`.
- **State changes:** `status → 'pending'`; `retry_count += 1`; `error_message =
  left(p_error, 4000)`; lease cleared (`lease_owner`, `lease_expires_at`,
  `heartbeat_at` nulled); **`scheduled_at = now() + backoff`** where `backoff =
  least(3600, 30 · 2^retry_count)` seconds (computed from `retry_count` *before*
  the increment: first retry waits 30s, then 60s, 120s, … capped at 1h). The task
  is now invisible to `claim` until the backoff elapses.
- **Event Spine behaviour:** ‹PR-B› `task.retried`.
- **Memory implications:** memory writes already committed are **not** rolled
  back — they are idempotent, and the retry resumes from the last checkpoint.
  (Multi-step tasks with external side effects that must be undone are the saga /
  compensation concern of Volume XII §10.3, a later directive.)
- **Future SDK interaction:** ‹PR-C› a thrown error the runner classifies as
  retryable maps to this call; the loop releases the worker to claim other work
  during the backoff.

### T6 — `running` → `failed` ✦  (terminal failure)

- **Trigger:** the handler raising a **non-retryable** error.
- **Preconditions:** `running` and lease-owned; `p_retryable = false` (or
  retryable with no retries left — see §6).
- **SQL entry point:** `hq_ai_task_fail(p_task_id, p_lease_owner, p_error,
  p_retryable = false)`.
- **State changes:** `status → 'failed'` ✦; `error_message` recorded;
  `finished_at = now()`; lease cleared. The guard freezes the row.
- **Event Spine behaviour:** ‹PR-B› `task.failed` (a `warn`/`critical` fact, to be
  decided in PR-B; escalation off failures is a later concern, Volume XII §8.4).
- **Memory implications:** as T5, committed memory is not auto-reverted; a failed
  task is surfaced for human triage.
- **Future SDK interaction:** ‹PR-C› a thrown error classified non-retryable maps
  here; the loop records the failure and moves on.

### T7 — `running` → `pending`  (lease reaped → backoff)

- **Trigger:** the reaper sweep finding this task's lease expired (its worker
  died or stalled past the lease).
- **Preconditions:** `status = 'running'` and `lease_expires_at < now()`;
  `retry_count < max_retries`. The reaper scans under `FOR UPDATE SKIP LOCKED`, so
  two overlapping reaper runs never double-process a row.
- **SQL entry point:** `hq_ai_task_reap(p_task_type = null, p_limit = 50)` —
  recovers up to `p_limit` expired tasks (optionally filtered by type) and returns
  the count.
- **State changes:** identical to T5 (re-queue with backoff, `retry_count += 1`,
  lease cleared) but driven by the engine, not the worker; `error_message =
  'lease expired (worker timed out)'`.
- **Event Spine behaviour:** ‹PR-B› `task.retried` (with a reap reason).
- **Memory implications:** as T5 — idempotent steps + checkpointing make the
  re-run safe.
- **Future SDK interaction:** ‹PR-C/scheduler› the reaper is a recurring task, not
  a handler concern. A worker that revives after being reaped learns its lease is
  gone via a `false`/`lease_lost` return on its next call and stops.

### T8 — `running` → `failed` ✦  (lease reaped, retries exhausted)

- **Trigger:** as T7, but `retry_count` has reached `max_retries`.
- **Preconditions:** `status = 'running'`, lease expired, no retries left.
- **SQL entry point:** `hq_ai_task_reap(...)` (the terminal branch of the same
  loop).
- **State changes:** `status → 'failed'` ✦; `error_message = 'lease expired (max
  retries exhausted)'`; `finished_at = now()`; lease cleared.
- **Event Spine behaviour:** ‹PR-B› `task.failed`.
- **Memory implications:** as T6.
- **Future SDK interaction:** as T7 — engine-driven, no handler.

### T9 — `pending` | `running` → `cancelled` ✦  (withdrawn)  ‹reserved entry point›

- **Trigger:** the work is superseded or withdrawn (by a human, a manager
  employee, or a parent cancelling its subtree).
- **Preconditions:** the row is non-terminal. The **guard already permits** this
  transition in PR-A.
- **SQL entry point:** **none in PR-A.** A sanctioned `hq_ai_task_cancel` (clear
  lease, stamp `finished_at`, emit `task.cancelled`) is a later PR. Until then no
  caller can legally cancel through the API.
- **State changes (when wired):** `status → 'cancelled'` ✦; lease cleared;
  `finished_at` stamped (the guard already auto-stamps `finished_at` on any
  terminal move).
- **Event Spine behaviour:** ‹later› `task.cancelled`.
- **Memory implications:** ‹later› with the DAG seam, cancelling a parent cancels
  its incomplete children; compensation for already-applied effects is the saga
  concern (Volume XII §10.3).
- **Future SDK interaction:** ‹later› an admin/Boardroom operation, not a runner
  handler.

---

## 8. What is reserved — the forward map

The engine is deliberately a **thin correct slice**. The following are present as
**inert seams** (columns/enum values that carry no behaviour yet) so the
directives that wire them *extend* this engine instead of forking it — the
"protected platform capability" rule ([ADR 0004](../decisions/0004-generic-task-engine.md);
[architecture freeze](../governance/architecture-freeze.md) contract #5): **no
employee may introduce a custom task runner, and no parallel queue is permitted.**

| Reserved | Carried as | Wired by |
|----------|-----------|----------|
| Spine emission + `task.*` verbs | (none yet — registry has no `task.` namespace) | **PR-B** |
| The SDK runner / `run()` loop / `RunContext` | `server/sdk/tasks.ts` (not yet written) | **PR-C** |
| Memory⇄task binding | `hq_memories.bound_task_id` (FK from Shared Memory) | **PR-D** |
| Migration of the two live sales workloads | `hq_sales_ai_tasks` still runs untouched | **PR-E / PR-F** |
| Dependencies / DAG | `parent_task_id`, `depends_on[]` columns; `blocked` state | later directive |
| Assignment hand-off | `assigned_employee_id`; `claimed` state | later directive |
| Deferral as a distinct state | `scheduled` state (today: `scheduled_at` on a `pending` row) | later directive |
| Approval checkpoints (the autonomy test, P4) | `approval_status`; `waiting_approval` state | later directive |
| Verification | `verification jsonb`; `verifying` state | later directive |
| Capability routing | `required_capability` (unenforced) | Capability Registry directive |
| Cost / budget | `cost_micros`, `cost_budget_micros` | later directive |
| Health / SLA | `deadline_at` | later directive |
| Recurring scheduler + reaper-as-task | (the reaper is callable directly today) | later directive |

Each wiring lands as its own PR with its own ADR and updates this file in the same
change, so this reference never drifts from the code.

---

## 9. Cross-cutting guarantees (the short version)

- **One queue, inherited identically.** There is exactly one work table; every
  employee claims, leases, retries, and recovers through the same seven functions.
  This *is* the §1.4 inheritance promise for work execution.
- **At-least-once, idempotent.** A crash never loses a task (the lease + reaper
  reclaim it). Re-running is safe because runners checkpoint and side effects are
  keyed for idempotency. The system never promises *exactly* once; it promises
  *at least* once plus idempotent steps, which is the achievable, honest contract.
- **The database is the boundary.** Atomicity (claim), legality (the guard), and
  durability (terminal immutability) are enforced in Postgres, not in TypeScript —
  so they hold against every caller, including the `service_role` admin client.
- **No silent nulls.** Worker RPCs return `{ok,…}` envelopes with an explicit
  `reason`, so "queue empty" and "lease lost" are branchable outcomes, not an
  ambiguous null.

---

## 10. Provenance & references

- **Decision:** [ADR 0004 — The Generic Task Engine](../decisions/0004-generic-task-engine.md).
- **Architecture:** [Volume XII — Task Engine](./volume-12-task-engine.md) (the
  full intended design, including the seams above).
- **Code (built shape):** `supabase/migrations/20260802000000_hq_ai_tasks.sql`
  (table, guard, seven entry points, grants).
- **Freeze status:** [architecture-freeze.md](../governance/architecture-freeze.md)
  contract #5 (Task Engine — *Partial*, protected capability).
- **Substrate primitives:** [substrate/README.md](./README.md) P1 (event
  envelope), P2 (correlation), P3 (output envelope), P4 (autonomy test), P5
  (service-role guardrail).
- **Tests that pin this behaviour:**
  `__tests__/integration/tasks/task-engine.test.ts` (real Postgres — claim
  atomicity, heartbeat, reaper, retry backoff, dedupe, guard invariants, RLS) and
  `__tests__/security/task-engine-invariants.test.ts` (hermetic — grants, definer,
  search_path, generic naming, PR-A boundary).

---

*Engineering reference under CEO Directive #012 / D-02. Reconciled with the code
at the PR-A commit. It records no decision and changes no schema; it makes the
built engine legible. Updated in lockstep as PR-B and later wire the reserved
seams.*
