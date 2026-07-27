# CrewFlow Governance — Directive #014 (D-04) Architecture Proposal: the AI SDK Envelope

> **Status:** **Architecture proposal — design only.** This document presents the
> architecture for **Directive #014 / Master Roadmap D-04 — the AI SDK Envelope**, the
> step the CEO authorised after the merge of PR #206: *"Present the architecture proposal
> for Directive #014. Do not begin implementation until the Directive #014 proposal has
> been reviewed and approved."* It is **held pending CEO review and approval**; **no
> implementation begins** until it is approved. The document itself changes no code,
> schema, migration, configuration, or git history.
>
> **Sequence context.** The forward sequence — **D-03 / #013 RunContext → D-04 / #014 AI
> SDK Envelope → D-05 / #015 Capability Registry** — was approved by the CEO (Option B) on
> the evidence of the
> [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md) and
> recorded in [`numbering.md`](./numbering.md) §3 (row **#014**). #013 is complete (its
> [completion report](./directive-013-completion-report.md); [ADR
> 0007](../decisions/0007-runcontext-runtime-contract.md)) and the RunContext is now a
> **frozen, Established** kernel contract. #014 is the next directive to be *issued*.

---

## 1. How to read this

The CEO's mandate for this step is to **present the architecture and hold for review** —
not to begin building. §2 gives the one-paragraph thesis. §3 answers, in order, the
fixed set of architecture-review questions a CTO would ask before approving an ABI this
load-bearing (each in its own subsection). §4 is an illustrative — **not implemented** —
interface sketch. §5 is the *fill-the-slots* map that backs the "binds reserved seams and
already-built subsystems" claim with `file:line` evidence. §6 draws the in/out scope
boundary and recommends **phasing within #014**. §7 surfaces the genuine scope forks as
**explicit questions for the CEO to rule on** — it does **not** decide the roadmap. §8
records status; §9 is reserved for the CEO's review outcome.

Every factual claim is cited to repository evidence verified at the current integration
tip. This proposal aligns with the standing principle homed in the [Kernel Contract
Map](./kernel-contract-map.md) §2 — *kernel contracts grow more stable; employee
implementations grow easier to change* — and is measured by the [Platform Reuse
Index](./platform-reuse-index.md). **The proposal proposes; it does not build.**

---

## 2. The thesis (one paragraph)

