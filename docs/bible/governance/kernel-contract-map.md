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

### The Facet Isolation Rule

A **fourth** standard, set by CEO directive on the review of **Directive #014 Phase A**
(the events + comms facets; independent CTO review). The three standards above govern the
SDK's **vertical** boundary — a stable surface held steady over a moving kernel. This one
governs its **horizontal** boundary — how the facets relate to **one another**:

> **Each SDK facet must remain independently composable. SDK facets should not depend
> directly on one another (`ctx.memory`, `ctx.events`, `ctx.comms`, `ctx.tasks`, …). The
> runtime composes the facets; the facets do not compose each other. This keeps the SDK
> modular as additional capabilities are introduced.**

It is *extend before replace* ([Architecture Freeze](./architecture-freeze.md) §2.4) made
structural at the facet seam: a new facet is added by binding it onto `ctx` in the runner
(`server/sdk/tasks.ts`), never by importing a sibling. A facet that reached into another
would couple two kernel primitives behind the SDK's back and re-introduce exactly the
per-employee forking the kernel exists to prevent. The runner is the **one** place facets
meet — where cross-facet sequencing lives (the Phase A evidence-drain folds `ctx.memory`'s
recalled ids into the handler's output without either the memory facet or the output
envelope importing the other). Its architectural form is the §4 boundary: **facets expose
capability; the runtime composes it.**

### The Policy vs Mechanism Rule

A **fifth** standard, set by CEO directive on the review of **Directive #014 Phase B** (the
permission gate — "the doorman"; independent CTO review). Where the Facet Isolation Rule
governs how facets relate to **one another**, this one governs how **enforcement** relates to
**execution** — the seam between *deciding what is permitted* and *carrying it out*:

> **The gate defines policy. The runtime provides mechanism. The gate should never know how
> approvals are requested, how events are emitted, or how communications are sent. The gate
> answers only: "What is permitted under the current policy?"**

It is the **gate-specific sharpening** of *facets expose capability; the runtime composes it*
(§4.2): the permission gate (`server/sdk/gate.ts`, Phase B) is a **pure predicate** —
`evaluateAction(action, posture, capabilities, budget) → GateVerdict` — that returns a
**declarative** verdict (`{ decision, reasons }`) and **imports no facet, performs no I/O, and
triggers no side effect**. The verdict *represents* policy; the **runtime consumes it and
determines the mechanism** — auditing an autonomous decision through the `events` facet, or
handing a non-autonomous one to the Approval Engine via `requestApproval`. Keeping the gate
free of mechanism is what makes it **deterministic, pure, independently testable, and
reusable**, and it is the structural reason the gate is not a facet (it composes nothing) and
`proposeActions` is not a facet (the runtime owns the composition).

**Forward compatibility:** the gate's *inputs* may evolve — the Capability Registry (Directive
**#015**) becomes another **information source** for the `capabilities` (and posture) the gate
reads — but the **gate interface itself stays stable**: its responsibilities do not change when
its source does. This is **#013 threads · #014 enforces · #015 sources** applied at the gate,
and the §2 **SDK ABI Principle** (a stable interface over a moving implementation) made
concrete one layer down.

### The Runtime Composition Rule

A **sixth** standard, set by CEO directive on the review of **Directive #014 Phase B B2** (the
runtime composition that turned the pure gate into the doorman; independent CTO review). It is
the **explicit generalisation** of the Facet Isolation Rule: where that rule forbids a facet from
reaching *sideways* into a sibling, this one states the positive principle it implies —
**composition is the runtime's exclusive responsibility**:

> **The runtime is the only component permitted to combine multiple kernel capabilities into
> higher-level behaviour (e.g. policy + approvals, policy + events, policy + communications). SDK
> facets remain capability providers; the runtime remains the orchestrator. No SDK facet may
> orchestrate another SDK facet directly.**

