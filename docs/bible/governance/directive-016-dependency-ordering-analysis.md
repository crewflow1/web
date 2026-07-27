# CrewFlow Governance — Directive #016 Dependency-Ordering Analysis

> **Status:** Governance **analysis & recommendation** — *not* a decision, and it
> renumbers nothing. With **#013** (RunContext), **#014** (AI SDK Envelope) and **#015**
> (Capability Registry) all **complete** — Architecture-Freeze contracts **#3 / #4 / #8**
> each **Established** — it answers: **which thing-name should take the next free directive
> number #016 / D-06, and in what order do the remaining platform-contract frontiers
> follow?** Every conclusion is backed by `file:line` repository evidence. Prepared under
> CEO Directive **#011** (*Governance, Numbering & Scope Reconciliation*; Master Roadmap
> **D-01**); it **informs the #016 subject the CEO must confirm** before the Architecture
> Proposal is written, exactly as the [#013 dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md)
> informed which thing-name took #013.
>
> **Bottom line:** the dependency is **asymmetric** again. The **Live Executor Rollout** —
> wiring the already-built, **C4-proven** executor into the live run loop — depends **only**
> on contracts that are **already Established** (#3 AI SDK, #4 RunContext, #6 Approval Engine,
> #8 Capability Registry). Every other open frontier (the **API gateway + cost metering**,
> **Task-Engine verification**, the **Boardroom write/decision** interface, the **agent-to-agent
> protocol**) depends, directly or transitively, on the executor being **live**. So the executor
> rollout is the **keystone** and should take **#016**. The **API gateway + cost metering** is its
> natural successor — the **evidence fixes the order** (the executor must be live before its egress
> is metered); whether the two are **one directive or two** is the **CEO's call**, exactly as the
> RunContext-vs-SDK packaging was at #013.

---

## 1. The question, and the method

The three platform directives the [#013 analysis](./directive-013-dependency-ordering-analysis.md)
sequenced are now finished. Per [`numbering.md`](./numbering.md) §3: **#013** (RunContext) and
**#014** (AI SDK Envelope) are **complete** with contracts **#4** and **#3** Established, and
**#015** (Capability Registry) is **complete** with contract **#8** Established. The next directive
to be *issued* is **D-06 = #016**, and the roadmap assigns it **no thing-name** — only D-03/D-04/D-05
carry assigned names (`numbering.md` §7). So **#016 is genuinely open**, and the CEO has asked for an
Architecture Proposal *once the subject is confirmed*. This analysis is the precursor that recommends
that subject.

What remains on the **platform-contract** frontier (the CEO-named ten,
[`architecture-freeze.md`](./architecture-freeze.md) §4) is short and specific:

- **#3 AI SDK** — *Established*, but carries **one explicitly-deferred, not-yet-written extension**:
  *"the executor rollout into the live run loop and the API gateway + cost metering"* (freeze §4 #3;
  `numbering.md` §3 row 014).
- **#5 Task Engine** — *Partial*: *"the reserved seams — task dependencies/DAG (`depends_on`),
  approval-gated tasks, and verification — are inert pending their own ADRs."*
- **#9 Boardroom interfaces** — *Partial (read-only)*: *"the Boardroom observes, it does not yet act."*
- **#10 Shared Communication Protocol** — *Reserved (spec only)*: no agent-to-agent messaging in code.

The test is the same one that decided #013: **for each candidate, does its correct design depend on
another candidate, or only on a contract that is already Established?** Whichever candidate depends
**only on settled contracts** is the keystone and comes first — the [Architecture Freeze](./architecture-freeze.md)
exists precisely to stop a load-bearing contract being improvised and then re-cut. All evidence is
`file:line` at integration tip `f4f14fb` (the PR #258 merge).

---

## 2. Two pivotal facts that reframe the question

Neither the keystone nor its successors are greenfield. As with #013, this is what makes the
dependency direction **decidable from evidence** rather than speculation.

**(a) The executor already exists — it is built and proven, just not wired in.**
`server/sdk/executor.ts` ships the **full** plan-then-apply boundary: `planExecution` (L211),
`executePlan` (L264), `execute` (L287), the `Executor` interface (L311) and `createExecutor` (L329) —
described in the source itself as *"the end-to-end shape the runner composes"* (L281). It is proven
**end-to-end, with no mock**, by the **C4 Reference Path** (`__tests__/sdk/reference-path-execution.test.ts`):
the real **registry → gate → executor → application** chain composed together, *"proving apply, replay,
idempotency, failure-recovery and escalation"* (freeze §4 #3). **But the runner does not compose it:**
`server/sdk/tasks.ts` — the live claim → run → complete loop — contains **zero** references to the
executor, the application record, or tool invocation. The executor is therefore not *"embryonic
intent"*; it is **built, frozen, and dormant**, waiting only to be threaded into the live loop. *(This
is the exact dual of #013's pivotal fact (a): there, a **minimal RunContext** was already shipped and
waiting to be widened; here, a **proven executor** is already shipped and waiting to be wired.)*

**(b) The seams the *successor* frontiers need are already reserved and named.** The Task-Engine
migration cut them on day one (`supabase/migrations/20260802000000_hq_ai_tasks.sql`): `cost_micros`
and `cost_budget_micros` as `-- SEAM (Cost/Budget)` (L153–154), `verification jsonb -- SEAM
(Verification)` (L151), the `verifying` state in the status enum (L104), and `required_capability`
for the registry. The runner already **threads the budget ceiling read-only**
(`server/sdk/tasks.ts:545` — `task.cost_budget_micros ?? 0`) and states in terms that
*"metering is a later directive"* (`tasks.ts:223`). So **cost metering and verification are not
inventions** — they are **reserved seams waiting for their activating directive**, and the migration
itself **defers metering to "a later directive."**

These two facts tilt the answer: the executor is the **moving keystone** — built and waiting to go
live; the gateway / verification / Boardroom / protocol are **consumers** that need either the executor
live first, or a reserved seam activated — and the seam activations *themselves* presuppose live
execution (you **meter** executed spend; you **verify** executed output; the Boardroom **orchestrates**
executing employees; agents **coordinate** executing work).

---

## 3. The candidate dependency analysis

| # | Candidate (contract) | What the directive would do | Depends on | Direction / order |
|---|---|---|---|---|
| 1 | **Live Executor Rollout** (#3 extension; advances #5) | Wire the proven `registry → gate → executor → application` chain into the runner's claim → run → complete loop (`server/sdk/tasks.ts`); bind **apply-on-approval** (ADR 0009) to the Approval Engine | **#3 AI SDK** (Established), **#4 RunContext** (Established — `identity`/`budget`/`signal`/`capabilities` **already threaded**, freeze §4 #4), **#6 Approval Engine** (Established), **#8 Capability Registry** (Established — **sources** capabilities), and the **#5 Task-Engine loop** (Partial, but `claim/lease/complete` ships) | depends **only on Established contracts** → **keystone, comes first** |
| 2 | **API Gateway + Cost Metering** (#3 extension; activates the `cost_micros` seam) | The external-API egress chokepoint + per-call cost accounting against `ctx.budget` | the **executor being live** (the gateway governs the executor's *external* tool-calls; metering meters *executed* work) + #4 budget ceiling | depends on the executor → **after #016**; the migration itself defers it (*"a later directive"*, `tasks.ts:223`) |
| 3 | **Task-Engine completion** (#5 Partial → Established) | Activate `depends_on`/DAG, approval-gated tasks, and the `verification`/`verifying` seam | **verification** depends on **executed output** to verify; approval-gating leans on #6; the executor going live is what *produces the artefacts* verification checks | verification depends on the executor → **after #016** |
| 4 | **Boardroom write/act** (#9 Partial → Established) | A write/decision interface so the Boardroom **acts**, not just observes | **employees actually executing** (the Boardroom orchestrates executors; today it *"observes, it does not yet act"*, freeze §4 #9) | depends on live execution → **after #016** |
| 5 | **Shared Communication Protocol** (#10 Reserved → Established) | Agent-to-agent messaging | **executing employees with work to coordinate**; the human-delivery Communication Layer (#7) is the sibling precedent, *not* this | depends on live execution → **latest** |

**Reading the table.** Every candidate **except #1** depends, directly or transitively, on the
executor being **live**. In **none** of them does the executor rollout's correct shape depend on the
others. The dependency runs **one way** — exactly the #013 shape.

---

## 4. The asymmetry, stated plainly

- **Does the executor rollout's shape depend on the gateway / verification / Boardroom / protocol?**
  **No.** The rollout threads an **already-frozen** executor (`execute()`) into an **already-shipped**
  loop, gating every applied action on an **already-Established** registry, over an **already-Established**
  RunContext. It introduces **no new contract** — it makes **four Established contracts load-bearing
  together for the first time.** Its only net-new surface is the wiring itself plus the apply-on-approval
  binding to #6 — **both already designed in ADR 0009.**
- **Does each other frontier's shape depend on the executor rollout?** **Yes, decisively:**
  1. **The API gateway** meters and governs the executor's external calls — there is nothing to meter
     or gate until the executor runs. `cost_micros` is a **reserved seam** (mig L153) the runner
     **defers to "a later directive"** (`tasks.ts:223`).
  2. **Verification** checks the **output of executed work**; the `verification` seam (mig L151) and
     the `verifying` state (mig L104) have nothing to verify until the executor produces artefacts.
  3. **The Boardroom** can only orchestrate or decide over **executing** employees; today it *"observes,
     it does not yet act"* (freeze §4 #9).
  4. **The agent-to-agent protocol** coordinates **executing** employees; with no employee executing
     autonomous multi-step actions, there is nothing to coordinate.

> **Direct answer:** the **Live Executor Rollout is the one open frontier whose load-bearing design
> depends on nothing unsettled** — every contract it consumes is **already Established**. It is
> therefore the correct **#016**. Every other frontier is downstream of it.

---

## 5. The packaging fork — bundle or split?

The one genuine sub-question is whether the executor rollout and the API gateway are **one** directive
or **two**. The [#014 AI SDK Envelope proposal](./directive-014-ai-sdk-envelope-architecture-proposal.md)
already surfaced this — flagging the API gateway as *"the one genuinely net-new chokepoint"* and asking
**whether it splits into its own directive.**

**Option A** — #016 = Executor rollout **+** API gateway **+** cost metering (the whole old *"Phase D"* at once).
**Option B** — #016 = **Live Executor Rollout** (internal capabilities first); **#017 = API Gateway + Cost Metering** (the net-new external chokepoint, its own ADR + review).

| Criterion | Option A (bundle) | Option B (split) |
|---|---|---|
| **Architectural clarity** | bundles a *contract-activation* with a *net-new build* | separates *"make the proven thing live"* from *"build a new chokepoint"* — two different risk profiles, read cleanly |
| **Dependency ordering** | respects executor-before-gateway internally, but puts the net-new egress chokepoint **on the critical path** of going live | lets execution go live on **internal, already-proven** capabilities (the C4 Reference Path is an internal capability), deferring external egress |
| **Risk / blast radius** | first **live execution** *and* first **external egress** land together — two new failure surfaces at once | lands them **in sequence**, each independently reviewable (the #015 *"slice by slice, each gated on the last"* discipline) |
| **Net-new infrastructure** | the API gateway — *"the one genuinely net-new chokepoint"* — rides in on the rollout | net-new infrastructure gets **its own ADR + architectural review** (freeze §2), where it most belongs |
| **Maintainability** | the deferred extension graduates in one large cut | it graduates in **two reviewable cuts** (executor live, then metered egress) |
| **OS coherence** | one big directive | **mirrors #013 exactly** — there, RunContext and the SDK were **split** (Option B) so a load-bearing contract was not improvised alongside a larger build; the same logic splits *"executor live"* from *"new egress chokepoint"* |

**Recommendation on the fork: Option B (split).** But — exactly as the #013 analysis said of the
RunContext-vs-SDK packaging — **the dependency order (executor live before egress is metered) is what
the evidence fixes; the packaging into one directive or two is the CEO's call.**

---

## 6. Recommendation

**Adopt the Live Executor Rollout as #016, then sequence the rest in the evidence-fixed order.**

1. **#016 / D-06 — the Live Executor Rollout** *(working thing-name; the CEO fixes the final name)*.
   Wire the **C4-proven** `registry → gate → executor → application` chain into the **live** Task-Engine
   run loop (`server/sdk/tasks.ts`): bind **apply-on-approval** (ADR 0009) to the Approval Engine (#6),
   thread `identity` / `budget` / `signal` / `capabilities` from the **already-frozen** RunContext (#4),
   and gate every applied action on the **registry** (#8). This is the directive that turns three
   **Established-but-dormant** contracts into **live, load-bearing execution** — the moment CrewFlow's
   employees first **act** autonomously *through the kernel* rather than through bespoke per-employee
   runners. It graduates no *new* contract by itself, but it **advances #5 Task Engine** (the run loop
   now carries real execution) and makes #3's deferred extension partly real. Squarely on-thesis:
   **platform capability (one shared executor) grows; employee complexity (bespoke action code) shrinks.**
2. **#017 / D-07 — the API Gateway + Cost Metering** *(indicative)* — the external-API egress chokepoint
   plus the `cost_micros` activation, governing and metering the now-live executor's outward calls
   against the RunContext budget ceiling. The migration already reserves the seam and defers it here.
3. **Then, in evidence-fixed order** *(indicative; each its own directive + ADR)*: **Task-Engine
   completion** (#5 → Established: `verification` over executed output, `depends_on`/DAG, approval-gated
   tasks) · **Boardroom write/act** (#9 → Established) · **Shared Communication Protocol** (#10 →
   Established). Each presupposes live execution; each is its own reviewed directive.

**Roadmap action requested (not taken here).** Per the #013 precedent, I recommend the CEO **confirm
the #016 subject** and then authorise recording **D-06 / #016 = Live Executor Rollout** in
[`numbering.md`](./numbering.md) §3/§7 and the [roadmap](../../roadmap.md) — in a **separate, explicitly
authorised change** — before any #016 Architecture Proposal is written. **No renumbering or thing-name
assignment is performed in this document**; it awaits the CEO's decision.

---

## 7. What this means, and an honest note

- **This recommends a *subject*; it does not write the *proposal*.** The CEO gated the Architecture
  Proposal on subject confirmation; the dependency-ordering analysis is the **precursor** that confirms
  it. The two are distinct artefacts — exactly as #013 had a separate
  [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md) **and** a separate
  [RunContext architecture proposal](./directive-013-runcontext-architecture-proposal.md).
- **Honest note on bundling.** An earlier chat recommendation bundled *"Live Executor + API Gateway"*
  as a single #016. This analysis, run against the **seam evidence**, refines that: the dependency
  **order** is right (executor before gateway), but the disciplined **packaging** *splits* them — the
  executor rollout **activates proven contracts**; the gateway **builds a net-new chokepoint**. The #013
  precedent (split RunContext from the SDK) is the governing analogy. **The CEO's call on packaging
  stands; the evidence only fixes the order.**
- **Scope honesty.** The [roadmap](../../roadmap.md)'s other open work — Sales Modules 4–7 (the
  conversion arc), Event Spine PR6/PR7 — is **employee/feature** work, not **platform-contract** work.
  #016, like #013/#014/#015, is a **platform-contract** directive; this analysis is scoped to the
  **contract frontier**, not the sales funnel. A directive that names Modules 4–7 is a separate,
  parallel track (roadmap *"What's next"* §1).

---

*Documentation only. No contract, schema, migration, service, or numbering was changed by this
analysis. It is a recommendation prepared for CEO decision under CEO Directive #011 (Master Roadmap
D-01). If adopted, the numbering ledger and the roadmap are updated in a separate, explicitly authorised
change, and the #016 Architecture Proposal is written, **before any #016 implementation begins.***
