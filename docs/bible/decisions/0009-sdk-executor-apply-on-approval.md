# ADR 0009 — SDK Executor and Apply-on-Approval Runtime

> **Status:** **Proposed · held for CEO review** — Directive #014 **Phase C** is **gated** on
> this ADR: no executor code is written until this decision is reviewed and approved · **Date:**
> 2026-06-28 · **Directive:** CEO Directive #014 / D-04 (the AI SDK Envelope), **Phase C — the
> executor** · **Supersedes:** none · **Superseded by:** none · **Builds on:**
> [ADR 0008](./0008-ai-sdk-envelope.md),
> [ADR 0007](./0007-runcontext-runtime-contract.md),
> [ADR 0004](./0004-generic-task-engine.md),
> [ADR 0001](./0001-approval-engine.md),
> [ADR 0003](./0003-communication-layer.md)
>
> Ninth ADR under the [`../README.md`](../README.md) *document-before-you-build* rule — in its
> **strictest** form, as for ADRs 0007 and 0008: on reviewing the Phase C architecture proposal
> the CEO ruled that *"Phase C introduces the first executor and apply-on-approval flow …
> significant enough to require a new ADR,"* and directed that this decision be **written,
> reviewed and approved before any Phase C implementation begins**, so it is authored ahead of
> the code. It formalises the CEO-approved [Phase C architecture
> proposal](../governance/directive-014-phase-c-executor-proposal.md) and folds in the **five
> architectural rulings the review returned** — **out-of-band apply-on-approval**, a **separate
> applied marker**, **inherited re-checking at the execution boundary**, **granular failure
> records**, and **clear event sequencing** — encoded below as first-class Decisions, not
> footnotes. The AI SDK is **frozen contract #3**
> ([architecture-freeze.md](../governance/architecture-freeze.md)); Phase C **advances the
> envelope but does not complete it**, so #3 stays **Partial** until Phase D lands `ctx.api`.
> This document changes no code, schema, migration, configuration, or git history.

---

## Context

Phase B shipped **the doorman**: the pure permission gate, the P4 autonomy classifier, the
`proposeActions` surface, and the hand-off to the already-built Approval Engine
([ADR 0008](./0008-ai-sdk-envelope.md) Decisions 4 & 8). It *classifies and routes* — on an
`autonomous` verdict it emits a best-effort `ai.action_permitted` audit and **stops**
(`server/sdk/tasks.ts:545-552`, the verb at `:548`); on `needs_approval` it calls
`requestApproval` and **stops**, throwing only if the request itself fails (`:533-543`). In both
branches **the side effect the action *describes* is never carried out** — Phase B "classifies,
it does not act" (Phase C proposal §3.7; §12 trap b). The runtime step that *applies* a cleared
action — `apply(action)` — was **explicitly deferred** to "the phase that has both an executor
and a registry" (Phase B proposal §3.8).

**Phase C is that phase, and this ADR is its contract.** ADR 0008 Decision 8 split the
autonomy/approval boundary into three acts — *decide* (the gate), *request* (the Approval-Engine
hand-off), and *apply* (the deferred remainder). Phase B shipped the first two; **Phase C ships
the third.** It does so by building one new runtime mechanism — **the executor** — over one new
typed catalogue — **the typed tool registry** (ADR 0008 Decision 6) — binding the subsystems that
already ship (the memory facet, the Communication Layer #7, the events facet, the Approval
Engine, the Task Engine), and inheriting the doorman's policy unchanged.

Phase C is **different in kind from Phases A and B**, which rode ADR 0008 because they
*implemented already-decided things* and let the architectural-review sign-off travel with the
implementation PRs (Architecture Freeze §2). Phase C introduces the **first executor** (a
mechanism that *applies side effects*), the **apply-on-approval flow** (the deferred
"fulfilment"), and the directive's **first net-new persistence** (Phases A and B added zero
schema). That is why the proposal escalated the question of a new ADR (§7.6), and why the CEO
ruled it required.

