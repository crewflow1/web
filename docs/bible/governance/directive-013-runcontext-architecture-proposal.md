# CrewFlow Governance — Directive #013 (D-03) Architecture Proposal: the RunContext Runtime Contract

> **Status:** **Architecture proposal — design only.** This document answers the
> CEO's review questions for **Directive #013 / Master Roadmap D-03 — the RunContext
> Runtime Contract**. It is **held pending CEO review and approval**; **no
> implementation begins** until it is approved. The document itself changes no code,
> schema, migration, configuration, or git history.
>
> **Sequence context.** The forward sequence — **D-03 / #013 RunContext → D-04 / #014
> AI SDK Envelope → D-05 / #015 Capability Registry** — was approved by the CEO
> (Option B) on the evidence of the
> [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md) and
> recorded in [`numbering.md`](./numbering.md) §3. This proposal is the next step the
> CEO authorised: *"After the roadmap update is complete, prepare the full architecture
> proposal for Directive #013."*

---

## 1. How to read this

The CEO's instruction was to answer a fixed list of questions before any code is
written. §3 answers **each question verbatim, in order**, one subsection per question
(the *"deferred to #014 and #015"* question is answered in two clearly-separated
parts). §2 gives the one-paragraph thesis; §4 is an illustrative (not implemented)
interface sketch; §5 is the seam-activation map that backs the "mostly binding, not
building" claim with `file:line` evidence; §6 draws the in/out scope boundary; §7
flags one coherence follow-up; §8 records status.

Every factual claim is cited to repository evidence verified at the current
integration tip. **The proposal proposes; it does not build.**

---

## 2. The thesis (one paragraph)

**RunContext is not greenfield — it is the runtime contract that already ships in
minimal form, and #013 graduates it by *binding inert seams the Generic Task Engine
already reserved*, not by inventing substrate.** The minimal RunContext exists today
(`server/sdk/tasks.ts:98-111`): `{ task, identity, memory, tasks, correlationId,
budgetMicros }`, assembled by `buildContext()` at claim time
(`server/sdk/tasks.ts:278-297`). Three of the concerns the CEO names —
**correlation**, **budget**, **memory** — are *already threaded*. Three more —
**deadlines** (`deadline_at`, `hq_ai_tasks` L145), **cancellation** (the `cancelled`
status + guard transition, L103/L267-268), and **capability** (`required_capability`,
L88) — already exist as reserved, inert columns. #013's job is to **freeze the
contract's shape and invariants, formalise identity, and activate those seams into the
runtime contract** so that #014 (the SDK envelope) and #015 (the Capability Registry)
can be assembled *over* it with no further change to its shape. That is the dependency
asymmetry the analysis proved, made concrete: the contract is the foundation; the SDK
and the registry stand on it.

---

## 3. The questions, answered

### 1. What exactly is RunContext?

RunContext is the **per-invocation runtime contract**: the single immutable,
request-scoped value the runner assembles when it claims a task and passes to an
employee's handler as that handler's **sole argument** —
`type TaskHandler = (ctx: RunContext) => Promise<…>` (`server/sdk/tasks.ts:120`). It is
the runtime spine that threads, for one task execution: *who is running* (identity),
*under what trace* (correlation), *within what limits* (budget, deadline), *with what
stop-signal* (cancellation), *over what substrate* (the `memory` and `tasks` facets
today; `comms`/`events`/`tools`/`api` later), and *under what authority* (the resolved
capability set).

