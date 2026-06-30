# ADR 0011 — Live Executor Rollout

> **Status:** **Accepted** *(CEO independent CTO review)* — the **governing architectural decision**
> for Directive **#016 / D-06**; on acceptance the CEO **authorised R1 only** (R1 scope amended — see
> Decision 11, *Acceptance amendment*) and **gated R2 → R6** on independent review. · **Date:** 2026-06-30 ·
> **Directive:** CEO Directive **#016 / D-06** (*the Live Executor Rollout*) · **Supersedes:** none ·
> **Superseded by:** none · **Builds on:**
> [ADR 0009](./0009-sdk-executor-apply-on-approval.md) (the SDK Executor and Apply-on-Approval
> Runtime — the design this ADR *rolls out*, not re-decides),
> [ADR 0008](./0008-ai-sdk-envelope.md) (the doorman, and the `apply` step Decision 8 deferred),
> [ADR 0007](./0007-runcontext-runtime-contract.md) (the frozen RunContext + canonical identity),
> [ADR 0010](./0010-capability-registry.md) (the resolved capability set the gate reads — consumed
> read-only), [ADR 0004](./0004-generic-task-engine.md) (the run loop, retry, and lifecycle the
> runner owns), [ADR 0001](./0001-approval-engine.md) (the `approved` rows the sweep reads),
> [ADR 0003](./0003-communication-layer.md) (the `comm.send` tool boundary).
>
> **Eleventh ADR** under the [`../README.md`](../README.md) *document-before-you-build* rule, in its
> **strictest** form — as for ADRs 0007/0008/0009/0010. The CEO, on approving the
> [#016 architecture proposal](../governance/directive-016-live-executor-rollout-architecture-proposal.md)
> (PR #261, merged), ruled: *"Before implementation begins: Write **ADR 0011 — Live Executor
> Rollout** … No implementation begins before ADR 0011 has been independently reviewed and
> approved … Do not begin R1 until ADR 0011 has been reviewed and approved."* This decision record
> is therefore authored **ahead of any #016 code** and held for that review. It defines the **ten
> elements the CEO required** — execution ownership · runner responsibilities · executor boundaries ·
> application persistence · approval application flow · shadow rollout strategy · operational
> kill-switch · rollback strategy · validation strategy · completion criteria — each a first-class
> Decision below, and records as the directive's governing principle the new permanent **Execution
> Ownership Rule** the CEO set on the proposal review (Decision 1; homed in the
> [Kernel Contract Map](../governance/kernel-contract-map.md) §2 in this same PR). #016 **introduces
> no new contract and no new policy**; it graduates no Architecture-Freeze contract. This document
> changes no code, schema, migration, configuration, or git history.

---

## Context

**The executor is built, proven, and dormant.** [ADR 0009](./0009-sdk-executor-apply-on-approval.md)
designed and Directive #014 Phase C shipped the full plan-then-apply boundary — `server/sdk/executor.ts`
(`planExecution` L211, the pure registry-consuming planner with four deny-by-default checks;
`executePlan` L264, the one async step that crosses the boundary via an injected `ToolImplementation`
L73; `execute` L287, *"the end-to-end shape the runner composes,"* L277; the `Executor` interface
L311) and the apply-on-approval marker `server/sdk/application.ts` (`deriveIdempotencyKey` L149,
`resolveAppliedPayload` L181, `shouldEscalate` L238, the `ApplicationStore` interface L307, `applyOnce`
L383). The **C4 Reference Path** (`__tests__/sdk/reference-path-execution.test.ts`) composed the
**real** `registry → gate → executor → application` chain end-to-end with **no mock** — autonomous
apply, the parked-then-cleared irreversible path with approver attribution and edited payload, replay
(`already_applied`), deterministic path-namespaced idempotency, and failure recovery — its driver
helper described in source as *"the exact shape the rollout will wire"* (test L182–185).

**But the live runner does not compose it.** `server/sdk/tasks.ts` — the claim → run → complete loop —
contains **zero** references to the executor, the application record, or tool invocation. The doorman's
autonomous branch (`createProposeActions`, tasks.ts:477; the autonomous `else` at tasks.ts:504–513)
today emits a best-effort `ai.action_permitted` audit (verb at tasks.ts:508) and **stops**; *the side
effect the action describes is never carried out.* This is precisely what ADR 0009 **gated out of its
own scope** — *"no broad executor rollout and no new employee migration in Phase C"* (Decision 12) —
and what it **deferred to the rollout**: *"the record's physical table and the out-of-band sweep that
writes it are the executor ROLLOUT — deliberately out of C3's scope"* (`application.ts` header).
Directive #014's completion record names the same gap as the deferred extension of the now-Established
AI SDK: *"the executor rollout into the live run loop and the API gateway + cost metering … are a
deferred future extension of the now-established contract"*
([directive-014-phase-c-executor-proposal.md](../governance/directive-014-phase-c-executor-proposal.md)
§9).

**#016 is that named, gated, deferred rollout** — the *first half* of the extension (the executor
going live), with the *second half* (the API gateway + cost metering) held to **#017** by the CEO's
explicit packaging ruling. The accepted
[#016 dependency-ordering analysis](../governance/directive-016-dependency-ordering-analysis.md)
(PR #260) fixed the subject and the order; the CEO-approved
[#016 architecture proposal](../governance/directive-016-live-executor-rollout-architecture-proposal.md)
(PR #261) presented the architecture and **required this ADR before any code.** This ADR is the
contract that proposal named.

**Why a new ADR, not a rider on ADR 0009.** ADR 0009 designed the *mechanics*; the rollout carries
**net-new decisions ADR 0009 did not make** — the same test that made Phase C warrant its own ADR:

1. **First live execution** — the runner composing the executor into the *production* loop for the two
   live employees (ADR 0009 proved the shape on a *reference* employee, in tests).
2. **First net-new persistence** — the durable `hq_ai_applications` table and its access pattern (the
   identical logic by which *"the directive's first net-new persistence … significant enough to require
   a new ADR"* warranted ADR 0009; ADR 0009 Context).
3. **A net-new runtime trigger** — the out-of-band apply-on-approval sweep (its cadence, bounding,
   escalation wiring, and idempotency against concurrent runs).
4. **A live-employee migration plan** — moving `lead-qualification` and `research-ai` off bespoke action
   code onto the kernel executor, with the rollout/rollback controls that make it safe.

**The CEO review of the proposal returned two binding things this ADR encodes.** The CEO **approved**
the architecture (*"the production rollout of the executor path already designed, tested and deferred
from Directive #014"*) and set **one new permanent engineering rule** — the **Execution Ownership
Rule** — to govern the directive (Decision 1), and **one implementation gate**: *no implementation
begins until this ADR is independently reviewed and approved; then small reviewable increments; do not
begin R1 until then* (Decision 11). Both are encoded below as first-class Decisions, not footnotes.

---

## Decision

**1. Execution ownership — the Execution Ownership Rule governs Directive #016 (the CEO's new
permanent principle).** Only the runtime may execute approved or autonomous actions. The directive's
governing rule, set by the CEO on the architecture-proposal review and homed in the
[Kernel Contract Map](../governance/kernel-contract-map.md) §2 in this same PR, is:

> **Only the runtime may execute approved or autonomous actions. Employees may propose actions. The
> gate may classify actions. The Approval Engine may approve actions. The executor may apply actions.
> But the runtime owns the decision to execute. No employee handler may bypass the runtime execution
> path.**

This is the #016 counterpart to the rule each prior directive earned (the **Single Source of
Authority Rule** governed #015; the **Executor Boundary Rule** governed #014 Phase C): it draws the
**five-actor separation** the rollout must preserve at every step — *propose* (the employee handler) ·
*classify* (the gate) · *approve* (the Approval Engine) · *apply* (the executor mechanism) · **own the
decision to execute** (the runtime/runner). It is the structural reason the apply orchestration lives
in the **runner** and never in a facet or a handler (the **Runtime Composition Rule**): an employee
handler proposes, but it **cannot reach the executor** — the runtime composes the path, so there is no
employee-bypass surface. Every Decision below is an application of this rule.

**2. Runner responsibilities — the runner composes `registry → gate → executor → application`, and
owns everything around the apply.** The runner (`server/sdk/tasks.ts`) is the **one** place facets
meet, where cross-facet sequencing lives (the **Runtime Composition Rule**; the **Facet Isolation
Rule** forbids a facet from doing this). #016 extends the **autonomous branch only** —
`createProposeActions`'s autonomous `else` (tasks.ts:504–513), today **audit-only** — from *audit* to
**apply+audit**, composing the C4-proven shape: `executor.plan(action, verdict)` →
`applyOnce({ store, identity, apply: () => executor.apply(plan, invoke) })` over the durable store,
then audit `ai.tool_called` **after** `ai.action_permitted` (ADR 0009 Decision 10). This is the
**third** runtime-composition seam, sequenced after the Phase-A evidence-drain (`drainEvidenceInto`,
tasks.ts:655) and the Phase-B doorman. The runner **owns**: building and freezing the RunContext
(`buildContext` tasks.ts:526; `Object.freeze(ctx)` tasks.ts:567); threading canonical identity
(tasks.ts:548); supplying the injected `ToolImplementation` boundary that binds each tool to its
shipped subsystem (Decision 3); the audit sequencing (Decision 1 of ADR 0009 Decision 10); reading the
operational kill-switch (Decision 7); and the **run lifecycle** around the applies — claim, heartbeat,
checkpoint, complete, and the lease-guarded fail (`failTask`, tasks.ts:640). The runner owns the
*decision to execute* and the *lifecycle*; the executor owns only the *apply of a single action*. The
`needs_approval` branch (`requestApproval`, tasks.ts:493) is **unchanged**; nothing about the gate, the
verdict taxonomy, the approval hand-off, or the run lifecycle changes.

**3. Executor boundaries — unchanged from ADR 0009's Executor Boundary Rule; the executor code is
consumed, not extended.** #016 adds **no executor behaviour.** The executor stays a **mechanism only**
under the standing Executor Boundary Rule (*"the executor applies only actions that have already passed
the gate … must not decide whether an action is allowed … must not request approval … must not bypass
the Task Engine … policy remains with the gate, approval with the Approval Engine, lifecycle with the
Task Engine"*): it **applies** a cleared action and nothing else. It **refuses** an uncleared action
(`not_cleared`) rather than re-classifying it; it **never** calls `failTask` (an unrecoverable inline
failure propagates and the *runner* records the lease-guarded fail, tasks.ts:640); it consumes the
resolved capability set and never widens it (the **Registry Immutability Rule**). The rollout wires
this mechanism into the runner **without moving any policy into it** — the Execution Ownership Rule and
the Executor Boundary Rule are the same boundary seen from the two sides: the runtime *owns the
decision to execute*, the executor *only applies what was cleared*.

**4. Application persistence — a durable `ApplicationStore` over one additive table, beside
`hq_approvals`, never inside it.** C3 built the `ApplicationStore` **interface** (application.ts:307)
and an **in-memory** implementation (application.ts:321) for tests, and deferred *"the record's
physical table"* to the rollout (application.ts header). #016 builds that table — one **additive**
table (working name `hq_ai_applications`), under *extend before replace*:

- **Keyed** by `deriveIdempotencyKey(identity)` — the deterministic, path-namespaced key C3 already
  computes (the **Executor Idempotency Rule**: *task id · approval id · tool label · action id ·
  correlation id*), so an autonomous key and an approval key can never collide.
- **Records** the discriminated `applied` / `failed` outcome (ADR 0009 Decision 5) under the
  **Application Atomicity Rule** — a failure **never** persists as applied; if persistence cannot
  represent the outcome unambiguously, the operation **fails** rather than recording an ambiguous
  state.
- **Sits beside `hq_approvals`**, touching no historical row and no frozen lifecycle. The Approval
  Engine table and its **five-state, terminal-immutable** machine (`lib/approvals/state.ts`) are
  **untouched**; *"applied"* is a **separate record**, never a sixth approval state (ADR 0009 Decision
  5; the CEO's *"do not reopen the Approval Engine state machine"*).

The durable store implements the **same** `ApplicationStore` interface the in-memory store implements,
so the **entire C3 contract suite re-runs against it unchanged** (Decision 9). This is #016's first
net-new persistence, isolated as the rollout's first slice (Decision 11, R1) precisely because it is
**descriptive persistence with no wiring** — lowest risk, highest test density.

**5. Approval application flow — the out-of-band apply-on-approval sweep (ADR 0009 Decision 4,
realised).** Apply-on-approval is **out of band**, not an in-band task block. The `needs_approval`
path is unchanged from Phase B: a needs-approval action becomes a `pending` `hq_approvals` row and
**the originating task completes.** A reviewer later grants it (`approveApproval`, recording
`approval.granted`), optionally editing the payload. #016's **net-new trigger** is a **bounded sweep**
that reads `approved`-but-unapplied approvals — the *"separate, later phase [that] reads `approved`
rows and acts"* the Approval Engine names (`server/services/hq-approvals.ts:32`) — and applies each
**once** through the registered tool, using `edited_payload ?? proposed_payload` (`resolveAppliedPayload`
application.ts:181), **attributing the human approver**, and **escalating** on ceiling exhaustion
(`shouldEscalate` application.ts:238; `ai.escalated`). Because the originating task is already terminal,
a sweep failure **cannot fail it**; the action stays **unapplied and safe to re-attempt** until it
succeeds or escalates (ADR 0009 Decision 9). This honours ADR 0008 Decision 8 — the `waiting_approval`
task transition (`server/services/hq-tasks.ts:47`) stays **deferred, not activated.** The trigger is a
bounded sweep (the `reapTasks` precedent — simplest, no new task type); the enqueued-application-task
option ADR 0009 Decision 4 also permits is **held in reserve** for if approval-to-apply latency ever
matters.

**6. Shadow rollout strategy — shadow-first on the autonomous path; prove parity before crossing the
boundary.** The autonomous path is the **apply-by-accident** risk surface, so the authority switch is
**preceded by a shadow** (the **Shadow Validation Rule**, #015's discipline applied to execution).
Before any live apply (Decision 11, R3), the autonomous branch is extended to **compute the plan and
record what it *would* apply** to the durable store **without crossing the boundary** (Decision 11, R2)
— a shadow over the two live employees, mirroring #015's R3 pure-resolver shadow. For a window, the
executor's intended applies are proven to **match** what the employees' bespoke code actually does;
only on demonstrated parity does R3 flip authority, **one employee at a time**, behind the kill-switch.
The apply-on-approval path (Decision 5) may go **direct behind the kill-switch** — a human already
gated each action, so the shadow's *apply-by-accident* concern does not apply there.

**7. Operational kill-switch — instant revert to audit-only, without a redeploy.** A runtime flag
reverts the live apply to today's **audit-only** behaviour **without a redeploy**: the autonomous
branch falls back to emitting `ai.action_permitted` and stopping (the exact pre-#016 behaviour,
tasks.ts:504–513), and the sweep is **paused.** It is **default-safe** — the rollout is gated *on*, so
the absence or failure of the switch leaves execution disabled, never silently enabled. It is the
operational expression of the **Rollback Readiness Rule** (#015's discipline): a live capability ships
only with a proven, deploy-free way to turn it off. The kill-switch is the *operational* half of the
rollback story (Decision 8a); it does **not** undo an already-applied effect (Decision 8b).

**8. Rollback strategy — two senses, both answered; no two-phase commit is built.**

- **(a) Rolling back the *rollout itself* — operational, instant.** The kill-switch (Decision 7) plus
  **per-slice additive revertibility**: every slice is **additive** (the durable store touches no
  historical row; the wiring extends one branch; no frozen lifecycle is reopened), so each is
  independently revertible, and disabling the wiring leaves the durable store **inert and harmless.**
  The shadow-first sequencing (Decision 6) means the first *live* effect is gated behind proven parity
  and the switch.
- **(b) Rolling back an *applied action* — structural, inherited unchanged from ADR 0009 Decision 7.**
  There is **no two-phase commit across heterogeneous tools, and #016 builds none** — that would be the
  rollout's largest over-engineering trap. The story is the one P4 already enforces: **irreversible
  actions never run autonomously in a batch** (P4 routes every irreversible action to approval, so it is
  applied *singly, post-approval* — no partial irreversible batch to undo); **reversible actions are
  idempotently re-applicable** (a partial failure leaves applied reversible writes in place; the Task
  Engine retries; idempotency converges the re-run — "rollback" for reversible state is **forward
  re-application**, not compensation); and **the irreducible mid-effect irreversible failure is named,
  not hidden** — recorded on the application record and **escalated to a human** (`ai.escalated`), the
  residue P4 concentrates into the approval path. The durable store (Decision 4) makes this
  **auditable**: every applied/failed/escalated action is a queryable row, so the escalation residue is
  visible and recoverable, never silent.

**9. Validation strategy — the six-gate bar on every slice, plus #016-specific proof that no boundary
weakened.** Every slice passes the standing six gates (TypeScript · lint · unit · integration ·
security · production build); no later slice begins until the current has passed and received CEO
approval. The #016-specific coverage:

- **The durable store passes the C3 contract unchanged** — apply-once, atomicity (a failure never
  records as applied), replay (`already_applied`), and escalation: the in-memory suite re-run against
  the durable implementation. *Same contract, new backing.*
- **The runner composition** — an autonomous verdict now **applies** through the bound tool and audits
  `ai.tool_called` **after** `ai.action_permitted`; a task that applies A then throws on B **skips A**
  on retry (no double-apply — the central guarantee); the inherited `SECURITY DEFINER` re-check
  **refuses a tampered call**; the executor **refuses** (`not_cleared`) an uncleared action rather than
  re-classifying.
- **Apply-on-approval** — an `approved` approval applies **once**, honours `edited_payload`,
  **attributes the approver**, and a second sweep is a **no-op**; an exhausted ceiling **escalates**,
  never silently drops.
- **The Reference Path stays green — and is extended through the live runner** — the C4 composition
  (`__tests__/sdk/reference-path-execution.test.ts`) continues to pass, and the reference employee is
  exercised **through the live loop**, not only the composed helper (the **Reference Path Rule** as the
  rollout's acceptance proof).
- **The two live employees stay green through migration, and their actions take effect** —
  `lead-qualification`'s reversible write is autonomously written and its irreversible send sent only
  post-approval; `research-ai`'s draft is created on the human-approved path; existing suites stay green
  at each step.
- **Security** — identity-stamping holds (no spoofing); **deny-by-default** holds (a missing capability
  or budget overrun routes to approval, never autonomy); the executor **never applies an uncleared
  action.**
- **Shadow parity (R2)** — for a window, the executor's intended applies match the bespoke code's
  actual applies before R3 flips authority (Decision 6).

**10. Completion criteria — #016 is complete when *all* hold.**

1. **The runner composes the executor** — the autonomous branch **applies+audits** (not audit-only);
   `server/sdk/tasks.ts` references the executor, the durable application store, and tool invocation —
   the exact **inverse** of the dependency-analysis fact that *"`tasks.ts` … contains zero references to
   the executor"* (accepted analysis §2a).
2. **The durable application store is live** over the additive `hq_ai_applications` table, and the C3
   contract suite passes against it (atomicity, apply-once, escalation).
3. **The out-of-band apply-on-approval sweep runs** — an approved action is **fulfilled** (applied
   once, approver attributed, escalation on exhaustion), with the `waiting_approval` transition still
   **deferred.**
4. **Both live employees execute through the kernel executor** — `lead-qualification` and `research-ai`
   migrated, their bespoke action code removed, each proven against the reference path before and after.
5. **The six gates pass on every slice**, and the security suite proves identity-stamping,
   deny-by-default, and no-uncleared-apply.
6. **The kill-switch exists and is proven** — the live apply can be returned to audit-only without
   redeploy.
7. **ADR 0011 is accepted; the #016 completion report is recorded;** freeze §4 #3 (executor-rollout
   half realised, API-gateway half deferred to #017) and #5 (advanced) are updated, with the Kernel
   Contract Map synchronised **in the same PR.**
8. **The API gateway, external calls, and live cost metering remain out** — their absence is **not** a
   defect of #016; they are #017. Completion of #016 does **not** require them.

**11. Scope, phasing (R1→R6), blast radius, and the implementation gate.** Implementation **does not
begin until this ADR is independently reviewed and approved** (the CEO's gate). It then proceeds in
**small reviewable increments**, each its own PR under the full six-gate discipline, no later slice
beginning until the current has passed the gates and received CEO approval — the #013/#014/#015 cadence:
**R1** the durable application store (descriptive persistence, no wiring) → **R2** the runner
composition shadow-first (plan + record intent, no boundary crossing; prove parity) → **R3** the
autonomous authority switch (live apply+audit, one employee at a time, behind the kill-switch) → **R4**
the out-of-band apply-on-approval sweep → **R5** migrate the two live employees one at a time
(`lead-qualification` first, then `research-ai`, each gated on the reference path) → **R6** the
completion record + contract synchronisation. The change is **additive** at every step (no historical
row rewritten), so the blast radius is introduced **gradually** — shadow (no effect) → one employee
live → both live → sweep — and each slice is independently revertible. **Out of scope and not begun:**
the API gateway, external provider calls, and live cost metering (**#017**); any Capability Registry
change (#015 is consumed read-only); any Task-Engine seam activation (`depends_on`/DAG, `waiting_approval`/
`verifying`, `approval_status`, the verification seam stay reserved-inert); any reopening of the
Approval Engine state machine; any saga/2PC. **Do not begin R1 until this ADR is reviewed and approved.**

**Acceptance amendment (CEO independent CTO review).** On approving this ADR the CEO **authorised
implementation of R1 only** and **fixed R1's scope** to a single shadow increment combining what this
decision authored as **R1 + R2** — *runner composition, executor invocation, application-store wiring,
execution-ownership enforcement, shadow execution, and audit continuity* — while **excluding**
everything from the authored R3 onward: **no employee migration, no approval sweep, no production
cut-over, no behavioural expansion, no policy change** (and, as already scoped out above, no API Gateway
and no Cost Metering — **#017**). The authored R1→R6 ladder stands as the rollout map; the amendment
merges its first two rungs into the one authorised increment and re-labels the live cut-over (authored
R3) and beyond as the **gated** remainder: *no later increment begins until R1 has been independently
reviewed and approved.* R1 stays **shadow** — it records what it *would* apply and crosses **no** tool
boundary.

---

## Alternatives weighed

- **Ride ADR 0009 with no new ADR.** **Rejected by the CEO** (*"Write ADR 0011 — Live Executor
  Rollout"*) — and on the merits: ADR 0009 **gated the rollout out of its own scope** (Decision 12) and
  deferred the durable store + sweep (application.ts header). The rollout adds first live execution,
  first net-new persistence, a new runtime trigger, and the first employee migration — the same test
  that made Phase C warrant ADR 0009. This record is that ADR; it **builds on** ADR 0009, it does not
  re-decide the executor.
- **Direct switch on the autonomous path (no shadow).** **Rejected** — the autonomous path is the
  *apply-by-accident* surface; crossing the boundary before proving parity inverts the safe order. The
  shadow-first sequence (R2 → R3) proves the executor's intended applies match the bespoke code for a
  window before any live effect (Decision 6). The apply-on-approval path may go direct behind the
  kill-switch (a human already gated it).
- **Migrate both live employees together.** **Rejected** in favour of **one at a time** —
  `lead-qualification` first (deterministic, autonomous, the C4 reference employee; lowest surprise),
  then `research-ai` (human-approved); each gated on the reference path before and after (Decision 11,
  R5). Migrating together would couple two unrelated blast radii into one unreviewable step.
- **An in-band apply-on-approval** (block the originating task at `waiting_approval` until the human
  decides, then resume). **Rejected** — ADR 0008 Decision 8 deferred that task transition; out-of-band
  fulfilment delivers the approval-completion flow without reopening the deferred seam or holding a lease
  across human latency (Decision 5; ADR 0009 Decision 4).
- **A sixth approval state ("applied").** **Rejected** (the CEO's standing *"do not reopen the Approval
  Engine state machine"*) — `approved` is terminal in the frozen five-state machine; application is a
  **separate record** (Decision 4; ADR 0009 Decision 5).
- **A distributed-transaction / saga / compensation engine for rollback.** **Rejected** — there is no
  atomic commit across heterogeneous tools; P4 already routes irreversible work to approval, bounding the
  blast radius to reversible (idempotently re-applicable) actions. This would be the rollout's largest
  over-engineering trap (Decision 8b; ADR 0009 Decision 7).
- **An enqueued application task on grant** (instead of a bounded sweep). **Considered** — ADR 0009
  Decision 4 permits it. **Held in reserve** in favour of a bounded sweep (simplest; no new task type;
  the `reapTasks` precedent), to be revisited only if approval-to-apply latency becomes a requirement
  (Decision 5).
- **An additive `applied` column on `hq_approvals`** (instead of a standalone table). **Rejected** —
  that places the application marker *inside* the approval lifecycle the CEO froze; the durable store is a
  **standalone additive table beside `hq_approvals`**, keyed by the C3 idempotency key (Decision 4; ADR
  0009 Decision 5).
- **Build the API gateway / external calls / cost metering in #016.** **Rejected by the CEO's packaging
  ruling** — *"Do not bundle the API Gateway and Cost Metering into Directive #016 … the next directive
  after the executor is live."* #016's tools touch HQ-internal substrate only; external calls are
  **#017** (Decision 11).

---

## Consequences

**What the workforce inherits.** With #016, a **permitted decision becomes an applied effect** and an
**approved decision is fulfilled** — in *production*, for the *live* employees, not only in the
reference test. Every employee — present and future — runs on **one shared executor**: typed tool
invocation, idempotent retry, a re-checked execution boundary, and a single audit trail, **for free**;
the doorman's verdicts stop being inert. This is squarely on-thesis: **platform capability (one shared
executor) grows; employee complexity (bespoke action code) shrinks** — the Platform-Reuse-Index thesis
made real on the execution path. The migration of `lead-qualification` and `research-ai` is a **net
removal** of per-employee action code (Reuse-Index R4).

**Blast radius.** *Code:* extend the autonomous branch from audit-only to apply+audit
(tasks.ts:504–513) — additive, the two live handlers stay green; add the durable `ApplicationStore`
implementation and the bounded sweep. *Schema:* **one additive table** (`hq_ai_applications`), touching
no historical row; the **frozen Approval Engine table and five-state lifecycle are untouched**, and **no
new task-lifecycle column** is added (the approval-lifecycle and verification seams stay deferred).
*Reversibility:* the kill-switch reverts live apply to audit-only without a redeploy; every slice is
additive and independently revertible; disabling the wiring leaves the durable store inert.

**Freeze status & synchronisation. #016 graduates no contract.** Contract **#3 (AI SDK)** is
**Established**; #016 **realises the executor-rollout half** of its named deferred extension (the
API-gateway half stays deferred to #017), so #3 stays **Established** with its freeze §4 note updated.
Contract **#5 (Task Engine)** is **Partial**; #016 **advances** it (the run loop now carries real
execution) but activates **no** reserved seam, so it stays **Partial (advanced, not completed)**.
Contracts **#4 (RunContext)**, **#6 (Approval Engine)**, and **#8 (Capability Registry)** are
**Established** and **consumed read-only** — unchanged. Per the synchronisation rule instituted with the
[Kernel Contract Map](../governance/kernel-contract-map.md), the completion of #016 updates **both** the
Architecture Freeze (§4 #3's deferred-extension note and #5's advancement) **and** the Kernel Contract
Map **in the same PR** (Decision 10, criterion 7). No row moves until the rollout is complete and
reviewed.

**The Execution Ownership Rule is standing.** Set by the CEO on the proposal review and homed in the
Kernel Contract Map §2 in this PR (Decision 1), it is **permanent and platform-wide**: it completes the
execution-seam rule stack (Facet Isolation → Policy vs Mechanism → Runtime Composition → Executor
Boundary → **Execution Ownership**) by naming the *whole* separation the others each govern one face of
— *propose · classify · approve · apply · own the decision to execute* — and it governs every future
directive that touches the execution path, not only #016.

**Numbering.** This is ADR **0011** ([`../governance/numbering.md`](../governance/numbering.md) §5); ADR
numbers are monotonic and never reused. The number was **reserved on creation** and registered in §5;
on the CEO's independent review the §5 row moved to **Accepted** and the next free ADR number stands at
**`0012`**. Per the Architecture Freeze §2, the architectural-review sign-off for the *contract change
itself* travels with the implementation PR(s) that carry the #016 code; this decision record is those
PRs' **prerequisite** — the R1 → R6 increments build upon it, and with the ADR now accepted **R1 is
authorised; no later increment begins until R1 has been independently reviewed and approved.**

**The implementation gate (the CEO's standing constraint).** On approving this ADR the CEO
**authorised implementation of R1 only** (scope fixed — Decision 11, *Acceptance amendment*).
Implementation proceeds in **small reviewable increments** (R1 → R6), each its own PR under the full
six-gate discipline, **no later slice beginning until the current has passed and received CEO
approval.** **No R2–R6 increment begins until R1 has been independently reviewed and approved.** The
API Gateway + Cost Metering remain **Directive #017**, opened only after the executor is live.

---

*Documentation only. No code, schema, migration, configuration, or git history was changed by this
record. Authored ahead of implementation under the document-before-you-build rule at the CEO's
direction and **accepted on CEO independent CTO review** — it is the **governing architectural
decision** for Directive #016, with **R1 authorised** (scope fixed by the acceptance amendment) and
**R2 → R6 gated** on independent review. Prepared for CEO Directive **#016 / D-06** (the Live Executor
Rollout); it formalises the CEO-approved
[#016 architecture proposal](../governance/directive-016-live-executor-rollout-architecture-proposal.md)
(PR #261), builds on [ADR 0009](./0009-sdk-executor-apply-on-approval.md) (the executor it rolls out,
not re-decides), and records as the directive's governing principle the new permanent **Execution
Ownership Rule** the CEO set on the proposal review, homed in the
[Kernel Contract Map](../governance/kernel-contract-map.md) §2 alongside this record (PR #262).*