`ctx.proposeActions` (Phase B B2, `server/sdk/tasks.ts`) is the worked example: it combines the
pure gate's **policy** (`evaluateAction → GateVerdict`) with two **mechanisms** — the `events`
facet's audit emit for an autonomous verdict, the Approval Engine's `requestApproval` for a
non-autonomous one — into the higher-level *doorman* behaviour. That composition lives in the
runner, never in a facet, which is the same structural reason the gate is not a facet and
`proposeActions` is not a facet (§4.2; the Policy vs Mechanism Rule). These horizontal rules
**stack**: **Facet Isolation** forbids sideways coupling, **Policy vs Mechanism** separates
deciding from doing, **Runtime Composition** names the one place the two are recombined — the
OS — and the **Executor Boundary Rule** (below) closes the stack at the execution seam, where a
gate-cleared action is finally applied. A facet that orchestrated another would not merely couple
two primitives (the Facet Isolation breach) but relocate *operating-system behaviour* into a
capability provider, re-introducing the per-employee forking the kernel exists to prevent.

### The Executor Boundary Rule

A **seventh** standard, set by CEO directive on the **acceptance** of [ADR
0009](../decisions/0009-sdk-executor-apply-on-approval.md) (the SDK Executor and Apply-on-Approval
Runtime; Directive #014 **Phase C**; independent CTO review). Where the Policy vs Mechanism Rule
separates *deciding what is permitted* from *carrying it out*, this one governs the **carrying-out**
side — the **executor**, the runtime step that *applies* an action the gate has already cleared:

> **The executor applies only actions that have already passed the gate. The executor must not
> decide whether an action is allowed. The executor must not request approval. The executor must
> not bypass the Task Engine. The executor is mechanism only. Policy remains with the gate.
> Approval remains with the Approval Engine. Lifecycle remains with the Task Engine.**

The executor (Phase C) is the **apply** mechanism — it resolves a cleared action to its registered
tool, re-asserts permission at the tool's `SECURITY DEFINER` boundary, invokes, captures the
result, and audits — and it is **runtime-composed beside `ctx.proposeActions`**, not a facet (it
orchestrates; §4.2). It is the structural mirror of the doorman: where `proposeActions` *classifies
and routes*, the executor *applies what was cleared*. The rule keeps three reservations intact —
**policy** stays with the pure gate (the executor never re-decides allowance), **approval** stays
with the Approval Engine (it never requests its own), and **lifecycle** stays with the Task Engine
(it never moves a task itself) — so the executor adds **mechanism, not authority**. This is the
execution-seam completion of the horizontal stack (Facet Isolation → Policy vs Mechanism → Runtime
Composition → **Executor Boundary**); it ratifies [ADR
0009](../decisions/0009-sdk-executor-apply-on-approval.md) Decisions 1, 3 and 11, and is the §4.4
line *"Approval decides; the Task Engine gates; the executor applies"* stated as a standing
engineering constraint.

### The Registry Immutability Rule

An **eighth** standard, set by CEO directive on the review of **Directive #014 Phase C C1** (the
typed tool registry contract; independent CTO review). Where the Executor Boundary Rule governs
*who* applies a cleared action, this one governs the *metadata that application consumes* — the
**tool registry** (`server/sdk/tools.ts`, C1), where tools are **registered as data** (Bible
Volume XIII §12) that forms a fixed platform contract, never runtime-mutable state:

> **Tool definitions are immutable platform metadata. Tool registration occurs during platform
> initialisation. Runtime execution must consume the registry. Runtime execution must never mutate
> the registry. This preserves determinism and reproducibility across every AI employee.**

