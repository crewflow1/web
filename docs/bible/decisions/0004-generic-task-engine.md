# ADR 0004 — The Generic Task Engine

> **Status:** Accepted · **Date:** 2026-06-26 · **Directive:** CEO Directive #012 /
> D-02 (Generic Task Engine), PR-A · **Supersedes:** none · **Superseded by:** none
>
> Fourth ADR under the [`../README.md`](../README.md) *document-before-you-build*
> rule, recorded in the same PR as the code. D-02 is a **major** architectural
> decision and the first plank of the spine that follows the Conversion Arc: **one
> durable, crash-safe, audited work queue that *every* AI employee inherits**, before
> the AI SDK / RunContext (D-04) wraps it. It builds on the Event Spine
> ([Volume XI](../substrate/volume-11-event-bus.md)) and the Approval Engine
> ([ADR 0001](./0001-approval-engine.md)), and it flips the **Task Engine** contract
> in the [Architecture Freeze](../governance/architecture-freeze.md) from **Reserved**
> to **Partial**. This record covers **PR-A only** — the schema and its sanctioned
> entry points; the later PRs (B–G) it sequences are listed under *Follow-ups*.

---

## Context

The CEO ratified a re-scoped D-02: not an Outreach feature, but the **Generic Task
Engine** — shared operating-system infrastructure that makes the inheritance promise
true for work execution. The governing constraint is the platform metric itself:

> "employee #42 inherits exactly the same architecture as employee #3."

A task runner is the most-cloned piece of a multi-agent system, so it is the most
dangerous place for per-employee forks. The
[Constitution](../../crewflow-v1.0-constitution.md) requires every Live employee to
be "stood up by inheritance only," and Volume XII names the Task Engine a frozen
platform contract. If each employee brought its own queue, that promise would fail at
the first new hire.

**The reuse audit (Engineering Rule 1: reuse before build).** The AI work queue
already exists in everything but its name.
[`hq_sales_ai_tasks`](../../../supabase/migrations/20260714000001_hq_sales_ai_scale.sql)
is described in its own header as "the AI Task Queue foundation," and a later
migration calls it "the GENERIC AI work queue." Three workloads ride it today — the
sales pipeline, `research_company`, and lead-qualification — keyed only by
`task_type`. What it lacks is (a) an employee-agnostic identity (it is sales-named and
FK-bound to `hq_sales_companies`/`contacts`), and (b) **crash recovery**: a dead
worker is detected today by a blunt 5-minute wall clock in TypeScript
(`STUCK_RUNNING_MS`), and a claim is a TypeScript conditional `UPDATE` with a benign
read-then-write race. A lease + heartbeat + reaper is the **one** capability Volume
XII §3 marks "to build" that the two live employees actually need.

So the question this ADR answers is: *what is the one task substrate the whole
workforce inherits, how is its concurrency made correct, and how is its security
boundary made unbypassable?*

## Decision

Generalise the proven queue into a generic, crash-safe **Task Engine** —
[`supabase/migrations/20260802000000_hq_ai_tasks.sql`](../../../supabase/migrations/20260802000000_hq_ai_tasks.sql)
— in three layers, with the **database as the single enforcer** and a **function
entry point** as the sole API.

1. **A generic, employee-agnostic table** (`public.hq_ai_tasks`). RLS-locked (HQ-only;
   no policies, so only the service-role admin client reaches it) and *generic*: the
   sales-specific `company_id`/`contact_id` become a polymorphic
   (`subject_kind`, `subject_id`) pair, so any employee addresses any subject. The
   columns, the `priority_rank` formula, and the dedupe partial-unique index are
   carried over **verbatim** from `hq_sales_ai_tasks`, so a migrated task dequeues in
   exactly the same order it does today. The one new structure is the **lease**
   (`lease_owner`, `lease_expires_at`, `heartbeat_at`).