It is **not** a service, a table, a registry, a session, or a long-lived object. It is
an assembled value with a **frozen shape**. The distinction that matters for #013: the
*contract* (the `RunContext` interface + its invariants) is what #013 freezes; the
*assembler* (`buildContext()`) is the implementation that fills it. Freezing the
contract is exactly what lets #014 fill more of it later "with no change" — the same
discipline the Memory facet already followed ("expose a stable interface, complete
later", Bible Volume XIII §11).

### 2. What fields does it own?

"Owns" = the value RunContext is the **authoritative carrier of for the duration of one
invocation**. The proposed frozen set (extending today's six):

| Field | Source | Status |
|---|---|---|
| `task: TaskRow` | the leased row | present (#012) |
| `identity: EmployeeIdentity` | resolved at assembly | present as `RunnerIdentity`; **formalised** (Q6) |
| `correlationId: string` | `task.correlation_id` | present, live |
| `budgetMicros: number` | `task.cost_budget_micros` | present (passthrough) |
| `memory: BoundMemory` | `createMemory(identity, task)` | present, unchanged (#009) |
| `tasks: BoundTasks` | bound to task + lease | present (create + checkpoint only) |
| `deadline: Date \| null` | `task.deadline_at` | **activated seam** (Q10) |
| `signal: AbortSignal` | composed: cancel ∪ deadline | **new runtime construct** (Q11) |
| `capabilities` (resolved set) | resolved at assembly, source-indifferent | **threaded** (Q7) |

It owns the **threading**, not the **source of truth**: identity's canonical store, the
cost meter, and the capability registry all live *elsewhere*; RunContext carries
resolved values, it does not author them.

### 3. What does it deliberately not own?

- **The other SDK facets' implementations.** `comms`, `events`, `tools`, `api` and the
  standard **output envelope** (`{summary, reasoning, confidence, evidence[]…}`, Volume
  XIII §10) are **#014**. #013 freezes the contract they slot into; it does not build
  them.
- **The capability *data* / registry.** `tools_allowed`, `permissions`, `memory_scope`,
  `department` and their consolidation into one declarative source + resolver are
  **#015**. RunContext carries a *resolved* set; it does not define where the set comes
  from or how it is authored.
- **Cost metering.** `budgetMicros` is a read-only ceiling. The meter (`cost_micros`,
  the API gateway) is **#014**.
- **Identity's historical re-stamping.** #013 *decides* the canonical identity rule; the
  data disposition (migrate / alias / freeze historical `actor_id`s) is a gated step
  recorded in the ADR's blast radius, not an automatic rewrite.
- **The remaining Task-Engine seams** — DAG (`depends_on`), approval lifecycle,
  verification — each its own directive.
- It is **not a god-object or a DI container**: no field exists "for the future"
  without a frozen-contract justification (see Q17).

### 4. How does it relate to the Generic Task Engine?

RunContext is **downstream of, and assembled from, a claimed task.** The engine (#012)
owns the durable queue, the lease, the heartbeat, the reaper, and the state-machine
guard; the runner claims a task (`claimTask`) and calls
`buildContext(identity, task, leaseOwner)` (`server/sdk/tasks.ts:315`). RunContext does
**not** drive terminal transitions — by the runner rules (Volume XIII §21, enforced in
`tasks.ts`) the handler receives `ctx`, does business logic only, and signals success by
returning / failure by throwing; the *runner* owns claim/heartbeat/complete/fail.

Critically, #013 mostly **activates seams #012 deliberately reserved**: `deadline_at` →
`ctx.deadline`; the `cancelled` status/transition → `ctx.signal`; `cost_budget_micros` →
`ctx.budgetMicros` (already); `correlation_id` → `ctx.correlationId` (already);
`required_capability` → the resolved capability set's input. This is the platform-reuse
thesis in action — #013 *binds* what the engine already provides.

### 5. How does it relate to the AI SDK?

RunContext is the **substrate the SDK envelope is assembled over.** The Constitution §3
requires the SDK to "carry a real `RunContext` that threads identity, scope, memory, and
the output envelope through every employee invocation." The dependency analysis proved
the asymmetry: **the SDK (#014) depends on the RunContext contract; the contract does
not depend on the SDK.** #013 freezes the contract (shape, invariants, and the *slots*
for the later facets); #014 fills the slots (`comms`/`events`/`tools`/`api` + the output
envelope) "with no change" to the frozen shape — the precedent the Memory facet already
set (Volume XIII §11 as-built note). RunContext is the seam between engine and SDK.

### 6. How does it relate to employee identity?

Identity is RunContext's **first and most load-bearing field**, and **#013 owns the
canonical runtime-identity decision** (moved here from #014 by the approved roadmap
update, because identity must settle before either the SDK or the registry can rely on
it — the dependency analysis's "killer" finding). Today identity is `RunnerIdentity`
(`server/sdk/tasks.ts:62-68`): `{ employeeId, slug?, department?, memoryScope? }`; the
Bible spec (Volume XIII §9) names `EmployeeIdentity` `{ slug, version, department }`.

#013 will, once and for all (the decisions catalogued in
[`runtime-identity.md`](./runtime-identity.md) §6, now retargeted to D-03):

- choose the **canonical identifier per employee** — resolving the proven three-way
  split (`lead-qualification` vs `qualification-ai` vs `lead-qualification-ai`,
  `runtime-identity.md` §4) to one slug that is simultaneously the runtime `actor_id`,
  the spec slug, and the SDK identity;
- decide the **disposition of historical `actor_id`s** (migrate / alias / freeze) — a
  data decision stated as the ADR's blast radius, *not* an automatic rewrite of
  append-only spine rows;
- set the **forward rule** that the three layers agree from that point on;
- record the disposition of **Reserved rows** like `design-ai`.

In the contract, identity becomes a **required, typed, resolved value** (`slug`
non-optional and canonical). #013 makes identity *correct and frozen*; it does not
re-key history beyond what its ADR explicitly authorises.

### 7. How does it relate to permissions and capabilities?

This is the **split dimension** from the dependency analysis, and the proposal honours
the split precisely:

- **The data** (what an employee may do) lives today on `ai_employees`
  (`tools_allowed text[]`, `permissions jsonb`, `memory_scope`,
  `supabase/migrations/20260712000000_ai_employees.sql` L72/L77/L80); its consolidation
  into one declarative registry + resolver is **#015**.
- **The threading** (carrying the *resolved authority* into the run) is RunContext's
  job, per the Constitution's "threads … scope." #013 threads a **resolved, opaque
  capability set** onto the context, computed at assembly time from whatever source
  exists *today* (the `ai_employees` columns) — and, after #015, from the registry, **with
  no change to the contract**. The set is **source-indifferent**: that indifference is
  exactly why the contract does not depend on the registry.

The Task Engine already reserved `required_capability` (`hq_ai_tasks` L88) and a
`p_required_capability` create-parameter (L319) — #013 can thread it; #015 makes it
*enforceable* against a real registry. The **enforcement predicate and its callers**
(`ctx.tools.invoke` checking permission before acting, Volume XIII §8/§12, "checked in
the SDK *and* re-asserted in the SQL entry point" — defence in depth) arrive with the
facets in **#014**. So: **#013 threads the resolved set; #014 enforces it; #015 sources
it.** #013 builds neither the registry nor the enforcement — only the carriage the
Constitution mandates the contract provide.

### 8. How does it propagate correlation?

**Already solved and live — #013 freezes the invariant.** `correlation_id` is a
`not null` column on `hq_ai_tasks` (L161), set at enqueue (inherited from a parent task
or freshly minted), read into `ctx.correlationId` (`server/sdk/tasks.ts:294`), and
auto-threaded to child tasks by `ctx.tasks.create` (`tasks.ts:263`); the `task.*` spine
events already stamp it (#012 PR-B). #013 adds no mechanism; it **formalises the rule**
that correlation is *inherited, never chosen by the handler* (Volume XIII §9: "the saga
— inherited, not chosen") and makes it the mandatory trace key every present and future
facet stamps.

### 9. How does it propagate budget?

`budgetMicros` is already on the context as a **passthrough** of
`task.cost_budget_micros` (`server/sdk/tasks.ts:295`; the column is the Cost/Budget seam
at `hq_ai_tasks` L154). #013 keeps it a **read-only ceiling carried into the run** — the
contract makes the limit visible; it does **not** meter. Metering (`cost_micros`, L153)
and enforcement (the API gateway refusing a call that would bust budget, Volume XIII §13)
are **#014**, which reads the ceiling #013 guarantees is present. Building a meter or a
budget-reservation ledger in #013 is an explicit over-engineering trap (Q17).

### 10. How does it propagate deadlines?

`deadline_at` is an inert Task-Engine seam (`hq_ai_tasks` L145; surfaced on `TaskRow`,
`server/services/hq-tasks.ts:73`). #013 **activates** it:
`ctx.deadline = task.deadline_at ? new Date(task.deadline_at) : null`, and composes it
into `ctx.signal` (the `AbortSignal` fires when the deadline passes). The handler and
facets observe it **cooperatively** (read `ctx.deadline`, or `await` against
`ctx.signal`). #013 does **not** add hard-kill enforcement — the engine's lease +
reaper already bound a crashed or overrunning run; a deadline is a *cooperative SLA
signal*, not a process killer. Optionally the claim may skip tasks already past their
deadline (a small engine-side filter); the minimal contract is simply *surface the
deadline and fold it into the signal.*

### 11. How does it handle cancellation?

The Task Engine already has the **`cancelled` status** (`hq_ai_tasks` L103) and the
**guard transition** `pending | running → cancelled` (L219, L267-268) — but there is
**no cancel entry point** among the seven (create/claim/heartbeat/checkpoint/complete/
fail/reap) and **no signal to a running handler**. #013 closes exactly that gap, with
the minimum:

- **A cooperative cancellation signal: `ctx.signal: AbortSignal`.** The runner already
  heartbeats every `lease/3` (`server/sdk/tasks.ts:319-322`); on that same beat it
  checks for a cancellation request and, if present, aborts the signal. The handler
  observes it cooperatively (long loops / `await`s check `ctx.signal.aborted` or pass
  the signal to `fetch`). This is **cooperative, not preemptive** — consistent with the
  lease model; you cannot safely kill arbitrary JavaScript mid-statement, and a handler
  that ignores the signal is still bounded by the lease + reaper (no regression).
- **The eighth entry point, `hq_ai_task_cancel`** (`pending | running → cancelled`), so
  an operator or a parent task can request cancellation *durably*; the running runner
  picks it up on its next heartbeat, aborts `ctx.signal`, and the engine finalises
  `cancelled`.

Deadline and cancellation share the **same `AbortSignal` plumbing** (a deadline is a
self-cancellation). Including the entry point in #013 is recommended: the status and the
transition already exist, so a signal with no durable way to trigger it would be half a
feature — and this is the **one place #013 likely touches schema** (a new
`SECURITY DEFINER` function; **no new column, no enum change**).

### 12. How does it interact with Shared Memory?

`ctx.memory` is the **only fully-built facet** and the **proven precedent.** It is a
`BoundMemory` from `createMemory({ employeeId, department, memoryScope, currentTaskId })`
(`server/sdk/tasks.ts:283-288`), already auto-bound to identity and the running task,
already stamping identity on every verb so the spoofing class is designed out (Volume
XIII §11 as-built note). **#013 changes nothing about the memory facet** — it inherits
it unchanged. Memory's relevance to #013 is as the **template**: it proves "build to a
stable contract, assemble into `ctx` with no change," which is exactly the discipline
#013 generalises to the whole context. The one forward link: when #014 adds the output
envelope, the memory facet's accumulated `evidence()` drains into `result.evidence[]` —
#013 *reserves* that hook but does not build it.

### 13. What remains deferred to Directive #014 and #015?

**Deferred to #014 (AI SDK Envelope):**
- the `comms` / `events` / `tools` / `api` facets;
- the standard **output envelope** and its evidence-drain hook;
- **cost metering** and the **API gateway** (budget *enforcement*, not just carriage);
- `ctx.tools.invoke` — the permission-check + meter + audit at invocation;
- the optional `inbound?` message facet (Volume XIII §9);
- the **enforcement predicate** that reads #013's resolved capability set.

All of the above are assembled **over #013's frozen shape, with no change to it.**

**Deferred to #015 (Capability Registry):**
- the single declarative registry table + resolver consolidating `tools_allowed` /
  `permissions` / `memory_scope` / `department` and the four registration surfaces named
  by the [platform-independence audit](./directive-012-platform-independence-audit.md);
- the authoring surface for capabilities;
- making `required_capability` **enforceable against a real registry**. #013 threads a
  *resolved* set; #015 becomes its **source** with no contract change.

**Also deferred** (other Task-Engine seams, each its own directive): DAG / `depends_on`,
approval lifecycle, verification.

### 14. What ADR is required?

**One ADR: `0007-runcontext-runtime-contract.md`** — the next free ADR number
([`numbering.md`](./numbering.md) §5). It records: the **frozen `RunContext` shape and
invariants**; the **canonical identity decision** (the slug rule, the three-way-split
resolution, and the historical-`actor_id` disposition with an explicit **blast radius**,
as the Freeze requires); the **cancellation/deadline design** (`AbortSignal` + the
`hq_ai_task_cancel` entry point); the **"resolved capability set, source-indifferent"**
rule; and the **explicit deferrals** to #014/#015. Because RunContext is **frozen
contract #4**, the [Architecture Freeze](./architecture-freeze.md) requires the ADR
**and an architectural review in the same PR** as the change. One ADR is cleaner than two
(the cancel entry point is recorded as a schema sub-section rather than a separate
decision).

### 15. What tests are required?

- **Contract / shape:** the assembled `ctx` has exactly the frozen fields; `correlationId
  === task.correlation_id`; `budgetMicros === task.cost_budget_micros` (passthrough,
  never mutated); `deadline` maps `task.deadline_at`.
- **Identity:** the canonical slug rule holds; the `memory` and `tasks` facets stamp the
  resolved identity; the qualification employee resolves to the single canonical slug.
- **Cancellation (the net-new behaviour — heaviest coverage):** cancel requested →
  `ctx.signal` aborts on the next heartbeat → a cooperative handler stops → the engine
  finalises `cancelled`; a handler that *ignores* the signal is still reaped by the lease
  (no regression); cancel of a `pending` task; cancel is terminal and idempotent
  (re-cancelling a `cancelled` task is rejected by the guard).
- **Deadline:** past-deadline → signal aborts; deadline + cancel **compose** (whichever
  fires first wins).
- **Capability threading:** the resolved set on `ctx` reflects the current
  `ai_employees` source; the set is opaque and read-only (defence-in-depth — the SQL
  entry point remains the backstop; the contract carries, it does not self-enforce).
- **No-regression:** the existing #012 runner/drain suite stays green (the `research-ai`
  and `lead-qualification` handlers are unchanged); the **six-gate CI** passes; the
  memory facet's behaviour is unchanged.
- **Concurrency / property:** cancel-during-heartbeat race; reaper-vs-cancel race
  resolves to exactly one terminal state.

### 16. What migration or schema changes are required, if any?

**Minimal — ideally one function, zero new columns.** Every *data* field #013 needs
already exists as a reserved seam on `hq_ai_tasks`: `deadline_at` (L145),
`cost_budget_micros` (L154), `correlation_id` (L161, live), `required_capability` (L88).
The **only** schema change is the **cancellation entry point** `hq_ai_task_cancel` — a
new `SECURITY DEFINER` function. The `cancelled` **status and its guard transition
already exist** (L103, L267-268), so there is **no enum change and no constraint
migration**. If cancellation is scoped out of #013, the schema delta is **zero** (pure
TypeScript over existing columns).

Identity *may* warrant a data step to reconcile `lead-qualification` `actor_id`s — but
the ADR can choose **alias or freeze over re-stamp** to avoid touching historical
append-only spine rows (the `runtime-identity.md` §1 warning). **Net:** the runtime
contract is overwhelmingly a *binding* exercise, not a schema one — the strongest single
piece of evidence that the approved sequence (contract first) is right.

### 17. What would make the design over-engineered?

The honest failure modes, each with its guard-rail:

1. **Building the Capability Registry inside #013.** That is #015. #013 threads a
   *resolved, opaque* set — no registry table, no resolver, no authoring UX. *(Biggest
   scope-creep risk.)*
2. **Building the comms/events/tools/api facets, the API gateway, or the cost meter.**
   That is #014. `budgetMicros` stays a passthrough.
3. **Turning RunContext into a god-object / DI container** — adding fields no current
   consumer or already-built facet needs. The ceiling is the minimal six + (identity
   formalised, `deadline`, `signal`, the resolved capability set). The capability set is
   the *one* field present for the frozen contract rather than a #013 consumer; it is
   justified by the Constitution's "threads … scope" + the freeze, and bounded by being
   *opaque* (no predicate, no enforcement, no source in #013).
4. **Preemptive cancellation / thread-kill machinery.** Cooperative `AbortSignal`
   matches the lease model; a hard-kill scheduler is over-build.
5. **A budget-reservation ledger or distributed quota.** Premature; the meter is #014.
6. **Re-stamping all historical `actor_id`s when an alias suffices** — high blast radius
   for little gain.
7. **Context-versioning / negotiation machinery before a second version exists** —
   YAGNI; the Architecture Freeze already governs how the shape changes.

**The discipline test:** every field must have a *live consumer in #013 or an
already-built facet*, **or** an explicit frozen-contract justification; every *mechanism*
must bind an *already-reserved seam*. A field whose only justification is a future
directive belongs in that directive.

---

## 4. Illustrative target shape *(design only — not implemented)*

```ts
// PROPOSED graduation of server/sdk/tasks.ts:98-111. Shape frozen by #013; the
// later facets (#014) and the registry source (#015) attach with NO change to it.
interface RunContext {
  // —— present today (PR-C slice, #012) ——
  task: TaskRow;                 // the leased unit of work
  identity: EmployeeIdentity;    // formalised from RunnerIdentity (Q6)
  memory: BoundMemory;           // unchanged — the built facet (#009)
  tasks: BoundTasks;             // create + checkpoint ONLY (runner rule 3)
  correlationId: string;         // task.correlation_id — inherited, never chosen
  budgetMicros: number;          // task.cost_budget_micros — passthrough, NOT metered

  // —— activated seams (#013) ——
  deadline: Date | null;         // from task.deadline_at (seam → live)
  signal: AbortSignal;           // cooperative cancel ∪ deadline (composed)
  capabilities: ResolvedCapabilitySet; // opaque, source-indifferent (Q7)
}

interface EmployeeIdentity {
  employeeId: string;            // ai_employees.id (memory key / FK target)
  slug: string;                  // the CANONICAL runtime slug — the actor_id (Q6)
  department: string | null;
  memoryScope: MemoryScope;
  // version?: string;           // §9 includes it; deferred until a 2nd version exists (Q17)
}
```

The slots #013 does **not** fill (arriving in #014, over this frozen shape):
`comms`, `events`, `tools`, `api`, the output envelope, `inbound?`, and the enforcement
predicate over `capabilities`.

---

## 5. Seam-activation map (the "binding, not building" evidence)

| Concern | Already exists | #013 action | Deferred to |
|---|---|---|---|
| **Correlation** | `correlation_id` (live) — `hq_ai_tasks` L161; `ctx.correlationId` `tasks.ts:294` | freeze the *inherited, never chosen* invariant | — |
| **Budget (ceiling)** | `cost_budget_micros` L154; `ctx.budgetMicros` `tasks.ts:295` | keep passthrough; guarantee presence | metering → #014 |
| **Memory** | `BoundMemory` (built, #009) `tasks.ts:283-288` | inherit unchanged | envelope drain → #014 |
| **Deadline** | `deadline_at` seam L145; `TaskRow` `hq-tasks.ts:73` | `ctx.deadline` + fold into `ctx.signal` | hard SLA policy → later |
| **Cancellation** | `cancelled` status L103 + transition L267-268 (no entry point) | `ctx.signal` + `hq_ai_task_cancel` fn | — |
| **Capability** | `required_capability` seam L88; `ai_employees` cols L72/77/80 | thread an opaque resolved set | enforce → #014 · source → #015 |
| **Identity** | `RunnerIdentity` `tasks.ts:62-68`; split recorded `runtime-identity.md` §4 | formalise + decide canonical slug | — |

The pattern is uniform: **#013 binds what the platform already reserved.** Only
cancellation adds a function; nothing adds a column.

---

## 6. Recommended scope boundary

**In #013:** freeze the `RunContext` contract (shape + invariants); formalise
`EmployeeIdentity` and make the canonical runtime-identity decision; activate
`deadline`; add `ctx.signal` (cooperative cancel ∪ deadline) and the `hq_ai_task_cancel`
entry point; thread an opaque resolved `capabilities` set; ADR `0007` + architectural
review in the same PR; the test matrix in Q15. Graduate Architecture-Freeze contract
**#4 (RunContext)** Partial → **Established**.

**Out of #013 (by design):** every other SDK facet and the output envelope (#014); the
cost meter / API gateway (#014); the capability registry + resolver + authoring (#015);
DAG / approval / verification (their own directives); any re-stamp of historical
`actor_id`s beyond what the ADR explicitly authorises.

---

## 7. One coherence follow-up (flagged, not done here)

The [Constitution](../../crewflow-v1.0-constitution.md) §3 still reads *"The canonical
SDK + identity design is owned by the AI SDK directive (D-04 / #014)"* — bundling
identity with the SDK. The approved Option B **split** them: identity now settles in
**#013**. This proposal **does not edit the Constitution** — it was outside the CEO's
authorised roadmap-update file list, and the Constitution has deliberate special status
(the V1.0 finish line, not a Bible/roadmap document). **Recommendation:** a one-line
reconciliation of Constitution §3 (identity → D-03 / #013; SDK envelope → D-04 / #014),
made under explicit CEO authorisation. Surfaced here so the gap is on the record rather
than silently carried.

---

## 8. Status & next step

**Reviewed — outcome in §9.** On approval, #013 is issued: branch `directive/013-*`, ADR
`0007` written **before** code (the document-before-build rule), the contract frozen and
graduated to Established, and the Platform Reuse Index gains its #013 entry (expected
shape: **R1** the frozen contract + `hq_ai_task_cancel`; **R2** heavy reuse — five seams
bound, the memory facet inherited; **R4** none yet; **R3** ≈ 0 net new per-employee
code; **trend** platform ↑ · employee ↓). **No implementation begins until this proposal
is approved.**

---

## 9. CEO review outcome *(recorded after review)*

The CEO completed an independent CTO review of this proposal. **Outcome: the RunContext
Runtime Contract architecture is approved**, with **one architectural amendment** and **two
additional standing rules**. All three are now encoded as first-class principles in
**[ADR 0007 — The RunContext Runtime Contract](../decisions/0007-runcontext-runtime-contract.md)**
(Decisions 2–4):

1. **Execution-state ownership (amendment).** RunContext **does not own execution state**.
   *The Operating System (Task Engine) owns it* — cancellation, deadlines, budget, leases,
   retries. *RunContext exposes it* — `ctx.signal`, `ctx.deadline`, `ctx.budget`. *Handlers
   consume it* and **never own or mutate runtime execution state**. This becomes a permanent
   architectural principle. It **sharpens** this proposal's thesis: even the new
   `hq_ai_task_cancel` entry point is an *engine* capability — RunContext merely surfaces its
   effect.
2. **RunContext immutability (rule).** Once execution begins, `identity`, `correlationId`,
   `deadline`, `budget`, and `signal` remain immutable; the handler's context object stays
   stable throughout execution, guaranteeing deterministic handler behaviour. (ADR 0007
   pins the one precise carve-out: the `signal` reference is immutable and its `aborted` flag
   is a monotonic one-way latch — the designed cancellation edge, not a context mutation.)
3. **No infrastructure exposure (rule).** RunContext never exposes infrastructure — no SQL,
   Supabase, database clients, transport clients, or raw services. Employees interact with
   the OS **only through SDK abstractions**: *the SDK becomes the only interface between AI
   employees and the operating system.*

**Field-name reconciliation carried into ADR 0007:** the exposed budget accessor is
**`ctx.budget`** (the CEO's vocabulary; a clean abstraction), replacing today's raw-unit
`ctx.budgetMicros` (`server/sdk/tasks.ts:110`) while still carrying the reserved micros
ceiling.

**Outcome.** The CEO reviewed and **accepted ADR 0007**
([`../decisions/0007-runcontext-runtime-contract.md`](../decisions/0007-runcontext-runtime-contract.md),
status *Accepted*), confirming the kernel boundary: *the OS owns execution state · the Task
Engine owns task state · RunContext exposes execution context · the SDK exposes platform
capabilities · employee handlers own business logic only.* The CEO also authorised the
minimal **Constitution §3 reconciliation** flagged in §7 (identity → D-03 / #013; SDK
envelope → D-04 / #014).

**Implementation authorisation.** Once ADR 0007 and the Constitution reconciliation are
merged, Directive #013 implementation is authorised — the **smallest correct** RunContext
Runtime Contract, strictly within the ADR scope: **no** SDK-envelope expansion, **no**
Capability Registry, **no** employee migration, **no** new platform tools, **no** raw
infrastructure exposure; held to the full validation discipline (typecheck · lint · unit ·
integration · security · production build). Directive #014 does not begin until #013 has a
completion report and CEO review.

---

*Documentation only. No code, schema, migration, configuration, or git history was
changed by this proposal. Prepared under CEO Directive #011 (Master Roadmap D-01) as the
architecture proposal for Directive #013 / D-03; the forward sequence it designs against
was approved by the CEO (Option B) and recorded in [`numbering.md`](./numbering.md) §3.
The CEO's review outcome is recorded in §9; the approved contract and its three amendments
are formalised in [ADR 0007](../decisions/0007-runcontext-runtime-contract.md).*
