# CrewFlow Governance — Directive #014 (D-04) **Phase C** Architecture Proposal: the Executor

> **Status:** **Approved** *(CEO independent CTO review)* — Phase C implementation **authorised
> but gated**: it does **not** begin until **[ADR 0009](../decisions/0009-sdk-executor-apply-on-approval.md)
> (SDK Executor and Apply-on-Approval Runtime)** has been written, reviewed and approved; see
> **§9** for the outcome, the five **architectural rulings** (out-of-band apply-on-approval ·
> separate applied marker · inherited re-check at the execution boundary · granular failure
> records · clear event sequencing), and the small-increment implementation gate. This document
> presents the architecture for **Directive #014 / D-04, Phase C — the executor: the typed tool
> registry, the step that *applies* a permitted action, and the approval-completion flow that
> applies an action a human has granted.** It was the step the CEO authorised after Phase B
> completed: *"Before implementation begins, present the complete Phase C architecture proposal
> for review. Phase C must clearly define: executor responsibilities, execution lifecycle,
> approval completion flow, event sequencing, failure semantics, retry interaction, rollback
> expectations, boundaries with the Generic Task Engine. No implementation is authorised until
> that proposal has been reviewed and approved."* The document itself changes no code, schema,
> migration, configuration, or git history; it is the governance record the now-gated Phase C
> implementation PRs build upon. **§3 answers the CEO's eight required definitions, each in its
> own subsection.** §9 records the review outcome.
>
> **Phase context.** The phased plan accepted in
> **[ADR 0008](../decisions/0008-ai-sdk-envelope.md)** (Decision 10) is **A** (`events` +
> `comms` facets · the P3 output envelope · the evidence-drain) → **B** (the doorman: the gate +
> P4 + `proposeActions` + the Approval-Engine hand-off) → **C** (this proposal) → **D** (the API
> gateway + live cost metering, **last**). **Phases A and B are merged** (ADR 0008 acceptance
> note; PRs #208→#216 on the `#011` integration branch). Phase C **implements** ADR 0008
> **Decision 6** (the Tool Registry Principle) and the **execution half** of **Decision 8** (the
> doorman *decided*; Phase B *requested*; Phase C *applies*) — but it is the **first phase to
> introduce an executor and net-new persistence**, so whether it warrants its **own ADR (0009)**
> is the one structural question this proposal escalates (§7.6), unlike Phases A and B, which
> rode ADR 0008.

---

## 1. How to read this

The CEO's mandate for this step is to **present the architecture and hold for review** — not to
begin building. §2 gives the one-paragraph thesis. §3 answers, in order, the **eight definitions
the CEO required** — executor responsibilities · execution lifecycle · approval completion flow ·
event sequencing · failure semantics · retry interaction · rollback expectations · boundaries
with the Generic Task Engine — each in its own subsection, preceded by two framing questions
(what Phase C *is*, and what it builds/binds/defers). §4 is an illustrative — **not
implemented** — interface sketch. §5 is the *fill-the-slots* map that backs the "builds the
executor, binds the tools" claim with `file:line` evidence. §6 draws the in/out scope boundary
and recommends **phasing within Phase C**. §7 surfaces the genuine forks as **explicit questions
for the CEO to rule on**. §8 records status; §9 is reserved for the CEO's review outcome.

Every factual claim is cited to repository evidence verified at the current integration tip.
This proposal is governed by the **engineering standards homed in the
[Kernel Contract Map](./kernel-contract-map.md) §2** and accumulated across this directive: the
**Facet Isolation Rule** and the *facets-expose-capability / the-runtime-composes-it* principle
(Phase A); the **Policy vs Mechanism Rule** and the **Runtime Composition Rule** (Phase B); and
the **Reference Path Rule** introduced on the Phase B B3 review (PR #217, merged). Phase C
is the **first test of the Reference Path Rule as a deliverable**: the new capability — *applying*
an action — must be proven end-to-end through the **Reference Employee** before the platform
expands on it (§3.10, §6 C4). **The proposal proposes; it does not build.**

---

## 2. The thesis (one paragraph)

**Phase C is where a permitted decision becomes an applied effect — and it is built as one new
runtime mechanism (the executor) over one new typed catalogue (the tool registry), binding the
already-shipped subsystems and inheriting the doorman's policy unchanged.** The Phase B doorman
*classifies and routes*: it emits `ai.action_permitted` for an autonomous action and hands a
needs-approval action to the Approval Engine — but it **explicitly does not `apply(action)`**
(Phase B proposal §3.7; §12 trap b). Phase C closes that gap, and only that gap. It adds the
**typed tool registry** (ADR 0008 Decision 6; Volume XIII §12) — the Built `tools_allowed`
labels become registered tools, each carrying a typed arg schema, the permission it needs, a cost
estimator, and the **reversibility/blast-radius class that already feeds P4** — and the
**executor**: the runtime step that takes an action the doorman has *cleared* (an `autonomous`
verdict now, or an `approved` approval later) and **applies it by invoking the registered tool,
re-asserting permission at the tool's `SECURITY DEFINER` boundary, and auditing the application
to the one log**. The executor is **runtime-composed, not a facet** — exactly like
`proposeActions` — because applying an action sequences several facets (resolve a tool, re-gate,
emit audit), which the Facet Isolation Rule forbids a facet from doing (Kernel Contract Map §4.2;
the Runtime Composition Rule). The **approval-completion flow** is the same executor on a second
trigger: *"the engine NEVER sends, generates, or automates … a separate, later phase reads
`approved` rows and acts"* (`server/services/hq-approvals.ts:31-33`) — Phase C **is** that
separate phase, applying the granted (possibly edited) payload and **attributing the human
approver** (Volume XIII §15). Crucially, the executor **does not re-decide autonomy** (the gate
owns policy), **does not authorise capability-holding** (#015 sources), **does not make external
provider calls** (the API gateway is Phase D), and **does not own the task's terminal transition**
(the runner does — runner rule 3). It applies; nothing more. The honest boundary on **rollback**:
there is no two-phase commit across heterogeneous tools, and Phase C builds none — instead it
**relies on the P4 classification the doorman already enforces**, which routes every irreversible
action to approval, so the blast radius of a partial failure is bounded to *reversible* actions,
which are idempotently re-applicable on the Task Engine's existing retry. Phase C builds **the
registry + the executor + the apply-on-approval step**, binds **the four shipped subsystems its
reference tools act through** (memory, comms-to-human #7, events, tasks), and **defers** the API
gateway (D), the Capability Registry (#015), verification, and the `waiting_approval` task
transition (ADR 0008 Decision 8) — exactly the lines ADR 0008 already drew.

---

## 3. The questions, answered

### Framing-1. What exactly is "the executor", and what does Phase C close?

The **executor** is the runtime step that **applies** an action — the `apply(action)` the Phase B
doorman deferred. Today, `ctx.proposeActions` runs the pure gate and, on an `autonomous` verdict,
emits a best-effort `ai.action_permitted` audit and **stops** (`server/sdk/tasks.ts:547-549`); on
`needs_approval` it calls `requestApproval` and **stops** (`:533-543`). In both branches the
side effect the action *describes* is never carried out — Phase B "classifies, it does not act"
(Volume XIII §3 line 110: "The **executor** that applies an approved action … is Phase C"). Phase
C makes the autonomous branch **apply + audit** instead of **audit only**, and adds a second
trigger — apply-on-approval — for the branch a human later grants.

**What Phase C closes is the *execution* half of Decision 8.** ADR 0008 Decision 8 split the
autonomy/approval boundary into three acts: #014 *decides* (the gate), *requests* (the Approval
Engine hand-off), and — the deferred remainder — *applies*. Phase B shipped the first two; Phase
C ships the third. After Phase C, a permitted action **takes effect through a typed, audited,
permission-re-checked tool**, and an approved action is **fulfilled** rather than left as a
tracked-but-inert decision. What Phase C **does not** close: the external-call path
(`ctx.api.*`, the gateway — Phase D), capability *sourcing* (#015), and *verification* of an
applied result (deferred, Decision 8) — see Framing-2 and §3.8.

### Framing-2. What does Phase C build, bind, and defer — and does it need a new ADR or migration?

**Builds (the new substrate — three pieces):**

- **the typed tool registry** — `tools_allowed` labels (`Built-inert`, Volume XIII §3 line 102)
  become registered tools: `{ argSchema, permission, costEstimator, reversibilityClass }`
  (ADR 0008 Decision 6; Volume XIII §12 lines 303-310). A descriptive catalogue, **not** an
  authorisation system (Decision 6: "the Tool Registry must never become the authorisation
  system; authorisation remains #015").
- **the executor** — the runtime step `apply(action)`: resolve the tool, re-assert permission at
  the tool's `SECURITY DEFINER` boundary, invoke, capture the result, audit. Exposed as
  `ctx.tools.invoke(name, args)` (Volume XIII §12 line 306) and composed in the runner, exactly
  where `proposeActions` lives.
- **the apply-on-approval step** — reads `approved` approvals and runs the executor against the
  granted/edited payload, attributing the approver (Volume XIII §15 lines 347-350).

**Binds (already shipped — what the reference tools act through):** the **memory facet**
(`server/sdk/memory.ts`, Phase A/earlier) for a `memory.write`; the **Communication Layer #7**
(`server/services/hq-comms.ts`, ADR 0003 — outbound-to-human, Established) for a `comm.send`; the
**events facet** (`server/sdk/events.ts`, Phase A) for the application audit; the **Approval
Engine** (`server/services/hq-approvals.ts`, ADR 0001) for the granted-payload read on the
apply-on-approval path. The doorman binds unchanged: the executor runs **after** a verdict the
existing `evaluateAction` produced.

**Defers** (ADR 0008 Decisions 8, 9, 10): the **API gateway** and live **cost metering** (Phase
D — every *external* provider call; Phase C's reference tools touch HQ substrate only); the
**Capability Registry** and any registry-keyed SQL re-check (#015); **verification** of an applied
result; the **`waiting_approval` / `verifying` task transitions** and the `approval_status` task
column (`server/services/hq-tasks.ts:47-48,78` — reserved-inert; Decision 8 defers the task-side
mechanics to their own directive); the **DAG** (`depends_on`, `:69`).

**Migration — yes, minimally, and this is new for the directive.** Phases A and B added **zero**
schema. Phase C needs persistence the prior phases did not: the **tool/provider registry** rows
(ADR 0008 Consequences names this — "a tool/provider registry + per-call audit rows, settled
within this ADR's scope at implementation") and an **idempotency/application record** so a retried
task does not double-apply and an approved action is applied **once** (§3.6, §3.3). Both are
**additive** (new tables), touch no historical row, and are held to *extend before replace*. The
Approval Engine's **frozen five-state machine is not reopened** (`lib/approvals/state.ts:32-46`) —
the application record sits **beside** `hq_approvals`, not inside its lifecycle (§3.3, §7.2).

**ADR — recommended (the one genuine escalation).** Phases A and B rode ADR 0008 because they
*implemented already-decided things*; the architectural-review sign-off travelled with the
implementation PRs (Architecture Freeze §2). Phase C is different in kind: it introduces the
**first executor** (a mechanism that *applies side effects*), the **apply-on-approval flow**
(the deferred "fulfilment"), and **net-new persistence**. The recommendation is a **new
ADR 0009** to record the executor contract, the idempotency model, and the apply-on-approval
mechanics before code — the *document-before-you-build* rule in its strict form, as for ADRs 0007
and 0008. §7.6 puts this to the CEO; if the CEO prefers, Phase C can ride ADR 0008 like A/B.

### 1. **Executor responsibilities** — what the executor does, and what it must never do

The executor is a **mechanism**, governed by the Policy vs Mechanism Rule: "the gate defines
policy; the runtime provides mechanism" (Phase B proposal §9). Its responsibilities are exactly
four, and its non-responsibilities are deliberately five.

**It does:**
1. **Resolve** a cleared `ProposedAction` to a registered tool by its capability/type
   (the registry lookup, §3-Framing-2).
2. **Re-assert permission** at the point of application — the `SECURITY DEFINER` re-check ADR 0008
   Decision 4 requires ("in the SDK **and** re-asserted in the `SECURITY DEFINER` entry point").
   Phase B *inherited* this re-check from the engines it routed to and **deferred the executor's
   own** to "the phase that has both an executor and a registry" (Phase B proposal §3.8). Phase C
   **is** that phase: the re-check lands at the tool's bound entry point (§3.8).
3. **Invoke** the tool's typed implementation against the validated args / approved payload, and
   **capture** its result into the run.
4. **Audit** the application to the one event log (C5) through the `events` facet, in policy-then-
   mechanism order (§3.4).

**It must not:**
1. **Decide autonomy** — the gate owns that; the executor runs only on a verdict already cleared
   (`autonomous`, or an `approved` approval). It never re-classifies (Volume XIII §15: "the
   handler never decides its own autonomy").
2. **Authorise capability-holding** — whether the employee *may hold* the capability is #015's
   job, *sourced* through the resolver the gate already reads; the executor consumes the resolved
   set, it does not widen it (ADR 0008 Decision 6; "#013 threads · #014 enforces · #015 sources").
3. **Make external provider calls** — those route through the **API gateway (Phase D)**; a Phase C
   tool whose implementation needs a net-new external call **depends on D** and is therefore out
   of Phase C's reference set (§3-Framing-2; ADR 0008 Decision 5).
4. **Own the task's terminal transition** — the executor never calls `hq_ai_task_complete` /
   `hq_ai_task_fail`; it signals outcome by returning or throwing, and the **runner** translates
   that into the lease-guarded transition (runner rule 3, Volume XIII §21 lines 487-491; §3.8).
5. **Meter cost / enforce budget at the call** — that is the gateway's job (Phase D, Decision 5);
   Phase C reads the registry's cost *estimate* into P4's atom 5 (as Phase B already does against
   `ctx.budget`), but live metering is D.

### 2. **Execution lifecycle** — the per-action steps, inline in the run

For an **autonomous** action the lifecycle is **inline** in the handler's run, an additive
extension of today's `proposeActions` autonomous branch (`server/sdk/tasks.ts:545-550`):

```
verdict = evaluateAction(action, posture, capabilities, budget)   // Phase B (unchanged)
  └─ autonomous ─▶ resolve tool ─▶ re-gate at tool boundary ─▶ invoke ─▶ capture result ─▶ audit
                   (registry)      (SECURITY DEFINER)          (apply)   (into run)        (events)
```

Concretely: `ctx.proposeActions` (or `ctx.tools.invoke`) classifies as it does today; on
`autonomous`, instead of emitting `ai.action_permitted` and stopping, it **invokes the registered
tool**, then audits the *application* (§3.4). The step is **idempotent by construction** (§3.6) so
a re-run is safe. The lifecycle is **per-action**: a handler proposing N actions applies each in
input order, and the runner still owns the **run's** lifecycle around them (claim, heartbeat,
checkpoint, completion) — the executor only owns the **apply** of a single action. This is the
*second* runtime-composition seam the runner carries, after the Phase-A evidence-drain
(`server/sdk/tasks.ts:695`) and Phase B's `proposeActions`: the runtime composes capability the
facets may not (Runtime Composition Rule).

The **approval-completion** lifecycle is the same four steps on a **different trigger** and
**out of band** from the original run (§3.3): the originating task has already completed (Phase B
behaviour, unchanged); a separate executor invocation, triggered by a human grant, resolves the
tool and applies the approved payload.

### 3. **Approval completion flow** — applying what a human has granted

This is the flow Volume XIII §15 sketches — "**Fail → park** … on approval the SDK applies the
action with the same audit trail, attributing the human approver" (lines 347-350) — and the
Approval Engine names — "a separate, later phase reads `approved` rows and acts"
(`server/services/hq-approvals.ts:31-33`). The chain, end to end:

1. **Phase B (unchanged):** a needs-approval action becomes a `pending` `hq_approvals` row via
   `requestApproval`; the INSERT trigger emits `approval.requested`; **the originating task
   completes** (the Reference Employee proved exactly this — the task completes while the approval
   waits).
2. **Human decision (built):** a reviewer grants it via `approveApproval`
   (`server/services/hq-approvals.ts:256-290`) — state → `approved`, optionally with an
   `edited_payload`; the engine records `approval.granted`. The engine **marks; it does not act**
   (lines 31-33).
3. **Phase C (new) — apply-on-approval:** the executor reads `approved` approvals and **applies
   the granted action** through the registered tool, using `edited_payload ?? proposed_payload`,
   **attributing the human approver** in the audit (Volume XIII §15). It applies **once** (the
   idempotency record, §3.6) and records the application outcome.

The load-bearing design choice — **out of band, not in band.** The recommended model applies on
approval through a **separate executor trigger** (a bounded sweep over `approved`-but-unapplied
approvals, or an enqueued application task), **not** by blocking the original task at
`waiting_approval` until the human decides. This **honours ADR 0008 Decision 8**, which defers the
`waiting_approval` task transition to "its own directive", while still delivering the CEO's
"approval completion flow." The heavier **in-band** model (task blocks across human latency,
lease held or re-acquired, then resumes) is precisely what Decision 8 deferred; §7.1 puts the
choice to the CEO. The recommendation is **out of band**: it is the minimal correct fulfilment and
keeps the deferred seam deferred.

**The "applied" marker — without reopening a frozen contract.** The Approval Engine's state
machine is **five states, terminal-immutable** (`lib/approvals/state.ts:32-46`); `approved` is a
**terminal** state, frozen forever. "Applied" is therefore **not** a sixth approval state — adding
one would reopen frozen contract #6. Phase C records application in a **separate
application/idempotency record** keyed by approval id (and by autonomous-action identity), so the
sweep knows what it has already applied and never double-acts. §7.2 puts the exact shape to the
CEO (separate record — recommended — vs an additive `applied_at` column that is *not* a
state-machine change).

### 4. **Event sequencing** — the canonical spine order, so cause precedes effect

The invariant: **the permission/approval event always precedes the application event**, so the
one log reconstructs *permitted/approved → applied* for any action, answering "what did this AI
do and was it allowed to?" with `WHERE actor_id = slug ORDER BY id` (Volume XIII §16 line 370).

**Autonomous path:**
```
ai.action_permitted          (Phase B — the verdict, already emitted at :548)
  → ai.tool_called            (Phase C — the application; registered verb, lib/events/registry.ts:77)
     → [tool's own domain event, e.g. memory.written]   (the bound subsystem's audit, unchanged)
```

**Approval path:**
```
approval.requested  (Phase B, in-transaction on INSERT)
  → approval.granted (human, server/services/hq-approvals.ts:283 records it)
     → ai.tool_called  (Phase C — the application, attributing the approver)
        → [tool's own domain event]
```

**Vocabulary — reuse before mint.** The registry already carries `ai.tool_called`
(`lib/events/registry.ts:77`) and §21 names `tool.invoked` for the same act; the recommendation is
to **reuse the registered `ai.tool_called`** for the application event rather than mint a new verb
— the "one source of event names" discipline (the registry grew to 11 only when `ai.action_permitted`
was genuinely new under #014). Whether an application *failure* needs its own verb (e.g. a new
`ai.action_failed`, additive as `ai.action_permitted` was) is §7.3; the conservative default is to
carry the failure on the run's existing `ai.run_failed` (`:79`) plus the tool's own error event.

### 5. **Failure semantics** — when a tool invocation fails (not when it is denied)

A **denial** is the doorman's verdict (Phase B); a **failure** is a *cleared* action whose tool
**invocation** then fails (the write errors, the send bounces). They are different events with
different owners.

**Autonomous (inline) failure → the throw-based ABI.** A tool failure surfaces as an error from
`ctx.tools.invoke`. Per runner rule 3/6 and the **precedent the Reference Employee already set**
— B3's third test proved a refused approval *throws out of `proposeActions`* and the runner
records a **task failure via `hq_ai_task_fail`** (`__tests__/sdk/reference-employee.test.ts`,
the throw-based ABI test) — an unrecoverable application failure **propagates as a throw**, and
the runner translates it into the lease-guarded terminal failure. The executor itself **never**
calls `failTask` (rule 3). Whether *one* failed action fails the *whole* task, or `invoke`
returns a per-action outcome the handler can branch on (symmetric with `proposeActions` returning
`GateVerdict[]`), is a real fork — §7.5; the recommendation is **throw-by-default, with a typed
result available** so a handler that wants partial-progress semantics can opt in.

**Apply-on-approval (out-of-band) failure.** The originating task is already terminal, so a
failure here cannot fail it. The application record (§3.3) captures the failure; the action stays
**unapplied** and is **safe to re-attempt** (idempotency, §3.6) on the next sweep, bounded by a
retry ceiling; an action that exhausts it **escalates** (`ai.escalated`, `lib/events/registry.ts:83`)
to a human rather than silently dropping — the same "never silently drop a human-required side
effect" property B3 proved for the throw path. The precise ceiling/escalation policy is an
implementation detail within this contract.

### 6. **Retry interaction** — composing with the Task Engine's retry, idempotently

The Task Engine already owns retry: `failTask(retryable)` re-queues with exponential backoff while
retries remain, else fails terminally (`server/services/hq-tasks.ts:311-329`); `reapTasks`
recovers expired leases as retryable failures (`:374-385`). The Task Engine retries the **whole
task** — re-claim, re-run the handler from the top. This makes **idempotency the central Phase C
obligation**: a task that applied action A, then failed on action B, must **not re-apply A** when
it retries.

Two mechanisms, composed (neither invented — both already present in the substrate's vocabulary):

- **Application idempotency.** Each application carries a **stable key** (the run's
  `correlationId` + the action's identity; for an approval, the approval id). The executor records
  the key in the application table (§3.3, the same table the apply-on-approval sweep reads) and a
  re-attempt with a key already marked *applied* is a **no-op success** — exactly the idempotency
  the Approval Engine itself uses ("re-deciding a row already in the target terminal state is a
  no-op success", `server/services/hq-approvals.ts:35-37`). This is also the discipline the Task
  Engine already exposes via `dedupeKey` (`server/services/hq-tasks.ts:175`).
- **Checkpoint of applied actions.** The runner's `checkpointTask`
  (`server/services/hq-tasks.ts:268-281`) "persists a partial result mid-run so a re-run resumes
  from the last good state" — the executor checkpoints which actions have applied, so a re-run
  **skips** the completed ones before the idempotency key is even consulted. Defence in depth: the
  checkpoint is the fast path, the idempotency key is the guarantee.

The net property: **retry is safe because application is idempotent**, and the executor adds *no*
new retry machinery — it composes the Task Engine's, which is the whole point of the Generic Task
Engine boundary (§3.8).

### 7. **Rollback expectations** — the honest boundary (no 2PC; P4 bounds the blast radius)

This is the question that most needs an honest answer. **There is no two-phase commit across
heterogeneous tools** — a `memory.write` and a `comm.send` cannot be one atomic transaction — and
**Phase C builds no saga/compensation engine**. Instead, the rollback story is **structural,
inherited from the P4 classification the doorman already enforces**:

- **Irreversible actions never run autonomously in a batch.** P4 atom 1 routes every irreversible
  action (external / customer-facing / spend / delete) to **approval** (the Reference Employee
  proved exactly this: `irreversibleSend` → `needs_approval`, reason `p4.irreversible`). An
  irreversible action is therefore **applied singly, post-approval** (§3.3), never as one of N
  autonomous applies that might half-fail. There is nothing to *roll back* because there is no
  partial irreversible batch.
- **Reversible actions are idempotently re-applicable.** What *can* be in an autonomous batch is,
  by P4's definition, **reversible** — HQ-internal, append-or-correctable state. A partial failure
  leaves applied reversible writes in place; the Task Engine retries the task; idempotency (§3.6)
  makes the re-run converge to the intended state. "Rollback" for reversible state is **forward
  re-application**, not compensation.
- **The genuine hard case is named, not hidden:** an *irreversible* tool that fails *mid-effect*
  (a send that partially transmitted). Phase C does **not** pretend to undo it; it records the
  failure on the application record and **escalates to a human** (§3.5). This is the residue P4
  deliberately concentrates into the approval path so a human is already in the loop.

So Phase C's "rollback expectation" is precise: **rely on P4, idempotent retry for reversible
actions, single-apply-post-approval for irreversible ones, and escalation for the irreducible
mid-effect failure** — and build no distributed-transaction machinery, which would be the largest
over-engineering trap of the phase (§3-Framing-2; §6).

### 8. **Boundaries with the Generic Task Engine** — "Approval decides; the Task Engine gates"

The boundary is the Kernel Contract Map §4.4 line, unchanged: *Approval decides; the Task Engine
gates* — and Phase C adds a third clause it must respect: **the executor applies; it owns no task
lifecycle.** Concretely:

- **The Task Engine owns the run lifecycle** — its eight `SECURITY DEFINER` entry points
  (create / claim / heartbeat / checkpoint / complete / fail / reap / cancel,
  `server/services/hq-tasks.ts`) are the *only* way the queue is touched. The executor calls
  **none** of the terminal ones; it signals via return/throw, and the runner drives the transition
  (runner rules 1–4, Volume XIII §21 lines 479-494). The executor *does* lean on **checkpoint**
  (§3.6) — a non-terminal, lease-guarded primitive the runner already calls.
- **The executor sits at the runtime layer, beside `proposeActions`** — not in a facet. Applying
  an action sequences the registry lookup, the re-gate, the invocation, and the audit emit across
  facets; the Facet Isolation Rule forbids a facet from orchestrating siblings, so the composition
  lives in the runner (Runtime Composition Rule; Kernel Contract Map §4.2). The **`ctx.tools`
  facet** *exposes* the registry (resolve a tool, read its schema/permission/cost/reversibility);
  the **apply orchestration** is runtime — the same split Phase B drew between the pure gate and
  `proposeActions`.
- **The deferred task-side seams stay deferred.** `waiting_approval` and `verifying`
  (`server/services/hq-tasks.ts:47-48`), the `approval_status` column (`:78`), and `depends_on`
  (`:69`) remain reserved-inert — Phase C's out-of-band apply-on-approval (§3.3) **needs none of
  them**. Activating `waiting_approval` is the in-band alternative the CEO may rule for (§7.1);
  absent that ruling, Phase C does not touch task lifecycle at all, exactly as Decision 8 drew.

### 9. Defence in depth — where the re-check finally lands

ADR 0008 Decision 4 requires every action be checked "in the SDK **and** re-asserted in the
`SECURITY DEFINER` entry point." Phase B satisfied this **only on the approval path** (it inherited
the Approval Engine's SQL boundary) and **explicitly deferred** the autonomous re-check to "the
phase that has both an executor to re-gate and a registry to check against" (Phase B proposal §3.8;
§12 trap c). **Phase C is that phase.** The re-assertion lands at **each tool's bound
`SECURITY DEFINER` entry point**: a `memory.write` tool re-checks at the memory entry point, a
`comm.send` tool at the Communication Layer's. Where a tool binds a subsystem that already has such
a boundary, Phase C **inherits** it (the Phase B discipline); the one candidate for **genuinely
new SQL** is a generic tool-application guard for tools that lack one — §7.4 flags whether that
needs its own treatment. A registry-keyed capability re-check (does the employee still *hold* this
capability?) stays with **#015**, which builds the registry to check against (ADR 0008 Decision 9).

### 10. Tests and the Reference-Employee acceptance (the Reference Path Rule, applied)

The same six-gate bar (typecheck · lint · unit · integration · security · production build), plus
Phase-C-specific coverage:

- **the tool registry** — resolution by capability; the reversibility class feeds P4 (a
  `send_email`-class tool is irreversible → the existing gate routes it to approval; a
  memory-class tool is reversible → autonomous), proving the registry *describes* and the gate
  still *decides* (Decision 6 not violated);
- **the executor, autonomous** — an `autonomous` verdict now **applies** through the bound tool
  and audits `ai.tool_called` after `ai.action_permitted`; the `SECURITY DEFINER` re-check refuses
  a tampered call (defence in depth, §3.9);
- **idempotent retry** — a task that applies action A then throws on B, on retry **skips A** (no
  double-apply) — the central Phase-C guarantee (§3.6);
- **apply-on-approval** — an `approved` approval is applied **once**, honours `edited_payload`,
  attributes the approver, and a second sweep is a **no-op** (§3.3);
- **failure & escalation** — an unrecoverable autonomous failure throws → `hq_ai_task_fail`
  (the B3 precedent); an exhausted apply-on-approval **escalates**, never silently drops (§3.5);
- **facet isolation, re-pinned** — the `ctx.tools` facet exposes the registry but the apply
  orchestration lives in the runner (the source-level assertion that guards Phase A/B);
- **the Reference Employee — extended (the Reference Path Rule's first deliverable use).** The
  same Lead Qualification AI that in Phase B *classified* now **applies**: its reversible
  `memory.write` is **actually written**, and — after a simulated human grant — its irreversible
  `comm.send` is **actually sent through the Communication Layer #7**, attributing the approver.
  Per the **Reference Path Rule** (PR #217), the new capability is **validated end-to-end through
  the reference path before the platform expands on it** — Phase C is where that rule first earns
  its keep.

### 11. What would make Phase C over-engineered?

The traps, named so the review can watch for them: **(a)** building a **distributed-transaction /
saga / compensation engine** for rollback — Phase C relies on P4 + idempotent retry instead
(§3.7); **(b)** building the **API gateway** or any *external* provider call — that is Phase D
(ADR 0008 Decisions 5, 10); **(c)** building the **Capability Registry** or a registry-keyed SQL
re-check — that is #015 (Decision 9); **(d)** **reopening the frozen Approval Engine** to add an
`applied` state — application is a *separate* record, not a sixth approval state (§3.3); **(e)**
activating the **`waiting_approval` task transition** (the in-band model) without a CEO ruling —
Decision 8 defers it, and out-of-band apply-on-approval needs none of it (§3.3, §7.1); **(f)**
making the **tool registry an authorisation system** (a tool grant = a capability grant) — Decision
6 forbids it; the registry *describes*, #015 *authorises*; **(g)** putting the **apply
orchestration in a facet** — it is cross-facet, so it lives in the runner (Runtime Composition
Rule, §3.8); **(h)** building **verification** of an applied result — deferred (Decision 8). The
discipline that keeps Phase C honest is the same that kept A and B honest: **the runtime composes;
the facets do not; the gate decides; the executor only applies.**

---

## 4. Illustrative target shape (design only — not implemented)

A sketch to make the additive extension concrete. **This is not an implementation**; the exact
types are settled by the Phase-C implementation PRs (under ADR 0008, or ADR 0009 if the CEO so
rules — §7.6). The nine #013-frozen fields and the Phase A/B additions are unchanged; the new
members are marked.

```ts
// ── the typed tool registry (ctx.tools facet — EXPOSES capability) ───────────────
// A registered tool DESCRIBES a capability; it does not AUTHORISE it (ADR 0008 Dec. 6).
interface RegisteredTool<Args = unknown, Result = unknown> {
  name: string;                       // the label, from tools_allowed (Built)
  capability: string;                 // the token the gate matches (P4 atom 4)
  argSchema: Schema<Args>;            // typed, validated before apply
  permission: string;                 // which scope it needs (composed in §8)
  estimateCostMicros(args: Args): number;   // feeds P4 atom 5 (metering is Phase D)
  reversibility: "reversible" | "irreversible";  // feeds P4 atom 1 (Dec. 6)
  // the bound implementation — acts through a SHIPPED subsystem (memory/comms/#7/…),
  // re-asserting permission at ITS SECURITY DEFINER boundary (defence in depth, §3.9):
  apply(args: Args, cx: ToolApplyContext): Promise<Result>;
}

// ── the executor — RUNTIME-composed (NOT a facet), beside proposeActions ─────────
interface RunContext {
  // … the nine #013-frozen fields + Phase-A events/comms + Phase-B proposeActions, unchanged …

  /**
   * Apply an action through a registered tool (#014 Phase C). The RUNTIME composes this:
   * resolve the tool, re-gate at its SECURITY DEFINER boundary, invoke, audit
   * (ai.tool_called) — cross-facet orchestration that may not live in a facet
   * (Facet Isolation Rule / Runtime Composition Rule). It NEVER completes/fails the
   * task (runner rule 3) and NEVER makes an external provider call (that is the
   * Phase-D gateway). Idempotent by stable key, so a retried run does not double-apply.
   */
  tools: {
    invoke<R>(name: string, args: unknown): Promise<R>;   // ← added by Phase C
    // (registry reads — list/resolve — also exposed here; descriptive only)
  };
}

// Implemented in the runner, closing over identity + correlation + the events facet +
// the application/idempotency record (the same the apply-on-approval sweep reads):
async function applyAction(action: ProposedAction): Promise<unknown> {
  const verdict = evaluateAction(action, posture, ctx.capabilities, ctx.budget);  // Phase B, unchanged
  if (verdict.decision !== "autonomous") {
    return requestApproval({ /* … */ });          // Phase B path — apply happens on grant (§3.3)
  }
  const key = idempotencyKey(ctx.correlationId, action);
  if (await alreadyApplied(key)) return; // no-op success — retry-safe (§3.6)
  const tool = registry.resolve(action.capability);          // resolve (responsibility 1)
  const result = await tool.apply(action.payload, applyCx);  // re-gate + invoke (2, 3) — SECURITY DEFINER
  await markApplied(key, result);                            // idempotency record (§3.6)
  await ctx.events.emit({ verb: "ai.tool_called", /* … attribute, correlate (§3.4) */ });  // audit (4)
  return result;
}

// ── apply-on-approval — the SAME executor, a DIFFERENT trigger, OUT OF BAND (§3.3) ─
// "the engine NEVER sends … a separate, later phase reads `approved` rows and acts"
// (server/services/hq-approvals.ts:31-33). Reads granted approvals; applies once;
// attributes the human approver; the originating task already completed in Phase B.
async function applyApprovedAction(approval: ApprovalRow): Promise<void> {
  if (await alreadyApplied(approval.id)) return;                  // no double-apply (§3.6)
  const payload = approval.edited_payload ?? approval.proposed_payload;  // honour the reviewer's edit
  const tool = registry.resolve(approval.action);
  await tool.apply(payload, applyCx);                             // re-gate + invoke
  await markApplied(approval.id);
  await emitApplication(approval, /* attributing */ approval.reviewer_email);  // ai.tool_called (§3.4)
}
```

---

## 5. The fill-the-slots map (binds, builds — the evidence)

The backbone of the thesis: Phase C **builds the executor + the registry + apply-on-approval** and
**binds the shipped subsystems its reference tools act through**. Every row is cited.

| Phase-C deliverable | Binds / activates | Build vs bind | Evidence |
|---|---|---|---|
| the typed tool registry | `tools_allowed` labels (Built-inert) | **build (new substrate)** | Volume XIII §3 line 102, §12 lines 303-310; ADR 0008 Dec. 6 |
| the executor (`apply` + `ctx.tools.invoke`) | the runner (where facets meet) | **wire (runtime compose)** | `server/sdk/tasks.ts:545-550` (proposeActions autonomous branch to extend); `:695` (evidence-drain precedent) |
| autonomous apply audit | the `events` facet (Phase A) | **bind** | `lib/events/registry.ts:77` (`ai.tool_called`) |
| `SECURITY DEFINER` re-check | each tool's bound subsystem boundary | **bind (build only if a tool lacks one)** | ADR 0008 Dec. 4; Phase B proposal §3.8 |
| reference tool: `memory.write` | the memory facet | **bind** | `server/sdk/memory.ts` |
| reference tool: `comm.send` | the Communication Layer #7 | **bind** | `server/services/hq-comms.ts` (ADR 0003) |
| apply-on-approval read | the Approval Engine (`approved` rows) | **bind** | `server/services/hq-approvals.ts:31-33,256-290` |
| idempotency / application record | (keyed by correlation+action / approval id) | **build (additive table)** | `server/services/hq-approvals.ts:35-37` (idempotency idiom); ADR 0008 Consequences |
| retry safety | the Task Engine (`checkpoint`, `fail`, `reap`) | **bind** | `server/services/hq-tasks.ts:268-281,311-329,374-385` |
| API gateway / external calls / metering | — | **defer (Phase D)** | ADR 0008 Dec. 5, 10 |
| Capability Registry / SQL capability re-check | — | **defer (#015)** | ADR 0008 Dec. 9 |
| `waiting_approval` task transition / verification | — | **defer** | ADR 0008 Dec. 8; `server/services/hq-tasks.ts:47-48,78` |

Read down the *Build vs bind* column: the new substrate is the **registry, the executor, and one
additive idempotency table**; everything else binds a shipped subsystem or defers. Phase C is a
larger build than B (which added zero schema), but it is still **substantially a binding
exercise**, and it is the phase that finally makes the doorman's permitted decisions **take
effect**.

---

## 6. Recommended scope boundary (and phasing within Phase C)

**In scope for Phase C** (ADR 0008 Decision 6 + the execution half of Decision 8): the typed tool
registry over `tools_allowed`; the executor (`ctx.tools.invoke` / the runtime `apply` step) with
its `SECURITY DEFINER` re-check; the autonomous **apply + audit** (extending today's audit-only
branch); the **out-of-band apply-on-approval** flow with the idempotency/application record;
idempotent retry over the Task Engine's existing machinery; a small reference tool set binding the
shipped subsystems (memory, comms #7); the **extended Reference-Employee** acceptance.

**Out of scope** (deferred): the **API gateway**, *external* provider calls, and live **cost
metering** (Phase D — Decisions 5, 10); the **Capability Registry** and any registry-keyed SQL
re-check (#015 — Decision 9); **verification** of an applied result (Decision 8); the **in-band
`waiting_approval` task transition** and the `approval_status` task column (Decision 8 — unless the
CEO rules for it, §7.1); the **DAG** (`depends_on`); any **rollback/saga** engine (§3.7).

**Recommended phasing within Phase C** — smallest-correct-first, each PR shippable and reviewable,
mirroring Phase B's B1→B2→B3:

1. **C1 — the typed tool registry.** `tools_allowed` labels → registered tools
   (`{argSchema, permission, costEstimator, reversibilityClass}`) exposed as the `ctx.tools`
   facet (resolve/list — descriptive only), with a small reference tool set binding shipped
   subsystems. Tests: resolution, reversibility-feeds-P4, facet-isolation. **No apply yet** —
   lowest risk, highest test density (the Phase-B "pure first" discipline).
2. **C2 — the executor (autonomous apply).** Extend the runner's autonomous branch from
   audit-only to **apply + audit** via `ctx.tools.invoke`; the `SECURITY DEFINER` re-check; the
   idempotency record + checkpoint for retry safety; failure → throw → runner. Tests: apply
   end-to-end, idempotent retry, defence-in-depth refusal, failure propagation.
3. **C3 — apply-on-approval.** The out-of-band step over `approved` approvals: apply once, honour
   `edited_payload`, attribute the approver, escalate on exhaustion. Tests: approve→apply,
   no-double-apply, edited-payload, escalation.
4. **C4 — the extended Reference Employee.** The same Lead Qualification AI now **applies** both
   verdicts: the reversible write actually written; the irreversible send actually sent
   post-approval — the **Reference Path Rule** in action (validate the new capability end-to-end
   before platform expansion). Phase D does not begin until Phase C has a completion record and
   CEO review.

---

## 7. Open questions for the CEO to rule on

This proposal presents the ADR-0008-bounded scope; it does **not** decide the roadmap (the
standing rule: *I propose; the CEO decides*). Six forks warrant an explicit ruling:

1. **Apply-on-approval: out of band, or in band?** *Out of band* (recommended — a sweep/task over
   `approved` rows; the original task already completed) keeps the `waiting_approval` transition
   **deferred**, exactly as ADR 0008 Decision 8 drew. *In band* (the task blocks at
   `waiting_approval` until the human decides, then resumes) is richer but heavier (lease across
   human latency) and was **explicitly deferred** by Decision 8. **Recommendation: out of band**;
   activate `waiting_approval` only on an explicit CEO ruling.
2. **The "applied" marker — separate record, or an additive column?** The Approval Engine's
   five-state machine is **frozen** (`lib/approvals/state.ts:32-46`); "applied" must **not** be a
   sixth state. *A separate application/idempotency record* (recommended) keeps the engine
   untouched; an additive `applied_at`/`application_status` **column** on `hq_approvals` is *not* a
   state-machine change but does touch the engine's table. **Recommendation: a separate record.**
3. **Event vocabulary — reuse `ai.tool_called`, or mint `ai.action_applied`/`ai.action_failed`?**
   Reuse (recommended — the registered verb already exists, `lib/events/registry.ts:77`) honours
   "one source of event names"; minting is additive (as `ai.action_permitted` was) and more
   explicit. **Recommendation: reuse `ai.tool_called` for success; carry failure on `ai.run_failed`
   + the tool's own error event** — mint only if the CEO wants an explicit application-failure verb.
4. **The executor's `SECURITY DEFINER` re-check — inherit per-tool, or one generic guard?**
   Inherit each bound subsystem's boundary where it exists (recommended — the Phase-B discipline);
   a *generic* tool-application guard is the one candidate for genuinely-new SQL, for tools lacking
   one. **Recommendation: inherit; build a generic guard only if a reference tool needs it, and
   flag it for ADR treatment if so.**
5. **Failure granularity — one failed action fails the task, or per-action outcomes?**
   Throw-by-default (recommended — the B3 throw-based ABI precedent; simplest, never silently
   drops) with a **typed per-action result available** so a handler may opt into partial-progress
   semantics (symmetric with `proposeActions` returning `GateVerdict[]`). **Recommendation:
   throw-by-default, typed result available.**
6. **Does Phase C warrant its own ADR (0009)?** Phases A and B rode ADR 0008. Phase C introduces
   the **first executor**, **apply-on-approval**, and **net-new persistence** — more than A/B did.
   **Recommendation: yes — a new ADR 0009** recording the executor contract, the idempotency
   model, and the apply-on-approval mechanics before code (the strict *document-before-you-build*
   form used for ADRs 0007/0008). If the CEO prefers, Phase C rides ADR 0008 and the sign-off
   travels with the implementation PRs, as for A/B.

---

## 8. Status & next step

This document is an **architecture proposal, held for CEO review**. It changes no code, schema,
migration, configuration, or git history. **No Phase C implementation begins** until it is
reviewed and approved — per the CEO's mandate (*"No implementation is authorised until that
proposal has been reviewed and approved"*) and the standing rule to *protect the CrewFlow
Operating System architecture above implementation speed*.

On approval, the next step is **C1** (the typed tool registry + reference tools + tests) on the
`#011` integration branch, held to the full six-gate validation discipline (§3.10), followed by
**C2** (the executor / autonomous apply), **C3** (apply-on-approval), and **C4** (the extended
Reference Employee) — each its own reviewable PR, no later sub-phase beginning until the current
one has passed the gates and received CEO approval. If the CEO rules for a new ADR (§7.6), **ADR
0009 is authored and accepted before C1**. **Phase D (the API gateway + live cost metering) does
not begin until Phase C has a completion record and CEO review.**

---

## 9. CEO review outcome

The CEO completed an independent CTO review of this proposal. **Outcome: the Directive #014
Phase C architecture is approved** — *"The Phase C proposal correctly separates classification
from execution. Phase B decided what is permitted. Phase C defines how permitted actions become
real effects. This is the correct next architectural step."* The approval carries **one
structural requirement** — a new ADR before any code — and **settles every fork in §7**. The
review also accepted the **Reference Path Rule** (PR #217, merged), the standard this proposal
leans on and first puts to deliverable use (§3.10, §6 C4).

**The ADR requirement — ADR 0009, written and approved before implementation.** The CEO ruled
that Phase C *"introduces the first executor and apply-on-approval flow … significant enough to
require a new ADR,"* and directed: **"Proceed with ADR 0009 — SDK Executor and Apply-on-Approval
Runtime. Do not implement Phase C until ADR 0009 has been written, reviewed and approved."** This
settles §7.6 — the one structural question this proposal escalated — **yes**: unlike Phases A and
B, which rode ADR 0008, Phase C gets its own decision record under the strict
*document-before-you-build* rule (as for ADRs 0007/0008).
[**ADR 0009**](../decisions/0009-sdk-executor-apply-on-approval.md) records the executor
contract, the idempotency model, and the apply-on-approval mechanics; it is registered in
[numbering.md](./numbering.md) §5 and is itself **held for CEO review** before any Phase C code.

**Approved direction (the load-bearing architecture).** Each thesis-level decision is approved
explicitly: the **typed tool registry**; the **executor as a runtime-owned mechanism** (not a
facet); **the tool registry *describes* capability** while **the Capability Registry *authorises*
it later in Directive #015**; the **Approval Engine remains frozen**, with **applied state
separate from approval state — no sixth approval state**; **retry safety through idempotency**;
**rollback by limiting irreversible work through approval**; and **Phase D remains responsible for
the external-provider gateway and live metering**. This ratifies the thesis (§2) and the
over-engineering traps it named (§3.11) point for point.

**Architectural decisions — the five rulings, mapped to §7.** The CEO directed: *"Use: out-of-band
apply-on-approval; separate applied marker; inherited re-checking at execution boundary; granular
failure records; clear event sequencing. Do not reopen the Approval Engine state machine. Do not
expand Phase C into Phase D."* Each settles a §7 fork as the proposal recommended:

1. **Out-of-band apply-on-approval** (§7.1) — a separate executor trigger over `approved` rows;
   the `waiting_approval` task transition stays **deferred**, exactly as ADR 0008 Decision 8 drew.
2. **Separate applied marker** (§7.2) — a distinct application/idempotency record; "applied" is
   **not** a sixth approval state, and the Approval Engine's five-state machine is **not
   reopened** (the explicit *"do not reopen"*).
3. **Inherited re-checking at the execution boundary** (§7.4) — the `SECURITY DEFINER` re-check
   lands at each tool's bound subsystem boundary (§3.9), the defence-in-depth Phase B deferred to
   "the phase that has both an executor and a registry."
4. **Granular failure records** (§7.5) — per-action failure is recorded (throw-by-default with a
   typed result available), so a human-required side effect is **never silently dropped**.
5. **Clear event sequencing** (§7.3) — the permission/approval event always precedes the
   application event, reusing the registered `ai.tool_called` (§3.4).

The two boundary instructions are standing: **do not reopen the Approval Engine state machine**
(§3.3; trap d) and **do not expand Phase C into Phase D** (§3.11 traps b/c — no API gateway, no
external provider call, no Capability Registry).

**Implementation gate — small reviewable increments, after ADR 0009.** Implementation begins
**only after ADR 0009 is approved**, then proceeds *"in small reviewable increments … the
smallest safe slice,"* which maps to the proposal's within-Phase-C phasing (§6):

1. **Tool registry contract** (C1) — the typed registry over `tools_allowed`, descriptive only.
2. **Executor contract** (C2) — the autonomous apply + the `SECURITY DEFINER` re-check +
   idempotent retry.
3. **Apply-on-approval marker** (C3) — the out-of-band step + the separate applied record.
4. **Reference Path execution test** (C4) — the extended Reference Employee, the Reference Path
   Rule's first deliverable use.

The CEO set explicit guardrails on the slice: **no broad executor rollout, no new employee
migration, no Capability Registry, no API Gateway**, and **maintain full validation discipline**
(the six-gate bar, §3.10). **Phase D (the API gateway + live cost metering) does not begin until
Phase C has a completion record and CEO review.**

---

*Documentation only. No code, schema, migration, configuration, or git history was changed by this
proposal. Prepared under the #011 governance umbrella (Master Roadmap D-01) as the architecture
proposal for Directive #014 / D-04 **Phase C** — the executor — assembled over the frozen
RunContext (contract #4, Established under #013 / ADR 0007), the Phase-A facet layer (events +
comms + the output envelope), and the Phase-B doorman (the pure gate + `proposeActions` + the
Approval-Engine hand-off). It implements ADR 0008 Decision 6 and the execution half of Decision 8,
and is governed by the engineering standards homed in the
[Kernel Contract Map](./kernel-contract-map.md) §2 — the Facet Isolation, Policy vs Mechanism,
and Runtime Composition Rules, and the Reference Path Rule (PR #217, merged). The CEO's
review outcome is recorded in §9.*