2. **A `BEFORE` guard trigger** as the state-machine enforcer (`hq_ai_tasks_guard`).
   It makes the deterministic lifecycle structural: a task is born `pending`; terminal
   rows (`completed`/`failed`/`cancelled`) are frozen (`restrict_violation`); the task
   *definition* (type, subject, payload, DAG shape, trace) is write-once; only the
   D-02 transitions are legal (`pending→running|cancelled`,
   `running→completed|failed|pending|cancelled`), and `updated_at`/`finished_at` are
   auto-stamped. This guard is **defence in depth**: the service reaches the table
   through the service-role admin client, which **BYPASSES RLS**, so a guarantee that
   lived only in the functions could be bypassed by a raw `UPDATE` (exactly what the
   current sales runners do). The guard holds regardless of caller.

3. **Seven SECURITY DEFINER entry points** as the sanctioned API (Volume XII §11.1):
   `create` · `claim` · `heartbeat` · `checkpoint` · `complete` · `fail` · `reap`.
   Each pins an empty `search_path`, is fully schema-qualified, and has EXECUTE
   revoked from `public`/`anon`/`authenticated` and granted only to `service_role`.
   They are the one way an employee touches the queue.

**Why a function-entry-point engine, and not a trigger engine like Approvals.** The
Approval Engine ([ADR 0001](./0001-approval-engine.md)) enforces its machine with a
trigger over plain `UPDATE`s because every approval operation targets a *known* row.
The Task Engine cannot: its core operation is "pick *which* runnable row to claim" —
an **atomic dequeue** (`FOR UPDATE SKIP LOCKED`) that no row-level trigger can
express. `claim` and `reap` use that primitive — already the proven concurrency
control of the Event Spine drainer and the memory embedding workers — so concurrent
workers each take a **distinct** row, closing the race the TypeScript conditional
`UPDATE` leaves open.

**Crash recovery is a lease, not a wall clock.** A `claim` stamps an opaque
`lease_owner` (a worker token, *not* a user identity) and `lease_expires_at`; the
worker extends it by `heartbeat`; the `reap` function recovers any `running` row whose
lease has expired, re-queuing it with bounded exponential backoff
(`least(3600, 30·2^retry_count)`) while retries remain, else failing it. This replaces
worker liveness-by-guess with worker-declared liveness.

**The seams are reserved, not built.** Columns and status values that later spine
directives will need are placed now as **inert, nullable seams** so those directives
*extend* this table rather than re-migrate it: `required_capability` (Capability
Registry); `parent_task_id`/`depends_on` and the `blocked` status (DAG);
`approval_status`/`waiting_approval` (Approval-lifecycle); `verification`/`verifying`
(Verification); `cost_micros`/`cost_budget_micros` (Cost/Budget); `deadline_at`
(Health/SLA); `claimed` (assignment hand-off). They carry **no behaviour** in D-02 —
the guard wires only the D-02 transitions.

**The Task Engine becomes a protected platform capability.** Per the CEO's ratifying
decision, this rule is now binding (recorded in the
[Architecture Freeze](../governance/architecture-freeze.md) and the
[Constitution](../../crewflow-v1.0-constitution.md)):

> Every AI employee created after D-02 inherits the Generic Task Engine. No employee
> may introduce a custom task runner. No parallel queue implementations are permitted.
> Any exception requires an ADR, architectural review, and CEO approval.

## Alternatives weighed

- **A trigger-only engine (mirror the Approval Engine exactly).** Rejected. The
  defining operation is choosing which of many runnable rows to claim under
  concurrency; a row-level trigger fires on a row already chosen and cannot express
  `FOR UPDATE SKIP LOCKED`. The engine must be functions. The guard trigger is kept
  *alongside* them as the unbypassable backstop, so this is "and", not "or".

- **A brand-new bespoke queue.** Rejected as duplication. The proven queue already
  carries three workloads; inventing a second one would fork the very infrastructure
  this directive exists to unify, and would strand the sales workload's ordering
  semantics. We generalise the incumbent instead.

- **Per-employee task runners (the status quo, extrapolated).** Rejected — this is the
  failure mode the protected-capability rule now forbids. Every clone re-implements
  claiming, retry, and recovery slightly differently; "#42 inherits what #3 has"
  becomes false. One inherited engine is the whole point.