The registry is **built once, read forever**: `createToolRegistry` freezes its index and its
listings, so a registered tool is descriptive, immutable data — a `label`, a `permission`, an
`argSchema`, a `costEstimator`, a `reversibilityClass` — that does not change after initialisation.
The executor (Phase C C2) is a **consumer**: it *resolves* a tool to apply a gate-cleared action; it
never adds, removes, or rewrites one. That is what keeps the apply-seam **deterministic and
reproducible** — every employee resolves the same `memory.write` to the same contract, so the same
proposed action yields the same P4 facts (reversibility → atom 1, cost → atom 5) and the same gate
verdict, run after run, employee after employee. It is the complement of the Executor Boundary Rule:
the executor is *mechanism only* (it does not decide), and the registry is *metadata only* (it does
not change) — together they keep the execution seam pure. This sharpens [ADR
0009](../decisions/0009-sdk-executor-apply-on-approval.md) Decision 2 (the registry *describes*
capability and "must never become the authorisation system") with its run-time corollary: it must
never become mutable *state* either.

### The Reference Path Rule

A **ninth** standard, set by CEO directive on the review of **Directive #014 Phase B B3** (the
Reference Employee acceptance; independent CTO review). The eight standards above are **structural**
— they say what the kernel *must be* (a stable surface, a layering guarantee, isolated facets, a
policy/mechanism split, runtime-owned composition, an execution-seam boundary, and immutable tool
metadata). This one is **evidentiary** — it says how a
kernel capability is *proven* to honour them, and how that proof is kept honest as the platform
grows:

> **Every new kernel capability should have one canonical reference path that exercises it
> end-to-end. The reference path exists to prove runtime composition, SDK behaviour, kernel
> interaction, and the architectural boundaries. Future regressions should be validated against
> the reference path before platform expansion.**

It is the **verification counterpart** to *extend before replace*
([Architecture Freeze](./architecture-freeze.md) §2.4): where the change-control rules say a frozen
contract is widened by addition under ADR + review, the Reference Path Rule names the **regression
gate** that addition must clear — one living, end-to-end exercise that fails loudly when an
extension breaks the capability beneath it. A reference path is deliberately **not** a unit test of
a part: it drives the **real** runtime so it proves the parts *compose* — that Facet Isolation,
Policy vs Mechanism, and Runtime Composition all still hold **together**, not merely in isolation.
It is also the operational form of the kernel-stability principle (§2): the kernel is allowed to
stay frozen and the employees on top stay simple precisely because one canonical path proves, on
every change, that the floor has not moved.

