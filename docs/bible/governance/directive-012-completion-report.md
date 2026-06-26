# CrewFlow — Directive #012 Completion Report (The Generic Task Engine)

> **Status:** Governance **record** — the permanent engineering record of a
> completed directive. Directive **#012** (Master Roadmap **D-02**), *The Generic
> Task Engine*, is **architecturally complete**: all seven build PRs (PR-A … PR-G)
> and three documentation-substrate PRs are merged into the integration branch
> `directive/011-governance-reconciliation`, every gate green. This report records
> what was built, what was deliberately left, and what the platform learned —
> written so any engineer or AI employee can pick the work up cold.
>
> **Scope of "complete":** the engine, its SDK, its spine and memory integration,
> the reference and second employee migrations, the unified operator read model,
> and the documentation reconciliation are all **merged to the integration
> branch**. The **cutover to `main` and the production migration are a separate,
> CEO-gated step** (see §2, §9). "Architecturally complete" is not "in production".

---

## 0. The directive in one paragraph

Before #012, every executing AI employee carried its **own** work queue. The
Sales-AI employees ran on a bespoke `hq_sales_ai_tasks` table with a per-service
`STUCK_RUNNING_MS` wall clock for crash detection — a pattern that would have been
**re-cloned 42 times**, once per employee, each a place for the inheritance promise
to fork. Directive #012 replaced that with **one** durable, crash-safe, audited
work engine — `hq_ai_tasks` — that every AI employee claims, leases, heartbeats,
retries, and recovers through **identically**. The bespoke queue is retired; the
bespoke wall clock is retired; crash recovery is now a property of the platform
(leases + a reaper), not of each employee. The architectural promise — *employee
#42 inherits exactly the same execution model as employee #3* — is now enforced by
the database, the SDK, and the test suite rather than by discipline.

---

## 1. Objectives completed

All objectives the CEO approved in the Final Review are merged and verified.

