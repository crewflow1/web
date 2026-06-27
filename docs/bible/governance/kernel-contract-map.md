# CrewFlow Governance — The Kernel Contract Map

> **Status:** Permanent **engineering reference** — a single-page overview of the
> CrewFlow Operating System *kernel*. It is **not an ADR** and **not implementation**;
> it records no decision and changes no code. It names the six kernel layers and, for
> each, the four boundaries that must stay clear: **Owns · Exposes · Consumes ·
> Explicitly does not own**.
>
> Instituted by CEO directive on approval of the [Directive #013 completion
> report](./directive-013-completion-report.md) (the merge of PR #206), as the
> engineering reference required **before Directive #014 implementation begins**.
> Recorded under the **#011** governance umbrella (Master Roadmap **D-01**).

---

## 1. What the kernel is

The **kernel** is the shared substrate every AI employee stands on — the part of the
platform that is inherited, not re-implemented. It is **exactly the first six
[frozen contracts](./architecture-freeze.md)** (`#1`–`#6`); the remaining four frozen
contracts (`#7` Communication Layer, `#8` Capability Registry, `#9` Boardroom, `#10`
Shared Communication Protocol) are kernel-*adjacent* substrate, not the kernel itself.

The kernel is **stratified** — each layer stands on the ones below it. From the
foundation up:

- **Event Spine** (contract #1) — the append-only floor; records what happened.
- **Shared Memory** (#2) · **Approval Engine** (#6) · **Generic Task Engine** (#5) —
  the three state engines: durable knowledge · human-gate decisions · execution state.
- **RunContext** (#4) — the per-invocation immutable envelope that binds the engines
  into a handler's single frozen argument.
- **AI SDK** (#3) — the single employee-facing door (a facade over the layers below).
- *Above the kernel:* **the AI employees** — the changeable layer, edited often, that
  the §2 principle says should grow *simpler* as the kernel matures.

(The `#N` is each layer's [Architecture-Freeze](./architecture-freeze.md) contract id,
not its stack position — the kernel is exactly contracts #1–#6, so the numbers read out
of order when listed foundation-up.)

The lower a layer, the more **frozen** it is (the Event Spine is append-only and its
verb vocabulary is closed); the higher a layer, the more **changeable** it is meant to
be. That stratification is the principle in §2 made concrete.

---

## 2. The governing engineering principle

The kernel exists to serve one standing engineering principle, set by CEO directive on
the completion of Directive #013. It is the first **written** engineering standard
(Bible *Volume IX — Engineering Standards* is named but unauthored); this is its
canonical home, and the [Platform Reuse Index](./platform-reuse-index.md) is its
**metric**.

> **Kernel contracts should become progressively more stable. Employee
> implementations should become progressively easier to change. Platform maturity is
> measured by the stability of the kernel and the simplicity of the employees built
> upon it.**

Read against the stratification above: maturity is the **floor staying put while the
top gets easier to edit**. A directive is healthy when it hardens a kernel contract and
makes the employees on top *smaller*; it is suspect when employee complexity rises
because a kernel contract was missing or leaked. This principle is the *why* the
[Architecture Freeze](./architecture-freeze.md) (how contracts may change) and the
[Reuse Index](./platform-reuse-index.md) (whether each directive grew the platform or
the employee) both exist.

### The SDK Stability Rule

A **second** written standard is homed here, set by CEO directive on the approval of the
Directive #014 architecture proposal and recorded in [ADR
0008](../decisions/0008-ai-sdk-envelope.md) (Decision 7). It **specialises** the
kernel-stability principle above to the single kernel layer that is *also* the
platform's **developer interface** — the AI SDK (contract #3):

> **The AI SDK is the primary developer interface to the CrewFlow Operating System.
> Backward compatibility is a design goal. Breaking SDK changes should be rare,
> documented, and justified through ADRs when appropriate.**

It follows directly from the principle above. Because the SDK is the one door every
employee is written against, *extend before replace*
([Architecture Freeze](./architecture-freeze.md) §2.4) is the **default mechanism** for
every new SDK facet, and a breaking SDK change is the exception that most needs an ADR +
architectural review — the same bar the Freeze already binds for contract #3.

### The SDK ABI Principle

A **third** standard, set by CEO directive on the **acceptance** of [ADR
0008](../decisions/0008-ai-sdk-envelope.md) (independent CTO review). It states the SDK
Stability Rule's deeper form — the SDK is not merely a stable *surface* but the platform's
stable **application interface (ABI)**, holding steady while everything beneath it moves:

> **The AI SDK is the stable application interface of the CrewFlow Operating System.
> Internal implementation may evolve. Kernel implementation may evolve. Database
> implementation may evolve. The SDK interface should remain stable whenever reasonably
> possible. Changes to SDK behaviour should preserve compatibility unless a documented
> architectural reason requires otherwise; when compatibility cannot be preserved, the
> change must be explicitly documented and justified through an ADR.**

The Stability Rule above is this principle's **compatibility clause**; the ABI Principle
adds the **layering guarantee** — kernel, internal, and database churn is **invisible** to
the employee code written against the SDK. It is the engineering-standards counterpart to
the boundary in §4: *the SDK exposes capabilities, never kernel implementation.* Together
they make the SDK a contract an employee can depend on **across** kernel evolution — the
stable top of a stratification whose lower layers are free to change.

---

## 3. The contract map

For every kernel layer: what state/authority it **owns**, the surface it **exposes**,
what it **consumes** from layers below, and — the boundary that keeps the kernel from
forking — what it **explicitly does not own**. Build status is tagged honestly
(*Established / Partial*), matching the [Architecture Freeze](./architecture-freeze.md)
§4.

### Event Spine — contract #1 · *Established*

| | |
|---|---|
| **Owns** | The append-only `hq_events` ledger and its immutability (the `hq_emit_event` AFTER-trigger forbids UPDATE/DELETE); the frozen verb registry (`lib/events/registry.ts`). |
| **Exposes** | One write path — `hq_emit_event(actor, verb, …)`; the ordered, queryable history; the closed verb vocabulary every producer must use. |
| **Consumes** | Nothing from higher layers — it is the floor. It stamps the `actor_type`/`actor_id` it is handed. |
| **Does *not* own** | The *meaning* of a verb (its producer owns that); identity resolution (it records the actor it is given — it does not mint or validate slugs); any other engine's authoritative state (it only observes their emissions). |

### Shared Memory — contract #2 · *Established*

| | |
|---|---|
| **Owns** | The durable `hq_shared_memory` store — scoped rows, embeddings, the write/recall/forget lifecycle, RLS scoping. |
| **Exposes** | The SDK memory facet `server/sdk/memory.ts` (`createMemory` / `BoundMemory`); the `bound_task_id` memory⇄task binding. |
| **Consumes** | The Event Spine (`memory.*` emissions); the employee scope it is bound to; a Task Engine task id to bind against. |
| **Does *not* own** | Execution/run state (it is durable *knowledge*, not a runner); the task lifecycle (it binds to a task, it does not drive one); identity resolution. |

### Approval Engine — contract #6 · *Established*

| | |
|---|---|
| **Owns** | The `hq_approvals` table and the approval state machine (request → decision). |
| **Exposes** | `server/services/hq-approvals.ts` — the request/decide surface and approval status. |
| **Consumes** | The Event Spine (`approval.*` emissions); identity (requester / decider). |
| **Does *not* own** | The work being approved; task *execution* (approval-gated tasks are a reserved Task Engine seam — Approval **decides**, the Task Engine **gates**); outbound delivery. |

### Generic Task Engine — contract #5 · *Partial*

| | |
|---|---|
| **Owns** | The authoritative *execution state* — `hq_ai_tasks` (status, lease, heartbeat, attempts, checkpoint); the state-machine guard (legal transitions only); the eight `SECURITY DEFINER` entry points; lease/heartbeat/reaper crash recovery. |
| **Exposes** | The eight entry points (create/claim/heartbeat/checkpoint/complete/fail/reap/**cancel**); the SDK runner `server/sdk/tasks.ts`; the `task.*` spine verbs; the unified operator read model (`server/services/hq-task-queue.ts` → `/admin/tasks`); the reserved-but-inert seams (`depends_on`, `required_capability`, `deadline_at`, `cost_budget_micros`, `correlation_id`). |
| **Consumes** | The Event Spine (`task.*` via `hq_ai_task_emit`); the `ai_employees` roster (`assigned_employee_id`). |
| **Does *not* own** | The *invocation envelope* handed to a handler (RunContext owns that — the engine owns durable *state*, not the per-run contract); the handler's logic (the employee owns that); capability *enforcement* (it stores `required_capability` inert — #015 sources · #014 enforces); identity resolution. |

### RunContext — contract #4 · *Established*

| | |
|---|---|
| **Owns** | The per-invocation, `Object.freeze`-d envelope assembled at claim time (`buildContext`); the cooperative-cancellation signal latch (`ctx.signal`) and the composition of the deadline into it; the *shape* of the handler's sole argument. |
| **Exposes** | The frozen `{ task, identity, memory, tasks, correlationId, budget, deadline, signal, capabilities }`; the `TaskHandler` type; `EmployeeIdentity` (canonical, non-optional `slug`); the read-only `budget` ceiling; the opaque `capabilities` set (it **threads**). |
| **Consumes** | The Task Engine (claim / heartbeat / `hq_ai_task_cancel` — the signal aborts off the *existing* heartbeat, **no new query**) and its inert columns bound to fields; Shared Memory (binds `ctx.memory`); the roster / identity (resolves the settled slug). |
| **Does *not* own** | Execution state (the OS owns it — RunContext **exposes**, never mutates); capability enforcement or sourcing (#014 enforces · #015 sources); cost *metering* (it exposes the ceiling read-only; #014 meters); the comms/events/tools/api facets (deferred to #014). |

### AI SDK — contract #3 · *Partial*

| | |
|---|---|
| **Owns** | *Today*, only the Memory facet (`createMemory` / `BoundMemory`). The full per-employee SDK envelope is **owned by D-04 / #014**. |
| **Exposes** | Today the memory facet; *intended* — the single employee-facing **door**: the facets (`memory`, `tasks`, …comms/events/tools/api) delivered *through* the frozen `ctx`. |
| **Consumes** | RunContext (its facets ride inside the immutable envelope); Shared Memory; the Task Engine (`ctx.tasks` = `BoundTasks`); the Event Spine; *(intended)* Approval, Communication, the Capability Registry. |
| **Does *not* own** | The envelope *shape* (RunContext owns it — the SDK populates facets *into* it); execution state; the kernel primitives themselves (the SDK is their employee-facing **facade**, not their owner); capability enforcement (#014, sourced by #015). |

---

## 4. Boundaries that must not blur

The map's value is the *Does-not-own* column. Four boundaries, if conflated, would let
the kernel fork into per-employee special cases:

1. **Execution state (the Task Engine) ≠ the invocation envelope (RunContext).** The
   Task Engine owns the durable row; RunContext owns the frozen per-run argument. They
   are deliberately separate so a handler can *read* its context but can never *mutate*
   execution state — the standing principle "the OS owns execution state" (ADR 0007).
2. **The AI SDK is a facade, not an owner — and it exposes capabilities, not kernel
   implementation.** Its facets are views onto the kernel primitives, delivered through
   `ctx`; the primitives keep their authority. "The SDK is built" would be an overclaim
   today — only its memory facet exists. **Permanent architectural objective** (CEO, on the
   acceptance of [ADR 0008](../decisions/0008-ai-sdk-envelope.md)): the SDK exposes
   *operating-system capabilities* and **never kernel implementation** — an employee knows
   *what it can do* and never needs to know *how the OS performs it*. This is the §2
   **SDK ABI Principle** stated as a boundary: the surface the employee sees stays stable
   precisely because the implementation it hides is free to change.
3. **The Event Spine observes; it does not own meaning.** Producers own verb semantics;
   the Spine guarantees only that the record is append-only and the vocabulary is closed.
4. **Approval decides; the Task Engine gates.** An approval outcome is a decision
   record; turning that decision into a held-or-released task is the Task Engine's
   reserved seam — neither layer absorbs the other.

---

## 5. Relationship to the rest of governance

- **[Architecture Freeze](./architecture-freeze.md)** — governs *how* these contracts
  may change (ADR + architectural review, same PR). The Freeze is the **lock**; this
  map is the **diagram**. The six kernel layers are frozen contracts `#1`–`#6`.
  **Synchronisation rule (CEO directive, on approval of this map):** the Freeze and this
  map are a **bound pair** and must stay synchronised. Whenever a kernel contract changes
  — its status (*Established / Partial / Reserved*), its surface, or any of its
  **Owns / Exposes / Consumes / Does-not-own** boundaries — **both documents are updated
  together, in the same PR** as the ADR + architectural review the change already
  requires. The lock and the diagram never drift apart.
- **[Platform Reuse Index](./platform-reuse-index.md)** — the **metric** for the §2
  principle: it scores every directive on platform-capability-added vs employee
  complexity, the measurable face of "kernel stable, employees simple."
- **ADRs** carry the reasoning, not this map: `0001` Approval, `0004` Task Engine,
  `0005` `task.*` spine, `0006` memory⇄task binding, `0007` RunContext.
- **[CrewFlow V1.0 Constitution](../../crewflow-v1.0-constitution.md)** sets the bar for
  declaring these contracts *complete*, not merely frozen.

---

*Documentation only. No code, schema, configuration, or git history was changed by this
record. It is a permanent engineering reference instituted under the #011 governance
umbrella (Master Roadmap D-01) on the completion of CEO Directive #013 (D-03).*
