# CrewFlow Governance — The Architecture Freeze

> **Status:** Governance **record**. This file names the platform contracts that
> are **architectural foundations** — the shared substrate every AI employee
> inherits — and freezes the rule that **changing any of them requires an explicit
> ADR _and_ an architectural review**, in the same PR as the change. Issued under
> CEO Directive **#011** (*Governance, Numbering & Scope Reconciliation*; Master
> Roadmap **D-01**).
>
> The freeze governs **how these contracts may change**, not whether they are
> finished. Several are only partially built or still reserved; the status column
> records that honestly. Freezing an unfinished contract means its *eventual* shape
> is load-bearing enough that it may not be altered casually — not that it already
> exists in full.

---

## 1. Why a freeze, and why now

CrewFlow's design rests on a single promise: **employee #42 inherits exactly the
same architecture as employee #3.** That promise only holds if the substrate every
employee stands on is stable. A change to the Event Spine, the SDK envelope, or the
`RunContext` is not a local edit — it silently re-shapes every employee that has
ever run or will ever run.

So these contracts are placed under a **freeze**: they remain changeable, but only
through a deliberate, reviewed, recorded path. The freeze is the mechanism that
keeps "shared substrate" from quietly forking into per-employee special cases.

This record does **not** itself change any contract. It enumerates them, records
their current build status truthfully, and binds the change-control rule.

---

## 2. The rule (what "frozen" means)

A contract in §4 is **frozen** in the following sense:

1. **No frozen contract changes without an ADR.** The change is recorded in
   `docs/bible/decisions/NNNN-*.md` (numbering per [`numbering.md`](./numbering.md)
   §5), in the **same PR** as the code/schema change — never after the fact.
2. **No frozen contract changes without an architectural review.** A human reviewer
   with substrate authority signs off that the change preserves the inheritance
   promise (or knowingly, explicitly breaks it with a migration plan).
3. **The ADR states the blast radius.** Because these contracts are inherited, the
   ADR must name *which employees and which historical rows* are affected, and how
   (migrate / alias / freeze).
4. **Extend before replace.** A frozen contract is widened by addition (new optional
   fields, new verbs appended to the registry) in preference to redefinition. A
   breaking redefinition is the exception that most needs the ADR + review.
