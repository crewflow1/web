# Task Engine — Event Contract

> **Status: live and enforced.** This is the canonical engineering reference for
> every event the Generic Task Engine emits onto the Event Spine. It is *not* an
> ADR and *not* implementation — it is the **contract** a consumer codes against,
> reconciled byte-for-byte with the emitter migration
> `supabase/migrations/20260803000000_hq_ai_tasks_spine.sql` (CEO Directive #012 /
> D-02, PR-B) and the registry `lib/events/registry.ts`.
>
> Read alongside: the lifecycle spec (`./task-engine-lifecycle.md`, the state
> machine these events project), the versioning rule (`./event-versioning.md`, why
> every event has a version), the Event Bus (`./volume-11-event-bus.md`, the spine
> these events ride), and **ADR-0005** (`../decisions/0005-task-engine-spine-emission.md`,
> *why* the Task Engine emits from its functions, not a trigger).

---

## 0. Scope — five events, one engine

The Task Engine emits **exactly five** registered verbs, one per *wired* lifecycle
transition. All are **schema version 1**.

| Event | Severity | Producer(s) | Actor | Distinguisher |
|-------|----------|-------------|-------|---------------|
| `task.created` | `info` | `hq_ai_task_create` | creator (employee \| system) | — |
| `task.claimed` | `info` | `hq_ai_task_claim` | worker (employee \| lease owner) | — |
| `task.completed` | `success` | `hq_ai_task_complete` | worker (employee \| lease owner) | — |
| `task.retried` | `warn` | `hq_ai_task_fail` **or** `hq_ai_task_reap` | worker **or** system | `payload.reason` + actor |
| `task.failed` | `warn` | `hq_ai_task_fail` **or** `hq_ai_task_reap` | worker **or** system | `payload.reason` + actor |

`task.retried` and `task.failed` each cover **two** transitions told apart by
**actor + `payload.reason`** (`worker_error` vs `lease_expired`) — the precision the
function-level emission choice buys that an `AFTER` trigger could not recover
(ADR-0005). Deliberately **absent** (registered only when a real transition lands,
never as dead vocabulary): `task.heartbeated`, `task.checkpointed`, `task.cancelled`
— see §4.

---

## 1. The common envelope (holds for all five)

Every task event is assembled in **one place** — the helper
`hq_ai_task_emit(...)` — so the envelope below is identical across all five verbs;
only `severity`, `actor`, and the payload **delta** (§3) differ per event.

| Envelope field | Value for every task event |
|----------------|----------------------------|
| `object_type` / `object_id` | `'ai_task'` / the task's `id` (uuid as text) |
| `target_type` / `target_id` | the task's `(subject_kind, subject_id)` when `subject_id is not null`, else `null` — the polymorphic business subject the work is about |
| `correlation_id` | the task's `correlation_id` (see §2) |
| `causation_id` | **not set by PR-B** (`null`) — see §2 and §4 |
| `visibility` | `hq` (the spine default) |
| `actor_type` | `ai_employee` if the task has an `assigned_employee_id`, else `system` — except the **reaper**, always `system` (§3) |

**Base payload — present on every task event** (the write-once identity the helper
reads off the row), then merged with each event's delta (§3):

```jsonc
{
  "task_id":              "uuid",        // = object_id
  "task_type":            "string",      // the queue/type this task runs on
  "subject_kind":         "string",      // 'none' when unset
  "subject_id":           "uuid | null", // the business subject (= target_id)
  "assigned_employee_id": "uuid | null", // set ⇒ actor_type ai_employee
  "priority":             "string",      // 'low' | 'normal' | 'high' | …
  "origin":               "string"       // 'manual' | 'cron' | … — how it was enqueued
}
```

> **Payloads are small, non-PII identifiers + state** (Engineering Bible Ch.04).
> The task's `payload`/`result` prose **never** rides the event — it stays in the
> RLS:hq `hq_ai_tasks` row. The event carries enough to *find* and *order* the
> work, not to *reconstruct* it.

---

## 2. Correlation, ordering & delivery (common to all five)

These properties are **structural** — they come from the spine (Volume XI §8, §10)
and the transactional-outbox emission, and are therefore identical for every task
event. Each per-event section (§3) restates them by reference.

- **Correlation behaviour.** `correlation_id` is the task's own, set at creation
  (`hq_ai_task_create` mints one with `gen_random_uuid()` if the caller supplies
  none) and **propagated unchanged** onto every subsequent event for that task. The
  entire lifecycle of one task is therefore a single saga trace:
  `WHERE correlation_id = <task> ORDER BY id`. `causation_id` (the parent-event id,
  the causal DAG of P2) is **not threaded by PR-B** — a documented forward
  enhancement (§4); correlation alone threads the saga today.

