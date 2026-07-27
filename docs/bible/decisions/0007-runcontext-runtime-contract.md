# ADR 0007 — The RunContext Runtime Contract

> **Status:** Accepted · **Date:** 2026-06-27 · **Directive:** CEO Directive #013 / D-03
> (the RunContext Runtime Contract) · **Supersedes:** none · **Superseded by:** none ·
> **Builds on:** [ADR 0004](./0004-generic-task-engine.md),
> [ADR 0005](./0005-task-engine-spine-emission.md)
>
> Seventh ADR under the [`../README.md`](../README.md) *document-before-you-build* rule —
> here in its **strictest** form: the CEO directed that this decision be **written and
> reviewed before any implementation begins**, so it is authored ahead of the code rather
> than alongside it. It formalises the CEO-approved [Directive #013 architecture
> proposal](../governance/directive-013-runcontext-architecture-proposal.md) and folds in
> the three amendments returned by the CTO review — **execution-state ownership**,
> **RunContext immutability**, and **no-infrastructure exposure**. RunContext is **frozen
> contract #4** ([architecture-freeze.md](../governance/architecture-freeze.md)); on
> acceptance and implementation it graduates **Partial → Established**. This document
> changes no code, schema, migration, configuration, or git history.

---

## Context

CrewFlow's defining promise is that **employee #42 inherits exactly the same
architecture as employee #3**. The carrier of that promise at runtime is **RunContext**:
the single, request-scoped value the Task Engine runner assembles when it claims a task
and hands to an employee's handler as that handler's sole argument
(`type TaskHandler = (ctx: RunContext) => …`, `server/sdk/tasks.ts:120`). It already
ships in **minimal** form — `{ task, identity, memory, tasks, correlationId,
budgetMicros }` (`server/sdk/tasks.ts:98-111`), built by `buildContext()` at claim time
(`server/sdk/tasks.ts:278-297`). Directive #013 does not invent it; it **graduates** it.

