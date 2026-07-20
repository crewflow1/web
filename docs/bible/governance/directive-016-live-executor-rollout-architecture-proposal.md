# CrewFlow Governance — Directive #016 (D-06) Architecture Proposal: the Live Executor Rollout

> **Status:** **Architecture proposal — held for CEO review.** It changes no code, schema,
> migration, configuration, or git history. **No #016 implementation begins** until it is reviewed
> and approved, and (per §6) **ADR 0011 is authored, reviewed and accepted before any code.** This
> document presents the architecture for **Directive #016 / D-06 — the Live Executor Rollout: wiring
> the already-built, C4-proven SDK Executor into the live AI-employee run loop, so a permitted
> decision becomes an applied effect in production.** It is the proposal the CEO authorised on
> confirming the subject: *"Directive #016 shall be the Live Executor Rollout … wire the already-built,
> C4-proven SDK Executor into the live AI employee run loop … make it load-bearing in production,"*
> with the packaging ruling *"do not bundle the API Gateway and Cost Metering into Directive #016 …
> API Gateway + Cost Metering should become the next directive after the executor is live."* It
> follows the [accepted #016 dependency-ordering analysis](./directive-016-dependency-ordering-analysis.md)
> (merged, PR #260), which fixed the subject and the order, and maintains the document-first, ADR-first,
> incremental discipline of Directives #013, #014 and #015.
>
> **The required definitions, in order.** The CEO directed the proposal define **purpose · scope ·
> non-goals · architecture · contracts · ADR requirements · rollout strategy · validation strategy ·
> rollback strategy · completion criteria.** §§1–10 answer those ten, each in its own section and in
> that order. §11 surfaces the genuine forks as explicit questions for the CEO to rule on (the standing
> *I propose; the CEO decides* discipline); §12 records status and the next step.
>
> **Thesis (one line):** #016 introduces **no new contract and no new policy** — it composes the
> **C4-proven** `registry → gate → executor → application` chain into the live runner, making **four
> Established contracts** (#3 AI SDK, #4 RunContext, #6 Approval Engine, #8 Capability Registry)
> **load-bearing together** for the first time; its only genuinely net-new build is the **durable
> application store + the out-of-band apply-on-approval sweep** that C3 deliberately deferred to *"the
> executor rollout,"* and the **migration of the two live employees** onto the kernel executor.

---

## 0. How to read this

The CEO's mandate is to **present the architecture and hold for review** — not to build. Every factual
claim is cited to repository evidence verified at integration tip **`563385f`** (the PR #260 merge).
§§1–10 are the CEO's ten required definitions, answered in order. The proposal is governed by the
engineering standards homed in the [Kernel Contract Map](./kernel-contract-map.md) §2 and accumulated
across this platform: the **Facet Isolation**, **Policy vs Mechanism**, **Runtime Composition**,
**Executor Boundary**, **Registry Immutability**, **Executor Idempotency**, **Application Atomicity**,
**Reference Path**, and **Reference Implementation** Rules. **#016 invents none of these — it is bound
by all of them.** The whole point of the rollout is that the policy was already decided (ADR 0008/0009)
and proven (C4); #016 is the disciplined act of making the proven thing live. **The proposal proposes;
it does not build.**

---

## 1. Purpose

**Why this directive exists.** The SDK Executor is **built, proven, and dormant.**

- **Built.** `server/sdk/executor.ts` ships the full plan-then-apply boundary: `planExecution`
  (L211, the pure registry-consuming planner with four deny-by-default checks), `executePlan` (L264,
  the one async step that crosses the boundary via an injected `ToolImplementation`), `execute` (L287,
  *"the end-to-end shape the runner composes,"* L281), the `Executor` interface (L311), `createExecutor`
  (L329) and `REFERENCE_EXECUTOR` (L351). The apply-on-approval marker ships beside it in
  `server/sdk/application.ts`: `deriveIdempotencyKey` (L149), `resolveAppliedPayload` (L181), the
  applied/failed `ApplicationRecord`, `shouldEscalate` (L238), the `ApplicationStore` interface (L307)
  and `applyOnce` (L383).
- **Proven.** The **C4 Reference Path** (`__tests__/sdk/reference-path-execution.test.ts`) composes the
  **real** `registry → gate → executor → application` chain end-to-end with **no mock** — autonomous
  apply, the parked-then-cleared irreversible path with approver attribution and edited payload, replay
  (`already_applied`), deterministic path-namespaced idempotency, and failure recovery (a thrown
  boundary records a *failure*, never an application; transient-then-success recovers to exactly one
  application; ceiling-exhaustion escalates without re-crossing). Its driver helper is described, in
  source, as *"the executor's plan/apply wrapped by the marker's apply-once, **the exact shape the
  rollout will wire**"* (test L182–185).
- **Dormant.** The live runner does **not** compose it. `server/sdk/tasks.ts` — the claim → run →
  complete loop — contains **zero** references to the executor, the application record, or tool
  invocation. The doorman's autonomous branch today (`createProposeActions`, tasks.ts:504–513) emits a
  best-effort `ai.action_permitted` audit and **stops**; *the side effect the action describes is never
  carried out.*

Directive #014's own completion record names this exact gap as the deferred future extension of the
now-Established AI SDK: *"the executor rollout into the live run loop and the API gateway + cost metering
… are a deferred future extension of the now-established contract"*
([directive-014-phase-c-executor-proposal.md](./directive-014-phase-c-executor-proposal.md) §9). ADR
0009, which designed the executor, gated precisely this: *"no broad executor rollout and no new employee
migration in Phase C"* (Decision 12). **#016 is that named, gated, deferred rollout** — the first half
of the extension (the executor going live), with the second half (the API gateway + cost metering) held
to **#017** per the CEO's packaging ruling.

**The purpose, stated plainly:** make the proven executor **load-bearing in production** — the moment
CrewFlow's AI employees first **act** autonomously *through the kernel* rather than through bespoke
per-employee action code. After #016, a permitted decision **takes effect** through a typed, audited,
permission-re-checked tool, and an approved decision is **fulfilled** rather than left a tracked-but-inert
record. It is squarely on-thesis: **platform capability (one shared executor) grows; employee complexity
(bespoke action code) shrinks** — the Platform-Reuse-Index thesis made real on the execution path.

---

## 2. Scope

**What #016 includes.** The rollout is **mostly wiring, with two honest net-new builds.** In scope:

1. **The runner composition (the autonomous, inline path).** Extend the runner's autonomous branch from
   **audit-only to apply+audit** (`createProposeActions`/`buildContext`, tasks.ts:477–568): on an
   `autonomous` verdict, compose `executor.plan(action, verdict)` → `applyOnce({ store, identity, apply:
   () => executor.apply(plan, invoke) })` over the durable store, then audit `ai.tool_called` **after**
   `ai.action_permitted` (ADR 0009 Decision 10). The runner owns this composition (the **Runtime
   Composition Rule**) — it is the **third** runtime-composition seam, after the Phase-A evidence-drain
   (tasks.ts:655) and the Phase-B `proposeActions`.
2. **The injected tool boundary for the live tools.** Bind each registered tool's `ToolImplementation`
   (executor.ts:73 — the one place an effect happens) to its **already-shipped** subsystem: `memory.write`
   → the memory facet; `comm.send` → the Communication Layer #7 (`server/services/hq-comms.ts`, ADR
   0003). The `SECURITY DEFINER` re-check is **inherited** at each subsystem's existing boundary, not
   newly built (ADR 0009 Decision 8).
3. **The durable `ApplicationStore` (net-new persistence).** Today only `createInMemoryApplicationStore`
   exists (application.ts:321) — sufficient for C3's tests, not for production. #016 implements a
   durable, Supabase-backed store over **one additive table** (working name `hq_ai_applications`), keyed
   by `deriveIdempotencyKey`, recording applied/failed outcomes — the sweep's *"what is still unapplied"*
   source of truth. It sits **beside** `hq_approvals`, never inside its lifecycle (ADR 0009 Decision 5).
4. **The out-of-band apply-on-approval sweep (net-new runtime trigger).** A bounded sweep over
   `approved`-but-unapplied approvals that applies each **once** through the registered tool, using
   `edited_payload ?? proposed_payload`, **attributing the human approver**, and **escalating** on
   ceiling exhaustion (`ai.escalated`). This is the *"separate, later phase [that] reads `approved` rows
   and acts"* the Approval Engine names (`server/services/hq-approvals.ts:31-33`) and that C3 deferred to
   *"the executor rollout"* (application.ts header).
5. **The migration of the two live employees onto the kernel executor.** `lead-qualification`
   (autonomous, deterministic — the C4 reference employee) and `research-ai` (executing, read+draft,
   human-approved) move from bespoke action handling to the executor path — **one at a time**, each
   validated against the reference path before and after (the **Reference Path Rule**).
6. **An operational kill-switch.** A flag that reverts the live apply to today's audit-only behaviour
   **without a redeploy** (see §9), so live execution can be disabled instantly if it misbehaves.
7. **The completion record + contract-row synchronisation** (the #016 completion report; the
   freeze §4 #3 and Kernel Contract Map updates that record the executor-rollout half as realised).

---

## 3. Non-goals

**What #016 explicitly does not do** — the boundary that keeps the rollout small and the dependency order
clean. Each is deferred, with its destination named:

- **The API gateway, external provider calls, and live cost metering → Directive #017.** The CEO's
  explicit packaging ruling: *"Do not bundle the API Gateway and Cost Metering into Directive #016."*
  #016's tools touch **HQ-internal substrate only** (memory, comms-to-human #7); a tool needing a net-new
  *external* call depends on #017 and is out of scope. The runner continues to thread the budget ceiling
  **read-only** (`task.cost_budget_micros`, tasks.ts:545) and *"metering is a later directive"*
  (tasks.ts:223) stands — #016 does not activate the `cost_micros` seam (mig L153).
- **Any change to the Capability Registry (#015).** #015 is complete; #016 **consumes** the resolved
  capability set **read-only** to source the gate's inputs (the **Registry Immutability Rule**) — it adds
  no capability, widens no scope, and modifies no registry surface.
- **Any Task-Engine seam activation.** `depends_on`/DAG (`server/services/hq-tasks.ts:69`), the
  `waiting_approval`/`verifying` transitions (`:47-48`), the `approval_status` column (`:78`), and the
  `verification` seam (mig L151) **stay reserved-inert.** Out-of-band apply-on-approval needs **none** of
  them (ADR 0009 Decision 11). Verification of an applied result is a later directive.
- **Reopening the Approval Engine state machine.** The five-state, terminal-immutable machine
  (`lib/approvals/state.ts:32-46`) is **frozen**; *"applied"* is a **separate record**, never a sixth
  approval state (ADR 0009 Decision 5; the CEO's *"do not reopen the Approval Engine state machine"*).
- **Any distributed-transaction / saga / compensation engine for rollback.** #016 builds none; the
  rollback story is **structural**, inherited unchanged from ADR 0009 Decision 7 (see §9).
- **Speculative tool-catalogue expansion.** The registry is descriptive (the **Registry Immutability
  Rule**); #016 wires only the tools the two live employees actually use. New tools arrive with the
  employees that need them, not ahead of them.
- **The downstream frontiers.** The Boardroom write/act interface (#9, *"observes, does not yet act"*)
  and the Shared Communication Protocol (#10, Reserved) are **downstream of live execution** (accepted
  analysis §3–§4) and out of scope.

---

## 4. Architecture

### 4.1 The seam, precisely located

Today the runner builds the RunContext in `buildContext` (tasks.ts:526) and freezes it (`Object.freeze`,
tasks.ts:567). The context's `proposeActions` member is `createProposeActions` (tasks.ts:477) — the
**doorman**, which for each proposed action asks the **pure gate** (`evaluateAction`, gate.ts:135) for a
verdict and then supplies the *mechanism* the gate must never know (the **Policy vs Mechanism Rule**):

- `needs_approval` → hand off to the Approval Engine (`requestApproval`, tasks.ts:493); throw on refusal
  (the throw-based ABI). **Unchanged by #016.**
- `autonomous` → emit a best-effort `ai.action_permitted` audit (tasks.ts:507–512) and **stop.** **This
  is the seam #016 fills:** today the branch *classifies and routes but does not apply.*

**#016 changes only the autonomous branch — from audit-only to apply+audit.** Nothing about the gate, the
verdict taxonomy, the approval hand-off, or the run lifecycle changes. The doorman keeps deciding; the
runner starts applying what it cleared.

### 4.2 The composition the runner wires (the C4-proven shape)

The exact composition is the one the C4 Reference Path already drives end-to-end (its helper
`applyClearedThroughExecutor`, test L187–208):

```
verdict = evaluateAction(action, posture, capabilities, budget)   // Phase B — UNCHANGED (gate.ts:135)
  └─ autonomous ─▶ plan = executor.plan(action, verdict)          // C2 — pure (executor.ts:211)
                   └─ applyOnce({                                  // C3 — idempotent marker (application.ts:383)
                        store,                                     //   the DURABLE store (§4.4) — net-new
                        identity,                                  //   ExecutionIdentity (autonomous | approval)
                        apply: () => executor.apply(plan, invoke), //   cross the boundary ONCE (executor.ts:264)
                      })
                   └─ audit ai.tool_called AFTER ai.action_permitted   // ADR 0009 Decision 10
```

- **`invoke` is the injected boundary** (`ToolImplementation`, executor.ts:73) — the runner supplies it,
  binding each tool to its shipped subsystem. The envelope stays pure up to this single seam, which is why
  C4 needed no mock and why the rollout's risk is concentrated at exactly one, well-tested point.
- **`identity` is the `ExecutionIdentity`** (application.ts) — `autonomous` (task id · tool label · action
  id · correlation id) on the inline path, `approval` (approval id · …) on the sweep path. The idempotency
  key is namespaced by path, so an autonomous key and an approval key never collide (the **Executor
  Idempotency Rule**).
- **Failure → throw → runner.** A cleared tool that throws is captured by `applyOnce` as a `failed`
  record; on the inline path an unrecoverable failure propagates and the **runner** records the
  lease-guarded `hq_ai_task_fail` (tasks.ts:640) — the executor **never** calls `failTask` (the **Executor
  Boundary Rule**; ADR 0009 Decision 3).

This is the **third runtime-composition seam**, sequenced after the existing evidence-drain
(`drainEvidenceInto`, tasks.ts:655) and the Phase-B doorman — cross-facet orchestration the Facet
Isolation Rule forbids a facet from doing, so it lives in the runner (the **Runtime Composition Rule**).

### 4.3 The two paths

**Autonomous (inline, in the run).** The handler proposes; the gate clears; the runner applies each
cleared action in input order through the bound tool, records the applied marker, and audits
`ai.tool_called` after `ai.action_permitted`. Idempotent by construction (`deriveIdempotencyKey`), so the
Task Engine's existing whole-task retry (`failTask(retryable)`, `reapTasks`) is safe: a task that applied
A then failed on B **skips A** on re-run (the central no-double-apply guarantee). The runner still owns
the run's lifecycle around the applies (claim, heartbeat, checkpoint, complete/fail) — the executor owns
only the **apply** of a single action.

**Apply-on-approval (out-of-band, after the run).** Unchanged from Phase B: a needs-approval action
becomes a `pending` `hq_approvals` row and **the originating task completes.** A reviewer later grants it
(`approveApproval`, recording `approval.granted`), optionally editing the payload. **#016's net-new
trigger** — a bounded sweep — then reads `approved`-but-unapplied approvals and applies each **once**
through the registered tool, using `edited_payload ?? proposed_payload`, attributing the approver, and
escalating on ceiling exhaustion. The originating task is already terminal, so a sweep failure cannot fail
it; the action stays **unapplied and safe to re-attempt** until it succeeds or escalates (ADR 0009
Decision 9). This honours ADR 0008 Decision 8 — the `waiting_approval` transition stays **deferred**, not
activated.

### 4.4 The durable application store (net-new persistence)

C3 built the `ApplicationStore` **interface** (application.ts:307) and an **in-memory** implementation
(application.ts:321) for tests, and stated plainly that *"the record's physical table and the out-of-band
sweep that writes it are the executor ROLLOUT — deliberately out of C3's scope"* (application.ts header).
**#016 builds that physical table** — one additive table (working name `hq_ai_applications`):

- **Keyed** by `deriveIdempotencyKey(identity)` — the deterministic, path-namespaced key C3 already
  computes (the **Executor Idempotency Rule**: *task id · approval id · tool label · action id ·
  correlation id*).
- **Records** the discriminated `applied` / `failed` outcome (ADR 0009 Decision 5; the **Application
  Atomicity Rule** — a failure **never** persists as applied; if persistence cannot represent the
  outcome, the operation fails rather than recording an ambiguous state).
- **Sits beside `hq_approvals`**, touching no historical row and no frozen lifecycle — *extend before
  replace.* The Approval Engine table and its five-state machine are **untouched.**

The store implements the **same** interface the in-memory store implements, so the entire C3 contract
suite re-runs against the durable implementation unchanged (§8). This is the rollout's first slice (§7
R1) precisely because it is descriptive persistence with no wiring — lowest risk, highest test density.

### 4.5 Identity, audit, and the boundaries that hold the whole way

- **Identity is stamped by the SDK**, sourced from the frozen RunContext (`identity`, tasks.ts:548;
  #013 threads · #014 enforces · #015 sources). The executor consumes the resolved set; it never widens
  it. The spoofing class stays designed out.
- **Audit sequencing** is invariant: the permission/approval event **always precedes** the application
  event — `ai.action_permitted → ai.tool_called → [tool's domain event]` (autonomous);
  `approval.requested → approval.granted → ai.tool_called (approver attributed) → [domain event]`
  (approval). `ai.tool_called` is **reused**, not re-minted (ADR 0009 Decision 10).
- **The Executor Boundary Rule holds end-to-end:** the executor **applies; it never decides** (a
  non-autonomous verdict is **refused** — `not_cleared` — never re-classified), never requests approval,
  never touches the Task Engine. The rollout wires the mechanism into the runner **without** moving any
  policy into it.

### 4.6 Illustrative target shape (design only — not implemented)

A sketch to make the additive wiring concrete. **This is not implementation;** the exact types are settled
by the #016 implementation PRs under ADR 0011. The frozen RunContext fields are unchanged.

```ts
// In the runner (server/sdk/tasks.ts), the autonomous branch of createProposeActions —
// today AUDIT-ONLY (tasks.ts:504-513), extended to APPLY+AUDIT. Cross-facet orchestration,
// so it lives in the runner (Runtime Composition Rule), never in a facet.
async function applyCleared(action: ProposedAction, verdict: GateVerdict): Promise<void> {
  const planned = executor.plan(action, verdict);           // C2 — pure; refuses an uncleared action
  if (!planned.ok) throw new Error(`uncleared: ${planned.refusal.reason}`);  // never re-classify
  const result = await applyOnce({                          // C3 — idempotent, atomic
    store: durableApplicationStore,                         // §4.4 — the net-new durable store
    identity: autonomousIdentity(task, action),             // task·tool·action·correlation
    apply: () => executor.apply(planned.plan, invokeFor(action)),  // cross the boundary ONCE
  });
  // ai.action_permitted already emitted (Phase B); now the application, AFTER it (Decision 10):
  if (result.status === "applied") {
    await events.emit({ verb: "ai.tool_called", /* …attribute, correlate… */ });
  }
  // failed/escalated: the marker records it; the inline path throws so the runner fails the task.
}

// The out-of-band sweep (a bounded reaper-style pass; §4.3). The originating task already completed.
async function applyApprovedActions(): Promise<void> {
  for (const approval of await readApprovedUnapplied(/* bounded */)) {
    await applyOnce({
      store: durableApplicationStore,
      identity: approvalIdentity(approval),                 // approval·tool·action·correlation
      apply: () => executor.apply(planFromApproval(approval), invokeFor(approval)),
      approver: { approverId: approval.reviewer_id, approverEmail: approval.reviewer_email },
    });  // edited_payload ?? proposed_payload; escalates on ceiling exhaustion (Decision 9)
  }
}
```

---

## 5. Contracts

The Architecture-Freeze contracts #016 touches, and their honest status transitions. **#016 graduates no
contract by itself** — it makes Established contracts load-bearing and advances one Partial contract.

| # | Contract | Status today | #016's effect | Status after #016 |
|---|---|---|---|---|
| **#3** | AI SDK | **Established** (executor *built*, rollout deferred) | **realises the executor-rollout half** of the named deferred extension; the API-gateway half stays deferred to #017 | **Established** — extension half realised; freeze §4 #3 note updated |
| **#4** | RunContext | **Established** | **consumes** `identity`/`budget`/`signal`/`capabilities` read-only; no contract change | **Established** (unchanged) |
| **#5** | Task Engine | **Partial** (DAG/verification/approval-gating inert) | **advances** it — the run loop now carries real execution — but activates **no** reserved seam | **Partial** (advanced, not completed) |
| **#6** | Approval Engine | **Established** | **binds** apply-on-approval to it (reads `approved` rows); state machine **not** reopened | **Established** (unchanged) |
| **#8** | Capability Registry | **Established** | **gates** every applied action on it (sources capabilities); read-only | **Established** (unchanged) |

**The standing rules #016 is bound by (and invents none of).** The executor family is already fully
specified: the **Executor Boundary Rule** (applies only cleared actions; owns no policy/approval/lifecycle),
the **Registry Immutability Rule** (consume the registry, never mutate it), the **Executor Idempotency
Rule** (deterministic key from stable execution identity), the **Application Atomicity Rule** (a failure
never records as applied), the **Reference Path** and **Reference Implementation** Rules (prove the
capability end-to-end before platform expansion). #016 is the disciplined application of all of them to the
live loop. The freeze rule (§2: *changing a contract requires an ADR + architectural review in the same
PR*) is satisfied by **ADR 0011** (§6) plus the review travelling with the implementation PRs.

**The contract-row synchronisation** (the rule instituted with the Kernel Contract Map): the completion of
#016 updates **both** the Architecture Freeze (§4 #3's deferred-extension note, and #5's advancement) **and**
the Kernel Contract Map, **in the same PR.** No row moves until the rollout is complete and reviewed.

---

## 6. ADR requirements

**A new ADR — ADR 0011 — is required, authored and accepted before any #016 code** (the next free ADR
number per [numbering.md](./numbering.md) §5; ADRs 0001–0010 are issued). #016 does **not** ride ADR 0009.

**Why a new ADR, not ADR 0009.** ADR 0009 designed the executor and the apply-on-approval *mechanics*, but
**explicitly gated the rollout out of its own scope**: *"no broad executor rollout and no new employee
migration"* (Decision 12), and it deferred *"the record's physical table and the out-of-band sweep"* to the
rollout (application.ts header). The rollout therefore carries **net-new decisions ADR 0009 did not make**:

1. **First live execution** — the runner composing the executor into the production loop for the two live
   employees (ADR 0009's reference path proved the shape on a *reference* employee, in tests).
2. **Net-new persistence** — the durable `hq_ai_applications` table and its access pattern. This is the
   same test that made Phase C warrant ADR 0009 in the first place: *"the directive's first net-new
   persistence … significant enough to require a new ADR"* (ADR 0009 Context). The durable store is #016's
   first net-new persistence by the identical logic.
3. **A net-new runtime trigger** — the out-of-band apply-on-approval sweep (its cadence, bounding,
   escalation wiring, and idempotency against concurrent runs).
4. **A live-employee migration plan** — moving `lead-qualification` and `research-ai` off bespoke action
   code onto the kernel executor, and the rollout/rollback controls that make that safe.

**What ADR 0011 must record** (the contract before the code): the runner-composition contract (where
`execute()` wires in, and the invariant that only the autonomous branch changes); the durable
`ApplicationStore` schema and the *extend-before-replace*, *beside-not-inside-`hq_approvals`* placement;
the sweep design (cadence, bounding, ceiling/escalation, concurrency idempotency); the inherited
`SECURITY DEFINER` re-check landing for each live tool; the kill-switch and the per-slice rollback; the
live-employee migration order and its reference-path gating; and which freeze/Kernel-Contract-Map rows
update on completion. It is authored in the **strict document-before-you-build** form used for ADRs
0007/0008/0009 — written, reviewed, and **accepted before R1 begins.**

**No other ADR is reopened.** ADR 0009 stands as the executor's design basis; ADR 0011 *builds on* it
(the way ADR 0009 built on 0007/0008/0004/0001/0003) and records the rollout, not a re-decision of the
executor. ADRs 0001 (Approval Engine), 0004 (Task Engine), 0007 (RunContext), 0010 (Capability Registry)
are consumed unchanged.

---

## 7. Rollout strategy

**Incrementally, smallest-safe-slice-first, each its own PR under the full six-gate validation discipline,
no later slice beginning until the current has passed the gates and received CEO approval** — the
#013/#014/#015 cadence (#014's C1→C4; #015's R1→R4 then LR1→LR5). The slices:

- **R1 — the durable application store.** Implement the Supabase-backed `ApplicationStore` over the
  additive `hq_ai_applications` table (the C3 interface, now durable). **Descriptive persistence only — no
  wiring.** The full C3 contract suite re-runs against it. *Lowest risk; the schema-first discipline.*
- **R2 — the runner composition, shadow-first.** Extend the autonomous branch to **compute the plan and
  record what it *would* apply** to the durable store **without crossing the boundary** — a shadow over the
  two live employees, mirroring #015's R3 pure-resolver shadow. Prove parity: the executor's intended
  applies match what the bespoke code does, for a window.
- **R3 — the authority switch (autonomous apply), behind the kill-switch.** Flip the autonomous branch from
  shadow to **live apply+audit** for one employee at a time, gated by the §9 kill-switch. `ai.tool_called`
  now lands after `ai.action_permitted`; the reversible write is **actually written.**
- **R4 — the out-of-band apply-on-approval sweep.** Ship the bounded sweep: apply once, honour
  `edited_payload`, attribute the approver, escalate on exhaustion. The irreversible send is **actually
  sent**, only post-grant.
- **R5 — migrate the two live employees, one at a time.** `lead-qualification` first (autonomous,
  deterministic — the C4 reference employee, lowest surprise), then `research-ai` (human-approved). Each
  migration removes that employee's bespoke action code and is **validated against the reference path
  before and after** (the Reference Path Rule). The platform-compatibility matrix records each migration.
- **R6 — completion record + contract synchronisation.** The #016 completion report; the freeze §4 #3 /
  #5 and Kernel Contract Map updates (§5), in one PR.

**The blast radius is introduced gradually:** shadow (no effect) → one employee live → both live → sweep.
At every step the change is **additive** (no historical row rewritten), so each slice is independently
revertible, and the kill-switch can return any live slice to today's audit-only behaviour without redeploy.

---

## 8. Validation strategy

**The standing six-gate bar** — TypeScript · lint · unit · integration · security · production build — on
every slice, plus #016-specific coverage that proves the rollout did not weaken any boundary:

- **The durable store passes the C3 contract unchanged.** Apply-once, atomicity (a failure never records
  as applied), replay (`already_applied`), and escalation — the in-memory suite re-run against the durable
  implementation. *Same contract, new backing.*
- **The runner composition.** An autonomous verdict now **applies** through the bound tool and audits
  `ai.tool_called` **after** `ai.action_permitted`; a task that applies A then throws on B **skips A** on
  retry (no double-apply — the central guarantee); the inherited `SECURITY DEFINER` re-check **refuses a
  tampered call**; the executor **refuses** (`not_cleared`) an uncleared action rather than re-classifying.
- **Apply-on-approval.** An `approved` approval applies **once**, honours `edited_payload`, **attributes
  the approver**, and a second sweep is a **no-op**; an exhausted ceiling **escalates** (`ai.escalated`),
  never silently drops.
- **The Reference Path stays green — and is extended through the live runner.** The C4 composition
  (`__tests__/sdk/reference-path-execution.test.ts`) continues to pass, and the reference employee is
  exercised **through the live loop** (not only the composed helper) — the Reference Path Rule's continued
  use as the rollout's acceptance proof.
- **The two live employees stay green through migration, and their actions take effect.**
  `lead-qualification`'s reversible write is autonomously written and its irreversible send sent only
  post-approval; `research-ai`'s draft is created on the human-approved path. Existing suites stay green at
  each step.
- **Security.** Identity-stamping holds (no spoofing); **deny-by-default** holds (a missing capability or
  budget overrun routes to approval, never autonomy); the executor **never applies an uncleared action.**
- **Shadow parity (R2).** For a window, the executor's intended applies match the bespoke code's actual
  applies before R3 flips authority — the #015 R2/R3 parity discipline.

---

## 9. Rollback strategy

Two distinct senses, both answered honestly:

**(a) Rolling back the *rollout itself* — operational, instant.** A **kill-switch** flag reverts the live
apply to today's **audit-only** behaviour **without a redeploy**: the autonomous branch falls back to
emitting `ai.action_permitted` and stopping (the exact pre-#016 behaviour, tasks.ts:504–513), and the sweep
is paused. Because every slice is **additive** (the durable store touches no historical row; the wiring
extends one branch; no frozen lifecycle is reopened), each can be reverted independently, and disabling the
wiring leaves the durable store **inert and harmless.** The shadow-first sequencing (R2) means the first
*live* effect is gated behind proven parity and the switch.

**(b) Rolling back an *applied action* — structural, inherited unchanged from ADR 0009 Decision 7.** There
is **no two-phase commit across heterogeneous tools**, and #016 builds none — that would be the rollout's
largest over-engineering trap. The story is the one P4 already enforces:

- **Irreversible actions never run autonomously in a batch** — P4 atom 1 routes every irreversible action
  to approval, so it is **applied singly, post-approval**; there is no partial irreversible batch to undo.
- **Reversible actions are idempotently re-applicable** — a partial failure leaves applied reversible
  writes in place; the Task Engine retries; idempotency converges the re-run. "Rollback" for reversible
  state is **forward re-application**, not compensation.
- **The irreducible mid-effect irreversible failure is named, not hidden** — it is recorded on the
  application record and **escalated to a human** (`ai.escalated`), the residue P4 concentrates into the
  approval path so a human is already in the loop. The **durable store makes this auditable**: every
  applied/failed/escalated action is a queryable row, so the escalation residue is visible and recoverable,
  never silent.

---

## 10. Completion criteria

#016 is complete when **all** hold:

1. **The runner composes the executor.** The autonomous branch **applies+audits** (not audit-only);
   `server/sdk/tasks.ts` references the executor, the durable application store, and tool invocation — the
   exact **inverse** of the dependency-analysis fact that *"`tasks.ts` … contains zero references to the
   executor"* (accepted analysis §2a).
2. **The durable application store is live** over the additive `hq_ai_applications` table, and the C3
   contract suite passes against it (atomicity, apply-once, escalation).
3. **The out-of-band apply-on-approval sweep runs** — an approved action is **fulfilled** (applied once,
   approver attributed, escalation on exhaustion), with the `waiting_approval` transition still **deferred**.
4. **Both live employees execute through the kernel executor** — `lead-qualification` and `research-ai`
   migrated, their bespoke action code removed, each proven against the reference path before and after.
5. **The six gates pass on every slice**, and the security suite proves identity-stamping, deny-by-default,
   and no-uncleared-apply.
6. **The kill-switch exists and is proven** — the live apply can be returned to audit-only without redeploy.
7. **ADR 0011 is accepted; the #016 completion report is recorded;** freeze §4 #3 (executor-rollout half
   realised, API-gateway half deferred to #017) and #5 (advanced) are updated, with the Kernel Contract Map
   synchronised **in the same PR**.
8. **The API gateway, external calls, and live cost metering remain out** — their absence is **not** a
   defect of #016; they are #017. Completion of #016 does **not** require them.

---

## 11. Open questions for the CEO to rule on

The proposal presents the recommended shape; it does not decide the roadmap (*I propose; the CEO decides*).
Five genuine forks warrant an explicit ruling:

1. **A new ADR 0011, or ride ADR 0009?** ADR 0009 designed the executor but **gated the rollout out of its
   scope** and deferred the durable store + sweep. The rollout adds **first live execution, first net-new
   persistence, a new runtime trigger, and the first employee migration** — the same test that made Phase C
   warrant ADR 0009. **Recommendation: a new ADR 0011**, authored and accepted before R1.
2. **Shadow-first, or direct switch on the autonomous path?** **Recommendation: shadow-first** (R2 → R3) —
   the autonomous path is the *apply-by-accident* risk surface, so prove parity before crossing the
   boundary; the apply-on-approval path may go direct behind the kill-switch (a human already gated it).
3. **Migrate both employees together, or one at a time?** **Recommendation: one at a time** —
   `lead-qualification` first (deterministic, autonomous, the C4 reference employee; lowest surprise), then
   `research-ai` (human-approved). Each gated on the reference path.
4. **The apply-on-approval trigger — a bounded cron sweep, or an enqueued application task on grant?** ADR
   0009 Decision 4 permits either. **Recommendation: a bounded sweep** (simplest; no new task type; the
   `reapTasks` precedent), with the enqueued-task option held in reserve if approval-to-apply latency ever
   matters.
5. **The durable store table — standalone `hq_ai_applications`, or an additive column elsewhere?**
   **Recommendation: a standalone additive table beside `hq_approvals`** (ADR 0009 Decision 5 — never inside
   the approval lifecycle), keyed by the C3 idempotency key.

---

## 12. Status & next step

This document is an **architecture proposal, held for CEO review.** It changes no code, schema, migration,
configuration, or git history. **No #016 implementation begins** until it is reviewed and approved, and —
on approval — **ADR 0011 is authored, reviewed and accepted before R1** (the strict document-before-you-build
gate). The CEO's standing constraints for this step are honoured in full: *do not begin implementation; do
not write migrations; do not change runtime behaviour; do not change schema; do not open implementation PRs;
architecture proposal only.*

On approval, the sequence is: **ADR 0011** (the rollout decision) → **R1** (the durable application store) →
**R2** (the shadow composition) → **R3** (the autonomous authority switch, behind the kill-switch) → **R4**
(the apply-on-approval sweep) → **R5** (migrate the two live employees, one at a time) → **R6** (the
completion record + contract synchronisation) — each its own reviewable PR under the full six-gate
discipline, no later slice beginning until the current has passed and received CEO approval. **The API
Gateway + Cost Metering remain Directive #017**, opened only after the executor is live.

---

*Documentation only. No code, schema, migration, configuration, or git history was changed by this
proposal. Prepared under the #011 governance umbrella (Master Roadmap D-01) as the architecture proposal
for Directive #016 / D-06 — the Live Executor Rollout — assembled over the C4-proven SDK Executor
(`server/sdk/executor.ts`, `application.ts`; ADR 0009), the frozen RunContext (contract #4, Established
under #013 / ADR 0007), the Capability Registry (contract #8, Established under #015 / ADR 0010), and the
Approval Engine (contract #6, Established under ADR 0001). It follows the accepted
[#016 dependency-ordering analysis](./directive-016-dependency-ordering-analysis.md) (PR #260) and is
governed by the engineering standards homed in the [Kernel Contract Map](./kernel-contract-map.md) §2.
The CEO's review outcome will be recorded in a follow-up section, as for the #014 Phase C proposal.*