The doorman's reference path is the **Reference Employee**
(`__tests__/sdk/reference-employee.test.ts`, Phase B B3): the Lead Qualification AI recast as an SDK
instance, driven through the real runner (`runReadyTask`) as the first caller of
`ctx.proposeActions`. It exercises the pure gate (policy), the runtime composition
(`proposeActions`), and **both** mechanisms (the `events` audit for an autonomous verdict, the
Approval Engine hand-off for one that needs approval), and it pins the boundaries end-to-end: a
reversible write is audited as the bound actor (no spoofing), an irreversible send is parked, a
missing posture defaults to the locked floor (deny-by-default), and a refused approval propagates as
a task failure (the throw-based ABI). Before Phase C extends the SDK with an executor, that path is
the regression it must not break — the standard made operational: **prove the kernel through one
canonical path, and defend it there.** (Distinct from, and complementary to, the *Reference Employee
Rule* of Bible Volume XIII §22, which governs employee **migration** conformance; this rule governs
kernel-**capability** validation.)

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
| **Owns** | *Today* the **memory**, **events**, and **comms** facets (`createMemory`/`BoundMemory`, `createEvents`/`BoundEvents`, `createComms`/`BoundComms`), the **output envelope** (`server/sdk/output.ts`), the runner's **evidence-drain** hook — shipped under **D-04 / #014 Phase A** ([ADR 0008](../decisions/0008-ai-sdk-envelope.md)) — and the **permission doorman + P4**: the pure gate (`server/sdk/gate.ts` — `evaluateAction → GateVerdict`), the runtime composition `ctx.proposeActions`, `resolveEmployeePosture`, and the `ai.action_permitted` audit verb — shipped under **D-04 / #014 Phase B** ([ADR 0008](../decisions/0008-ai-sdk-envelope.md) Decisions 4 & 8). The remaining envelope (the typed tool registry, the API gateway + cost metering — Phases C–D) is **owned by D-04 / #014**. |
| **Exposes** | Today the memory, events, and comms facets + the output envelope + the doorman (`ctx.proposeActions`), delivered *through* the frozen `ctx`; *intended* — the single employee-facing **door**: every facet (`memory`, `tasks`, `events`, `comms`, …tools/api) over one `ctx`. Each facet is **independently composable** — the runtime composes them, they do not compose each other (§2 Facet Isolation Rule). The gate is a **pure policy leaf** and `proposeActions` is the **runtime composition** of that policy with mechanism — neither is a facet (§2 Policy vs Mechanism Rule). |
| **Consumes** | RunContext (its facets ride inside the immutable envelope); Shared Memory; the Task Engine (`ctx.tasks` = `BoundTasks`); the Event Spine (`ctx.events` binds `emitEvent`); the Communication Layer (`ctx.comms` binds `deliverDraft`); the **Approval Engine** (`ctx.proposeActions` hands a non-autonomous verdict to `requestApproval`); *(intended)* the API gateway, the Capability Registry. |
| **Does *not* own** | The envelope *shape* (RunContext owns it — the SDK populates facets *into* it); execution state; **cross-facet orchestration** (the runtime composes capability — §4.2 — so a facet never sequences another); the **mechanism** behind a verdict (the gate states *what is permitted*; the runtime requests approval or emits the audit — §2 Policy vs Mechanism Rule); the kernel primitives themselves (the SDK is their employee-facing **facade**, not their owner); capability enforcement (#014, sourced by #015). |

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
   today — only the memory, events, and comms facets exist (Phase A). **Permanent
   architectural objective** (CEO, on the acceptance of
   [ADR 0008](../decisions/0008-ai-sdk-envelope.md)): the SDK exposes *operating-system
   capabilities* and **never kernel implementation** — an employee knows *what it can do*
   and never needs to know *how the OS performs it*. This is the §2 **SDK ABI Principle**
   stated as a boundary: the surface the employee sees stays stable precisely because the
   implementation it hides is free to change.

   **Facets expose capability; the runtime composes it** — a CEO architectural principle set
   on the review of Directive #014 Phase A: *"SDK facets expose capability. The runtime
   composes capability. Cross-facet orchestration should remain inside the runtime rather
   than inside individual SDK modules."* This is the architectural form of the §2 **Facet
   Isolation Rule** and, stated positively, the §2 **Runtime Composition Rule** (set on the
   Phase B B2 review — the runtime is the *only* component that combines kernel capabilities into
   higher-level behaviour): because no facet depends on another, the only place capabilities are
   *combined* is the runner — so the facade stays a flat set of independent views, and sequencing
   logic (e.g. the Phase A evidence-drain, the Phase B doorman `ctx.proposeActions`) lives in the
   OS, never smuggled into a facet.

   **Policy ≠ mechanism** — the same boundary at the *enforcement* seam (§2 **Policy vs
   Mechanism Rule**, set on the Directive #014 Phase B review). The permission gate states
   *what is permitted* (a pure, declarative `GateVerdict`); the runtime decides *how* to act on
   that verdict (audit an autonomous decision, or request approval for a non-autonomous one).
   So the most security-critical code stays a pure, testable leaf the OS composes — the gate
   never reaches for a facet, and `proposeActions` (the composition) lives in the runner.
3. **The Event Spine observes; it does not own meaning.** Producers own verb semantics;
   the Spine guarantees only that the record is append-only and the vocabulary is closed.
4. **Approval decides; the Task Engine gates; the executor applies.** An approval outcome
   is a decision record; turning that decision into a held-or-released task is the Task
   Engine's reserved seam; and turning a *gate-cleared* action into a real effect is the
   **executor's** reserved seam (Phase C, [ADR
   0009](../decisions/0009-sdk-executor-apply-on-approval.md)) — none of the three absorbs
   another.

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