- **Keep the TypeScript wall-clock recovery (`STUCK_RUNNING_MS`).** Rejected. A fixed
  5-minute timeout cannot tell a slow-but-alive worker from a dead one, so it either
  kills live work or leaves dead work stuck. A worker-declared lease + heartbeat makes
  liveness explicit and recovery correct, and moves it into the database where every
  employee inherits it.

- **A foreign key on the subject.** Rejected (R2). The engine is generic over subject
  kinds it cannot enumerate, so `(subject_kind, subject_id)` carries no FK. The lost
  referential integrity is the accepted cost of genericity; a task's subject is
  validated by the employee that created it, not by the queue.

- **A `status` column with no guard.** Rejected as the boundary, for the same reason
  as ADR 0001: app-layer checks are bypassable (a second caller, a future migration,
  the admin client). The database guard makes illegal transitions and terminal
  mutation structurally impossible; the
  [security suite](../../../__tests__/security/task-engine-invariants.test.ts) pins the
  boundary against source text and the
  [integration suite](../../../__tests__/integration/tasks/task-engine.test.ts) proves
  the atomic dequeue against real Postgres.

## Consequences

**What the workforce inherits.** One engine: a deterministic, crash-safe, RLS-locked
work queue. A new employee enqueues work by calling `hq_ai_task_create` with its own
`task_type`; it inherits atomic claiming, leasing, heartbeating, checkpointing,
retry-with-backoff, dead-worker reaping, dedupe, and priority ordering for free. No
employee re-implements any of it — and, by the protected-capability rule, none may.

**Security boundary.** The queue is reachable only through the HQ admin client via the
seven SECURITY DEFINER functions; the table is RLS-locked with no policies; the guard
refuses every illegal or terminal mutation regardless of caller. The boundary cannot
be bypassed from the application layer because the application layer is not the
boundary — even a raw `UPDATE` from the service-role client meets the guard.

**What this explicitly does NOT do (PR-A is the thinnest correct slice).** PR-A ships
the table, the guard, and the entry points, and **nothing routes to it**. It emits
**no** Event Spine event (the canonical `task.*` verbs and the emitter are PR-B); it
adds **no** TypeScript runner (PR-C); it changes **no** existing employee (the two
live runners keep using `hq_sales_ai_tasks` until PR-E/PR-F). The reserved seams carry
no behaviour.

**Blast radius.** At PR-A: **zero** rows, **zero** employees, **zero** routes touched
— the migration is provably additive (one new HQ table; no tenant table altered; no
existing row re-stamped). When routing lands later, the employees affected are exactly
two — `research-ai` and lead-qualification — and per-`task_type` routing means the
sales pipeline's rows in `hq_sales_ai_tasks` are never touched. No historical task is
migrated or re-stamped; the cutover is forward-only.

**Validation bar.** The engine ships behind the six-gate suite — typecheck, lint, unit,
security (the source-of-truth invariants), integration (claim atomicity, leasing,
reaping, backoff, dedupe, and RLS against real Postgres), and e2e — consistent with
Directive 004. The freeze status moves to **Partial** precisely because PR-A
establishes the contract while PR-B–G complete it.

**Follow-ups (sequenced, each its own reviewable + reversible PR; none in this one).**
- **PR-B** — the canonical `task.*` Event Spine verbs and an `AFTER` emitter, so every
  lifecycle transition writes one audit event in the same transaction (the pattern of
  ADRs [0001](./0001-approval-engine.md)/[0003](./0003-communication-layer.md)).
- **PR-C** — the TypeScript runner abstraction at `server/sdk/tasks.ts`, the SDK
  surface that becomes `ctx.tasks.create()/run()/checkpoint()/complete()`.
- **PR-D** — the `bound_task_id` FK from Shared Memory, closing the memory↔task link.
- **PR-E / PR-F** — migrate `research-ai` and lead-qualification off
  `hq_sales_ai_tasks` onto the generic engine, by `task_type`, retiring
  `STUCK_RUNNING_MS`.
- **PR-G** — the operator read-view and the Volume XII / living-tracker reconciliation
  that records the engine as built.
