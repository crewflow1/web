# ADR 0008 — The AI SDK Envelope

> **Status:** **Accepted** *(CEO independent CTO review, 2026-06-27)* — Directive #014
> implementation **authorised**, beginning with **Phase A** under per-phase review gates ·
> **Date:** 2026-06-27 · **Directive:** CEO Directive #014 / D-04 (the AI SDK Envelope) ·
> **Supersedes:** none · **Superseded by:** none · **Builds on:**
> [ADR 0007](./0007-runcontext-runtime-contract.md),
> [ADR 0004](./0004-generic-task-engine.md),
> [ADR 0001](./0001-approval-engine.md),
> [ADR 0003](./0003-communication-layer.md)
>
> Eighth ADR under the [`../README.md`](../README.md) *document-before-you-build* rule — in
> its **strictest** form, as for ADR 0007: the CEO directed that this decision be **written
> and reviewed before any implementation begins**, so it is authored ahead of the code. It
> formalises the CEO-approved [Directive #014 architecture
> proposal](../governance/directive-014-ai-sdk-envelope-architecture-proposal.md) and folds
> in the **three decisions returned by the CTO review** — the **API Gateway ↔ SDK
> boundary**, the **Tool Registry Principle**, and the **SDK Stability Rule**. The AI SDK is
> **frozen contract #3** ([architecture-freeze.md](../governance/architecture-freeze.md));
> on acceptance and implementation it graduates **Partial → Established**. This document
> changes no code, schema, migration, configuration, or git history.

---

## Context

CrewFlow's defining promise is that **employee #42 inherits exactly the same architecture
as employee #3**. At runtime that promise is carried by **RunContext** — frozen in #013
([ADR 0007](./0007-runcontext-runtime-contract.md)) to a nine-field, `Object.freeze`-d
envelope assembled per claim (`server/sdk/tasks.ts:178-214`, frozen at `:430`). #013
*deliberately left room* for the rest of the envelope: its own source comment names what it
omits — "comms, tools, the API gateway, cost metering, the approval runtime, autonomy and
verification (later directives that EXTEND this context)" (`server/sdk/tasks.ts:41-47`).

**Directive #014 is that extension.** It is the **AI SDK Envelope**: the single, uniform
interface every employee uses to reach the platform — `ctx.identity · memory · comms ·
events · tasks · tools · api`, wrapped by a permission gate, the autonomy test (P4), a cost
meter, and audit emission (Volume XIII §2). Today the envelope is **Partial**: the *only*
facet built is **memory** (`server/sdk/memory.ts`), plus the `tasks` create+checkpoint
surface (`server/sdk/tasks.ts:149-162`); the Architecture Freeze records contract #3 as
**Partial** for exactly this reason.

Like #013, #014 is **substantially a binding exercise**, though it builds more than #013
did. Four of its seven facets stand on substrate that already ships:

- **events** — binds the **Event Spine** (#1, Established): `lib/events/registry.ts` + the
  `hq_event_spine_*` migrations;
- **comms** — binds the **Communication Layer** (#7, Established): `server/services/hq-comms.ts`
  ([ADR 0003](./0003-communication-layer.md)) — *outbound to humans*, not the inter-employee
  protocol;
- **approval hand-off** — binds the **Approval Engine** (#6, Established):
  `server/services/hq-approvals.ts` ([ADR 0001](./0001-approval-engine.md));
- **memory** (#2) and **tasks** (#5) — **already on the frozen `ctx`**.

Cost metering **activates a reserved-inert seam**: `cost_micros` (`hq_ai_tasks` L153)
already exists as the spend counter, against the `cost_budget_micros` ceiling (L154) that
#013 already exposes read-only as `ctx.budget` (`server/sdk/tasks.ts:194`) — the division
[ADR 0007](./0007-runcontext-runtime-contract.md) Decision 8 reserved ("#013 makes the
limit visible … metering and enforcement are #014"). The genuinely **new** substrate is
narrow and named: the **API gateway** (the one net-new external integration), the **typed
tool registry** over the built `tools_allowed` labels, the **enforcement predicate** (the
doorman) that finally *reads* the capability set #013 threads, and the **autonomy
classifier (P4)**.

**The CTO review.** The CEO reviewed the architecture proposal and **approved its scope,
phasing, and dependency ordering**, returning one architectural clarification and two
additional standing rules — encoded below as first-class Decisions 5, 6, and 7, not
footnotes:

1. **The API Gateway ↔ SDK boundary.** *"Maintain a clear boundary between the API Gateway
   and the SDK. The API Gateway owns external integration, authentication, authorization,
   rate limiting, request auditing. The SDK owns developer-facing abstractions, typed
   interfaces, platform ergonomics. The SDK should consume the API Gateway. The API Gateway
   should never become an SDK implementation detail."*
2. **The Tool Registry Principle.** *"Tools describe capability. The Capability Registry
   authorizes capability. The Tool Registry must never become the authorization system.
   Authorization remains the responsibility of Directive #015."*
3. **The SDK Stability Rule.** *"The AI SDK is the primary developer interface to the
   CrewFlow Operating System. Backward compatibility should be treated as a design goal.
   Breaking SDK changes should be rare, documented, and justified through ADRs when
   appropriate."*

The clarification **sharpens** the binding thesis: the API Gateway is not an SDK internal
but a **separable component the SDK consumes**, so cost/secret/rate concerns live behind a
boundary the SDK never absorbs — and the gateway's *future* extraction into its own
directive remains a non-breaking move.

---

## Decision

**1. The envelope extends the frozen RunContext by addition; it never reopens it.** The
four facets (`comms`, `events`, `tools`, `api`) and the optional `inbound?` are added as
**new fields** on the same `ctx`; the nine frozen fields (`task, identity, memory, tasks,
correlationId, budget, deadline, signal, capabilities` — `server/sdk/tasks.ts:178-214`,
`Object.freeze`-d at `:430`) are **untouched** in name and semantics. This honours the
Architecture Freeze §2.4 rule, *extend before replace*. On implementation the envelope
graduates contract **#3 (AI SDK) Partial → Established**. The memory facet already proved
the pattern — built to its stable contract "so that `createContext()`, when it lands,
exposes it AS `ctx.memory` with **no change**" (Volume XIII §11).

**2. Each facet binds the kernel primitive that already owns its state; the SDK is a
facade, never a new owner.** `ctx.events` binds the Event Spine (#1); `ctx.comms` binds the
Communication Layer (#7); the approval hand-off binds the Approval Engine (#6); `ctx.memory`
(#2) and `ctx.tasks` (#5) are already present. The new substrate is the **typed tool
registry** (over `tools_allowed` labels) and the **API gateway**. The primitives keep their
authority; the facets are views delivered through `ctx`. This is the Kernel Contract Map
boundary made binding: *the AI SDK is a facade, not an owner.*

**3. Every handler returns the standard output envelope (P3); the handler return type
graduates.** The envelope is `{summary, reasoning, confidence, evidence[], alternatives[],
approvalRequired, actions[]}` (Volume XIII §10) — the one shape the Task Engine stores in
`result`, the verifier checks, the Approval Framework inspects, and Comms carries in a
reply. This graduates `TaskHandler` from `Promise<Record<string, unknown> | void>`
(`server/sdk/tasks.ts:223`) to the typed envelope — an **additive** widening of contract
#3's handler surface, which the runner already round-trips through `result`
(`completeTask(task.id, leaseOwner, result ?? null)`, `server/sdk/tasks.ts:516`). The
**evidence-drain hook** drains the memory facet's accumulated recalled-ids into
`result.evidence[]` in the runner **immediately before** completion; the OS still owns the
terminal transition (runner rules 3 & 4).

**4. The permission gate ("the doorman") is the enforcement predicate, and it is where C4
becomes structural.** Composed from three layers, evaluated on **every** SDK call (Volume
XIII §8): (1) employee posture `ai_employees.permissions` `{can_execute, requires_approval,
scopes}`; (2) capability scope; (3) the autonomy test **P4** — *reversible ∧ bounded ∧
type-target ∧ in-scope ∧ in-budget*. The check is **in the SDK and re-asserted in the
`SECURITY DEFINER` entry point** (defence in depth): even a buggy SDK cannot get an
unpermitted write past the guard. The employee process holds **no ambient authority** — no
DB handle, no API key, no service-role token; its only capability is "call the SDK" (§16).
This predicate **reads #013's resolved capability set** (`ResolvedCapabilitySet`,
`server/sdk/tasks.ts:103-106`) through a **resolver interface** whose only implementation
today reads the `ai_employees` row (`resolveEmployeeCapabilities`,
`server/sdk/tasks.ts:123-139`); #015 repoints that source with **no change** to the
contract a handler sees. The split holds at the gate: **#013 threads · #014 enforces · #015
sources** ([ADR 0007](./0007-runcontext-runtime-contract.md) Decision 7).

**5. The API Gateway ↔ SDK boundary (CEO clarification — first-class).** The boundary
between the gateway and the SDK must stay clear:

- **The API Gateway owns** — external integration, **authentication** (to external
  providers), **authorisation of the external call**, **rate limiting**, and **request
  auditing**. An employee calls `ctx.api.<provider>.<method>`; the gateway **meters cost**
  into `cost_micros` (`hq_ai_tasks` L153) and **enforces the budget *before* the call**
  against the ceiling #013 exposes read-only as `ctx.budget` (`server/sdk/tasks.ts:194`;
  [ADR 0007](./0007-runcontext-runtime-contract.md) Decision 8); it **holds the secrets**
  server-side (P5/C4, Volume XIII §13).
- **The SDK owns** — developer-facing abstractions, typed interfaces, and platform
  ergonomics.
- **The SDK *consumes* the API Gateway; the API Gateway *never* becomes an SDK
  implementation detail.** It is a **separable component the SDK calls**, not an internal of
  it. *Consequence (the CEO's intent):* the gateway's future extraction into its own
  directive or service is a **non-breaking** move, because the SDK only ever depended on its
  boundary, never on its internals.

**6. The Tool Registry Principle (CEO standing rule — first-class). Tools describe
capability; the Capability Registry authorises capability.** A registered tool carries a
typed arg schema, a **permission** (which scope it needs), a **cost** estimator, and a
**reversibility/blast-radius class** that feeds P4 (Volume XIII §12) — but it **does not
decide whether the employee may hold the capability**. The **Tool Registry must never
become the authorisation system; authorisation remains the responsibility of Directive
#015.** Two distinct authorisations **compose** and must not be conflated: **capability-holding
authorisation** (may this employee hold this capability at all? → #015, *sourced*) and
**external-call authorisation** (is this specific outbound call within budget / rate /
provider limits? → the API Gateway, Decision 5). The Tool Registry is **neither** — it is a
typed description.

**7. The SDK Stability Rule (CEO engineering standard — first-class). The AI SDK is the
primary developer interface to the CrewFlow Operating System.** Backward compatibility is a
**design goal**; breaking SDK changes are **rare, documented, and justified through ADRs**
when appropriate. This **specialises the kernel-stability principle** (Kernel Contract Map
§2) to the SDK's developer-interface role: because the SDK is frozen contract #3,
*extend before replace* (Architecture Freeze §2.4) is the **default mechanism** for every
future facet, and a breaking change is the exception that most needs an ADR + architectural
review. The rule is **homed alongside the kernel-stability principle in the Kernel Contract
Map §2** (the engineering-standards section) and recorded here.

**8. The autonomy / approval boundary.** #014 builds the **P4 autonomy classifier**, the
`proposeActions` surface, and the **hand-off to the already-built Approval Engine** (#6):
#014 *decides* an action needs approval and *requests* it through the built engine (Volume
XIII §15). The **task-lifecycle approval *mechanics*** — the `approval_status` seam and the
`waiting_approval` status transition on `hq_ai_tasks` — and **verification** defer to their
own directive ([ADR 0007](./0007-runcontext-runtime-contract.md) Decision 9). The Kernel
Contract Map §4.4 boundary holds: *Approval decides; the Task Engine gates.*

**9. Explicit deferrals — assembled *over* this envelope, not folded into it.**

- **To #015 (Capability Registry):** the single declarative registry + resolver
  (`hq_ai_capabilities`, Volume XIII §4 — **#015, not #014**), the authoring surface, and
  making `required_capability` (`hq_ai_tasks` L88) *enforceable against a real registry*.
  #014 enforces against the **resolved set**; it does not build the registry.
- **To their own directives:** the DAG (`depends_on`, L137); the approval **lifecycle**
  mechanics + verification (Decision 8); **versioning / lifecycle / health** (Volume XIII
  §17/§18/§20).
- **The `inbound?` slot is reserved additively, but inter-employee delivery is not built.**
  It leans on the **Reserved, unbuilt** Shared Communication Protocol (contract #10 —
  *distinct* from the built outbound Communication Layer #7, Architecture Freeze §5); #014
  reserves the optional field and triggers only from what exists.
- The Volume XIII §24 standing questions (runtime topology, model/provider strategy,
  inter-employee delegation limits) are **not #014**.

**10. Scope, phasing, blast radius, and the implementation gate.** The approved phasing is
**A** (`events` + `comms` facets + the P3 output envelope + evidence-drain) → **B** (the
doorman: the gate + P4 + `proposeActions` + the Approval-Engine hand-off) → **C** (the typed
tool registry) → **D** (the API gateway + live cost metering, **last**). The change is
**additive** — new `ctx` fields and a widened return type — so **no historical row is
rewritten** and the two live handlers (`research-ai`, `lead-qualification`) stay green.
**Implementation does not begin until this ADR is reviewed and approved** (the CEO's gate);
it is then held to the full validation discipline with the **Reference Employee** (Volume
XIII §22) as the acceptance harness. Directive #015 does not begin until #014 has a
completion report and CEO review.

---

## Alternatives weighed

- **Fold the Capability Registry into #014** (resolve *and* author capabilities here).
  **Rejected** — it is Directive #015 by the approved sequence; #014 enforces against the
  *resolved* set through a resolver interface, so the registry can be repointed later with no
  contract change (Decision 4). Building it now is the largest scope-creep risk (proposal
  §3.14a).
- **The API Gateway as an SDK module** (secrets, rate-limiting, retries living inside the
  SDK package). **Rejected by the CTO review** — it makes the gateway an SDK implementation
  detail, couples secret custody to the developer surface, and blocks the gateway's future
  extraction. Decision 5 makes the SDK *consume* a separable gateway.
- **The Tool Registry as the authorisation system** (a tool grant = a capability grant).
  **Rejected by the CTO review** — it conflates *describing* a capability with *authorising*
  it and would fork authorisation away from #015. Decision 6 keeps the registry descriptive.
- **Build the approval *lifecycle* mechanics in #014** (the `waiting_approval` transition +
  verification). **Rejected** — deferred to its own directive
  ([ADR 0007](./0007-runcontext-runtime-contract.md) Decision 9); #014 builds the *predicate*
  and the *request*, the engine owns the *gating* (Decision 8).
- **Build inter-employee `inbound?` delivery on contract #10.** **Rejected** — #10 is
  Reserved and unbuilt; building on it now would improvise the inter-employee protocol on top
  of the human-delivery layer (Architecture Freeze §5). Decision 9 reserves the slot only.
- **A god-object `ctx`** carrying every future facet "for completeness." **Rejected** — each
  facet must bind a live subsystem or genuinely new, named substrate; `inbound?` is the one
  reserved-but-inert field, bounded by being optional (the proposal's discipline test, §3.14).
- **Two ADRs (the envelope, and the gateway separately).** **Considered** — the gateway is
  the most separable piece. **Rejected for now**: the envelope is incomplete without
  `ctx.api`, so the gateway stays in #014 *phased last* (Decision 10); Decision 5's boundary
  is precisely what makes a *later* split non-breaking if the CEO chooses it.

---

## Consequences

**What the workforce inherits.** Every employee — present and future — receives **one
uniform door** to the platform: typed `comms` / `events` / `tools` / `api` facets over the
frozen RunContext, a single output envelope, one permission gate, one autonomy path, one
cost meter, and one audit log. A new employee inherits correct human-in-the-loop behaviour,
budget enforcement, and audit **for free** — it is "a configured instance of one blueprint"
(Volume XIII §25). Employee handlers get **smaller**, which is the Reuse-Index thesis and
the kernel-stability principle made concrete: *platform capability up, employee complexity
down*.

**Where C4 closes.** This is the directive where "the AI never bypasses security" stops
being doctrine and becomes a **structural property**: no ambient authority, the SDK the only
door, every call permission-checked in the SDK **and** re-asserted in the `SECURITY DEFINER`
guard, every call audited to the one log (C5), identity stamped by the SDK so the spoofing
class is designed out (Decisions 4 & 2).

**Blast radius.** *Code:* graduate the `RunContext` interface
(`server/sdk/tasks.ts:178-214`) by **addition** (`comms`, `events`, `tools`, `api`,
optional `inbound?`) and widen the `TaskHandler` return type (`:223`) to the P3 envelope;
both are additive, so the two live handlers stay green. *Schema:* `comms` / `events` /
`approval` bind existing tables (`hq_communications`, `hq_events`, `hq_approvals`) and cost
metering **writes the existing `cost_micros` column** — the genuinely new persistence is
whatever the **typed tool registry** and the **API gateway** require (a tool/provider
registry + per-call audit rows), settled within this ADR's scope at implementation and held
to *extend before replace*. *No* new task-lifecycle column (the approval-lifecycle seam is
deferred). *Reversibility:* the new `ctx` fields are additive; the gateway sits behind a
boundary (Decision 5) so it can be extracted later without touching handlers.

**Enforcement.** The test matrix the envelope must pass: the gate denies by default (an
unpermitted write refused in the SDK **and** by the `SECURITY DEFINER` re-check); the
gateway refuses a budget-busting call *before* it is made; identity-stamping proves a
handler cannot spoof another employee's `actor_id`; the evidence-drain populates
`result.evidence[]`; P4 routes reversible→autonomous and irreversible→approval; the
Reference Employee exercises every facet end to end; the six-gate CI and the #012/#013
runner suites stay green.

**Freeze status & synchronisation.** Contract #3 (AI SDK) is **Partial** today and **stays
Partial until this ADR is accepted and implemented**; on implementation it graduates
**Partial → Established**. Per the synchronisation rule instituted with the
[Kernel Contract Map](../governance/kernel-contract-map.md), the graduation updates **both**
the Architecture Freeze (§4 row 3) **and** the Kernel Contract Map (the AI SDK row) **in the
same PR**. The three CTO-review decisions are **standing**: the API-Gateway/SDK boundary and
the Tool-Registry/authorisation split bind #015 and every later facet, and the SDK Stability
Rule binds every future SDK change. **Update (2026-06-28):** implementation is now complete through
**Phase C** (the CEO ruled Directive #014 complete at Phase C; C1–C4 merged), so the graduation
predicted here has **occurred** — contract #3 is now **Established** (this completion-record PR
updates the Architecture Freeze §4 row 3 and the Kernel Contract Map together, honouring the
synchronisation rule above).

**Numbering.** This is ADR **0008**
([`../governance/numbering.md`](../governance/numbering.md) §5); ADR numbers are monotonic
and never reused. The number is **reserved on creation**; this ADR is **Proposed · held for
CEO review**, so it is registered in §5 as *Proposed* and the next free ADR number advances
to **`0009`**. Per the Architecture Freeze §2, the architectural-review sign-off for the
*contract change itself* travels with the implementation PR(s) that carry the code; this
decision record — once **accepted** by the CEO — is those PRs' prerequisite, and **no #014
implementation begins before that acceptance**.

**Acceptance & implementation authorisation.** Accepted by the CEO on independent CTO
review (2026-06-27): the API-Gateway/SDK separation, the Tool Registry Principle, the SDK
Stability Rule, the SDK phasing, and every deferral (Capability Registry, authorisation,
inter-employee protocol, health expansion) are approved, and **Directive #014 implementation
is authorised**. On acceptance the CEO introduced **two further permanent rules**, homed in
the [Kernel Contract Map](../governance/kernel-contract-map.md): the **SDK ABI Principle**
(§2 — the SDK is the stable application interface; kernel, internal, and database
implementation may evolve beneath it; compatibility is preserved unless a documented
architectural reason, carried by an ADR, requires otherwise) and the **capability-exposure
objective** (§4 — the SDK exposes *operating-system capabilities* and **never kernel
implementation**; an employee knows *what it can do*, never *how the OS performs it*).
Implementation follows the approved phased plan, beginning with **Phase A** (events + comms
facets · the P3 output envelope · the evidence-drain hook); **no later phase begins until the
current one has completed implementation, passed the full validation suite (TypeScript · lint
· unit · integration · security · production build), received architectural review, and
received CEO approval.** Directive #015 stays out of scope until #014 is complete.

**Phase A — reviewed, approved, merged (2026-06-27).** The `events` + `comms` facets, the
output envelope (`server/sdk/output.ts`), and the runner's evidence-drain hook were
implemented, passed the full six-gate validation suite (TypeScript · lint · unit ·
integration · security · production build), received architectural review, and were merged
to the `#011` integration branch (PRs #208 → #209 → #210). On the Phase A review the CEO
introduced **two further permanent rules**, homed in the
[Kernel Contract Map](../governance/kernel-contract-map.md) alongside the SDK Stability Rule
and the SDK ABI Principle: the **Facet Isolation Rule** (§2 — each SDK facet is
independently composable; facets do not depend on one another; the runtime composes the
facets) and its architectural form, **facets expose capability, the runtime composes it**
(§4.2 — *"cross-facet orchestration should remain inside the runtime rather than inside
individual SDK modules"*). Contract #3 remains **Partial** (Phase A is a partial envelope);
it graduates **Partial → Established** when Phases B–D complete the envelope. Per the
synchronisation rule, this Phase A canon update touches **both** the Kernel Contract Map and
the [Architecture Freeze](../governance/architecture-freeze.md) §4 row 3 in the same PR.

---

*Documentation only. No code, schema, migration, configuration, or git history was changed
by this record. Authored ahead of implementation under the document-before-you-build rule at
the CEO's direction, and **accepted by the CEO on independent CTO review (2026-06-27)**:
Directive #014 implementation is **authorised**, beginning with Phase A under per-phase
review gates. Prepared for CEO Directive #014 / D-04 (the AI SDK Envelope); it formalises
the CEO-approved
[architecture proposal](../governance/directive-014-ai-sdk-envelope-architecture-proposal.md)
and the three decisions returned by the CTO review — the API Gateway ↔ SDK boundary, the
Tool Registry Principle, and the SDK Stability Rule — encoded above, and is the prerequisite
the now-authorised implementation PRs build upon.*
