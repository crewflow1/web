# CrewFlow Governance — Directive #014 (D-04) **Phase B** Architecture Proposal: the Doorman

> **Status:** **Approved** *(CEO independent CTO review)* — Phase B implementation
> **authorised** in the sequence pure gate → runtime composition → Approval-Engine hand-off →
> Reference-Employee validation; see **§9** for the outcome, the **`GateVerdict`-is-declarative**
> refinement, and the new **Policy vs Mechanism** principle. This document presents the
> architecture for **Directive #014 / D-04, Phase B — the permission gate ("the doorman"): the
> P4 autonomy classifier, the `proposeActions` surface, and the hand-off to the already-built
> Approval Engine.** It was the step the CEO authorised after the Phase A merges: *"Present the
> architecture proposal for Directive #014 Phase B. Do not begin implementation until the
> proposal has been reviewed and approved."* The document itself changes no code, schema,
> migration, configuration, or git history; it is the governance record the now-authorised
> Phase B implementation PRs build upon.
>
> **Phase context.** The phased plan accepted in **[ADR 0008](../decisions/0008-ai-sdk-envelope.md)**
> (Decision 10) is **A** (`events` + `comms` facets · the P3 output envelope · the
> evidence-drain) → **B** (this proposal) → **C** (the typed tool registry) → **D** (the
> API gateway + live cost metering, last). **Phase A is merged** (ADR 0008 acceptance note;
> PRs #208→#209→#210 on the `#011` integration branch). Phase B is **ADR-backed already** —
> it implements ADR 0008 **Decision 4** (the doorman as enforcement predicate) and **Decision
> 8** (the autonomy/approval boundary). It therefore proposes **no new ADR**; the
> architectural-review sign-off travels with the implementation PRs, per Architecture Freeze
> §2.

---

## 1. How to read this

The CEO's mandate for this step is to **present the architecture and hold for review** — not
to begin building. §2 gives the one-paragraph thesis. §3 answers, in order, the fixed set of
architecture-review questions a CTO would ask before approving the runtime's **security
heart** (each in its own subsection). §4 is an illustrative — **not implemented** — interface
sketch. §5 is the *fill-the-slots* map that backs the "builds one pure predicate, binds the
rest" claim with `file:line` evidence. §6 draws the in/out scope boundary and recommends
**phasing within Phase B**. §7 surfaces the genuine forks as **explicit questions for the CEO
to rule on**. §8 records status; §9 is reserved for the CEO's review outcome.

Every factual claim is cited to repository evidence verified at the current integration tip.
This proposal is governed by the two facet-composition standards introduced on the **Phase A
review** and homed in the [Kernel Contract Map](./kernel-contract-map.md) §2 / §4.2 — the
**Facet Isolation Rule** and the *facets-expose-capability / the-runtime-composes-it*
principle (documented in **PR #211, under review**). Phase B is the **first weighty test** of
those standards, because the doorman is inherently cross-facet: it *decides*, it *audits*, and
it *parks an approval*. The principles dictate **where** that composition lives. **The
proposal proposes; it does not build.**

---

## 2. The thesis (one paragraph)

**Phase B is where C4 — "the AI never bypasses security" — stops being doctrine and becomes a
structural property of the runtime; and the two Phase-A composition standards decide its
entire shape.** The doorman is built as **one pure predicate plus one runtime-composed
surface**, and nothing else. The predicate is `server/sdk/gate.ts` — `evaluateAction(action,
posture, capabilities, budget) → GateVerdict` — which composes the three enforcement layers
(employee posture, capability scope, the P4 autonomy test) into an explainable verdict, and
which **imports no facet**: it is pure, I/O-free, deterministic, and trivially testable, the
same shape Phase A's `output.ts` already established. The surface is `ctx.proposeActions`,
wired **in the runner** (`server/sdk/tasks.ts`) — never in a facet — because routing a decided
action is **cross-facet orchestration**: it runs the gate, then either emits an audit event
through the `events` facet (autonomous) **or** hands off to the already-built Approval Engine
through `requestApproval` (needs-approval). The Facet Isolation Rule forbids a facet from
sequencing another, so `proposeActions` *cannot* be a facet — it is the runtime composing
capability, exactly as the principle in PR #211 prescribes. Phase B builds **one new file**
(the pure gate) and **binds two already-shipped subsystems** (the `events` facet from Phase A;
the Approval Engine, contract #6, `server/services/hq-approvals.ts`, ADR 0001). It adds **no
migration** and **no new ADR**. It delivers the **decision and the request** — the two halves
ADR 0008 Decision 8 assigns to #014 — and **defers fulfilment** (apply-on-approval, the
`waiting_approval` task transition, verification) to the lifecycle directive, exactly as that
decision draws the line: *#014 builds the predicate and the request; the engine owns the
gating.*

---

## 3. The questions, answered

### 1. What exactly is "the doorman", and what does Phase B close?

The **doorman** is the permission gate every SDK action passes — the single enforcement point
the substrate names "the most important" (Volume XIII §8,
`docs/bible/substrate/volume-13-ai-sdk.md:196-217`). It composes three layers, evaluated per
proposed action: **(1)** employee posture (`ai_employees.permissions` —
`{can_execute, requires_approval, scopes}`, the coarse default-locked stance); **(2)**
capability scope (the per-capability grant); **(3)** the **autonomy test P4** — *reversible ∧
bounded ∧ type-target ∧ in-scope ∧ in-budget* (substrate `README.md` §P4,
`docs/bible/substrate/README.md:241-255`). ADR 0008 Decision 4 records this verbatim as "the
enforcement predicate … in the SDK and re-asserted in the `SECURITY DEFINER` entry point."

**What Phase B closes is the *decision* half of C4.** After Phase B, no proposed action is
treated as autonomous unless it **passes P4 against the employee's real posture and capability
set**, and every action that fails becomes a **tracked approval request** in the built Approval
Engine rather than an unreviewed side effect. The handler **never decides its own autonomy**
(Volume XIII §15, `:318-331`): it produces `actions[]` and the runtime classifies them. That
is the operational closure of conflict **C2** ("humans decide" vs "ships autonomous") — both
true at different stakes, reconciled by one mechanical test.

What Phase B **does not** close is the *fulfilment* half — *applying* an approved action and
*parking* the originating task. That is deferred by design (§3.7).

### 2. What does Phase B build, bind, and defer — and does it need a new ADR or migration?

**Builds (one pure module):** `server/sdk/gate.ts` — the `evaluateAction` predicate, the
`GateVerdict` / `ProposedAction` / `EmploymentPosture` types, and the per-atom P4 reasons.
Pure TypeScript; no I/O; no facet imports.

**Binds (already shipped):**

- the **`events` facet** (Phase A, `server/sdk/events.ts`) — to audit an autonomous decision
  on the one log (C5);
- the **Approval Engine** (contract #6, `server/services/hq-approvals.ts`, ADR 0001) — to
  *request* approval for a non-autonomous action via `requestApproval`
  (`server/services/hq-approvals.ts:171`), the **only** non-human entry point, which lands a
  `pending` row and whose INSERT trigger emits `approval.requested` **in-transaction**;
- the **employee posture** already persisted on `ai_employees.permissions` (Built-inert,
  default-locked; `normalizePermissions`, `lib/ai-employees/model.ts:186-199`) and the
  **resolved capability set** #013 already threads onto `ctx.capabilities`
  (`server/sdk/tasks.ts:115-118`, `:467`).

**Wires (runtime composition):** `ctx.proposeActions` in the runner (`server/sdk/tasks.ts`) —
classify each action via the gate, then route autonomous→audit-emit, needs-approval→request.

**Defers** (ADR 0008 Decisions 8 & 9): the `waiting_approval` task transition + the
`hq_ai_task_approvals` task-lifecycle row + **apply-on-approval fulfilment** + **verification**
(their own directive); the **executor** of an autonomous action (Phase C tools / Phase D
gateway); the Capability **Registry** that would let a SQL guard re-check a capability (#015).

**No new ADR.** Phase B *implements* ADR 0008 Decisions 4 and 8; per Architecture Freeze §2
the architectural-review sign-off travels with the implementation PR(s). The only candidate
for its own record is the public `GateVerdict` shape — §7 flags it; the recommendation is that
it is an **additive SDK type already covered by ADR 0008** (Decision 3's envelope family), not
a contract reopening.

**No migration.** The gate is pure; `proposeActions` is wiring; the approval hand-off binds an
existing table (`hq_approvals`); posture and capabilities are already persisted. Phase B adds
**zero** schema — the smallest-footprint phase of the four.

### 3. The gate is a **pure predicate** — why, and what does the Facet Isolation Rule dictate?

The gate is `evaluateAction(action, posture, capabilities, budget): GateVerdict` — a **pure
function**: same inputs, same verdict, no I/O, no clock, no client. It is the Phase-A
`output.ts` discipline applied to enforcement (`server/sdk/output.ts` carries no `server-only`
and reaches for no server module — `__tests__/security/sdk-facets-invariants.test.ts:113-130`
pins exactly that). Three reasons purity is not stylistic but **load-bearing** here:

1. **It is the most security-critical code in the SDK, so it must be the most testable.** A
   pure predicate lets every branch of the five P4 atoms and the three posture/scope layers be
   proven by a table of inputs, with no mocks and no transport — deny-by-default becomes a
   matter of *source*, not discipline.
2. **The Facet Isolation Rule makes it structural.** The rule (Kernel Contract Map §2, PR #211)
   says facets must not depend on one another. The gate imports **no facet** — not `events`,
   not `comms`, not the Approval Engine. It does not *fetch* a posture or *emit* an audit; it
   is *handed* its inputs and *returns* a verdict. It is therefore not a facet that reaches
   sideways; it is a leaf the runtime feeds. (Whether it physically lives at
   `server/sdk/gate.ts` or as a non-exported runner helper is a packaging detail — its
   *purity* and *facet-blindness* are the contract.)
3. **It keeps the doorman re-pointable.** Because the gate reads a `capabilities` set and a
   `posture` it is *given*, #015 can change where those come from (the registry instead of the
   `ai_employees` row) **without touching the predicate** — the same source-indifference #013
   built into `ctx.capabilities` (`server/sdk/tasks.ts:107-118`). **#013 threads · #014
   enforces · #015 sources**, made operational at the gate.

### 4. `proposeActions` is a **runtime-composed surface** — why the runner, not a facet?

This is the proposal's central architectural claim, and it is **forced** by the second Phase-A
standard — *"SDK facets expose capability; the runtime composes capability; cross-facet
orchestration should remain inside the runtime rather than inside individual SDK modules"*
(Kernel Contract Map §4.2, PR #211). `proposeActions` is **inherently cross-facet**: for each
action it (a) runs the gate, (b) on autonomous, emits an audit event **through the `events`
facet**, and (c) on needs-approval, **hands off to the Approval Engine**. A facet that did this
— say a hypothetical `server/sdk/approvals.ts` — would have to `import` the `events` facet to
audit, which is exactly the sibling-import the **Facet Isolation Rule forbids**. So the
orchestration *cannot* live in a facet; it lives in the runner (`server/sdk/tasks.ts`), the
**one** place facets are already allowed to meet. The runner already composes facets once — the
Phase-A **evidence-drain** sequences the `memory` facet into the result before completion
(`server/sdk/tasks.ts:555-558`). `proposeActions` is the **second, weightier** instance of the
same pattern: the runtime composing capability that no single facet may sequence.

Concretely, `proposeActions` is exposed on `ctx` (so a handler can call it, or return actions
in the P3 envelope for the runner to drain — symmetric with the evidence-drain) but
**implemented in the runner**, closing over the run's identity, correlation, gate inputs, and
the `events` facet. It is a *surface*, not a *facet*: it owns no state and binds no single
subsystem — it **composes several**.

### 5. The three doorman layers — where does each datum come from **today**?

| Layer | Datum | Source today | Phase B's job |
|---|---|---|---|
| **1. Employee posture** | `{can_execute, requires_approval, scopes}` | `ai_employees.permissions` (Built-inert, default-locked: `can_execute=false`, `requires_approval=true`, `scopes:['read']`); `normalizePermissions` (`lib/ai-employees/model.ts:186-199`) | **resolve** it once at identity assembly (a `resolveEmployeePosture`, sibling to the existing `resolveEmployeeCapabilities`) and feed the gate |
| **2. Capability scope** | the resolved token set | `ctx.capabilities` (`ResolvedCapabilitySet`, threaded by #013 — `server/sdk/tasks.ts:115-118`, `:467`) | **read** it; the gate matches an action's required capability against the set |
| **3. Autonomy test P4** | reversible ∧ bounded ∧ type-target ∧ in-scope ∧ in-budget | the action descriptor + scope + `ctx.budget` (`:219`) | **compute** it (§3.6) |

One gap is worth naming: `resolveEmployeeCapabilities` folds `permissions.scopes` into the
capability set but **does not thread the two booleans** `can_execute` / `requires_approval`
(`server/sdk/tasks.ts:135-151`). The gate needs them (layer 1), so Phase B adds a **posture
resolver** beside the capability resolver — structurally typed, reading the same
`ai_employees` row, repointable by #015 with no contract change. Whether the resolved posture
is *also* exposed on `ctx` (like `ctx.capabilities`) or kept runtime-internal is a §7 question;
the recommendation is **runtime-internal** — a handler has no need to read its own posture, and
the gate consumes it directly.

### 6. The P4 autonomy test, atom by atom — how is each decided in Phase B?

The five atoms (substrate `README.md` §P4, `:241-255`), and how the Phase-B gate evaluates
each from a `ProposedAction` descriptor:

1. **Reversible** — from the action's declared reversibility class. In Phase B (no typed tool
   registry yet) this rides on the action descriptor itself: an action declares whether it
   writes only HQ-internal, append-or-correctable state (reversible) or crosses an external /
   customer-facing / spend / delete boundary (irreversible). Phase C's tool registry will make
   this a property of the *registered tool* (ADR 0008 Decision 6 — "a reversibility/blast-radius
   class that feeds P4"); Phase B reads it from the descriptor so the classifier is live now.
2. **Low blast radius** — the action names a **bounded** subject set, not an open-ended one.
3. **Type-bounded target** — the target is typed and validated, not free-form.
4. **Within capability scope** — the action's required capability is present in
   `ctx.capabilities` (layer 2). This is the one atom that already has its real source.
5. **Within cost budget** — the action's estimated cost fits `ctx.budget` (`:219`, the
   read-only ceiling #013 exposes; metering itself is Phase D). In Phase B, absent a metered
   cost, an action with no estimate is treated conservatively (a positive-cost action with no
   budget headroom fails this atom).

**The posture short-circuit (layer 1) precedes P4:** if `can_execute` is false, every
write/execute action is non-autonomous regardless of P4 (the default-locked stance); if
`requires_approval` is true, even an otherwise-autonomous action is routed to approval. P4 only
*grants* autonomy to an action the posture already permits. This ordering is what makes the
Built default (`can_execute=false`) a true floor, not a suggestion (Volume XIII §16,
`:343-346`).

### 7. The approval hand-off — exactly what Phase B does, and does **not**, do

**Does:** on a needs-approval verdict, `proposeActions` calls **`requestApproval`**
(`server/services/hq-approvals.ts:171`) with the employee id, the action's subject
(`subjectType`/`subjectId`), the action verb, the proposed payload, and the run's
`correlationId`. The engine lands a `pending` `hq_approvals` row and its INSERT trigger emits
`approval.requested` **in the same transaction** — so the proposal is durably tracked and
auditable the instant it is raised. `requestApproval` is the **only** non-human entry point and
is itself **not gated** (it merely queues), so the hand-off is a clean, single call. This is
exactly ADR 0008 Decision 8: "#014 *decides* an action needs approval and *requests* it through
the built engine."

**Does not:** Phase B does **not** transition the originating task to `waiting_approval`, does
**not** write an `hq_ai_task_approvals` task-lifecycle row, and does **not** *apply* the action
when a human later approves it. Those are the **task-lifecycle approval *mechanics*** and
**fulfilment**, which ADR 0008 Decision 8 and Decision 9 **defer to their own directive** —
"the engine owns the gating." The Kernel Contract Map §4.4 boundary holds: *Approval decides;
the Task Engine gates.* Note that Volume XIII §15 (`:325-326`) sketches the *eventual* parked
`waiting_approval` task + `hq_ai_task_approvals` row; Phase B deliberately implements only the
**request** against `hq_approvals`, leaving the task-side parking and the apply-on-approval loop
to the lifecycle directive. The consequence is honest and bounded: after Phase B a non-autonomous
action becomes a **tracked, pending human decision**; *fulfilling* that decision arrives with the
executor (Phases C/D) and the lifecycle wiring.

### 8. Defence in depth without a new SQL function — where is the re-check?

ADR 0008 Decision 4 requires the check be "in the SDK **and** re-asserted in the
`SECURITY DEFINER` entry point." Phase B satisfies this **without writing a new SQL guard**,
because every engine `proposeActions` routes to **already has one**:

- the **needs-approval** path calls `requestApproval`, which writes through the Approval
  Engine's own `SECURITY DEFINER` boundary (contract #6) — the SDK gate is the *first* check,
  the engine's SQL is the *re-assertion*;
- the **autonomous** path, in Phase B, only *audits a decision* (no external side effect yet —
  the executor is Phases C/D). When that executor lands, its own `SECURITY DEFINER` entry point
  (the tool's / the gateway's) is the re-assertion — and that is precisely **where** a minimal
  capability SQL re-check belongs, because only then is there an execution to re-gate **and**
  (with #015) a registry to re-check against.

So Phase B's defence-in-depth backstop is **inherited from the routed engines**, not a new
chokepoint. Whether to add a minimal capability re-check earlier is a §7 question; the
recommendation is **defer** it to the phase that has both an executor and a registry.

### 9. The `GateVerdict` — explainability and the deny-by-default audit

The verdict is **explainable by construction**: `{ decision: "autonomous" | "needs_approval";
reasons: GateReason[] }`, where each `GateReason` names the layer/atom that forced the outcome
(`posture.can_execute`, `posture.requires_approval`, `scope.missing_capability`,
`p4.irreversible`, `p4.blast_radius`, `p4.untyped_target`, `p4.out_of_scope`, `p4.over_budget`).
This is what makes deny-by-default **auditable**: every non-autonomous routing records *why*,
and the audit event the autonomous path emits records *that it was permitted and on what basis*.
One query still answers "what did this AI do and was it allowed to?" — `WHERE actor_id = slug
ORDER BY id` (Volume XIII §16, `:347-348`) — because the gate's decisions flow to the **one**
event log through the `events` facet, never a parallel log (C5).

### 10. Blast radius, back-compat, and the two live handlers

**Additive, like Phase A.** `proposeActions` is a **new** `ctx` surface (an added method,
mirroring how Phase A added the `events`/`comms` fields); the gate is a **new** pure module; the
posture resolver is a **new** function beside `resolveEmployeeCapabilities`. **No frozen field
of the RunContext changes** (the nine #013 fields are untouched — Architecture Freeze §2.4,
*extend before replace*). The two live handlers (`research-ai`, `lead-qualification`) **do not
call `proposeActions` yet**, so they stay green unchanged; the **Reference Employee** (Volume
XIII §22) is the first caller. **No historical row is rewritten** (no migration). The change is
reversible: the surface is additive and the gate sits behind it.

### 11. Tests and the Reference-Employee acceptance

The same six-gate bar (typecheck · lint · unit · integration · security · production build),
plus Phase-B-specific coverage that is unusually *cheap* because the gate is pure:

- **the pure gate, exhaustively** — a table driving every P4 atom and every posture/scope layer
  to its verdict, no mocks (the deny-by-default proof);
- **the posture short-circuit** — `can_execute=false` forces non-autonomous for a write;
  `requires_approval=true` forces approval even when all five P4 atoms pass;
- **`proposeActions` routing** — an autonomous action emits an audit event and **no** approval
  row; a needs-approval action calls `requestApproval` **once** with the threaded
  `correlationId` and emits **no** premature side effect (the `comms`/service mocks prove the
  hand-off, mirroring `__tests__/sdk/comms-sdk.test.ts`);
- **facet isolation, re-pinned** — a source-level assertion that `gate.ts` imports no facet,
  guarding the Facet Isolation Rule the way `sdk-facets-invariants.test.ts` guards Phase A;
- **the Reference Employee** — one employee that proposes a **reversible** action (an
  HQ-internal memory/status write → permitted-autonomous, audited) and an **irreversible** one
  (an email / spend / customer-facing write → parked as a pending approval), proving the test
  routes reversible→autonomous and irreversible→approval end to end.

### 12. What would make Phase B over-engineered?

The traps, named so the review can watch for them: **(a)** building the **task-lifecycle
parking** (`waiting_approval` + `hq_ai_task_approvals`) or **apply-on-approval fulfilment** —
that is the deferred lifecycle directive (§3.7); **(b)** building an **executor** for autonomous
actions inside Phase B — execution is Phases C/D (the tool registry / the gateway), and Phase B
must classify, not act; **(c)** adding a **new `SECURITY DEFINER` capability guard** before
there is an executor to re-gate or a registry (#015) to check against (§3.8); **(d)** making the
gate **impure** — letting it fetch a posture or emit an audit, which both bloats the most
security-critical code and **violates the Facet Isolation Rule** (§3.3); **(e)** implementing
`proposeActions` **as a facet** that imports `events`/approvals — the orchestration belongs in
the runner (§3.4); **(f)** sourcing capabilities from anywhere but the existing resolver — that
is #015's repoint, not Phase B's. The discipline that keeps Phase B honest is the same that
kept Phase A honest: **the runtime composes; the facets do not** — and the gate stays a pure,
testable leaf.

---

## 4. Illustrative target shape (design only — not implemented)

A sketch to make the additive extension concrete. **This is not an implementation**; the exact
types are settled by the Phase-B implementation PRs under ADR 0008. The nine frozen fields are
unchanged; the one new `ctx` member is marked.

```ts
// ── server/sdk/gate.ts — the PURE doorman predicate (imports NO facet) ───────────
// Same shape discipline as Phase A's output.ts: no `server-only`, no I/O, no client.

/** The employee's coarse stance — resolved from ai_employees.permissions (Built). */
interface EmploymentPosture {
  canExecute: boolean;        // ai_employees.permissions.can_execute (default false)
  requiresApproval: boolean;  // ai_employees.permissions.requires_approval (default true)
  // scopes already fold into ctx.capabilities via resolveEmployeeCapabilities()
}

/** A description of intent the handler proposes — never an execution (Phase A's AiAction). */
interface ProposedAction {
  type: string;                       // a capability-style verb
  capability?: string;                // the token P4 atom 4 matches against ctx.capabilities
  subjectType: string;                // for the approval hand-off + blast-radius (atom 2)
  subjectId: string;
  reversible: boolean;                // atom 1 (Phase C makes this a registered-tool property)
  typedTarget: boolean;               // atom 3
  estimatedCostMicros?: number;       // atom 5, against ctx.budget (metering is Phase D)
  payload?: Record<string, unknown>;  // carried into the approval request
}

type GateReason =
  | "posture.can_execute" | "posture.requires_approval"
  | "scope.missing_capability"
  | "p4.irreversible" | "p4.blast_radius" | "p4.untyped_target"
  | "p4.out_of_scope"  | "p4.over_budget";

interface GateVerdict {
  decision: "autonomous" | "needs_approval";
  reasons: GateReason[];   // why — explainable, deny-by-default auditable
}

// PURE: posture + capabilities + budget in → verdict out. No facet, no fetch, no emit.
export function evaluateAction(
  action: ProposedAction,
  posture: EmploymentPosture,
  capabilities: ResolvedCapabilitySet,   // threaded by #013, sourced by #015
  budget: number,                        // ctx.budget — read-only ceiling
): GateVerdict { /* posture short-circuit, then the five P4 atoms */ }


// ── server/sdk/tasks.ts — the RUNNER composes capability (NOT a facet) ───────────
interface RunContext {
  // … the nine #013-frozen fields + the Phase-A events/comms facets, unchanged …

  /**
   * Classify + route proposed actions (#014 Phase B). The RUNTIME composes this:
   * it runs the pure gate, then audits (autonomous) or requests approval
   * (needs-approval) — cross-facet orchestration that may not live in a facet
   * (Facet Isolation Rule / Kernel Contract Map §4.2).
   */
  proposeActions(actions: ProposedAction[]): Promise<GateVerdict[]>;  // ← added by Phase B
}

// Implemented in the runner, closing over identity + correlation + the events facet:
async function proposeActions(actions: ProposedAction[]): Promise<GateVerdict[]> {
  const verdicts: GateVerdict[] = [];
  for (const action of actions) {
    const verdict = evaluateAction(action, posture, ctx.capabilities, ctx.budget);
    if (verdict.decision === "needs_approval") {
      await requestApproval({                 // bind the built Approval Engine (#6)
        aiEmployeeId: identity.employeeId,
        subjectType: action.subjectType, subjectId: action.subjectId,
        action: action.type, proposedPayload: action.payload,
        correlationId: ctx.correlationId,
      });
    } else {
      await ctx.events.emit({ /* action.permitted — audit the autonomous decision */ });
    }
    verdicts.push(verdict);
  }
  return verdicts;
}
```

---

## 5. The fill-the-slots map (binds, builds — the evidence)

The backbone of the thesis: Phase B **builds one pure predicate** and **binds/activates
everything else**. Every row is cited.

| Phase-B deliverable | Binds / activates | Build vs bind | Evidence |
|---|---|---|---|
| the gate predicate (`evaluateAction` + P4) | — (new pure module) | **build (pure)** | substrate `README.md` §P4 `:241-255`; ADR 0008 Dec. 4 |
| `GateVerdict` / `ProposedAction` types | extends Phase A's `AiAction` | **build (additive type)** | `server/sdk/output.ts:40-49` |
| posture resolution | `ai_employees.permissions` (Built-inert) | **bind** | `lib/ai-employees/model.ts:186-199` |
| capability matching (P4 atom 4) | `ctx.capabilities` (threaded by #013) | **bind** | `server/sdk/tasks.ts:115-118`, `:467` |
| budget atom (P4 atom 5) | `ctx.budget` (read-only ceiling) | **bind** | `server/sdk/tasks.ts:219` |
| `proposeActions` surface | the runner (where facets meet) | **wire (runtime compose)** | `server/sdk/tasks.ts:555-558` (evidence-drain precedent) |
| autonomous → audit | the `events` facet (Phase A) | **bind** | `server/sdk/events.ts` |
| needs-approval → request | the Approval Engine (#6) | **bind** | `server/services/hq-approvals.ts:171` |
| task parking / fulfilment / verification | — | **defer** | ADR 0008 Dec. 8 & 9 |
| executor of an autonomous action | — | **defer (Phases C/D)** | ADR 0008 Dec. 10 |
| capability SQL re-check | — | **defer (with executor + #015)** | ADR 0008 Dec. 4 / §3.8 |

Read down the *Build vs bind* column: the only **new substrate is one pure predicate**;
everything else binds a shipped subsystem, activates a threaded value, or defers. Phase B is the
**smallest-footprint** phase — pure SDK + binding, **zero migrations** — and the **highest
security value** (it closes the decision half of C4).

---

## 6. Recommended scope boundary (and phasing within Phase B)

**In scope for Phase B** (ADR 0008 Decisions 4 & 8): the pure gate predicate (posture + scope +
P4) and its explainable `GateVerdict`; the posture resolver beside the capability resolver;
`ctx.proposeActions` wired in the runner; the autonomous→audit and needs-approval→`requestApproval`
routing; the Reference-Employee proof.

**Out of scope** (deferred): the `waiting_approval` task transition + `hq_ai_task_approvals` row
+ apply-on-approval fulfilment + verification (their own directive); the **executor** of an
autonomous action (Phase C tools / Phase D gateway); the Capability **Registry** and any SQL
capability re-check keyed to it (#015); cost **metering** (Phase D — Phase B reads the ceiling,
it does not meter).

**Recommended phasing within Phase B** — smallest-correct-first, each PR shippable and
reviewable, mirroring Phase A's #208→#209→#210:

1. **B1 — the pure gate.** `server/sdk/gate.ts` (`evaluateAction`, the types, the per-atom
   reasons) + the posture resolver, with the exhaustive pure-predicate test table and the
   facet-isolation source assertion. No `ctx` change yet — lowest risk, highest test density.
2. **B2 — the runtime surface.** Wire `ctx.proposeActions` in the runner: classify → route
   (autonomous→`events.emit`, needs-approval→`requestApproval`), correlation-threaded; the
   routing tests (audit-vs-request, the posture short-circuit, one-call hand-off).
3. **B3 — the Reference-Employee acceptance.** One employee exercising both verdicts end to end
   (reversible→autonomous-audited, irreversible→pending-approval), proving the doorman before
   Phase C builds an executor on top of it.

---

## 7. Open questions for the CEO to rule on

This proposal presents the ADR-0008-bounded scope; it does **not** decide the roadmap (the
standing rule: *I propose; the CEO decides*). Four forks warrant an explicit ruling:

1. **Ship `proposeActions` in Phase B as classifier-and-router (no executor yet), or hold it
   until Phase C?** In Phase B the **needs-approval** path is fully live (the Approval Engine is
   built) and the **autonomous** path *audits a permitted decision* but has no executor (tools =
   C, gateway = D). **Recommendation: ship it in Phase B** — the approval hand-off is the C4-closing
   win and is fully functional now; the autonomous branch's executor is filled additively in
   Phase C without changing the surface.
2. **Expose the resolved posture on `ctx`, or keep it runtime-internal?** The gate needs
   `{can_execute, requires_approval}`, which `resolveEmployeeCapabilities` does not thread.
   **Recommendation: keep posture runtime-internal** (a handler has no need to read its own
   posture; the gate consumes it) — additive to expose later if a use emerges.
3. **Add a minimal capability `SECURITY DEFINER` re-check now, or defer?** ADR 0008 Decision 4
   wants the check re-asserted in SQL. **Recommendation: defer** — Phase B's defence-in-depth is
   inherited from the engines it routes to (the Approval Engine's SQL boundary today; the
   tool/gateway boundary in C/D), and a capability re-check belongs in the phase that has both an
   executor to re-gate and a registry (#015) to check against.
4. **Does the public `GateVerdict` shape need its own ADR?** **Recommendation: no** — it is an
   additive SDK type within ADR 0008's envelope family (Decision 3), not a contract reopening;
   the architectural-review sign-off travels with the Phase-B implementation PRs per Architecture
   Freeze §2.

---

## 8. Status & next step

This document is an **architecture proposal, held for CEO review**. It changes no code, schema,
migration, configuration, or git history. **No Phase B implementation begins** until it is
reviewed and approved — per the CEO's mandate and the standing rule to *protect the CrewFlow
Operating System architecture above implementation speed*.

On approval, the next step is the **B1 implementation PR** (the pure gate + the posture
resolver + tests) on the `#011` integration branch, held to the full validation discipline
(§3.11), followed by **B2** (the `proposeActions` runtime surface + the approval hand-off) and
**B3** (the Reference-Employee acceptance) — each its own reviewable PR, no later sub-phase
beginning until the current one has passed the six gates and received CEO approval. Phase C (the
typed tool registry) does not begin until Phase B has a completion record and CEO review.

---

## 9. CEO review outcome

The CEO completed an independent CTO review of this proposal. **Outcome: the Directive #014
Phase B architecture is approved.** Each load-bearing decision is approved explicitly — the
**pure gate**, **runtime-owned orchestration**, the **Approval-Engine hand-off**, the
**deferred executor**, the **deferred lifecycle transitions**, **deferred verification**, **no
new schema**, and **no new ADR** — *"The separation between the gate, runtime and Approval
Engine is correct."* The review returned **one architectural refinement** and **one new
permanent engineering principle**, and **authorised implementation** in the proposed sequence.

**Architectural refinement — `GateVerdict` is a declarative result.** The verdict represents
**policy, not execution**: it states *what is permitted*, and *"the runtime consumes the
verdict and determines the appropriate mechanism."* This **confirms and sharpens** §3.9 / §4 —
the gate returns `{decision, reasons}` in policy language (`autonomous` / `needs_approval`) and
**never** a mechanism instruction or a side effect; the runner alone maps a verdict to its
mechanism (audit-emit vs `requestApproval`). It keeps the gate **deterministic, pure,
independently testable, and reusable**, exactly as the proposal argued (§3.3).

**New permanent engineering principle — Policy vs Mechanism.** The CEO introduced a standing
architectural rule, homed alongside the Facet Isolation Rule and the runtime-composes-capability
principle in the [Kernel Contract Map](./kernel-contract-map.md) §2:

> **The gate defines policy. The runtime provides mechanism. The gate should never know how
> approvals are requested, how events are emitted, or how communications are sent. The gate
> answers only: "What is permitted under the current policy?"**

This is the **gate-specific sharpening** of the runtime-composes-capability principle (§4.2):
the gate is the *policy* leaf; the runtime *composes* it into a mechanism. It binds Phase B's
file layout structurally — the pure predicate may import no facet and perform no I/O, and **all
mechanism** (the audit emit, the approval request) lives in the runner (§3.3 / §3.4).

**Future compatibility — the gate interface stays stable as its inputs evolve.** The CEO
directed that the Capability Registry (Directive #015) become **another information source for
the gate**: #015 changes *where* the gate's `capabilities` (and posture) come from, but the
**gate interface itself remains stable** — *"Its inputs may evolve. Its responsibilities should
not."* This is **#013 threads · #014 enforces · #015 sources** applied at the gate: because
`evaluateAction` reads a *given* capability set and posture, #015 repoints the source with **no
change** to its contract (§3.3 / §3.5).

**How the refinement resolves the §7 open questions.** Three of the four forks are settled by
the CEO's explicit approvals, and the fourth stands as the proposal recommended:

1. **Ship `proposeActions` in Phase B as classifier-and-router** — settled **yes** by the
   approved **deferred executor**: the verdict is policy, the runtime routes, and the executor
   of an autonomous action arrives in Phases C/D.
2. **Resolved posture stays a gate input the runtime resolves** (runtime-internal) — consistent
   with *"the gate answers only what is permitted"* and *"its inputs may evolve"*; it is a
   reversible implementation choice, additive to expose later if a use emerges.
3. **No early capability SQL re-check** — settled by the approved **no new schema**; the
   re-check belongs in the phase that has both an executor and the #015 registry (§3.8).
4. **`GateVerdict` needs no separate ADR** — settled by the approved **no new ADR**; it is an
   additive, **declarative** SDK type under ADR 0008.

**Implementation authorisation.** Directive #014 **Phase B implementation is authorised**, in
the approved sequence — **(1) the pure gate → (2) runtime composition → (3) the Approval-Engine
hand-off → (4) Reference-Employee validation** — each held to the established six-gate
validation discipline (§3.11) and the standing instruction to **continue protecting the kernel
boundaries**. **Phase C (the typed tool registry) does not begin until Phase B has completed
implementation, validation, and review.**

---

*Documentation only. No code, schema, migration, configuration, or git history was changed by
this proposal. Prepared under the #011 governance umbrella (Master Roadmap D-01) as the
architecture proposal for Directive #014 / D-04 **Phase B** — the doorman — assembled over the
frozen RunContext (contract #4, Established under #013 / ADR 0007) and the Phase-A facet layer
(events + comms + the output envelope, merged under #014 / ADR 0008). It implements ADR 0008
Decisions 4 and 8 and is governed by the two facet-composition standards homed in the
[Kernel Contract Map](./kernel-contract-map.md) §2 / §4.2 (PR #211, under review). The CEO's
review outcome is recorded in §9.*