**#014 is the ABI that *fills the slots #013 froze* — it makes the inert live, binds the
already-built engines into facets, and adds exactly one genuinely new chokepoint (the API
gateway) — and it is the directive where C4, "the AI never bypasses security," stops being
a promise and becomes structural.** #013 froze a nine-field RunContext and *deliberately
left room* for the rest of the envelope: its own source comment names what it omits —
"comms, tools, the API gateway, cost metering, the approval runtime, autonomy and
verification (later directives that EXTEND this context)" (`server/sdk/tasks.ts:41-47`).
#014 is that extension. Most of it is **reuse, not invention**: the `events` facet binds
the built Event Spine (contract #1; `lib/events/registry.ts`); the `comms` facet binds the
built Communication Layer (contract #7; `server/services/hq-comms.ts`); the approval
hand-off binds the built Approval Engine (contract #6; `server/services/hq-approvals.ts`);
`memory` and `tasks` are **already on the frozen `ctx`**; and cost metering activates the
reserved-inert `cost_micros` seam (`hq_ai_tasks` L153) against the `cost_budget_micros`
ceiling #013 already exposes as `ctx.budget` (`server/sdk/tasks.ts:194`). What is
genuinely **new** is narrow and named: the **API gateway** (the only net-new external
integration), the **typed tool registry** over the built `tools_allowed` labels, the
**enforcement predicate** (the doorman) that finally *reads* the capability set #013 only
threads, and the **autonomy classifier (P4)**. So #014 graduates contract **#3 (AI SDK)
Partial → Established** (`numbering.md` §3 row #014) by *assembling over* the frozen
RunContext — adding facet fields by **extension, never redefinition** (Architecture Freeze
§2.4) — not by reopening it. The split the dependency analysis proved holds at every gate:
**#013 threads · #014 enforces · #015 sources** (ADR 0007, Decision 7).

---

## 3. The questions, answered

### 1. What exactly is the AI SDK Envelope, and what does "Partial → Established" mean here?

The **AI SDK Envelope** is the single, uniform interface every AI employee uses to reach
the platform — the `ctx` an employee's handler receives, complete with the facets that
today are missing. It is the "single door" the Kernel Contract Map names: a *facade* over
the kernel primitives, delivered **through the frozen RunContext**, never a new owner of
their state. Volume XIII §2 draws it as the ABI: `ctx.identity · ctx.memory · ctx.comms ·
ctx.events · ctx.tasks · ctx.tools · ctx.api`, wrapped by a permission gate, the autonomy
test (P4), a cost meter, audit emission, and health/metrics
(`docs/bible/substrate/volume-13-ai-sdk.md:54-75`).

**"Partial" today** is literal and narrow: the *only* facet that exists is **memory**
(`server/sdk/memory.ts` — `createMemory` / `BoundMemory`), plus the `tasks` create+checkpoint
surface the engine carries (`server/sdk/tasks.ts:149-162`). The Architecture Freeze records
contract **#3 (AI SDK)** as **Partial** for exactly this reason — "only the **Memory facet**
is built … the full per-employee SDK envelope is not yet written"
(`architecture-freeze.md` §4 row 3). **"Established"** is reached when the remaining facets
(`comms`/`events`/`tools`/`api`), the standard output envelope, the permission gate, and
cost metering are built **to one uniform contract** so that *any* employee is "a configured
instance of one blueprint" (Volume XIII §25). The canonical scope is fixed in `numbering.md`
§3 row #014: *"The full per-employee SDK envelope (`comms`/`events`/`tools`/`api` facets)
assembled over the frozen RunContext, reading the existing `ai_employees` scope columns.
Graduates contract #3 (AI SDK) Partial → Established."*

### 2. What does #014 own, and what does it deliberately *not* own?

**#014 owns** the *employee-facing surface and its enforcement*: the typed facets
(`comms`/`events`/`tools`/`api`), the standard output envelope (P3), the permission gate
("the doorman"), the autonomy classifier (P4), cost metering, the API gateway, and the
SDK-side audit emission. In Kernel-Contract-Map terms it **owns the facade**; it does
**not** own the primitives behind the facets — those keep their authority (the boundary
"the AI SDK is a facade, not an owner", Kernel Contract Map §4.2).

**#014 deliberately does not own:**

- **The RunContext shape** — contract #4 owns it; #014 *populates facets into it*
  additively and may not redefine the nine frozen fields (Kernel Contract Map §3, AI SDK
  *Does-not-own*; Architecture Freeze §2.4 "extend before replace").
- **Execution state** — the OS/Task Engine owns cancellation, deadlines, budget ceilings,
  leases, retries; the SDK *exposes and consumes*, never mutates (ADR 0007 Decision 2; the
  standing kernel rule).
- **Where capability tokens come from** — #014 *enforces* the resolved set; **#015 sources**
  it (ADR 0007 Decision 7). #014 reads tokens through a resolver interface that **today reads
  `ai_employees`** and is repointed by #015 with no contract change.
- **The Capability Registry table/resolver, the DAG (`depends_on`), the approval *lifecycle*
  mechanics, and verification** — each deferred to #015 or to its own directive (ADR 0007
  Decision 9; see §3.10).

### 3. How does it relate to the frozen RunContext — does #014 change the #013 contract?

**No field of the frozen contract changes; #014 widens by addition.** RunContext is
Established and frozen (`{ task, identity, memory, tasks, correlationId, budget, deadline,
signal, capabilities }`, `Object.freeze`-d at `server/sdk/tasks.ts:430`). The Architecture
Freeze's fourth rule is **"extend before replace": a frozen contract is widened by addition
… in preference to redefinition** (`architecture-freeze.md` §2.4). #014 adds the new facets
as **new fields** on the same `ctx` (`comms`, `events`, `tools`, `api`, and the optional
`inbound?`); it touches **none** of the nine frozen fields' names or semantics. The memory
facet already proved this pattern: it was built "to its stable contract so that
`createContext()`, when it lands, exposes it AS `ctx.memory` with **no change** to the
facet" (Volume XIII §11, `volume-13-ai-sdk.md:274-277`).

Because #014 *touches* two frozen contracts — it **graduates #3 (AI SDK)** and **extends
the surface of #4 (RunContext)** by addition — the Architecture-Freeze change-control rule
applies to **both**: an **ADR + an architectural review in the same PR** (§2.1–2.2). That
is recorded in §3.11.

### 4. The facets, one by one — which already-built subsystem does each stand on?

The honest answer to "how much of #014 is new code?" is this table. Four of the seven
facets bind a subsystem that **already ships**; two are already on the frozen `ctx`; only
**one** facet (`api`) is net-new external integration.

| Facet | Stands on | Built today? | #014's job |
|---|---|---|---|
| `memory` | Shared Memory (contract #2), `server/sdk/memory.ts` | **Yes — already on `ctx`** | none new — drain `evidence[]` on completion (§3.5) |
| `tasks` | Task Engine (contract #5), `BoundTasks` | **Yes — already on `ctx`** | none new (create+checkpoint only, by rule) |
| `events` | Event Spine (contract #1), `lib/events/registry.ts` | **Yes (Established)** | **bind** — typed `ctx.events.publish/subscribe`; validate against the frozen verb registry; stamp identity+correlation; emit in-transaction |
| `comms` | Communication Layer (contract #7), `server/services/hq-comms.ts` | **Yes (Established)** | **bind** — `ctx.comms` over the gated outbound-to-humans service (ADR 0003) |
| `tools` | `ai_employees.tools_allowed text[]` labels | **Labels only (inert)** | **build** the typed tool registry: each tool = arg schema + permission + cost estimator + reversibility class (feeds P4); invoked via `ctx.tools.invoke` |
| `api` | *(none — external providers)* | **No — net-new** | **build** the API gateway: the single chokepoint for every external call (§3.7) |
| `inbound?` | Shared Communication Protocol (contract #10) | **No — Reserved (spec only)** | **reserve the slot**; its trigger substrate is unbuilt (see §3.10 / §7) |

`ctx.events` binds the verb registry and emits in-transaction, so "all audit events the SDK
emits on the employee's behalf also flow here — one log (C5)" (Volume XIII §14). `ctx.comms`
binds the **outbound-to-humans** Communication Layer — *not* the inter-employee protocol,
which the Architecture Freeze §5 is explicit must not be conflated.

### 5. The standard output envelope (P3) — and the `TaskHandler` return-type graduation

Today a handler returns `Promise<Record<string, unknown> | void>`
(`server/sdk/tasks.ts:223`) and the runner stores whatever it returns:
`completeTask(task.id, leaseOwner, result ?? null)` (`server/sdk/tasks.ts:516`). #014
**graduates the return type** to the standard AI output envelope (P3): `{summary, reasoning,
confidence, evidence[], alternatives[], approvalRequired, actions[]}` (Volume XIII §10,
`volume-13-ai-sdk.md:246-251`). Uniform output is what lets *any* employee's work be
"explainable and gateable without bespoke handling" — it is the one shape "the Task Engine
stores in `result`, the verifier checks, the Approval Framework inspects, and the
Communication Protocol carries in a reply."

This is an **additive graduation of contract #3's handler surface** (a widened return type
the runner already round-trips through `result`), recorded by the #014 ADR. It carries one
small, named hook: the **evidence-drain**. The memory facet already accumulates recalled
ids for exactly this purpose ("recalled ids accumulated (`evidence()`) for the output
envelope", Volume XIII §11), and the surrounding hook that "drains `evidence()` into
`result.evidence[]`" on completion is named as not-yet-built there
(`volume-13-ai-sdk.md:272-274`). #014 builds that drain in the runner, immediately before
`completeTask` — the OS still owns the terminal transition (rule 3/4).

### 6. The permission gate ("the doorman") — where C4 becomes structural

This is the heart of #014 and the point at which **C4 ("the AI never bypasses security")
stops being doctrine and becomes a structural property of the runtime.** Volume XIII §8
composes the gate from three layers, evaluated on **every** SDK call: (1) employee posture
`ai_employees.permissions` `{can_execute, requires_approval, scopes}`; (2) capability scope
(per-capability grant); (3) the autonomy test P4 — *reversible ∧ bounded ∧ type-target ∧
in-scope ∧ in-budget* (`volume-13-ai-sdk.md:196-217`). The defining property is **defence
in depth**: the check is "**in the SDK and re-asserted in the SQL entry point** … even a
buggy SDK can't get an unpermitted write past the `SECURITY DEFINER` guard"
(`volume-13-ai-sdk.md:219-222`). Security §16 states the same as "no ambient authority":
the employee process holds "**no DB handle, no API key, no service-role token** … its only
capability is 'call the SDK'" (`volume-13-ai-sdk.md:337-342`).

This is precisely the **enforcement predicate ADR 0007 Decision 9 assigns to #014: "the
enforcement predicate that reads #013's resolved capability set."** #013 threaded that set
onto `ctx.capabilities` as an **opaque, read-only, source-indifferent** value
(`ResolvedCapabilitySet`, `server/sdk/tasks.ts:103-106`) and resolved it from the one
source it was allowed to read — the `ai_employees` row (`resolveEmployeeCapabilities`,
`server/sdk/tasks.ts:123-139`). #014 writes the predicate that *interprets and matches* a
token; it reads through a **resolver interface** whose only implementation today reads
`ai_employees`, so #015 repoints the source "by changing ONLY this function — the
`ResolvedCapabilitySet` every handler sees stays byte-for-byte identical"
(`server/sdk/tasks.ts:118-121`). The contract a handler sees does not move when the source
does. That is the **#013 threads · #014 enforces · #015 sources** split, made operational.

### 7. Cost metering and the API gateway — the heaviest, most secret-bearing piece

The **API gateway** is the one genuinely new external integration. An employee "never calls
Anthropic/OpenAI/Twilio/Resend/Companies House directly. It calls `ctx.api.<provider>.<method>`,
which routes through the SDK API gateway — the single chokepoint for every external call"
(Volume XIII §13, `volume-13-ai-sdk.md:290-307`). The gateway: **meters cost** into the
task's `cost_micros` and **enforces the budget *before* the call** (a call that would bust
budget is refused → approval/escalation); **rate-limits & retries** per provider centrally;
**audits** every call (`api.called`, never the secret); and **holds the secrets** in the
server env, "never in an employee's reach (P5/C4)."

Cost metering **activates a reserved-inert seam**: `cost_micros` already exists on
`hq_ai_tasks` (L153) as the spend counter, against the `cost_budget_micros` ceiling (L154)
that #013 already exposes read-only as `ctx.budget` (`server/sdk/tasks.ts:194`). ADR 0007
Decision 8 reserved this exact division of labour: "*#013 makes the limit visible; it does
not count spend. Metering (`cost_micros`, L153) and enforcement (the API gateway refusing a
call that would bust budget) are #014*" (`0007-runcontext-runtime-contract.md:193-194`). So
the gateway *fills the meter behind the ceiling #013 froze*.

Because the gateway is the heaviest, most infrastructure- and secret-bearing, most
"external-world" piece — and the most separable — it is the natural **last phase of #014**,
and it is the one component for which a **split into its own directive is a coherent option**
(mirroring how Option B split RunContext from the SDK). This proposal **recommends keeping it
in #014, phased last**, and surfaces the split as a CEO decision in §7.

### 8. The autonomy framework (P4) and the approval hand-off

Autonomy is "made mechanical" at the ABI: the handler **never decides its own autonomy** —
it produces actions and calls `ctx.proposeActions(actions)` (or returns them in the P3
envelope); the **SDK** runs the autonomy test P4 per action. **Pass → apply + audit; fail →
park** as a `waiting_approval` task surfaced to a human, then applied with the same audit
trail attributing the approver (Volume XIII §15, `volume-13-ai-sdk.md:318-331`). There is
exactly **one** approval path, so "a new employee inherits correct human-in-the-loop
behaviour for free." This is the operational closure of **C2** (humans-decide vs autonomy).

A scope line must be drawn carefully here, because ADR 0007 Decision 9 sends *some* of this
to #014 and *some* to "their own directives." This proposal reads the split as:

- **In #014:** the **autonomy classifier (P4)** itself, the `proposeActions` surface, and
  the **hand-off to the already-built Approval Engine** (contract #6, `server/services/hq-approvals.ts`,
  ADR 0001) — i.e. #014 *decides* an action needs approval and *requests* it through the
  built engine.
- **Deferred to its own directive (ADR 0007 Decision 9 — "approval lifecycle, verification"):**
  the **task-lifecycle approval mechanics** — the `approval_status` seam and the
  `waiting_approval` status transition on `hq_ai_tasks` (the reserved Approval-lifecycle
  seam), and **verification**. These are the Task Engine's reserved seams, not the SDK's
  surface; the Kernel Contract Map §4.4 boundary holds — *Approval decides; the Task Engine
  gates.*

This division keeps #014 building the *predicate and the request*, while the *gating
mechanics* stay with the engine that owns task state. §7 flags it for the CEO to confirm.

### 9. Audit, identity-stamping, and "one log" (C5)

#014 generalises the memory facet's most important safety property to every facet:
**identity is stamped by the SDK from the authenticated context, never set by the handler**
— "the spoofing class is designed out" (Volume XIII §11, `volume-13-ai-sdk.md:266-268`;
§16 "no spoofing, no escalation"). Every SDK call emits to the **one** event log through
`ctx.events`/the Event Spine, so "other logs are projections" — the resolution of **C5**
(parallel audit logs). The complete answer to "what did this AI do and was it allowed to?"
remains a single query: `WHERE actor_id = slug ORDER BY id` (`volume-13-ai-sdk.md:347-348`).
This requires no new audit substrate — it binds the built Event Spine (contract #1) — and is
why scope enforcement stays **server-side** in the SQL, with the facet able only to "narrow
ergonomics, never widen scope" (the memory precedent, `volume-13-ai-sdk.md:269-270`).

### 10. What defers to #015, and to other directives?

Held strictly to ADR 0007 Decision 9:

- **To #015 (Capability Registry):** the single declarative registry table + resolver
  (`hq_ai_capabilities`, Volume XIII §4 — this DDL is **#015, not #014**), the authoring
  surface, consolidating the four scattered registration surfaces, and making
  `required_capability` (`hq_ai_tasks` L88) *enforceable against a real registry*. #014
  enforces against the **resolved set**; it does not build the registry.
- **To their own directives:** the DAG (`depends_on`, `hq_ai_tasks` L137), the **approval
  *lifecycle*** mechanics (§3.8), and **verification**.
- **Open for a CEO ruling (Volume XIII §3 lists them "To build" but ADR 0007 does not assign
  them to #014):** **versioning / lifecycle / health** (Volume XIII §17/§18/§20). This
  proposal recommends **deferring** them — they are outside the `numbering.md` row-#014 scope
  ("comms/events/tools/api facets") — and flags the recommendation in §7.

### 11. What ADR(s) and architectural review does #014 require?

One new ADR — the **next free number is 0008** (`architecture-freeze.md` §6 records 0007 as
the last issued). It records: the four new facets as additive RunContext fields; the P3
output envelope + the `TaskHandler` return-type graduation; the permission gate / P4 / the
enforcement predicate and its resolver interface; cost metering + the API gateway; and the
audit/identity invariants. Because #014 **touches two frozen contracts** — graduating **#3
(AI SDK)** and extending the surface of **#4 (RunContext)** by addition — the Architecture
Freeze requires the ADR **and** an architectural review **in the same PR as the change**,
stating the **blast radius**: every employee inherits the new envelope, so the ADR names
which employees and which historical rows are affected (here: additive, so no historical
re-write — every existing handler keeps working because the new fields are *additions*).

### 12. Tests and validation discipline

The same bar #013 was held to: typecheck · lint · unit · integration · security · production
build, plus facet-specific coverage — the gate's deny-by-default behaviour (an unpermitted
write is refused in the SDK **and** by the `SECURITY DEFINER` re-check); the gateway
refusing a budget-busting call *before* it is made; identity-stamping proving a handler
cannot spoof another employee's `actor_id`; the evidence-drain populating `result.evidence[]`;
and the P4 classifier routing reversible→autonomous, irreversible→approval. The **Reference
Employee** (Volume XIII §22) is the proof harness — one employee exercising every facet end
to end before the envelope is declared Established.

### 13. Migrations / schema footprint

Smaller than its surface suggests, because so much is binding. **No new table is required
for the facets themselves** — `comms`/`events`/`approval` bind existing tables
(`hq_communications`, `hq_events`, `hq_approvals`), and cost metering **writes the existing
`cost_micros` column** (`hq_ai_tasks` L153) rather than adding one. The genuinely new
persistence is whatever the **typed tool registry** and the **API gateway** need (e.g. a
tool/provider registry and per-call audit rows) — to be settled by the #014 ADR, and kept
to the "extend before replace" discipline. The autonomy/approval **lifecycle** mechanics
(the `approval_status` transition) are **deferred** (§3.8/§3.10), so #014 adds **no** new
task-lifecycle column.

### 14. What would make #014 over-engineered?

The traps, named so the review can watch for them: **(a)** building the **Capability
Registry** inside #014 instead of enforcing against the resolved set (that is #015 — the
biggest scope-creep risk); **(b)** building the **approval *lifecycle*** mechanics +
verification rather than handing off to the built Approval Engine (that is a later
directive); **(c)** adding **versioning/lifecycle/health** before any employee needs them;
**(d)** building the **`inbound?`** inter-employee trigger on top of the **unbuilt**
contract #10 (Shared Communication Protocol) instead of reserving the slot; **(e)**
inventing a new audit log instead of binding the Event Spine; **(f)** putting *any*
infrastructure on `ctx` — the SDK is a facade, and ADR 0007 Decision 4 forbids SQL/clients
on the context. The discipline that keeps #014 honest is the Reuse Index thesis: **platform
capability up, employee complexity down** — every facet should make employee handlers
*smaller*.

---

## 4. Illustrative target shape (design only — not implemented)

A sketch to make the additive extension concrete. **This is not an implementation**; the
exact types are settled by the #014 ADR and PRs. The nine frozen fields are shown unchanged;
the new members are marked.

```ts
// EXTENDS the frozen RunContext by ADDITION (Architecture Freeze §2.4).
// The nine frozen fields are UNCHANGED (server/sdk/tasks.ts:178-214).
interface RunContext {
  // ── frozen by #013 (contract #4) — unchanged ──────────────────────────────
  task: TaskRow;
  identity: EmployeeIdentity;
  memory: BoundMemory;                 // contract #2 — already present
  tasks: BoundTasks;                   // contract #5 — create + checkpoint only
  correlationId: string;
  budget: number;                      // read-only ceiling (#014 meters behind it)
  deadline: Date | null;
  signal: AbortSignal;
  capabilities: ResolvedCapabilitySet; // opaque; #014 ENFORCES, #015 SOURCES

  // ── added by #014 (contract #3 facets) — all additive ─────────────────────
  comms: BoundComms;                   // binds Communication Layer (contract #7)
  events: BoundEvents;                 // binds Event Spine      (contract #1)
  tools: BoundTools;                   // typed registry over tools_allowed labels
  api: ApiGateway;                     // the single external-call chokepoint (NEW)
  inbound?: InboundMessage;            // slot reserved; substrate is contract #10 (unbuilt)

  proposeActions(actions: ProposedAction[]): Promise<void>; // P4 runs per action
}

// The standard AI output envelope (P3) — Volume XIII §10.
// GRADUATES the handler return type from `Record<string, unknown> | void`.
interface AiOutput {
  summary: string;
  reasoning: string;
  confidence: number;
  evidence: Ref[];        // drained from ctx.memory's recalled ids on completion
  alternatives: string[];
  approvalRequired: boolean;
  actions: ProposedAction[];
}
type TaskHandler = (ctx: RunContext) => Promise<AiOutput | void>;

// The doorman reads the RESOLVED set through a resolver interface whose only
// implementation today reads ai_employees; #015 repoints it with no contract change.
interface CapabilityResolver {                 // #015 swaps the implementation
  resolve(identity: EmployeeIdentity): ResolvedCapabilitySet;
}
function permitted(action: ProposedAction, ctx: RunContext): GateDecision {
  // (1) employee posture  (2) capability scope  (3) autonomy test P4
  // checked HERE and re-asserted in the SECURITY DEFINER entry point (defence in depth)
}
```

---

## 5. The fill-the-slots map (binds, builds — the evidence)

The backbone of the thesis: most #014 deliverables **activate a reserved seam or bind a
built subsystem**; a minority are genuinely new. Every row is cited.

| #014 deliverable | Binds / activates | Build vs bind | Evidence |
|---|---|---|---|
| `events` facet | Event Spine (contract #1) | **bind** | `lib/events/registry.ts`; `…hq_event_spine_core.sql` |
| `comms` facet | Communication Layer (contract #7) | **bind** | `server/services/hq-comms.ts`; ADR 0003 |
| approval hand-off | Approval Engine (contract #6) | **bind** | `server/services/hq-approvals.ts`; ADR 0001 |
| cost metering | `cost_micros` seam (inert) | **activate** | `hq_ai_tasks` L153; ADR 0007 Dec. 8 |
| budget enforcement | `cost_budget_micros` → `ctx.budget` | **activate** | `tasks.ts:194`; ADR 0007 Dec. 8 |
| enforcement predicate | `ctx.capabilities` (threaded by #013) | **build (reads resolver)** | `tasks.ts:103-139`; ADR 0007 Dec. 7/9 |
| evidence-drain | memory facet's recalled-ids | **build (hook)** | `volume-13-ai-sdk.md:272-274` |
| P3 output envelope | `TaskHandler` return; `result` round-trip | **graduate** | `tasks.ts:223,516` |
| `memory` / `tasks` facets | already on the frozen `ctx` | **none new** | `tasks.ts:178-214` |
| typed `tools` registry | `tools_allowed` labels (inert) | **build** | `…ai_employees.sql`; Volume XIII §12 |
| **API gateway** | external providers | **build (net-new)** | Volume XIII §13 |
| `inbound?` facet | Shared Comm Protocol (contract #10) | **reserve (unbuilt)** | Architecture Freeze §4 row 10 / §5 |

Read down the *Build vs bind* column: the new substrate is the **typed tool registry** and
the **API gateway**; everything else binds, activates, graduates, or reserves. #014 is more
*building* than #013's pure binding — but it remains substantially **reuse**.

---

## 6. Recommended scope boundary (and phasing within #014)

**In scope for #014** (canonical, `numbering.md` row #014 + ADR 0007 Decision 9): the
`comms`/`events`/`tools`/`api` facets over the frozen RunContext; the P3 output envelope +
evidence-drain + the `TaskHandler` return-type graduation; the permission gate (the
doorman) + the autonomy classifier P4 + `proposeActions` + the hand-off to the built
Approval Engine; cost metering + budget enforcement + the API gateway; SDK-side audit /
identity-stamping; the Reference Employee proving the envelope end to end.

**Out of scope** (deferred): the Capability Registry table/resolver (**#015**); the DAG
(`depends_on`); the approval **lifecycle** mechanics (`approval_status` transition) +
verification (their own directive); versioning/lifecycle/health (recommended deferral —
§7); building inter-employee `inbound?` delivery on the unbuilt contract #10.

**Recommended phasing within #014** — smallest-correct-first, each phase shippable and
reviewable:

1. **Phase A — the spine of the envelope:** the `events` + `comms` facets (pure binds of
   built #1/#7) + the P3 output envelope + evidence-drain. Lowest risk; immediately makes
   handlers smaller.
2. **Phase B — the doorman:** the permission gate, the autonomy classifier P4,
   `proposeActions`, and the hand-off to the built Approval Engine (#6). This is where C4
   becomes structural; the SQL re-check is the defence-in-depth backstop.
3. **Phase C — tools:** the typed tool registry over `tools_allowed` labels, with each tool
   carrying its permission + cost + reversibility class.
4. **Phase D — the gateway (last):** the API gateway + live cost metering against `cost_micros`,
   budget enforced pre-call, secret custody server-side. Heaviest and most separable — the
   candidate for a directive split (§7).

---

## 7. Open questions for the CEO to rule on

This proposal presents the canonical scope; it does **not** decide the roadmap (the standing
rule: *I propose; the CEO decides*). Five forks warrant an explicit ruling:

1. **Does the API gateway (Phase D) stay in #014, or split into its own directive?** It is
   the heaviest, most secret-bearing, most "external-world" component, and the most
   separable — a clean parallel to Option B splitting RunContext from the SDK. **Recommendation:
   keep it in #014, phased last** (the envelope is incomplete without `ctx.api`), but the
   split is a coherent and defensible alternative if the CEO prefers a tighter #014.
2. **Confirm the approval boundary.** This proposal puts the **P4 classifier + `proposeActions`
   + hand-off to the built Approval Engine** in #014, and defers the **task-lifecycle approval
   mechanics (`approval_status` transition) + verification** to their own directive (ADR 0007
   Decision 9). Confirm this is the intended line.
3. **Defer versioning / lifecycle / health?** Volume XIII §3 lists them "To build" but ADR
   0007 does not assign them to #014, and they are outside the row-#014 scope.
   **Recommendation: defer.** Confirm.
4. **The `inbound?` facet and contract #10.** The message-trigger facet leans on the
   **Reserved, unbuilt** Shared Communication Protocol (contract #10 — inter-employee
   messaging, *distinct* from the built outbound Communication Layer, Architecture Freeze §5).
   **Recommendation: reserve the optional `inbound?` slot additively, but do not build
   inter-employee delivery in #014;** trigger from what exists. Confirm the dependency is
   acceptable.
5. **The Volume XIII §24 standing open questions** are *not* #014 and are noted for a future
   ruling: employee **runtime topology** (serverless-task-claim — the as-built default,
   `tasks.ts:49-53` — vs long-lived workers); **model/provider strategy** (the gateway
   enforces the policy once set); **inter-employee trust & delegation limits**.

---

## 8. Status & next step

This document is an **architecture proposal, held for CEO review**. It changes no code,
schema, migration, configuration, or git history. **No #014 implementation begins** until
it is reviewed and approved — per the CEO's mandate and the standing rule to *protect the
CrewFlow Operating System architecture above implementation speed*.

On approval, the next step is **ADR 0008** (the AI SDK Envelope) + an architectural review,
in the same PR, followed by the smallest-correct implementation **strictly within the
approved scope** — Phase A first — held to the full validation discipline (§3.12), with the
Reference Employee as the acceptance harness. Directive #015 (the Capability Registry) does
not begin until #014 has a completion report and CEO review.

---

## 9. CEO review outcome

The CEO completed an independent CTO review of this proposal. **Outcome: the Directive
#014 AI SDK Envelope architecture is approved** — the proposed **scope**, **phasing**, and
**dependency ordering** are each approved — with **one architectural clarification** and
**two additional standing rules**, all three to be **incorporated into ADR 0008 before any
implementation begins**.

**The five §7 scope forks are resolved in favour of the proposal's recommendations:**

1. **The API gateway stays in #014, phased last** — *with* the strict architectural
   boundary in the clarification below.
2. **The approval boundary stands as proposed:** #014 builds the P4 autonomy classifier +
   `proposeActions` + the hand-off to the built Approval Engine (contract #6); the
   task-lifecycle approval *mechanics* (`approval_status` transition) + verification defer
   to their own directive.
3. **Versioning / lifecycle / health are deferred** (outside the #014 scope).
4. **The `inbound?` slot is reserved additively; inter-employee delivery (contract #10) is
   not built in #014.**
5. **The Volume XIII §24 standing questions** (runtime topology, model/provider strategy,
   delegation limits) are **not #014** — noted for a future ruling.

**Three architectural decisions carried into ADR 0008:**

1. **The API Gateway ↔ SDK boundary (clarification).** The boundary between the two must
   stay clear. **The API Gateway owns** external integration, authentication,
   authorisation *of the external call*, rate limiting, and request auditing. **The SDK
   owns** developer-facing abstractions, typed interfaces, and platform ergonomics. **The
   SDK consumes the API Gateway**; the API Gateway **never becomes an SDK implementation
   detail** (it is a separable component the SDK calls, not an internal of it). This makes
   the gateway's *future* extraction into its own directive/service a non-breaking move.
2. **The Tool Registry Principle (new standing rule).** **Tools describe capability; the
   Capability Registry authorises capability.** The Tool Registry must **never** become the
   authorisation system — **authorisation remains the responsibility of Directive #015**.
   (This is a distinct authorisation from the gateway's call-level gating in (1): #015
   authorises *whether an employee may hold a capability at all*; the gateway authorises
   *whether a given external call is within budget/rate/provider limits*. The two compose;
   neither is the Tool Registry.)
3. **The SDK Stability Rule (new engineering standard).** **The AI SDK is the primary
   developer interface to the CrewFlow Operating System.** Backward compatibility is a
   **design goal**; breaking SDK changes are **rare, documented, and justified through ADRs**
   when appropriate. Homed alongside the kernel-stability principle in the [Kernel Contract
   Map](./kernel-contract-map.md) §2 (the engineering-standards section) and formalised in
   ADR 0008.

**Authorisation.** Proceed with **ADR 0008** (the AI SDK Envelope) incorporating the three
decisions above. **Directive #014 implementation does not begin until ADR 0008 has been
reviewed and approved.** The established engineering discipline (§3.12) is maintained
throughout. PR #207 (the Kernel Contract Map + the standing principle) was **approved and
merged**, with the CEO's standing instruction that the map and the Architecture Freeze
remain a **synchronised pair** (updated together whenever a kernel contract changes) now
encoded in both documents.

---

*Documentation only. No code, schema, migration, configuration, or git history was changed
by this proposal. Prepared under the #011 governance umbrella (Master Roadmap D-01) as the
architecture proposal for Directive #014 / D-04 — the AI SDK Envelope — assembled over the
now-frozen RunContext (contract #4, Established under #013 / ADR 0007). The forward sequence
it designs against was approved by the CEO (Option B) and recorded in
[`numbering.md`](./numbering.md) §3. The CEO's review outcome is recorded in §9.*