- **Ordering guarantees.** `hq_events.id` (a globally monotonic bigint) is the
  **total order** — consumers order by `id`, **never** by `ts` (§P1). Per task, the
  events appear in causal order:
  `created → claimed → (retried → claimed)* → (completed | failed)`. The spine
  promises this per-`correlation_id`/per-`object_id` ordering; it does **not** promise
  cross-task global processing parallelism beyond the id order (Volume XI §10).

- **Delivery guarantees.** Emission is a **transactional outbox**: each event is
  written in the **same database transaction** as the state change it records (§P1).
  The event and the transition therefore commit together or not at all — there is no
  committed transition without its event, and no event for a transition that rolled
  back. Delivery *to consumers* is the spine's **at-least-once + idempotent apply =
  effectively-once** (Volume XI §8, P8); a poison event is dead-lettered after
  `max_attempts` without blocking the stream (Volume XI §9). Exactly one event row is
  emitted per committed transition.

---

## 3. The five events

Each event below lists the full contract. Fields marked *(common)* take the value
defined in §1–§2 identically; the **payload delta** is what this event adds on top
of the §1 base payload.

### 3.1 `task.created`

- **Version:** 1
- **Severity:** `info`
- **Producer:** `hq_ai_task_create` — emitted **only on a genuine insert**. A dedupe
  hit (an existing `pending`/`running` task with the same `dedupe_key`) and a lost
  unique-violation race both return the live row and emit **nothing**: no new work was
  enqueued, so no fact occurred.
- **Actor:** `actor_type` = `ai_employee` if `assigned_employee_id` is set, else
  `system`; `actor_id` = `coalesce(assigned_employee_id, created_by, 'system')`.
- **Payload delta:**
  ```jsonc
  { "status": "pending", "created_by": "string | null", "scheduled_at": "timestamptz | null" }
  ```
- **Consumers:** the `timeline` projection (The Pulse), where it surfaces under the
  **AI** filter chip (`lib/events/categories.ts` maps the `task` namespace to AI);
  any future consumer that subscribes to `task.*` (data-driven, Volume XI §6.2).
- **Correlation / Ordering / Delivery:** common (§2). This is the **first** event of
  the task's saga — it mints the trace if the caller supplied no `correlation_id`.

### 3.2 `task.claimed`

- **Version:** 1
- **Severity:** `info`
- **Producer:** `hq_ai_task_claim` — emitted on a **successful lease** only; an empty
  queue returns `{ ok: false, reason: 'empty' }` and emits nothing.
- **Actor:** `actor_type` = `ai_employee` if assigned, else `system`; `actor_id` =
  `coalesce(assigned_employee_id, lease_owner, 'system')`.
- **Payload delta:**
  ```jsonc
  {
    "status": "running",
    "lease_owner": "string",          // the worker token that won the lease
    "lease_expires_at": "timestamptz",// when the lease lapses (→ reaper territory)
    "retry_count": 0                   // attempts so far (0 on a first claim)
  }
  ```
- **Consumers / Correlation / Ordering / Delivery:** common (§1–§2).

### 3.3 `task.completed`

- **Version:** 1
- **Severity:** `success`
- **Producer:** `hq_ai_task_complete` — lease-guarded (`status = 'running' and
  lease_owner = <caller>`); a lost lease returns `{ ok: false, reason: 'lease_lost' }`
  and emits nothing.
- **Actor:** `actor_type` = `ai_employee` if assigned, else `system`; `actor_id` =
  `coalesce(assigned_employee_id, <lease_owner arg>, 'system')` (the row's lease is
  cleared by the same update, so the worker token is taken from the call argument).
- **Payload delta:**
  ```jsonc
  { "status": "completed", "lease_owner": "string", "retry_count": 0 }
  ```
- **Consumers / Correlation / Ordering / Delivery:** common (§1–§2). The terminal
  success event of the saga.

### 3.4 `task.retried`

One verb, **two transitions**, told apart by **actor + `payload.reason`**.

- **Version:** 1
- **Severity:** `warn`
- **Producers & the two paths:**

  **(A) Worker-reported retryable failure — `hq_ai_task_fail`** (when `p_retryable`
  and `retry_count < max_retries`). The task is re-queued with exponential backoff.
  - **Actor:** `ai_employee` if assigned, else `system`; `actor_id` =
    `coalesce(assigned_employee_id, <lease_owner arg>, 'system')`.
  - **Payload delta:**
    ```jsonc
    {
      "status": "pending",
      "reason": "worker_error",
      "error": "string",        // left(p_error, 500) — truncated, non-PII diagnostic
      "retry_count": 1,         // post-increment (attempts now consumed)
      "next_run_at": "timestamptz" // when it becomes claimable again
    }
    ```

  **(B) Reaper lease recovery — `hq_ai_task_reap`** (an expired lease, `retry_count <
  max_retries`). The worker is presumed dead; the **system** recovers the task.
  - **Actor:** `actor_type` = `system`, `actor_id` = `system`.
  - **Payload delta:**
    ```jsonc
    {
      "status": "pending",
      "reason": "lease_expired",
      "dead_lease_owner": "string | null", // the worker token whose lease lapsed
      "retry_count": 1,          // computed explicitly (reaper holds a PRE-update snapshot)
      "next_run_at": "timestamptz"
    }
    ```