The graduation is overwhelmingly a **binding** exercise, not a building one, because the
Generic Task Engine (#012, [ADR 0004](./0004-generic-task-engine.md)) deliberately
reserved every seam #013 needs as an inert column:

- **correlation** — `correlation_id` is `not null` and live (`hq_ai_tasks` L161), already
  read into `ctx.correlationId` (`tasks.ts:294`) and auto-threaded to child tasks;
- **budget** — `cost_budget_micros` (L154), already surfaced as `ctx.budgetMicros`
  (`tasks.ts:295`) as a read-only passthrough;
- **deadline** — `deadline_at` (L145), an inert seam surfaced on `TaskRow`
  (`server/services/hq-tasks.ts:73`) but not yet on the context;
- **cancellation** — the `cancelled` status (L103) and its guard transition
  `pending | running → cancelled` (L267-268) exist, but there is **no cancel entry point**
  among the seven sanctioned functions and **no signal to a running handler**;
- **capability** — `required_capability` (L88), reservable at enqueue, threaded nowhere
  yet.

So the net new substrate #013 introduces is **one cooperative cancellation signal and the
durable entry point that triggers it** — everything else is the act of freezing a shape
and activating columns the platform already owns.

**The CTO review.** The CEO reviewed the architecture proposal and **approved its
contract**, with one amendment and two additional standing rules that this ADR encodes as
first-class architectural principles, not footnotes:

1. **Ownership.** *"The Operating System owns execution state. RunContext exposes
   execution state … Handlers consume the context. Handlers never own or mutate runtime
   execution state. This distinction should become a permanent architectural principle."*
2. **Immutability.** *"Once execution begins, the following values must remain immutable:
   identity, correlationId, deadline, budget, signal … The handler's context object must
   remain stable throughout execution."* — to guarantee deterministic handler behaviour.
3. **No infrastructure exposure.** *"RunContext should never expose infrastructure
   directly. AI employees should never interact with SQL, Supabase, database clients,
   transport clients, raw services … The SDK becomes the only interface between AI
   employees and the operating system."*

The amendment **sharpens** the binding thesis rather than altering it: if the OS owns
execution state, then even the new cancellation entry point is an **OS (Task Engine)**
capability; RunContext does not own cancellation — it merely **exposes its effect** as
`ctx.signal`. The contract's job shrinks to *exposing* what the engine owns and *carrying*
what other layers author.

---

## Decision

**1. Freeze the `RunContext` shape and its invariants.** The contract graduates the
six-field minimal slice (`server/sdk/tasks.ts:98-111`) to the frozen set below; the shape
is what #013 freezes, the assembler (`buildContext`) is the implementation that fills it.

| Field | Owned by | RunContext role | Status |
|---|---|---|---|
| `task: TaskRow` | the engine (leased row) | carries | present (#012) |
| `identity: EmployeeIdentity` | the identity store | carries (resolved) | formalised (Decision 5) |
| `memory: BoundMemory` | Shared Memory (#009) | carries the built facet | present, unchanged |
| `tasks: BoundTasks` | the engine | carries (create + checkpoint only) | present |
| `correlationId: string` | the engine (set at enqueue) | exposes (read-only) | present, live |
| `budget` | the engine (`cost_budget_micros`) | **exposes** (read-only ceiling) | renamed (Decision 8) |
| `deadline: Date \| null` | the engine (`deadline_at`) | **exposes** | activated seam |
| `signal: AbortSignal` | the engine (cancel ∪ deadline) | **exposes** | new construct (Decision 6) |
| `capabilities` (resolved set) | the registry (#015) | carries (opaque, resolved) | threaded (Decision 7) |

The contract **owns the threading, not the source of truth**: identity's canonical store,
the cost meter, and the capability registry all live elsewhere; RunContext carries
resolved values, it does not author them.

**2. Execution state is owned by the Operating System, exposed by RunContext, and
consumed by handlers — never owned or mutated by handlers. This is a permanent
architectural principle.** The Task Engine (the OS) owns cancellation, deadlines, budget,
leases, and retries — the durable state and the machinery that advances it. RunContext is
a **read-only window** onto that state: `ctx.signal` exposes the engine's cancel/deadline
decision, `ctx.deadline` exposes the engine's SLA, `ctx.budget` exposes the engine's
ceiling. A handler **consumes** the context — reads it, branches on it, awaits against it
— and **never owns or mutates** it: it cannot extend its own deadline, lift its own
budget, clear its own cancellation, renew its own lease, or schedule its own retry. Those
are the engine's, because they are inherited substrate; letting a handler mutate them
would fork the guarantee per employee and break the inheritance promise. This is **stricter
than** the proposal's neutral "RunContext does not drive terminal transitions": it is a
positive rule about *who owns execution state at all*, and it binds every facet #014 adds.

**3. RunContext is immutable for the duration of one invocation.** Once execution begins,
`identity`, `correlationId`, `deadline`, `budget`, and `signal` **must remain stable** —
the handler's context object must not change underfoot. The runner may evolve its own
internal bookkeeping (lease renewals, heartbeat timing), but **none of it is visible as a
change to `ctx`**. This guarantees deterministic handler behaviour: the same task, claimed
once, presents one fixed identity, one trace, one deadline, one budget, and one signal for
the whole run.

> **One precise carve-out — the signal latch.** `ctx.signal` is immutable *by reference*
> (never reassigned), and its `aborted` flag is a **monotonic one-way latch**: it flips
> `false → true` exactly once (on cancel or deadline) and never back. That single,
> designed edge **is** the cooperative-cancellation mechanism — it is not a mutation of
> the context object, and it does not weaken determinism: a handler observing the signal
> sees a stable reference whose abort, if it comes, is final. Every *other* listed field
> is value-stable for the whole invocation.

**4. The SDK is the only interface between an AI employee and the operating system;
RunContext never exposes infrastructure.** No Supabase client, database client, transport
client, raw service handle, or SQL string appears on `ctx` or on any facet it carries. An
employee reaches memory through `ctx.memory`, tasks through `ctx.tasks`, and (in #014)
comms/events/tools/api through their facets — **never** the substrate beneath them. *"The
SDK becomes the only interface between AI employees and the operating system."* This keeps
identity-stamping, permission checks, audit, and budget accounting **non-bypassable**: an
employee cannot reach around the SDK to issue an unstamped write or an unmetered call,
because the only door it is given is the SDK. The principle also governs **naming**: the
context exposes clean abstractions (`ctx.budget`), not raw column units leaked upward
(Decision 8).

**5. Settle canonical runtime identity.** #013 owns the identity decision (moved here from
#014 by the approved roadmap update, because identity must settle before either the SDK or
the registry can rely on it). The ADR:

- **chooses one canonical slug per employee** that is simultaneously the runtime
  `actor_id`, the spec slug, and the SDK identity — resolving the proven three-way split
  (`lead-qualification` vs `qualification-ai` vs `lead-qualification-ai`,
  [`runtime-identity.md`](../governance/runtime-identity.md) §4) to a single value;
- **formalises `EmployeeIdentity`** — `RunnerIdentity` (`tasks.ts:62-68`, with `slug`
  optional) becomes a required, typed, resolved value with `slug` **non-optional and
  canonical** (`{ employeeId, slug, department, memoryScope }`; `version` deferred until a
  second version exists);
- **states the disposition of historical `actor_id`s as the blast radius** — preferring
  **alias or freeze** over re-stamping append-only spine rows (the
  [`runtime-identity.md`](../governance/runtime-identity.md) §1 warning); no automatic
  history rewrite beyond what this ADR explicitly authorises;
- **records the forward rule** that the three layers agree from that point on, and the
  disposition of Reserved rows such as `design-ai`.

**6. Cooperative cancellation and deadlines, exposed as `ctx.signal`, owned by the
engine.** Per Decision 2 the engine owns cancellation; #013 closes the one missing seam:

- **An eighth sanctioned entry point, `hq_ai_task_cancel`** — a `SECURITY DEFINER`
  function performing the already-defined guard transition `pending | running → cancelled`
  (`hq_ai_tasks` L103, L267-268), so an operator or a parent task can request cancellation
  **durably**. Because the status and the transition already exist, this is **a new
  function with no new column and no enum change** — and it belongs to the engine, not to
  RunContext.
- **`ctx.signal: AbortSignal`** exposes the effect to the handler. The runner already
  heartbeats every `lease/3` (`tasks.ts:319-322`); on that same beat it checks for a
  cancellation request and, if present, **aborts the signal**. The handler observes it
  **cooperatively** (long loops / `await`s check `ctx.signal.aborted` or pass the signal
  to `fetch`).
- **Deadlines compose into the same signal.** `ctx.deadline` exposes `task.deadline_at`;
  the signal is `cancel ∪ deadline` (a deadline is a self-cancellation). #013 adds **no
  hard-kill** machinery — cancellation is cooperative, consistent with the lease model;
  a handler that ignores the signal is still bounded by the lease + reaper (no
  regression). This is the **one place #013 touches schema**, and it touches it minimally.

**7. Thread a resolved, opaque, source-indifferent capability set.** RunContext carries
`ctx.capabilities` — the employee's *resolved authority for this run*, computed at assembly
time from whatever source exists (today the `ai_employees` columns `tools_allowed` /
`permissions` / `memory_scope` / `department`,
`supabase/migrations/20260712000000_ai_employees.sql` L72/L77/L80; after #015, the
registry — **with no change to the contract**). The set is **opaque and read-only**: #013
carries it, it does **not** define a predicate, does **not** enforce, and does **not**
author the source. The split the dependency analysis proved: **#013 threads the set, #014
enforces it, #015 sources it.** That source-indifference is exactly why the contract does
not depend on the registry.

**8. Budget is a read-only ceiling exposed as `ctx.budget`.** The exposed accessor is
**`ctx.budget`** (the CEO's vocabulary, and a clean abstraction per Decision 4), replacing
the current raw-unit name `ctx.budgetMicros` (`tasks.ts:110`, `:295`). It carries the
reserved ceiling `task.cost_budget_micros` and is a **read-only ceiling, never a meter**:
#013 makes the limit *visible*; it does not count spend. Metering (`cost_micros`, L153) and
enforcement (the API gateway refusing a call that would bust budget) are **#014**. The
precise representation — a bare micros integer, or a small read-only `Budget` value object
carrying `.micros` — is an implementation detail the #013 PR settles; the **name and the
read-only semantics are frozen here**.

**9. Explicit deferrals — assembled *over* this frozen shape with no change to it.**

- **To #014 (AI SDK Envelope):** the `comms` / `events` / `tools` / `api` facets; the
  standard output envelope and its evidence-drain hook; **cost metering** and the **API
  gateway**; `ctx.tools.invoke` (permission-check + meter + audit at invocation); the
  optional `inbound?` facet; the **enforcement predicate** that reads #013's resolved
  capability set.
- **To #015 (Capability Registry):** the single declarative registry + resolver
  consolidating the four scattered registration surfaces; the authoring surface; making
  `required_capability` **enforceable against a real registry**.
- **To their own directives:** the remaining Task-Engine seams — DAG (`depends_on`),
  approval lifecycle, verification.

**10. Migration footprint: one `SECURITY DEFINER` function, zero new columns, zero enum
changes.** Every *data* field #013 needs already exists (`deadline_at` L145,
`cost_budget_micros` L154, `correlation_id` L161, `required_capability` L88); the only
schema change is `hq_ai_task_cancel`. If cancellation were scoped out, the schema delta
would be **zero**. This is the binding-not-building thesis made concrete — and Decision 2
sharpens it: the one function is an **engine** capability, so RunContext's own schema
footprint is nil.

---

## Alternatives weighed

- **RunContext owns execution state** (a handler can extend its deadline, lift its budget,
  clear its cancellation, renew its lease). **Rejected — explicitly, by the CTO review.** A
  context that owns execution state forks the inheritance guarantee per employee and
  destroys determinism: two employees on the "same" substrate would behave differently
  because one rewrote its own limits. Ownership sits with the OS so #42 inherits exactly
  what #3 inherits. This is Decision 2.
- **A mutable / re-assignable context** (refresh `budget` mid-run, swap `identity`,
  replace `signal`). **Rejected** — it makes handler behaviour non-deterministic and the
  context unauditable. Decision 3 freezes the values for the invocation; the signal latch
  is the single, monotonic, designed exception.
- **Expose the Supabase client (or a raw service) on `ctx` for "advanced" handlers.**
  **Rejected** — it makes the SDK optional and lets an employee bypass identity-stamping,
  permission checks, audit, and budget accounting. Decision 4 makes the SDK the only door.
- **Two ADRs (the contract, and the cancel function separately).** **Rejected** — the
  cancel entry point is a sub-decision of the contract's cancellation design, not an
  independent architectural choice; recording it as Decision 6's schema sub-section keeps
  one coherent record (proposal Q14).
- **Preemptive cancellation / thread-kill machinery.** **Rejected** — you cannot safely
  kill arbitrary JavaScript mid-statement; a cooperative `AbortSignal` matches the lease
  model, and the lease + reaper already bound a runaway run. A hard-kill scheduler is
  over-build.
- **Zero-cancellation scope (pure TypeScript over existing columns, no function).**
  **Considered** — it makes the schema delta literally zero. **Rejected** because it leaves
  the `cancelled` status and its guard transition (already in the engine) unreachable by
  any operator or parent task: a half-feature. One `SECURITY DEFINER` function completes
  it.
- **Re-stamp every historical `actor_id` to the canonical slug.** **Rejected** — high blast
  radius on append-only spine rows for little gain; **alias or freeze** suffices
  ([`runtime-identity.md`](../governance/runtime-identity.md) §1). Decision 5 states the
  disposition as blast radius, not as an automatic rewrite.
- **A god-object RunContext** carrying fields "for the future". **Rejected** — every field
  must have a live #013 consumer (or an already-built facet), or an explicit frozen-contract
  justification; the capability set is the one carried-for-the-contract field, and it is
  bounded by being opaque (proposal Q17 discipline test).

---

## Consequences

**What the workforce inherits.** Every employee — present and future — receives **one
stable, immutable, infrastructure-free runtime contract**: who they are (canonical
identity), their trace (correlation), their limits (a read-only budget ceiling and a
deadline), their stop-signal (cooperative cancellation), their substrate facets (`memory`
today; comms/events/tools/api later), and their resolved authority (an opaque capability
set). They **consume** it; they never **own or mutate** it; they **never see SQL**. The
runner assembles the identical contract for employee #42 and employee #3 — the inheritance
promise, made load-bearing at runtime.

**Blast radius.** *Schema:* one `SECURITY DEFINER` function (`hq_ai_task_cancel`); **zero
new columns; zero enum changes** — the `cancelled` status and its guard transition already
exist (`hq_ai_tasks` L103, L267-268). *Code:* graduate the `RunContext` interface
(`server/sdk/tasks.ts:98-111`) by **addition** (`deadline`, `signal`, `capabilities`), the
`budgetMicros → budget` exposed-accessor rename (Decision 8), and `RunnerIdentity →
EmployeeIdentity` with a canonical non-optional `slug` (Decision 5). The two live handlers
(`research-ai`, `lead-qualification`) consume only fields that already exist, so they stay
green; the accessor rename is the single mechanical touch-point. *Identity:* a data
decision (alias / freeze) stated here, **not** an automatic spine rewrite. *Reversibility:*
the function drops cleanly; the new fields are additive.

**Enforcement.** The test matrix the contract must pass (proposal Q15): *contract-shape*
pins the exact frozen fields and the passthrough invariants (`correlationId ===
task.correlation_id`; `budget` reflects `cost_budget_micros`, never mutated; `deadline`
maps `deadline_at`); *immutability* tests prove the context's fields are stable references
across the run and that `ctx.signal` is a one-way latch; *cancellation* — the net-new
behaviour, heaviest coverage — proves cancel→signal-abort-on-heartbeat→cooperative-stop→
engine finalises `cancelled`, that a handler ignoring the signal is still reaped by the
lease (no regression), and that cancel is terminal and idempotent; *deadline* composes with
cancel (whichever fires first wins); the *no-infrastructure* principle is enforced by the
contract's own type surface (no client/service types reachable from `ctx`) plus the
architectural review; the **six-gate CI** and the existing #012 runner suite stay green.

**Freeze status.** RunContext is **Partial** today and **stays Partial until this ADR is
accepted and implemented**; on implementation it graduates **Partial → Established** (the
proposal's scope boundary §6). The three amendments are not local to #013 — they become
**standing architectural principles** that bind every facet the SDK adds in #014 and the
registry in #015: execution state stays OS-owned, the context stays immutable per
invocation, and the SDK stays the only interface.

**Numbering.** This is ADR **0007**
([`../governance/numbering.md`](../governance/numbering.md) §5); ADR numbers are monotonic
and never reused. The CEO accepted ADR 0007 **ahead of** implementation, so it is
**registered in §5 with this acceptance** and the next free ADR number advances to
**`0008`**. The architectural-review sign-off the
[Architecture Freeze](../governance/architecture-freeze.md) §2 requires for the *contract
change itself* travels with the implementation PR that carries the code; this accepted
decision record is that PR's prerequisite.

---

*Documentation only. No code, schema, migration, configuration, or git history was changed
by this record. Authored ahead of implementation under the document-before-you-build rule
at the CEO's direction. The CEO **accepted** this ADR and **authorised Directive #013
implementation** within the approved scope — the smallest correct RunContext Runtime
Contract, with **no** SDK-envelope expansion, **no** Capability Registry, **no** employee
migration, **no** new platform tools, and **no** raw infrastructure exposure — to begin
once this ADR and the Constitution reconciliation are merged. Prepared for CEO Directive
#013 / D-03 (the RunContext Runtime Contract); the contract it records was approved by the
CEO with the three amendments encoded above.*