**The CEO review of the proposal.** The CEO completed an independent CTO review and **approved**
the Phase C architecture — *"The Phase C proposal correctly separates classification from
execution … This is the correct next architectural step"* — returning **one structural
requirement** (this ADR) and **five architectural rulings**, all encoded below as first-class
Decisions:

1. **Out-of-band apply-on-approval** — a separate executor trigger over `approved` rows, not an
   in-band task block (Decision 4).
2. **A separate applied marker** — application is recorded beside the Approval Engine, never as a
   sixth approval state; *"Do not reopen the Approval Engine state machine"* (Decision 5).
3. **Inherited re-checking at the execution boundary** — the `SECURITY DEFINER` re-check lands at
   each tool's bound subsystem boundary (Decision 8).
4. **Granular failure records** — per-action failure is captured; a human-required side effect is
   never silently dropped (Decision 9).
5. **Clear event sequencing** — the permission/approval event always precedes the application
   event (Decision 10).

The review also accepted the **Reference Path Rule** (PR #217, merged): Phase C is that rule's
**first deliverable use** — the Reference Employee that *classified* in Phase B must be proven to
*apply* end-to-end before the platform expands on the executor (Decision 13).

---

## Decision

**1. The executor is a runtime-owned mechanism, beside `proposeActions` — not a facet. It
closes the execution half of ADR 0008 Decision 8.** The executor takes an action the doorman has
**cleared** (an `autonomous` verdict now, or an `approved` approval later) and **applies** it:
resolve the registered tool → re-assert permission at the tool's `SECURITY DEFINER` boundary →
invoke against the validated args / granted payload → capture the result → audit the application
to the one log. It is **runtime-composed, not a facet**, because applying an action sequences
several facets (resolve, re-gate, invoke, emit), which the **Facet Isolation Rule** forbids a
facet from doing; the composition lives in the runner exactly where `proposeActions` and the
Phase-A evidence-drain already live (`server/sdk/tasks.ts:695`; the **Runtime Composition Rule**,
Kernel Contract Map §4.2). After Phase C, a permitted action **takes effect through a typed,
audited, permission-re-checked tool**, and an approved action is **fulfilled** rather than left a
tracked-but-inert decision.

**2. The typed tool registry *describes* capability; it never *authorises* it (implements ADR
0008 Decision 6).** The Built-inert `tools_allowed` labels (Volume XIII §3) become **registered
tools** carrying `{ argSchema, permission, costEstimator, reversibilityClass }` (Volume XIII §12
lines 303-310). The `reversibilityClass` **feeds P4** (so the gate still routes an irreversible
tool to approval); the `costEstimator` feeds P4's budget atom (live metering is Phase D). The
registry is **descriptive only**: the **`ctx.tools` facet** *exposes* it (resolve / list a tool,
read its schema / permission / cost / reversibility), while the **apply orchestration is
runtime** (`ctx.tools.invoke`, composed in the runner — Decision 1). The **Tool Registry must
never become the authorisation system**: *capability-holding* authorisation is **Directive #015**
(sourced through the resolver the gate already reads), and *external-call* authorisation is the
**API Gateway** (Phase D); the registry is **neither** (ADR 0008 Decisions 5, 6, 9 —
"#013 threads · #014 enforces · #015 sources").

**3. The executor's responsibilities are four; its non-responsibilities are five.** As a
**mechanism** under the Policy vs Mechanism Rule (*"the gate defines policy; the runtime provides
mechanism"*), the executor **does**: (1) **resolve** a cleared `ProposedAction` to a registered
tool by its capability / type; (2) **re-assert permission** at the point of application — the
`SECURITY DEFINER` re-check (Decision 8); (3) **invoke** the tool's typed implementation against
the validated args / approved payload and **capture** its result into the run; (4) **audit** the
application to the one event log in policy-then-mechanism order (Decision 10). It **must not**:
(1) **decide autonomy** — the gate owns that; the executor runs only on an already-cleared
verdict and never re-classifies; (2) **authorise capability-holding** — #015's job, sourced
through the resolver; the executor consumes the resolved set, it does not widen it; (3) **make
external provider calls** — those route through the **API Gateway (Phase D)**; a tool needing a
net-new external call **depends on D** and is out of Phase C's reference set; (4) **own the
task's terminal transition** — it never calls `hq_ai_task_complete` / `hq_ai_task_fail`, it
signals via return / throw and the **runner** drives the lease-guarded transition (runner rule 3,
Volume XIII §21); (5) **meter cost / enforce budget at the call** — the gateway's job (Phase D);
Phase C reads the registry's cost *estimate* into P4 only.

**4. Apply-on-approval is *out of band* (the CEO's first ruling). The `waiting_approval` task
transition stays deferred.** The Approval Engine *"NEVER sends, generates, or automates …
approve() only marks an item approved; a separate, later phase reads `approved` rows and acts"*
(`server/services/hq-approvals.ts:31-33`). **Phase C is that separate phase**, triggered out of
band — a bounded sweep over `approved`-but-unapplied approvals, or an enqueued application task —
**not** by blocking the originating task at `waiting_approval` until the human decides. The chain:
a needs-approval action becomes a `pending` `hq_approvals` row via `requestApproval` and **the
originating task completes** (Phase B, unchanged); a reviewer grants it via `approveApproval`
(`server/services/hq-approvals.ts:256-290`, recording `approval.granted` at `:283`), optionally
with an `edited_payload`; the executor then **applies the granted action once** through the
registered tool, using **`edited_payload ?? proposed_payload`** and **attributing the human
approver** in the audit (Volume XIII §15 lines 347-350). Out-of-band fulfilment **honours ADR
0008 Decision 8**, which deferred the `waiting_approval` / `verifying` task transitions
(`server/services/hq-tasks.ts:47-48`) to their own directive; Phase C **does not activate them**.

**5. The "applied" marker is a *separate record*, not a sixth approval state (the CEO's second
ruling). The Approval Engine state machine is frozen and is not reopened.** The Approval Engine
is **five states, terminal-immutable** (`lib/approvals/state.ts:32-46`); `approved` is terminal,
frozen forever. "Applied" is therefore **not** a sixth state — adding one would reopen frozen
contract #6, which the CEO explicitly forbade (*"Do not reopen the Approval Engine state
machine"*). Phase C records application in a **separate application / idempotency record** keyed
by approval id (and, for an autonomous action, by the action's identity), sitting **beside**
`hq_approvals`, not inside its lifecycle. The record is the executor's source of truth for what
has already been applied (Decision 6) and for the apply-on-approval sweep's "what is still
unapplied" query.

**6. Retry safety is by *idempotency*, composing the Task Engine's existing retry — the executor
adds no new retry machinery (the CEO's approved direction).** The Task Engine already owns retry:
`failTask(retryable)` re-queues with exponential backoff while retries remain
(`server/services/hq-tasks.ts:311-329`); `reapTasks` recovers expired leases as retryable
failures (`:374-385`). It retries the **whole task** — re-claim, re-run the handler from the top
— so **idempotency is the central Phase-C obligation**: a task that applied action A then failed
on B must **not re-apply A** on retry. Two composed mechanisms, neither invented: (a)
**application idempotency** — each application carries a **stable key** (the run's
`correlationId` + the action's identity; for an approval, the approval id) recorded in the
application record (Decision 5); a re-attempt with an already-applied key is a **no-op success** —
the Approval Engine's own idiom (*"re-deciding a row already in the target terminal state is a
no-op success"*, `server/services/hq-approvals.ts:35-37`), and the discipline the Task Engine
exposes via `dedupeKey` (`server/services/hq-tasks.ts:175`); (b) **checkpoint of applied
actions** — the runner's `checkpointTask` (`server/services/hq-tasks.ts:268-281`) records which
actions have applied so a re-run **skips** completed ones before the key is even consulted
(defence in depth: the checkpoint is the fast path, the key is the guarantee).

**7. Rollback is *structural* — by limiting irreversible work through approval (the CEO's
approved direction). No two-phase commit, saga, or compensation engine is built.** There is no
atomic transaction across heterogeneous tools (a `memory.write` and a `comm.send` cannot be one
commit), and Phase C builds none. The rollback story is inherited from the **P4 classification
the doorman already enforces**: (a) **irreversible actions never run autonomously in a batch** —
P4 atom 1 routes every irreversible action to approval, so it is **applied singly, post-approval**
(Decision 4); there is no partial irreversible batch to undo; (b) **reversible actions are
idempotently re-applicable** — a partial failure leaves applied reversible writes in place, the
Task Engine retries, and idempotency (Decision 6) converges the re-run; "rollback" for reversible
state is **forward re-application**, not compensation; (c) **the irreducible hard case is named,
not hidden** — an *irreversible* tool that fails *mid-effect* is **not** silently undone; it is
recorded on the application record and **escalated to a human** (`ai.escalated`,
`lib/events/registry.ts:83`), the residue P4 deliberately concentrates into the approval path so
a human is already in the loop. Building distributed-transaction machinery would be the **largest
over-engineering trap of the phase** and is rejected.

**8. Defence in depth — *inherited re-checking at the execution boundary* (the CEO's third
ruling).** ADR 0008 Decision 4 requires every action be checked "in the SDK **and** re-asserted
in the `SECURITY DEFINER` entry point." Phase B satisfied this **only on the approval path** (it
inherited the Approval Engine's SQL boundary) and **explicitly deferred** the autonomous re-check
(Phase B proposal §3.8). Phase C lands it: the re-assertion sits at **each tool's bound
`SECURITY DEFINER` entry point** — a `memory.write` tool re-checks at the memory entry point, a
`comm.send` tool at the Communication Layer's. Where a tool binds a subsystem that already has
such a boundary, Phase C **inherits** it; a **generic tool-application guard** is built **only**
for a tool that lacks one, and if any genuinely-new SQL is required it is flagged for ADR
treatment. A **registry-keyed capability re-check** (does the employee still *hold* this
capability?) stays with **#015**, which builds the registry to check against (ADR 0008 Decision
9).

**9. Failure semantics — *granular failure records* (the CEO's fourth ruling); the throw-based
ABI for the inline path.** A **denial** is the doorman's verdict (Phase B); a **failure** is a
*cleared* action whose tool **invocation** then fails — different events, different owners. On the
**autonomous (inline)** path, a tool failure surfaces as a throw from `ctx.tools.invoke` and the
**runner** records the lease-guarded `hq_ai_task_fail` — the throw-based ABI the Reference
Employee already proved for a refused approval (`__tests__/sdk/reference-employee.test.ts`); the
executor itself **never** calls `failTask` (Decision 3, runner rule 3). The default is
**throw-by-default with a typed per-action result available**, so a handler that wants
partial-progress semantics can opt in (symmetric with `proposeActions` returning
`GateVerdict[]`). On the **apply-on-approval (out-of-band)** path, the originating task is already
terminal, so a failure cannot fail it: the application record captures the failure, the action
stays **unapplied** and **safe to re-attempt** (Decision 6) on the next sweep, bounded by a retry
ceiling; an action that exhausts it **escalates** (`ai.escalated`) rather than silently dropping —
the same "never silently drop a human-required side effect" property the throw path proves.

**10. Event sequencing — *clear sequencing* (the CEO's fifth ruling): cause precedes effect, and
`ai.tool_called` is reused, not re-minted.** The invariant: **the permission / approval event
always precedes the application event**, so the one log reconstructs *permitted/approved →
applied* for any action (`WHERE actor_id = slug ORDER BY id`, Volume XIII §16 line 370). The
canonical orders:

- **Autonomous:** `ai.action_permitted` (Phase B, `:548`) → `ai.tool_called` (Phase C, the
  application) → the tool's own domain event (e.g. `memory.written`).
- **Approval:** `approval.requested` (Phase B, in-transaction on INSERT) → `approval.granted`
  (human, `server/services/hq-approvals.ts:283`) → `ai.tool_called` (Phase C, **attributing the
  approver**) → the tool's own domain event.

The application event **reuses the registered `ai.tool_called`** (`lib/events/registry.ts:77`)
rather than mint a new verb — the "one source of event names" discipline; the registry grew to 11
only when `ai.action_permitted` was genuinely new under #014. An application **failure** is
carried on the run's existing `ai.run_failed` (`:79`) plus the tool's own error event; a dedicated
application-failure verb is minted only on an explicit later need.

**11. The boundary with the Generic Task Engine — "Approval decides; the Task Engine gates; the
executor applies."** The executor **owns no task lifecycle**. The Task Engine's eight
`SECURITY DEFINER` entry points remain the only way the queue is touched; the executor calls
**none** of the terminal ones (it signals via return / throw, the runner drives the transition —
runner rules 1–4, Volume XIII §21) and leans only on the **non-terminal, lease-guarded**
`checkpointTask` (Decision 6). The **deferred task-side seams stay reserved-inert** —
`waiting_approval` / `verifying` (`server/services/hq-tasks.ts:47-48`), the `approval_status`
column (`:78`), and `depends_on` (`:69`) — because out-of-band apply-on-approval (Decision 4)
needs **none** of them. This is the Kernel Contract Map §4.4 line, extended by one clause: the
executor applies; it gates nothing.

**12. Explicit deferrals — assembled *over* this contract, not folded into it (unchanged from ADR
0008).** To **Phase D**: the **API Gateway**, all *external* provider calls, and **live cost
metering** (ADR 0008 Decisions 5, 10) — Phase C's reference tools touch HQ substrate only. To
**Directive #015**: the **Capability Registry** and any **registry-keyed SQL capability re-check**
(ADR 0008 Decision 9). To their own directives: **verification** of an applied result, the
**`waiting_approval` / `verifying` task transitions**, and the **DAG** (`depends_on`). And per the
CEO's implementation gate: **no broad executor rollout** and **no new employee migration** in
Phase C.

**13. Scope, phasing within Phase C, blast radius, and the implementation gate.** Implementation
**does not begin until this ADR is reviewed and approved** (the CEO's gate). It then proceeds in
**small reviewable increments** — *"the smallest safe slice"* — mirroring Phase B's B1→B2→B3:
**C1** the **tool registry contract** (the typed registry over `tools_allowed` + reference tools,
descriptive only — no apply); **C2** the **executor contract** (the autonomous apply + the
`SECURITY DEFINER` re-check + idempotent retry; failure → throw → runner); **C3** the
**apply-on-approval marker** (the out-of-band step + the separate application record; apply once,
honour `edited_payload`, attribute the approver, escalate on exhaustion); **C4** the **Reference
Path execution test** (the extended Reference Employee — the Reference Path Rule's first
deliverable use). The change is **additive** — a new `ctx.tools` facet, a runtime apply step, and
two additive tables — so **no historical row is rewritten** and the two live handlers
(`research-ai`, `lead-qualification`) stay green. Each sub-phase is its own PR under the full
six-gate validation discipline (TypeScript · lint · unit · integration · security · production
build); **no later sub-phase begins until the current one has passed the gates and received CEO
approval.** **Phase D (the API gateway + live cost metering) does not begin until Phase C has a
completion record and CEO review.**

---

## Alternatives weighed

- **In-band apply-on-approval** (block the originating task at `waiting_approval` until the human
  decides, then resume). **Rejected** — ADR 0008 Decision 8 deferred that task transition to its
  own directive; out-of-band fulfilment delivers the "approval completion flow" without reopening
  the deferred seam or holding a lease across human latency (Decision 4).
- **A sixth approval state ("applied").** **Rejected by the CEO review** (*"Do not reopen the
  Approval Engine state machine"*) — `approved` is terminal in the frozen five-state machine
  (`lib/approvals/state.ts:32-46`); application is a **separate record**, not a state transition
  (Decision 5).
- **A distributed-transaction / saga / compensation engine for rollback.** **Rejected** — there
  is no atomic commit across heterogeneous tools; P4 already routes irreversible work to approval,
  bounding the blast radius to reversible (idempotently re-applicable) actions. This would be the
  phase's largest over-engineering trap (Decision 7).
- **The Tool Registry as the authorisation system** (a tool grant = a capability grant).
  **Rejected** (ADR 0008 Decision 6, re-affirmed by the CEO) — the registry *describes*;
  capability-holding authorisation is **#015**, external-call authorisation is the **gateway**
  (Decision 2).
- **Minting new application verbs** (`ai.action_applied` / `ai.action_failed`). **Considered** —
  more explicit, and additive as `ai.action_permitted` was. **Rejected for now** in favour of
  reusing the registered `ai.tool_called` ("one source of event names"); mint only on an explicit
  later need (Decision 10).
- **A single generic tool-application `SECURITY DEFINER` guard for all tools.** **Considered** —
  but most reference tools bind a subsystem that **already** has such a boundary, so Phase C
  **inherits** it (the Phase-B discipline); a generic guard is built only for a tool that lacks
  one, and flagged for ADR treatment if it needs genuinely-new SQL (Decision 8).
- **One failed action fails the whole task, with no per-action result.** **Rejected** in favour
  of **throw-by-default with a typed per-action result available** — the CEO's "granular failure
  records": simplest by default, never silently dropping, yet opt-in partial-progress for a
  handler that wants it (Decision 9).
- **Build external provider calls / the API Gateway in Phase C.** **Rejected** — that is Phase D
  (ADR 0008 Decisions 5, 10); Phase C's reference tools bind shipped HQ substrate only (Decision
  12).
- **Ride ADR 0008 with no new ADR, as Phases A and B did.** **Rejected by the CEO review** —
  Phase C introduces the **first executor**, the **apply-on-approval flow**, and the directive's
  **first net-new persistence**, *"significant enough to require a new ADR."* This record is that
  ADR.

---

## Consequences

**What the workforce inherits.** With Phase C, a **permitted decision becomes an applied effect**
and an **approved decision is fulfilled** — the same uniform door now *acts*, not just classifies.
Every employee — present and future — gets typed tool invocation, idempotent retry, a re-checked
execution boundary, and a single audit trail **for free**; the doorman's verdicts stop being
inert. Employee handlers stay **smaller** (the Reuse-Index thesis): the runtime composes the
apply, the facets only expose capability.

**Where C4 closes.** This is where the **autonomous-path defence-in-depth re-check** that Phase B
deferred finally lands (Decision 8): "the AI never bypasses security" becomes structural on the
execution path too — every applied action is permission-checked in the SDK **and** re-asserted at
the tool's `SECURITY DEFINER` boundary, audited to the one log, with identity stamped by the SDK
so the spoofing class stays designed out.

**Blast radius.** *Code:* add the `ctx.tools` facet (descriptive reads) and the runtime apply
step (`ctx.tools.invoke`), and **extend the autonomous branch from audit-only to apply+audit**
(`server/sdk/tasks.ts:545-552`) — additive, so the two live handlers stay green. *Schema:* **two
additive tables** — the **tool/provider registry** (ADR 0008 Consequences named this) and the
**application / idempotency record** (Decision 5) — both new, touching no historical row, held to
*extend before replace*; the **frozen Approval Engine table and lifecycle are untouched**, and
**no new task-lifecycle column** is added (the approval-lifecycle seam stays deferred).
*Reversibility:* the new `ctx.tools` member is additive; the executor sits behind the registry and
the application record, so its mechanism can evolve without touching handlers.

**Enforcement (the test matrix Phase C must pass).** The registry resolves by capability and its
`reversibilityClass` **feeds P4** (a send-class tool routes to approval, a memory-class tool runs
autonomous — proving the registry *describes* and the gate still *decides*); an `autonomous`
verdict **applies** through the bound tool and audits `ai.tool_called` **after**
`ai.action_permitted`, and the `SECURITY DEFINER` re-check **refuses a tampered call**; a task
that applies A then throws on B **skips A on retry** (no double-apply — the central guarantee); an
`approved` approval is **applied once**, honours `edited_payload`, **attributes the approver**, and
a second sweep is a **no-op**; an unrecoverable autonomous failure **throws → `hq_ai_task_fail`**,
an exhausted apply-on-approval **escalates**, never silently drops; facet isolation is re-pinned
(the `ctx.tools` facet exposes the registry, the apply orchestration lives in the runner); and the
**extended Reference Employee** exercises both verdict paths end-to-end (the reversible write
actually written; the irreversible send actually sent post-approval) — the **Reference Path Rule**
applied. The six-gate CI and the #012/#013/#014 runner suites stay green.

**Freeze status & synchronisation.** Contract #3 (AI SDK) is **Partial** today and **stays
Partial through Phase C** — Phase C advances the envelope (`ctx.tools` + the executor) but does
**not** complete it, because `ctx.api` lands in Phase D. The graduation **Partial → Established**
occurs when **Phase D completes the envelope**; per the synchronisation rule instituted with the
[Kernel Contract Map](../governance/kernel-contract-map.md), that graduation will update **both**
the Architecture Freeze (§4 row 3) **and** the Kernel Contract Map (the AI SDK row) **in the same
PR**. The five architectural rulings recorded here are **standing** for the rest of the directive.

**Numbering.** This is ADR **0009** ([`../governance/numbering.md`](../governance/numbering.md)
§5); ADR numbers are monotonic and never reused. The number is **reserved on creation**; this ADR
is **Proposed · held for CEO review**, so it is registered in §5 as *Proposed* and the next free
ADR number advances to **`0010`**. Per the Architecture Freeze §2, the architectural-review
sign-off for the *contract change itself* travels with the implementation PR(s) that carry the
Phase C code; this decision record — once **accepted** by the CEO — is those PRs' prerequisite, and
**no Phase C implementation begins before that acceptance.**

**Acceptance & implementation gate.** **No Phase C code is written until this ADR is reviewed and
approved.** On acceptance, implementation follows the approved small-increment plan — **C1** (tool
registry contract) → **C2** (executor contract) → **C3** (apply-on-approval marker) → **C4**
(Reference Path execution test) — each its own reviewable PR under the full six-gate validation
discipline, with **no broad executor rollout, no new employee migration, no Capability Registry,
and no API Gateway** in Phase C, and **full validation discipline maintained** throughout. Phase D
(the API gateway + live cost metering) does not begin until Phase C has a completion record and CEO
review; Directive #015 stays out of scope until #014 is complete.

---

*Documentation only. No code, schema, migration, configuration, or git history was changed by
this record. Authored ahead of implementation under the document-before-you-build rule at the
CEO's direction, and **held for CEO review**: no Directive #014 Phase C implementation begins
before this ADR is accepted. Prepared for CEO Directive #014 / D-04 (the AI SDK Envelope), **Phase
C — the executor**; it formalises the CEO-approved [Phase C architecture
proposal](../governance/directive-014-phase-c-executor-proposal.md) and the five architectural
rulings the review returned — out-of-band apply-on-approval, a separate applied marker, inherited
re-checking at the execution boundary, granular failure records, and clear event sequencing —
encoded above, and is the prerequisite the now-gated implementation PRs build upon.*
