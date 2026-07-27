# ADR 0005 — Task Engine spine emission (the `task.*` verbs)

> **Status:** Accepted · **Date:** 2026-06-26 · **Directive:** CEO Directive #012 /
> D-02 (Generic Task Engine), PR-B · **Supersedes:** none · **Superseded by:** none ·
> **Builds on:** [ADR 0004](./0004-generic-task-engine.md)
>
> Fifth ADR under the [`../README.md`](../README.md) *document-before-you-build* rule,
> recorded in the same PR as the code. This is **PR-B** of D-02: it brings the
> reserved `task.*` Event Spine verbs to life so every WIRED lifecycle transition of
> the Generic Task Engine writes **one** canonical audit event, in-transaction. It
> touches the [Event Spine](../substrate/volume-11-event-bus.md) verb registry — a
> frozen contract — so it requires an ADR by the
> [Architecture Freeze](../governance/architecture-freeze.md) §2 rule. It does **not**
> change the Task Engine schema, guard, or lease (ADR 0004); the freeze status of the
> Task Engine is unchanged (**Partial**) until the runner and the workload migrations
> land (PR-C–G).

---

## Context

ADR 0004 shipped the Task Engine queue, guard, and seven entry points, and explicitly
left spine emission to PR-B, anticipating *"the canonical `task.*` Event Spine verbs
and an `AFTER` emitter … the pattern of ADRs 0001/0003."* On implementation, that
anticipated shape did not survive contact with the engine's own state machine, and
this ADR records the refinement.

**What an `AFTER` trigger cannot do here.** The Approval, Draft, and Communication
engines emit from an `AFTER` trigger because each of their transitions maps **1:1**
from the row's new state to a verb + actor the trigger can read off the row. The Task
Engine has two transitions that are **ambiguous at the row level**:

- `running → pending` happens both when a worker reports a **retryable failure**
  (`hq_ai_task_fail`; actor: the employee/worker; reason: its error) **and** when the
  reaper recovers an **expired lease** (`hq_ai_task_reap`; actor: the **system**;
  reason: `lease_expired`). Both paths null the lease owner, so an `AFTER` trigger sees
  an identical row shape and cannot tell which operation occurred — nor recover the
  honest actor.
- `running → failed` is likewise either worker-reported or retries-exhausted-by-reaper.

A trigger would have to either emit a **degraded** event (wrong or unknowable actor and
reason) or be fed the missing context through a side channel (a session GUC or a
discriminator column) — **action-at-a-distance** that is harder to audit than the thing
it replaces. The Task Engine is, by ADR 0004's defining decision, a
**function-entry-point engine**: the seven SECURITY DEFINER functions are "the one way
an employee touches the queue." Only the function knows which operation it is. So the
emission belongs there.

This is the consistent principle, not an exception to it: **every engine emits from its
own sanctioned write path.** Approvals have no functions, so they emit from their
trigger; the Task Engine's sanctioned path *is* its functions, so it emits from them.
The `BEFORE` guard remains the unbypassable **invariant** backstop (illegal transitions
and terminal mutation are impossible even for a raw service-role `UPDATE`); the emitter
is the **audit** of the front-door operation.

## Decision

**1. Register a five-verb `task.*` group** in
[`lib/events/registry.ts`](../../../lib/events/registry.ts) — the single source of
event names — one verb per WIRED transition, past tense:

| Verb | Transition(s) | Severity | Actor |
|---|---|---|---|
| `task.created` | `create` → pending | `info` | creator (assignee, else system) |
| `task.claimed` | `claim` pending → running | `info` | worker/employee |
| `task.completed` | `complete` running → completed | `success` | worker/employee |
| `task.retried` | `fail`(retryable) **and** `reap`(retries remain) running → pending | `warn` | worker **or** system |
| `task.failed` | `fail`(terminal) **and** `reap`(exhausted) running → failed | `warn` | worker **or** system |

`task.retried` and `task.failed` each cover **two** code paths, told apart by
**actor + `payload.reason`** (`worker_error` vs `lease_expired`) — the precision the
function-emission choice buys that a single trigger verb could not. A `task.retried`
event is what later **unblocks DAG dependents** and what a health monitor counts for
flapping; a `lease_expired` retry is the signal that a worker died, distinct from a
clean worker-reported retry, and the spine must not blur them.