- **Distinguisher:** `reason = 'worker_error'` with a worker/employee actor (A) vs
  `reason = 'lease_expired'` with the `system` actor (B). A consumer that needs only
  "was this re-queued?" can ignore the branch; one that attributes blame reads both.
- **Consumers / Correlation / Ordering / Delivery:** common (§1–§2). A task may emit
  several `task.retried` events across its life, each followed by a fresh
  `task.claimed`.

### 3.5 `task.failed`

One verb, **two transitions**, told apart by **actor + `payload.reason`**.

- **Version:** 1
- **Severity:** `warn` — a single task reaching terminal failure is an *operational
  fact*, not a platform incident; aggregate failure pressure escalates via the golden
  signals and DLQ alarms (Volume XI §9, §14), not a `critical` per event.
- **Producers & the two paths:**

  **(A) Worker-reported terminal failure — `hq_ai_task_fail`** (when not retryable, or
  retries are exhausted).
  - **Actor:** `ai_employee` if assigned, else `system`; `actor_id` =
    `coalesce(assigned_employee_id, <lease_owner arg>, 'system')`.
  - **Payload delta:**
    ```jsonc
    {
      "status": "failed",
      "reason": "worker_error",
      "error": "string",     // left(p_error, 500)
      "retry_count": 3       // attempts consumed at the point of failure
    }
    ```

  **(B) Reaper retries-exhausted — `hq_ai_task_reap`** (an expired lease with
  `retry_count >= max_retries`).
  - **Actor:** `actor_type` = `system`, `actor_id` = `system`.
  - **Payload delta:**
    ```jsonc
    {
      "status": "failed",
      "reason": "lease_expired",
      "dead_lease_owner": "string | null",
      "retry_count": 3
    }
    ```
- **Distinguisher:** `reason` + actor, exactly as `task.retried` (§3.4).
- **Consumers / Correlation / Ordering / Delivery:** common (§1–§2). A terminal event
  of the saga (the alternative to `task.completed`).

---

## 4. Future-compatibility notes

The contract above is **v1**. What is reserved, deferred, or staged — so a future
change is additive, never a surprise:

- **Versioning.** Every event is schema version 1; the absence of a payload
  `schema_version` field *is* the v1 signal. A backward-incompatible payload change
  mints a new version (recorded beside the old here, and in
  `EVENT_SCHEMA_VERSION_OVERRIDES`) and begins stamping `payload.schema_version` —
  the full mechanism is `./event-versioning.md` §5. **Add fields additively**: a new,
  optional payload key that old consumers can ignore does not require a bump.
- **Deferred verbs (no dead vocabulary — ADR-0005).** Three transitions are
  intentionally silent and **unregistered** until a real wiring exists:
  - `task.heartbeated` — heartbeats are *liveness*, not facts; evented, they would
    drown the spine.
  - `task.checkpointed` — a checkpoint is internal resumption state; evented only if a
    consumer ever needs it.
  - `task.cancelled` — the guard permits `* → cancelled`, but PR-A ships no cancel
    entry point; the verb is registered the day a cancel function lands.
- **Actor identity is v1.** `actor_id` today is the assigned employee, the lease/worker
  token, or `system`; the dead lease owner travels in the payload. Threading the SDK's
  real `RunContext` identity onto `actor_id` is **D-04 / #014** (runtime-identity), not
  this contract.
- **Causation.** `causation_id` is not set by PR-B. When the SDK publish path
  (Volume XI §4.2, XIII) carries the ambient causation, task events will record the
  triggering event's id — turning the correlation *tree* into the full causal *DAG*
  (P2). Additive; no existing field changes.
- **Consumers will multiply.** Today the only live consumer is `timeline` (The Pulse).
  New subscribers (a task scheduler reacting to lifecycle, analytics, SLA sweeps) are
  added as **data** (subscription rows, Volume XI §6.2) against this same contract —
  no change to the emitter.

---

*Engineering reference for the Generic Task Engine's spine events (CEO Directive
#012 / D-02). Reconciled with the code at the PR-B commit. Governed by the Event
Versioning rule (`./event-versioning.md`); justified by ADR-0005
(`../decisions/0005-task-engine-spine-emission.md`).*