| # | Objective | How it was met | Evidence |
|---|-----------|----------------|----------|
| 1 | **Generic Task Engine** — one durable, crash-safe queue | `hq_ai_tasks` table + state-machine guard trigger + **seven** SECURITY DEFINER entry points; `task_type` is free-form (the extensibility seam — a new employee needs no schema change) | `supabase/migrations/20260802000000_hq_ai_tasks.sql` (624 lines); **ADR 0004**; PR-A (#191) |
| 2 | **SDK Runner** — one way to execute work | Generic runner SDK over the live entry points: `registerTaskHandler` · `runReadyTask` (claim-one) · `drainTaskType` | `server/sdk/tasks.ts` (452 lines); PR-C (#196) |
| 3 | **Event Spine integration** | `task.*` lifecycle verbs emit on the frozen Event Spine; every task transition is audited automatically | **ADR 0005**; PR-B (#193); Task Event Contract (#194/#195) |
| 4 | **Shared Memory integration** | Memory rows bind to the task that produced them via a `bound_task_id` FK — knowledge is attributable to work | **ADR 0006**; PR-D (#197) |
| 5 | **Reference Employee migration** | `research-ai` (`research_company`) moved onto the engine; bespoke queue + wall clock retired | `server/services/hq-research.ts`; PR-E (#198) |
| 6 | **Second employee migration** | `lead-qualification` (`qualify_company`) conformed to the *same* contract by construction | `server/services/hq-qualification.ts`; PR-F (#199) |
| 7 | **Unified operator read model** | One employee-agnostic screen for the whole workforce on the shared queue; groups by durable `task_type`, joins identity from `assigned_employee_id` | `server/services/hq-task-queue.ts` (369) + `app/admin/tasks/page.tsx` (301); PR-G (#200) |
| 8 | **Documentation reconciliation** | Volumes XII/XIII + ADR 0004 reconciled to as-built; two new permanent standards recorded | PR-E/PR-G docs; `substrate/volume-12-task-engine.md`, `substrate/volume-13-ai-sdk.md` |
| 9 | **Migration verification** | Cross-employee parity pinned in source analysis **and** proven against live Postgres | `__tests__/security/employee-migration-parity.test.ts`; `__tests__/integration/tasks/task-queue-read-model.test.ts` |
| 10 | **Platform validation** | All gates green on the integrated branch | typecheck clean · security **791/791** · unit **2655/2655** · read-model integration **6/6** |

**Two permanent standards were ratified by this directive** (Volume XIII):

- **The Reference Employee Rule** — the *first* migrated employee is the canonical
  reference; every later migration **conforms to the execution model it proved**. A
  migration that appears to need new infrastructure means the **platform** is
  missing a capability, not that the employee is exceptional.
- **The architectural-health metric** — each new AI employee should get *smaller*,
  the operating system *larger*. A standing trend line, made legible by the AI Task
  Queue read model.

---

## 2. Deferred work (named, not hidden)

Nothing below blocks the directive's architectural completion; each is a bounded,
explicitly-deferred follow-up.

1. **Cutover to `main` + production migration.** All #012 work is merged to the
   `directive/011-governance-reconciliation` integration branch, not to `main`, and
   the `hq_ai_tasks` migration is **not yet on production**. Prod's migration ledger
   also lags `main` (the Shared Memory engine migrations and others are still
   gated). The cutover — `#011 → main`, then a scheduled `supabase db push` — is a
   **separate, CEO-approved step**, never auto-applied.
2. **The other 40 employees.** Only **2 of 42** specified employees execute on the
   engine today (`research-ai`, `lead-qualification`). The remaining 40 are
   spec-only (Volume `workforce/`). Each migrates one at a time, by directive, on
   the now-proven template. The **Platform Compatibility Matrix**
   (`../workforce/platform-compatibility-matrix.md`) is the canonical tracker for
   that frontier.
3. **The inert engine seams.** The schema reserves — but does **not** yet
   activate — three capabilities: **task dependencies / DAG** (`depends_on`),
   **approval-gated tasks** (the `waiting_approval` status as a first-class gate),
   and **verification** (the `verifying` status as a second-pair-of-eyes step).
   They exist as typed seams so the *first* implementation goes through ADR +
   review, not ad hoc.
4. **Read-model scale.** The per-employee breakdown is computed over a bounded
   recent-activity window (≤ 1000 rows), not a true SQL aggregate. Honest about
   current activity, constant round-trips — but a future materialised view / SQL
   aggregate should replace the window **beneath the unchanged read contract** when
   task volume warrants it.
5. **Canon refresh at cutover.** Three records track `main` and should be refreshed
   **when #011 lands on `main`**, not before: `docs/roadmap.md` (a Workstream +
   changelog row for the engine), `governance/architecture-freeze.md` §4 row 5
   (Task Engine evidence — partially refreshed here for canon-consistency), and the
   `adoption-analysis.md` living tracker. This report and the numbering ledger row
   are updated now because they describe the directive itself, not `main`.

---

## 3. Technical debt

Tracked honestly; none of it is load-bearing on the platform's correctness.

- **Identity-slug drift.** The workforce spec roster (`workforce/README.md` §7)
  names employee #14 `qualification-ai`; the *running* employee's slug is
  `lead-qualification` (and Research is `research-ai`, matching). The read model
  joins on `assigned_employee_id`, so it is unaffected, but the spec/runtime slug
  reconciliation is owed to the AI SDK directive (D-04 / #014), where runtime
  identity is the canonical concern (`governance/runtime-identity.md`).
- **`as never` cast shims.** Both the read model and the migrated runners reach the
  generic queue through a small `taskReads<T>` / `taskCount` typed shim that casts
  `from("hq_ai_tasks" as never)` because the table is service-role-only and absent
  from the generated public types. It is the house idiom for "read the generic
  queue", but it is a cast, and a generated-types pass would remove it.
- **Read-model totals vs. window.** Headline totals are exact engine-wide
  head-counts; the per-type breakdown is windowed. The two can momentarily disagree
  for a type whose rows fall outside the window — correct by design (totals are the
  source of truth) but worth a UI note when volumes grow.
- **Department-enum gap (inherited, not introduced).** The `ai_employees.department`
  enum still lacks dedicated slots for several specified divisions; the workforce
  spec maps each to the closest value. Pre-existing; flagged in `workforce/README`.

---

## 4. Architecture assessment

**The engine is sound and the inheritance promise is now structurally enforced.**

- **Single source of truth.** There is exactly one work queue (`hq_ai_tasks`),
  written **only** through seven SECURITY DEFINER entry points, guarded by one
  BEFORE trigger that enforces the whole state machine (born-pending, write-once
  `task_type`/`payload`, terminal immutability, legal transitions only). An employee
  cannot raw-write the queue — the security tier pins that as an invariant.
- **Indistinguishability is machine-checked, not asserted.** The platform's central
  claim — "from the operating system's perspective, every employee is
  indistinguishable" — is proven two ways: a **source-analysis** tier
  (`employee-migration-parity.test.ts`) pins that both employees reach the engine
  through the *identical* surface (`enqueueTask` + `registerTaskHandler` +
  `runReadyTask` + `drainTaskType`) and have shed `STUCK_RUNNING_MS` and
  `hq_sales_ai_tasks`; and a **live-Postgres** tier
  (`task-queue-read-model.test.ts`) proves two distinct employees on the one queue
  render through one read model with the *identical bucket shape*, identity joined
  as data on top.
- **Crash-safety moved into the platform.** Leases + a reaper cron replace every
  employee's bespoke `STUCK_RUNNING_MS`. Recovery is now uniform and automatic; a
  new employee inherits it for free.
- **Extend-before-replace, honoured.** A new employee adds a `task_type` string and
  a handler — **no migration, no new table, no new SDK**. The free-form `task_type`
  is the extension point; the inert DAG/approval/verification seams are the
  designed-once expansion points.
- **Read model is employee-agnostic by construction.** It names no task type and
  joins identity dynamically, so a newly migrated employee appears the moment it
  enqueues — the operating system is the thing that grows, not the screen.

**Net:** the Generic Task Engine meets the Architecture Freeze bar for a *protected
platform capability* (no employee may introduce a custom runner; no parallel queues
— ADR 0004 + Freeze §4). The contract is **Partial** only in the honest sense that
its full intended surface (DAG, approval-gating, verification) is reserved, not
because the shipped core is incomplete.

---

## 5. Platform maturity

Where the substrate stands after #012 (statuses per `architecture-freeze.md` §4):

| Capability | Before #012 | After #012 |
|---|---|---|
| **Task Engine** (generic) | Reserved / per-employee bespoke queues | **Partial→load-bearing**: schema + 7 entry points + runner SDK + spine + memory FK + read model; 2 employees live; DAG/approval/verification reserved |
| **AI SDK** | Memory facet only | Memory facet **+ the task-runner facet** (`server/sdk/tasks.ts`); the per-employee `RunContext` envelope remains D-04 |
| **Event Spine** | Established | Established; now carries the `task.*` verb family |
| **Shared Memory** | Established (prod gated) | Established; now **bound to work** via `bound_task_id` |
| **Operator visibility** | Per-employee admin pages | **One** workforce-wide queue read model (`/admin/tasks`) |

**Maturity readout.** The platform has crossed from "one employee proves the
pattern" to "the pattern is the platform". The reuse ratio is now demonstrable: the
**second** migration (lead-qualification) added **zero** new platform code — it was
pure configuration + a handler against the engine the first migration proved. That
is the maturity signal the directive set out to produce.

---

## 6. Lessons learned

1. **A migration that seems to need new infrastructure is a platform gap.** The
   single most valuable lesson, now a permanent rule (the Reference Employee Rule).
   When research-ai's migration wanted "somewhere to detect stuck tasks", the right
   answer was *leases in the engine for everyone*, not a wall clock in the employee.
2. **Prove indistinguishability against a live database, not just source.** Source
   analysis can pin "both call the same functions"; only a real Postgres run proves
   "both render as one workforce through one read model". The two tiers are
   complementary and both are now required for a migration.
3. **The read model must name no employee.** The moment a unified view hard-codes a
   task type, it forks per employee. Grouping by the durable `task_type` contract
   and joining identity dynamically is what makes "a new employee appears
   automatically" true rather than aspirational.
4. **Free-form beats enumerated for the extension axis.** Leaving `task_type`
   unconstrained (no CHECK, no enum) is what lets employee #42 enqueue without a
   migration. The discipline that would normally argue for an enum is instead held
   by the SDK + tests.
5. **Small, ADR-anchored PRs kept a load-bearing change reviewable.** Ten PRs, three
   ADRs, one capability — each step independently green. A frozen, protected
   capability is exactly where the document-before-build rule earns its cost.
6. **Net-flat LOC can still be a large complexity reduction.** The migrated service
   files are roughly LOC-neutral, yet each shed an entire *category* of bespoke
   infrastructure (a private table, a private wall clock). Counting lines understates
   the win; counting *kinds of mechanism removed* captures it.

---

## 7. Future recommendations

1. **Schedule the `#011 → main` cutover and the production migration** as the next
   concrete step, CEO-gated, with the prod ledger lag accounted for (apply the
   backlog of gated migrations in one reviewed push).
2. **Make the Platform Compatibility Matrix the migration dashboard** for every
   subsequent employee directive — update it as the *first* artifact of each
   migration, before code.
3. **Activate the inert seams by directive, in order of demand** — approval-gated
   tasks first (it reuses the built Approval Engine), then verification, then the
   DAG. Each gets its own ADR.
4. **Promote the task-runner facet into the named AI SDK envelope** under D-04 /
   #014 so `RunContext`, memory, and tasks present one coherent employee SDK.
5. **Replace the read-model window with a SQL aggregate** when any single
   `task_type` routinely exceeds the window cap — behind the unchanged read
   contract.
6. **Adopt the two-tier migration proof (source parity + live read-model) as the
   standing acceptance bar** for migrating employees #3…#42.

---

## 8. Metrics

**Delivery.**

- **10 PRs** merged to the integration branch: 7 lettered build PRs (PR-A #191,
  PR-B #193, PR-C #196, PR-D #197, PR-E #198, PR-F #199, PR-G #200) + 3
  documentation-substrate PRs (#192 lifecycle reference, #194 versioning + Task
  Event Contract, #195 contract lifecycle metadata).
- **3 ADRs** (0004 engine, 0005 spine emission, 0006 memory↔task binding).
- Integration tip after merge: `4dd5beb` (Merge #200), merge order #198 → #199 →
  #200 at 22:10:31 / 22:10:52 / 22:11:09 UTC.

**Surface (lines of code).**

| Artifact | LOC |
|---|---|
| `migrations/20260802000000_hq_ai_tasks.sql` (schema + 7 entry points) | 624 |
| `server/services/hq-tasks.ts` (enqueue/service surface) | 340 |
| `server/sdk/tasks.ts` (runner SDK) | 452 |
| `server/services/hq-task-queue.ts` (read model) | 369 |
| `app/admin/tasks/page.tsx` (operator screen) | 301 |
| `__tests__/security/employee-migration-parity.test.ts` | 143 |
| `__tests__/integration/tasks/task-queue-read-model.test.ts` | 256 |

**The architectural-health signal (the point of the directive).**

| Employee | Migration churn | New migrations | New SDK/lib modules | Net new platform code |
|---|---|---|---|---|
| `research-ai` (reference, PR-E) | ~376 LOC in `hq-research.ts` | 0 | 0 | 0 |
| `lead-qualification` (#2, PR-F) | ~388 LOC in `hq-qualification.ts` | 0 | 0 | **0** |

The second migration added **no** new platform code — the headline maturity metric.

**Quality (integrated branch, verified post-merge).**

- typecheck `tsc --noEmit`: **clean**.
- security suite: **791 / 791** passing (35 files), incl. the 16-check parity tier.
- unit suite: **2655 / 2655** passing (138 files).
- read-model integration: **6 / 6** passing against live local Postgres.
- e2e / production build: green (`/admin/tasks` route built) — validated this cycle.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Prod migration ledger lag** — prod is several gated migrations behind; a future `db push` applies a backlog | Medium | High if unreviewed | Apply as **one CEO-reviewed push**, on a maintenance window, never auto-applied; dry-run on a branch DB first |
| **Branch stacking** — #012 sits on the `#011` integration branch, not `main`; a long-lived stack can drift | Low–Med | Medium | Cutover `#011 → main` promptly; the merges are clean today |
| **Two-employee sample** — parity proven at N=2; generalises *by construction*, but only two real data points exist | Low | Medium | Treat the two-tier proof as the standing bar; each new migration adds a data point and must stay green |
| **Inert seams improvised later** — DAG/approval/verification activated ad hoc would fork the contract | Low | High | They are frozen seams: first implementation requires ADR + review (Freeze §2) |
| **Read-model window vs. totals divergence** at scale | Low | Low | Totals are the documented source of truth; swap the window for a SQL aggregate behind the same contract |
| **Service-role `as never` shim masks a schema mismatch** | Low | Low | A generated-types pass removes the cast; integration tier exercises the real columns |

No **high-likelihood** risks remain open. The dominant residual risk is
operational (the gated production cutover), not architectural.

---

## 10. Suggested roadmap adjustments

1. **Record #012 as shipped in the canon at cutover.** The numbering ledger row is
   updated now (`numbering.md` §3); `docs/roadmap.md` should gain a **Workstream**
   for the Generic Task Engine and a changelog row **when #011 lands on `main`**
   (the roadmap tracks `main` merges).
2. **Reframe the boardroom progress line.** The roadmap's "14 seeded · 2 executing"
   should, post-cutover, read against the 42-employee workforce model with the
   Platform Compatibility Matrix as the live denominator — "2 of 42 on the engine"
   is the honest, motivating frame.
3. **Insert an explicit "seam-activation" track.** Approval-gated tasks (reusing the
   Approval Engine), verification, and the DAG are real future modules; name them in
   the roadmap as reserved engine capabilities so they are not improvised.
4. **Carry the architectural-health metric into the roadmap's "progress at a
   glance".** Make "net new platform code per employee migration" a tracked figure —
   the trend line *is* the platform thesis.
5. **Keep D-03 / #013 sequenced after this report's review.** Per the CEO's
   instruction, the Directive #013 architecture proposal follows the review of this
   report; no #013 implementation begins until that proposal is approved.

---

*Governance record under CEO Directive #012 (Master Roadmap D-02). Documentation
only — this report changes no code, schema, or configuration. It records a
completed directive for the permanent engineering canon. Canonical numbering:
[`numbering.md`](./numbering.md); the capabilities every employee inherits:
[`../workforce/platform-compatibility-matrix.md`](../workforce/platform-compatibility-matrix.md).*