**2. Emit from the functions, via one shared helper.**
[`20260803000000_hq_ai_tasks_spine.sql`](../../../supabase/migrations/20260803000000_hq_ai_tasks_spine.sql)
adds a private `hq_ai_task_emit(...)` helper that writes the envelope (object
`('ai_task', id)`, target `(subject_kind, subject_id)`, `correlation_id`, and a
standard non-PII identity payload) through `hq_emit_event` in exactly one place, and
`create-or-replace`s the five emitting entry points (signatures byte-for-byte
unchanged, so PR-A's grants are preserved) to call it at the precise transition. The
helper reads **only write-once identity** off the row and takes all **mutable** detail
(`status`, `retry_count`, `reason`, …) from the caller, so the reaper's pre-update row
snapshot can never emit a stale status. `heartbeat` and `checkpoint` are **not**
redefined and emit nothing.

**3. What is intentionally silent or deferred.**
- **No `task.heartbeated`** — heartbeats are liveness, not facts; one event per
  heartbeat would drown the spine. The lease *is* the record.
- **No `task.checkpointed`** — a checkpoint is internal resumption state, not a
  business fact; it is evented only if a concrete consumer ever needs it. (This
  resolves the open "PR-B decides" the lifecycle spec left.)
- **No `task.cancelled` yet** — the guard permits `*→cancelled`, but PR-A ships no
  cancel entry point. The verb is registered when that function lands, never as dead
  vocabulary in the registry.

**4. Actor mapping is v1.** An assigned task acts as its `ai_employee`; an unassigned
one acts as `system`; the worker/lease token and the dead-lease owner travel in the
payload. Threading the SDK's **real** `RunContext` identity onto `actor_id` is **D-04 /
#014** (runtime-identity), not PR-B. This ADR commits the *verbs and the emission
mechanism*; it does not pre-empt the identity decision the freeze reserves to D-04.

## Alternatives weighed

- **An `AFTER` trigger emitter (as ADR 0004 anticipated).** Rejected for the reason
  above: it cannot recover the actor or reason for the retry/fail transitions, which
  are ambiguous at the row level. It would force degraded events or a hidden side
  channel. The function emits the truth directly, at the site that knows it.
- **A discriminator column or session GUC to feed a trigger.** Rejected as
  action-at-a-distance: it adds persistent emission-signalling state (or invisible
  session coupling) purely to reconstruct, in a trigger, what the function already
  knows — strictly more machinery and harder to audit than emitting in place.
- **Separate `task.reaped` / `task.expired` verbs.** Rejected as redundant vocabulary.
  The *fact* is the same (a task was retried, or failed); the *cause* (a dead worker)
  is a payload `reason` + a `system` actor, not a new verb. The lifecycle spec's
  mapping (reap → `task.retried`/`task.failed`) is kept; minimal verb namespaces age
  better than a verb per cause.
- **Emit `task.checkpointed` for progress observability.** Deferred, not adopted:
  no consumer needs it yet, and a chatty per-checkpoint event is the kind of spine
  noise the "no `comm.queued`" precedent warns against. It can be added (additively)
  the day a consumer does.

## Consequences

**What the workforce inherits.** Every employee that creates, claims, completes, fails,
or has work reaped now leaves an **append-only audit trail** on the Event Spine, under
the same five verbs, with `correlation_id` threading each task's whole lifecycle into
one trace — for free, by inheriting the engine. No employee writes its own task audit.

**Emission completeness is enforced, not assumed.** Because emission lives in the
functions, the guarantee "every transition is on the spine" holds exactly as long as
"the queue is written only through the functions." ADR 0004 already made the functions
the sole sanctioned API and the guard the backstop; PR-B's
[security suite](../../../__tests__/security/task-engine-spine.test.ts) adds the pin
that **no application code raw-writes `hq_ai_tasks`** — so there is no sanctioned
non-emitting path. The
[integration suite](../../../__tests__/integration/tasks/task-engine-spine.test.ts)
proves, against real Postgres, that each transition emits exactly its verb with the
right actor/severity/reason, that heartbeat and checkpoint stay silent, and that a full
lifecycle yields the expected ordered verb sequence under one `correlation_id`.

**Blast radius.** Additive. **Zero** historical rows are re-stamped: PR-A emitted
nothing, so there is no backlog of un-evented tasks to backfill, and no existing event
verb changes meaning. The schema is untouched. The two live sales runners still use
`hq_sales_ai_tasks` (a different table) and are unaffected until PR-E/PR-F. The only new
load is one `hq_events` insert per task transition, in the same transaction as the
state change.

**Freeze status.** Unchanged: the Task Engine remains **Partial**. PR-B completes the
*audit* facet of the contract; the runner (PR-C), the memory binding (PR-D), and the
workload migrations (PR-E–G) remain outstanding before it can be declared Established.

**Numbering.** Registered in [`../governance/numbering.md`](../governance/numbering.md);
the next free ADR number is **0006**.