5. **Validate against the reference path.** Every kernel capability should have one
   canonical end-to-end reference path that exercises it through the real runtime — for
   the AI SDK (contract #3), the **Reference Employee**
   (`__tests__/sdk/reference-employee.test.ts`, #014 Phase B B3). A change to a frozen
   contract is validated against its reference path **before** the platform expands on it:
   the **Reference Path Rule** ([Kernel Contract Map](./kernel-contract-map.md) §2).

Anything **not** in §4 is ordinary application code and changes through the normal
PR process — no ADR required.

---

## 3. How to read the status column

| Tag | Meaning |
|---|---|
| **Established** | Built and load-bearing in running code today. Evidence cited. |
| **Partial** | Real code exists but only covers part of the contract's intended surface. |
| **Reserved** | Specified in the Bible, **not yet built** in code. Frozen so its eventual shape is designed once, deliberately — not improvised. |

The freeze applies to **all three** tags. A Reserved contract is frozen precisely so
the *first* implementation goes through ADR + review rather than landing ad hoc.

---

## 4. The frozen contracts (the CEO-named ten)

| # | Contract | Status | Where it lives today |
|---|---|---|---|
| 1 | **Event Spine** | **Established** | Append-only `hq_events` with `hq_emit_event` AFTER-trigger enforcer (`supabase/migrations/20260720000000_hq_event_spine_core.sql` + producers/consumers/backfill); frozen verb registry `lib/events/registry.ts` |
| 2 | **Shared Memory** | **Established** *(prod migration gated)* | `supabase/migrations/20260713000000_hq_shared_memory.sql` + write/recall/embeddings/lifecycle/forget migrations; SDK facet `server/sdk/memory.ts`. Canonical Directive **#009**. |
| 3 | **AI SDK** | **Partial** | The **Memory facet** (`server/sdk/memory.ts` — `createMemory` / `BoundMemory`), plus the **events** and **comms** facets, the **output envelope** (`server/sdk/{events,comms,output}.ts`) and the runner's **evidence-drain** — shipped under **#014 Phase A** (**ADR 0008**; PRs #208→#209→#210 on the `#011` integration branch) — and the **permission doorman + P4**: the pure gate `server/sdk/gate.ts` (`evaluateAction → GateVerdict`) consumed by `ctx.proposeActions` in the runner, with `resolveEmployeePosture` and the `ai.action_permitted` audit verb — shipped under **#014 Phase B** (**ADR 0008** Decisions 4 & 8). The remaining envelope is built in small reviewable **Phase C** increments **C1 → C2 → C3 → C4** (authorised on the acceptance of **ADR 0009** — the SDK executor + apply-on-approval runtime; CEO independent CTO review, 2026-06-28): **C1**, the **typed tool registry contract** (`server/sdk/tools.ts`, descriptive only), and **C2**, the **executor contract** (`server/sdk/executor.ts` — registry consumption + the execution boundary, descriptive/dependency-injected only, no runner wiring), are **shipped** (PRs #219, #221, merged); **C3** (the apply-on-approval marker + applied/failure persistence + idempotency key strategy) is **authorised**, and the broader **executor rollout** and the **API gateway + cost metering** (**Phase D**) are **not yet written**. Contract #3 stays **Partial** until the full envelope lands, then graduates **Partial → Established**. The facet/enforcement standards introduced across the Phase A/B reviews and **Phase C** (the acceptance of **ADR 0009** and the **C1** and **C2** reviews) — the **Facet Isolation Rule** and its generalisation the **Runtime Composition Rule** (the runtime is the only composer of kernel capabilities; no facet orchestrates another), the *facets-expose / runtime-composes* principle, the **Policy vs Mechanism Rule** (the gate is pure policy; the runtime supplies mechanism), the **Executor Boundary Rule** (the executor applies only gate-cleared actions and is mechanism only — policy stays with the gate, approval with the Approval Engine, lifecycle with the Task Engine), the **Registry Immutability Rule** (tool definitions are immutable platform metadata, registered at initialisation; runtime execution consumes the registry and never mutates it), and the **Executor Idempotency Rule** (every executor-applied action is idempotent by design or protected by a deterministic idempotency key — derived from stable execution identity; the executor never relies on "probably once") — are homed in the [Kernel Contract Map](./kernel-contract-map.md) (§2 / §4.2 / §4.4). Owned by the AI SDK directive (D-04 / **#014**). |
| 4 | **RunContext** | **Established** *(cutover CEO-gated)* | The runner assembles one **frozen, immutable, infrastructure-free** contract per claim and threads it through every handler as the handler's sole argument: `{ task, identity, memory, tasks, correlationId, budget, deadline, signal, capabilities }`, `Object.freeze`-d (`server/sdk/tasks.ts` — `RunContext` + `TaskHandler` + `buildContext`). Graduated **Partial → Established** under **#013 / D-03** (**ADR 0007**): deadlines and **cooperative cancellation** are exposed as `ctx.signal` (the eighth entry point `hq_ai_task_cancel`, `supabase/migrations/20260805000000_hq_ai_task_cancel.sql` — **one** `SECURITY DEFINER` function, **zero** new columns/enums), `budget` is a read-only ceiling, and `capabilities` is a resolved opaque set (#013 **threads** it · #014 enforces · #015 sources). Three standing principles bind every later facet: the OS owns execution state, the context is immutable per invocation, the SDK is the only door. Canonical runtime identity **settled** here (`EmployeeIdentity.slug`; [`runtime-identity.md`](./runtime-identity.md) §7). Implemented on **PR #206** (base `#011` integration branch); cutover to `main`/prod CEO-gated. Completion record: [`directive-013-completion-report.md`](./directive-013-completion-report.md). |
| 5 | **Task Engine** *(generic)* | **Partial** | Generic, crash-safe `hq_ai_tasks` queue + state-machine guard + seven SECURITY DEFINER entry points (`supabase/migrations/20260802000000_hq_ai_tasks.sql`); **ADR 0004**. Shipped under **#012 / D-02**: PR-A (schema + sanctioned API), PR-B `task.*` spine emission (**ADR 0005**), PR-C the SDK runner (`server/sdk/tasks.ts`), PR-D the memory↔task binding (**ADR 0006**), PR-E/PR-F the two live workloads migrated (`research-ai`, `lead-qualification`), PR-G the unified operator read model (`server/services/hq-task-queue.ts` → `/admin/tasks`) — all merged to the `#011` integration branch (cutover to `main`/prod CEO-gated). **Partial** because the reserved seams — task dependencies/DAG (`depends_on`), approval-gated tasks, and verification — are inert pending their own ADRs. Completion record: [`directive-012-completion-report.md`](./directive-012-completion-report.md); live inheritance: [`../workforce/platform-compatibility-matrix.md`](../workforce/platform-compatibility-matrix.md). Spec: Bible `substrate/volume-12-task-engine.md`. |
| 6 | **Approval Engine** | **Established** | `supabase/migrations/20260730000000_hq_approvals.sql`; `server/services/hq-approvals.ts`; **ADR 0001**. Shipped under **#010**. |
| 7 | **Communication Layer** | **Established** *(PR pending merge)* | `supabase/migrations/20260801000000_hq_communications.sql`; `server/services/hq-comms.ts`; **ADR 0003**. **#010** Phase 4. |
| 8 | **Capability Registry** | **Reserved** *(data latent, scattered)* | No capability-registry table or resolver exists; employee scopes are enforced ad hoc. The registry's *data* already lives **scattered** on `ai_employees` (`tools_allowed text[]`, `permissions jsonb`, `memory_scope`, `department` — `supabase/migrations/20260712000000_ai_employees.sql`) plus the four registration surfaces named by the [platform-independence audit](./directive-012-platform-independence-audit.md). Owned by the **Capability Registry** directive (D-05 / **#015**), sequenced **last** by the [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md): it *consolidates* what #013 (RunContext) and #014 (SDK) settle, rather than being designed before them. |
| 9 | **Boardroom interfaces** | **Partial** *(read-only)* | Admin read surfaces only: `app/admin/*`, `server/services/ai-employee-stats.ts`, `lib/ai-employees/*`. No write/decision interface; the Boardroom observes, it does not yet act. |
| 10 | **Shared Communication Protocol** | **Reserved** *(spec only)* | Bible `substrate/volume-09-communication-protocol.md`. No **agent-to-agent** messaging in code — distinct from the (built) Communication Layer, which is outbound delivery to humans, not inter-employee messaging. |

> **Sibling note — Draft Generation (ADR 0002).** The shipped engine trio of
> **#010** is Approval (ADR 0001) · Draft (ADR 0002) · Communication (ADR 0003).
> Draft Generation (`supabase/migrations/20260731000000_hq_drafts.sql`,
> `server/services/hq-drafts.ts`) is **Established** and is governed by this freeze
> as a member of the same engine family, even though it is not one of the ten
> separately named contracts.

> **Protected-capability note — the Task Engine (ADR 0004).** Beyond the ordinary
> freeze rule, the Generic Task Engine (#5) is a **protected platform capability**.
> Every AI employee created after **#012 / D-02** inherits it, and **no employee may
> introduce a custom task runner, and no parallel queue implementations are
> permitted**. Any exception requires an ADR, an architectural review, **and** CEO
> approval — the same bar recorded in the
> [Constitution](../../crewflow-v1.0-constitution.md) §4 and the
> [roadmap](../../roadmap.md). This is stricter than the §2 rule: the §2 rule governs
> *changing* the contract; this one forbids *duplicating* it at all.

---

## 5. Two distinctions the freeze must not blur

- **Communication Layer ≠ Shared Communication Protocol.** #7 is the built,
  gated, audited substrate that delivers messages **outward to humans** (email and
  the like). #10 is the **not-yet-built** protocol by which employees message **each
  other**. They share a word, not a contract. Freezing both keeps the future
  inter-employee protocol from being improvised on top of the human-delivery layer.
- **AI SDK ≠ Shared Memory.** The Memory facet is the **only** part of the SDK that
  exists. "The SDK is built" would be an overclaim; "the SDK's memory facet is built"
  is the truth. The freeze covers the whole envelope so the rest is designed to match
  the facet, not the other way round.

---

## 6. Relationship to the rest of governance

- **Numbering:** directive/ADR/volume numbers are governed by
  [`numbering.md`](./numbering.md). ADRs referenced here (0001–0007) live in
  [`../decisions/`](../decisions/); the next free ADR number is **0009** (ADR `0008`, the
  AI SDK Envelope under D-04 / #014, is **Accepted**; contract #3 graduates Partial →
  Established on implementation).
- **Runtime identity:** the `actor_id` an employee stamps onto Event Spine rows is a
  separate frozen concern recorded in [`runtime-identity.md`](./runtime-identity.md);
  its canonical decision is owned by the **RunContext Runtime Contract** directive
  (D-03 / **#013**). The [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md)
  sequences the runtime contract ahead of the SDK and the registry precisely because
  identity must settle *before* a Capability Registry can key to it.
- **Kernel Contract Map:** the [Kernel Contract Map](./kernel-contract-map.md) is the
  **diagram** to this Freeze's **lock** — the single-page
  **Owns / Exposes / Consumes / Does-not-own** view of the six kernel contracts
  (`#1`–`#6`). The two are a **bound pair**: whenever a kernel contract changes here — its
  status or any of its boundaries — the map is updated **in the same PR**, and vice
  versa, so the lock and the diagram never drift. Synchronisation rule instituted by CEO
  directive on the map's approval.
- **What "done" looks like:** the bar for declaring these contracts *complete* (not
  merely frozen) is set by the **CrewFlow Version 1.0 Constitution**
  ([`../../crewflow-v1.0-constitution.md`](../../crewflow-v1.0-constitution.md)).

---

*Documentation only. No contract, schema, migration, or service was changed by this
record. It binds a change-control rule for future edits. Adopted under CEO Directive
#011 (Master Roadmap D-01).*
