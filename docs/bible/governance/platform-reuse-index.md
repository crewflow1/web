# CrewFlow Governance — The Platform Reuse Index

> **Status:** Standing governance **metric** — a living architectural-health ledger,
> appended to for **every future directive**. Instituted by CEO directive on approval
> of the Directive #012 completion report; recorded under CEO Directive **#011**
> (*Governance, Numbering & Scope Reconciliation*; Master Roadmap **D-01**).
>
> **The thesis it measures (CEO's words):** *"Platform capability grows. Employee
> complexity shrinks."* A healthy directive **adds** shared platform capability,
> **reuses** what already exists, **removes** bespoke per-employee infrastructure, and
> leaves each new employee **smaller** than the last. This index is the architectural
> health indicator that makes that trend visible and auditable over time.

---

## 1. Why this exists

CrewFlow's promise is that *employee #42 inherits exactly the same architecture as
employee #3*. That promise can quietly rot in one of two ways: the platform stops
growing (employees start carrying their own bespoke machinery again), or the platform
grows by *duplication* rather than *reuse* (every directive reinvents a queue, a
runner, a read model). Either failure is invisible in a single PR and obvious only as a
trend.

The Reuse Index makes the trend a **recorded number per directive**. It is the
companion metric to the [Architecture Freeze](./architecture-freeze.md) (which governs
*how* contracts change) and the Reference Employee Rule (the first migrated employee is
canonical): the Freeze protects the substrate, the Reference Employee Rule sets the
bar, and this index **scores every directive against that bar**.

---

## 2. The five components (recorded for every directive)

| # | Component | Question it answers | Healthy direction |
|---|---|---|---|
| **R1** | **Platform capabilities added** | What new *shared* substrate did this directive create — capabilities *every* employee now inherits? | **> 0** when the directive's job is platform; named, not vague |
| **R2** | **Existing platform capabilities reused** | What already-built substrate did it stand on instead of reinventing (queues, spine, memory, auth, CI)? | **high** — reuse before build |
| **R3** | **Employee-specific code added** | How much code belongs to *one* employee (its runner, UI, routes, seed)? | **low and falling** per employee |
| **R4** | **Infrastructure removed** | What bespoke / duplicated machinery did it *delete* (per-employee runners, wall-clock hacks, parallel queues)? | **> 0** — maturity deletes |
| **R5** | **Platform code vs employee code — the trend** | Net direction: did platform capability grow while employee complexity shrank? | **platform ↑ · employee/employee ↓** |

**Recording rule.** Every directive that touches the substrate appends one entry to §5,
populated with **repository evidence** (LOC, PR/ADR numbers, file paths) — never
estimates. A documentation-only or pure-employee directive may record "platform-neutral"
explicitly rather than omit the entry.

---

## 3. How to read the index (what healthy looks like)

- **R1 named and R4 non-zero** → the directive *generalised* rather than bolted on. The
  strongest signal: a new capability that arrives *with* the deletion of the bespoke
  thing it replaces.
- **R2 ≫ R1** → reuse dominated invention; the platform grew by extension, not
  duplication.
- **R3 falling across successive employees**, ideally reaching **0 net new platform
  code** for the *n*-th migration → the Reference Employee Rule is holding; the platform
  is doing the work, not the employee.
- **R5 trend arrow** is the one-glance verdict. A run of `platform ↑ · employee ↓`
  entries is the architectural health the CEO named; a `platform ↑ · employee ↑` entry
  (capability added *and* per-employee complexity rising) is the early-warning sign to
  investigate before the next directive.

A directive is **not** unhealthy merely for adding employee code — a new employee must
exist somewhere. It is unhealthy when employee code grows *because the platform forced
it to* (a missing capability pushed into per-employee workarounds). That is the
distinction R3/R4 are designed to expose.

---

## 4. Running summary (one row per directive)

| Directive | Platform Δ (R1) | Reuse (R2) | Employee Δ (R3) | Removed (R4) | Trend (R5) |
|---|---|---|---|---|---|
| **#012 / D-02** — Generic Task Engine | **+6 capabilities** (~2 086 LOC substrate) | **5 prior capabilities** reused (queue, spine, memory, roster, CI/auth) | migration #1 ≈ 376 LOC churn · migration #2 **0 net new platform** | **3** bespoke mechanisms deleted | **platform ↑ · employee ↓** ✅ |
| **#013 / D-03** — RunContext Runtime Contract | **+2 capabilities** (cooperative cancellation + the frozen runtime contract; ~362 LOC: 148 SQL + 214 SDK) | **the whole #012 Task Engine** reused (7 entry points, guard, lease, heartbeat, reaper, the `cancelled` status + every inert seam) + Event Spine + registry | **0 new employee modules · 0 new migrations** for the 2 live employees (identity-shape churn ≈ 43 LOC) | **1** identity ambiguity removed (optional-slug `RunnerIdentity`) | **platform ↑ · employee ↓** ✅ |

*(Future directives #014… append below as they merge.)*

---

## 5. Directive entries (the ledger)

### Directive #012 / D-02 — The Generic Task Engine *(inaugural entry)*

Evidence base: the [completion report](./directive-012-completion-report.md) §8 and the
[platform-independence audit](./directive-012-platform-independence-audit.md). All
figures verified at integration tip `21a4104`.

**R1 — Platform capabilities added (6 new pieces of shared substrate):**

1. **Generic Task Engine** — `hq_ai_tasks` + 7 `SECURITY DEFINER` entry points
   (create/claim/heartbeat/checkpoint/complete/fail/reap) + the state-machine guard +
   lease/heartbeat/reaper crash recovery. 624 LOC. ADR 0004.
2. **Enqueue / service surface** — `server/services/hq-tasks.ts` (`enqueueTask`). 340 LOC.
3. **Runner SDK** — `server/sdk/tasks.ts` (`registerTaskHandler` / `runReadyTask` /
   `drainTaskType`). 452 LOC.
4. **`task.*` spine emission** — 5 frozen verbs appended to the Event Spine. ADR 0005.
5. **Shared Memory ⇄ Task binding** — the `bound_task_id` FK. ADR 0006.
6. **Unified operator read model** — `server/services/hq-task-queue.ts` + `/admin/tasks`
   (employee-agnostic, groups by `task_type`). 369 + 301 LOC.

**R2 — Existing platform capabilities reused (reuse before build):**

1. The **proven `hq_sales_ai_tasks` queue** — columns, `priority_rank` formula, dedupe
   partial-unique index, and RLS:hq posture carried over **verbatim**; the engine
   *generalised* the existing queue rather than inventing one (migration header §10).
2. The **Event Spine** — `task.*` verbs append via the existing `hq_emit_event` emitter;
   no new spine built.
3. **Shared Memory** — the binding reuses the existing memory facet
   (`server/sdk/memory.ts`); no new store.
4. The **`ai_employees` roster** — `assigned_employee_id` FK; no new identity table.
5. The **six-gate CI** + the **single HQ admin chokepoint/auth** — reused unchanged.

**R3 — Employee-specific code added:**

- `research-ai` (migration #1, PR-E): ≈ 376 LOC of consumer-wiring churn in
  `hq-research.ts`; **0 new platform modules**.
- `lead-qualification` (migration #2, PR-F): ≈ 388 LOC churn in `hq-qualification.ts`;
  **0 net new platform code** — the headline maturity signal.
- 2 employee crons (`research-drain`, `qualification-drain`).

**R4 — Infrastructure removed:**

1. `STUCK_RUNNING_MS` — the bespoke wall-clock stuck-detector, deleted from **both**
   employees; replaced by the engine lease + reaper.
2. The **read-then-write claim race** — replaced by the atomic `hq_ai_task_claim`.
3. The two employees' **direct ownership of `hq_sales_ai_tasks`** — replaced by the
   generic engine they now share.

**R5 — Platform vs employee trend:** **platform ↑ · employee ↓.** The platform gained
~2 086 LOC of shared substrate while *reusing* five prior capabilities; per-employee
complexity **fell** (each shed its bespoke stuck-detector and queue ownership), and the
**second** migration added **zero** net new platform code. The thesis holds at its first
measurement: *platform capability grew, employee complexity shrank.*

---

### Directive #013 / D-03 — The RunContext Runtime Contract

Evidence base: the [completion report](./directive-013-completion-report.md) and
[ADR 0007](../decisions/0007-runcontext-runtime-contract.md). Figures verified on **PR
#206** (base `#011` integration branch).

**The shape of this directive: binding, not building.** #013's defining metric is that it
added **one** `SECURITY DEFINER` function and *graduated* a contract — because #012
reserved every other seam it needed as an inert column. The **reuse ratio is the
headline**, not the LOC added.

**R1 — Platform capabilities added (2 new pieces of shared substrate):**

1. **Cooperative cancellation** — the 8th entry point `hq_ai_task_cancel` (148 LOC; one
   `SECURITY DEFINER` function, **zero** new columns/enums) plus the `ctx.signal`
   `AbortSignal` the runner aborts on the existing heartbeat. Every employee now inherits a
   durable cancel + a stop-signal, with deadlines composed into the same signal.
2. **The frozen RunContext contract** — the minimal slice graduated to the immutable,
   infrastructure-free envelope `{ task, identity, memory, tasks, correlationId, budget,
   deadline, signal, capabilities }` (`Object.freeze`-d), plus three standing principles
   (OS owns execution state · immutable per invocation · SDK the only door) that bind every
   later facet. ~214 LOC SDK graduation. ADR 0007. *(Carried by the contract, not built
   separately: `ctx.deadline` activates the `deadline_at` seam; `ctx.budget` exposes
   `cost_budget_micros` read-only; `ctx.capabilities` threads a resolved opaque set —
   #013 threads · #014 enforces · #015 sources.)*

**R2 — Existing platform capabilities reused (reuse before build — the headline):**

1. **The entire #012 Generic Task Engine** — the 7 entry points, the state-machine guard,
   the lease/heartbeat/reaper, and crucially the **`cancelled` status + its
   `pending|running → cancelled` guard transition**, which already existed: #013 added the
   *door* to a seam #012 had already cut. The cooperative-cancel mechanism **reused the
   existing heartbeat** (clear the lease → the next heartbeat matches zero rows → abort)
   with **zero new polling queries**.
2. **Every inert #012 column** — `correlation_id`, `cost_budget_micros`, `deadline_at`,
   `required_capability` — bound to context fields with **no schema change**.
3. **The Event Spine** — `task.cancelled` appends via the existing `hq_ai_task_emit` →
   `hq_emit_event`; no new spine, **one** new registered verb (VERBS 77 → 78).
4. **The existing minimal RunContext** — graduated by **addition**; both live handlers
   consume only fields that already existed.

**R3 — Employee-specific code added:**

- `research-ai` + `lead-qualification`: identity-shape churn only — `EmployeeIdentity` with
  the canonical, non-optional `slug` (≈ 22 + 21 LOC). **0 new employee modules, 0 new
  migrations, 0 new crons.** Both stayed green consuming only pre-existing fields.

**R4 — Infrastructure removed:**

1. The **optional-slug identity ambiguity** — `RunnerIdentity` (with `slug?` optional)
   replaced by `EmployeeIdentity` (canonical, non-optional `slug`); identity can no longer
   be half-specified.
2. The **raw-unit accessor** `ctx.budgetMicros` — replaced by the clean `ctx.budget`
   abstraction (no column unit leaked upward). *(A **tightening** directive, not a deletion
   directive — #013 removed ambiguity, not whole subsystems; the honest R4 is modest by
   design.)*

**R5 — Platform vs employee trend:** **platform ↑ · employee ↓.** The platform gained a
cancellation capability, a frozen runtime contract, and a settled identity rule for **one**
new function and ~one SDK file, while *reusing* the entire #012 engine; per-employee
complexity **fell** (a tighter inherited contract for ~0 net new employee code). The
binding-not-building ratio — **one new substrate primitive unlocked the whole runtime
contract** — is the maturity signal: the operating system grew, the employees did not.

---

*Documentation only. No code, schema, configuration, or git history was changed by this
record. Instituted under CEO Directive #011 (Master Roadmap D-01); inaugurated with the
CEO Directive #012 (D-02) entry; extended with the CEO Directive #013 (D-03) entry.*
