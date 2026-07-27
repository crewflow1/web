# CrewFlow — Directive #013 Completion Report (The RunContext Runtime Contract)

> **Status:** Governance **record** — the permanent engineering record of a
> completed directive. Directive **#013** (Master Roadmap **D-03**), *The RunContext
> Runtime Contract*, is **architecturally complete**: the implementation and its
> tests, plus the governance reconciliation, are merged into the integration branch
> work of `directive/013-runcontext-contract` and delivered as **PR #206** (base
> `directive/011-governance-reconciliation`), every gate green. RunContext —
> **frozen contract #4** — has graduated **Partial → Established**. This report
> records what was built, what was deliberately left, and what the platform learned,
> written so any engineer or AI employee can pick the work up cold.
>
> **Scope of "complete":** the frozen `RunContext` shape, its three standing
> principles, the one new cancellation entry point, the settled canonical runtime
> identity, and the documentation reconciliation are all on the **PR #206 branch**,
> reviewed and approved by the CEO. The **cutover to `main` and the production
> migration are a separate, CEO-gated step** (see §2, §8). "Architecturally
> complete" is not "in production". Issued under CEO Directive **#013** (D-03);
> authority is [ADR 0007](../decisions/0007-runcontext-runtime-contract.md).

---

## 0. The directive in one paragraph

Before #013, the value every AI employee's handler receives at runtime — `RunContext` —
existed only in **minimal** form (`{ task, identity, memory, tasks, correlationId,
budgetMicros }`) and as comments of intent; it carried no deadline, no stop-signal, no
resolved authority, its identity slug was optional, and there was **no way to cancel a
running task**. Directive #013 **graduated** that value into a frozen kernel contract:
the single, immutable, infrastructure-free envelope `{ task, identity, memory, tasks,
correlationId, budget, deadline, signal, capabilities }` that the Task Engine runner
assembles once per claim and hands to a handler as its **sole** argument. The graduation
was overwhelmingly a **binding** exercise, not a building one — the Generic Task Engine
(#012) had already reserved every seam #013 needed as an inert column, so the entire net
new substrate is **one `SECURITY DEFINER` function** (`hq_ai_task_cancel`), **zero** new
columns, **zero** enum changes. Identity was settled in the same stroke: the canonical
slug per employee is the one the spine already stamps, so the settlement is a **no-op on
the append-only history**. The architectural promise — *employee #42 inherits exactly the
same runtime contract as employee #3* — is now made load-bearing at runtime by the type
system, the frozen envelope, and the test suite, not by discipline.

---

## 1. Objectives achieved

All objectives the CEO approved in ADR 0007 and the PR #206 review are on the branch and
verified.

| # | Objective | How it was met | Evidence |
|---|-----------|----------------|----------|
| 1 | **Freeze the `RunContext` shape** (ADR Decision 1) | The minimal six-field slice graduated by **addition** to the frozen nine-field envelope; the assembled object is `Object.freeze`-d at claim time so every field is reference-stable for the invocation | `server/sdk/tasks.ts` (`RunContext`, `buildContext`); contract-shape tests in `__tests__/integration/tasks/task-runner-sdk.test.ts` |
| 2 | **Execution state is OS-owned, RunContext-exposed, handler-consumed** (Decision 2) | A positive standing principle: the engine owns cancellation, deadlines, budget, leases, retries; `ctx` is a read-only window; a handler cannot extend its deadline, lift its budget, clear its cancellation, renew its lease, or schedule its retry | ADR 0007 Decision 2; `BoundTasks` exposes **create + checkpoint only** (no complete/fail) — `__tests__/security/task-runner-sdk.test.ts` |
| 3 | **RunContext is immutable per invocation** (Decision 3) | `identity`, `correlationId`, `deadline`, `budget`, `signal` are value-stable for the run; the one carve-out is the **signal latch** — `signal.aborted` flips `false → true` exactly once and never back | `Object.freeze`d context; immutability + one-way-latch tests |
| 4 | **The SDK is the only door; no infrastructure on `ctx`** (Decision 4) | No Supabase/db/transport client, raw service handle, or SQL string is reachable from `ctx` or any facet; the service layer never names `.from('hq_ai_tasks')` — it touches the queue **only** through the eight `SECURITY DEFINER` RPCs | `__tests__/security/task-runner-sdk.test.ts` (RPC-only; no raw table write) |
| 5 | **Settle canonical runtime identity** (Decision 5) | Canonical slug = the slug **already stamped** as `actor_id`; the proven three-way split resolves to **`lead-qualification`**; `RunnerIdentity → EmployeeIdentity` with a **non-optional canonical `slug`** | `server/sdk/tasks.ts` (`EmployeeIdentity`); `QUALIFICATION_AI_SLUG="lead-qualification"`, `RESEARCH_AI_SLUG="research-ai"`; [`runtime-identity.md`](./runtime-identity.md) §7 |
| 6 | **Cooperative cancellation + deadlines as `ctx.signal`** (Decision 6) | An **eighth** entry point `hq_ai_task_cancel` performs the already-defined `pending\|running → cancelled` guard transition **and clears the lease**; the existing heartbeat then matches zero rows → `alive:false` → the runner aborts `ctx.signal`. Deadlines compose into the same signal | `supabase/migrations/20260805000000_hq_ai_task_cancel.sql`; live cancellation proof in `task-runner-sdk.test.ts` |
| 7 | **Thread a resolved, opaque capability set** (Decision 7) | `ctx.capabilities: ResolvedCapabilitySet` (`{ tokens, source }`) carried read-only; **#013 threads it, #014 enforces, #015 sources** — the contract is source-indifferent | `server/sdk/tasks.ts` (`ResolvedCapabilitySet`, `EMPTY_CAPABILITIES`) |
| 8 | **Budget is a read-only ceiling named `ctx.budget`** (Decision 8) | `budgetMicros → budget`, a read-only micros ceiling that binds `cost_budget_micros`; #013 makes the limit **visible**, it does not count spend | `server/sdk/tasks.ts` (`budget: number`); passthrough test (`budget` reflects `cost_budget_micros`, never mutated) |
| 9 | **One registered `task.cancelled` verb** | The cancel function emits exactly one `task.cancelled` (warn, with `prev_status`) through the shared `hq_ai_task_emit` helper — never a raw `hq_events` write; the verb is registered so the DB cannot drift from TypeScript | `lib/events/registry.ts` (TASK group 5→6, VERBS 77→78); `__tests__/security/task-cancel.test.ts` |
| 10 | **Migration footprint: one function, zero columns, zero enums** (Decision 10) | The cancel migration is purely additive — one `SECURITY DEFINER` function, no table/type/alter/drop, no guard edit, no other entry point redefined | `__tests__/security/task-cancel.test.ts` (additivity + lockdown invariants) |

**Net result:** RunContext meets the Architecture Freeze bar for a *protected kernel
contract* and graduates **Partial → Established**. Three standing architectural
principles were ratified (Decisions 2–4) that bind **every** facet the SDK adds in #014
and the registry in #015.

---

## 2. Objectives intentionally deferred

Nothing below blocks the directive's architectural completion; each is a bounded,
explicitly-deferred follow-up (ADR 0007 Decision 9), named so it is not improvised later.

1. **To #014 (AI SDK Envelope).** The `comms` / `events` / `tools` / `api` facets; the
   standard output envelope and its evidence-drain hook; **cost metering** (`cost_micros`)
   and the **API gateway** that refuses a call which would bust budget; `ctx.tools.invoke`
   (permission-check + meter + audit at invocation); the optional `inbound?` facet; and the
   **enforcement predicate** that reads #013's resolved `capabilities` set. #013 threads the
   set; #014 enforces it.
2. **To #015 (Capability Registry).** The single declarative registry + resolver
   consolidating the four scattered registration surfaces; the authoring surface; making
   `required_capability` **enforceable against a real registry**. #013's `capabilities` is
   sourced from the `ai_employees` columns today, opaquely, precisely so the contract does
   **not** depend on the registry.
3. **To their own directives — the remaining Task-Engine seams.** DAG (`depends_on`),
   the approval lifecycle, and verification stay reserved inert seams; the first
   implementation of each goes through its own ADR + review, not ad hoc.
4. **Identity history is frozen, not re-stamped (= no employee migration).** Choosing the
   already-stamped slug as canonical means **zero** historical `actor_id`s change. Of the 14
   seeded rows, `lead-qualification` was the lone three-way split, `design-ai` stays
   **Reserved** (neither adopted nor deprecated), and the other twelve were already
   consistent — so nothing needs re-stamping. This was explicitly CEO-ratified.
5. **Doc-only prose alignment (outside #013's footprint).** The employee spec
   (`workforce/employees/14-qualification-ai.md`, slug `qualification-ai`) and the SDK volume
   (`substrate/volume-13-ai-sdk.md`, `lead-qualification-ai`) still spell the divergent
   names. Aligning their **prose** to the canonical `lead-qualification` touches no code,
   seed, event, or migration; it is housekeeping, deliberately left out of #013's minimal
   footprint.

---

## 3. Architectural decisions

The full record is [ADR 0007](../decisions/0007-runcontext-runtime-contract.md) (ten
decisions, accepted ahead of implementation under the strictest reading of the
document-before-you-build rule). The load-bearing ones:

- **Binding, not building.** Because #012 reserved every data seam as an inert column
  (`correlation_id`, `cost_budget_micros`, `deadline_at`, `required_capability`, and the
  `cancelled` status with its guard transition), #013's job shrank to *freezing a shape* and
  *activating columns the platform already owns*. The only schema change is one function.
- **The three CTO amendments became standing principles, not footnotes** (Decisions 2–4):
  (a) **Ownership** — the OS owns execution state; RunContext exposes it; handlers consume
  it and **never own or mutate** it. (b) **Immutability** — the context is value-stable for
  one invocation, with a single designed carve-out: the monotonic signal latch. (c) **No
  infrastructure exposure** — the SDK is the *only* interface between an employee and the OS;
  no client, service, or SQL is reachable from `ctx`. These bind every future facet.
- **Cancellation is an *engine* capability, not a context one** (Decision 6). The new entry
  point belongs to the Task Engine; RunContext merely **exposes its effect** as `ctx.signal`.
  Cancellation is **cooperative** — there is **no hard-kill** (you cannot safely kill
  arbitrary JavaScript mid-statement); a handler that ignores the signal is still bounded by
  the lease + reaper, so there is no regression.
- **Canonical identity = the stamped slug** (Decision 5). The value the append-only spine
  already carries wins; the spec slug and SDK-volume identity reconcile *to it*. This is what
  makes "settle identity" a no-op on history — **alias or freeze over re-stamp**.
- **Capability source-indifference** (Decision 7). The resolved set is opaque and read-only;
  the contract carries it without defining a predicate, enforcing, or authoring the source —
  the clean split that lets #013 land before #014 and #015.

---

## 4. Runtime contract summary

The frozen `RunContext` envelope every employee inherits, as built
(`server/sdk/tasks.ts`):

| Field | Type | Owned by | RunContext role |
|---|---|---|---|
| `task` | `TaskRow` | the engine (leased row) | carries the claimed task |
| `identity` | `EmployeeIdentity` | the identity store | carries the **resolved canonical** identity (`slug` non-optional) |
| `memory` | `BoundMemory` | Shared Memory (#009) | carries the built facet (unchanged) |
| `tasks` | `BoundTasks` | the engine | carries **create + checkpoint only** (never complete/fail) |
| `correlationId` | `string` | the engine (set at enqueue) | exposes (read-only); `=== task.correlation_id` |
| `budget` | `number` | the engine (`cost_budget_micros`) | **exposes** a read-only micros ceiling (never a meter) |
| `deadline` | `Date \| null` | the engine (`deadline_at`) | **exposes** the hard deadline |
| `signal` | `AbortSignal` | the engine (cancel ∪ deadline) | **exposes** the cooperative stop-signal |
| `capabilities` | `ResolvedCapabilitySet` | the registry (#015, today `ai_employees`) | carries an **opaque, read-only** resolved set |

**Invariants (frozen here, enforced by tests):**

- The whole object is `Object.freeze`-d; `identity`, `correlationId`, `deadline`, `budget`,
  `signal` are reference-stable for the invocation.
- `ctx.signal` is immutable by reference; its `aborted` flag is a **one-way latch** (the
  single designed mutation, and the cooperative-cancellation mechanism itself).
- **Cooperative-cancel seam (no new polling query):** `hq_ai_task_cancel` sets
  `pending|running → cancelled` **and** `lease_owner = null`; the *existing* heartbeat
  (`status='running' AND lease_owner = p_lease_owner`) then matches zero rows → returns
  `alive:false` → the runner aborts `ctx.signal` with `DOMException(…, "AbortError")`.
- **Deadline composes into the same signal:** a future `deadline_at` arms one per-run timer
  that aborts with `DOMException(…, "TimeoutError")`; an **already-past** deadline aborts
  **before** the handler runs. `signal = cancel ∪ deadline`.
- The handler signature is `(ctx: RunContext) => Promise<…>` — **`ctx` is the only
  argument**; there is no actor parameter a caller could spoof (the runner mints its own
  opaque lease owner per invocation).

---

## 5. Implementation summary

Delivered as **PR #206** (`directive/013-runcontext-contract` → base
`directive/011-governance-reconciliation`), **2 commits**, **14 files**, **+1053 / −112**.

**Commit `136437a`** — *implementation + tests* (12 files):

| File | Δ | What changed |
|---|---|---|
| `supabase/migrations/20260805000000_hq_ai_task_cancel.sql` | +148 / −0 | The **one** new function — `hq_ai_task_cancel` (`SECURITY DEFINER`, empty `search_path`, service-role-only EXECUTE; args `p_task_id, p_reason, p_actor_type, p_actor_id`, **no `p_lease_owner`**); cancels by id + cancellable status, clears the lease, emits one `task.cancelled` via `hq_ai_task_emit` |
| `server/sdk/tasks.ts` | +214 / −41 | Graduated `RunContext` by addition (`deadline`, `signal`, `capabilities`); `Object.freeze` the context; `budgetMicros → budget`; `RunnerIdentity → EmployeeIdentity` (canonical `slug`); `ResolvedCapabilitySet`; deadline→signal timer; standalone `cancelTask` |
| `server/services/hq-tasks.ts` | +49 / −4 | `cancelTask` service wrapper over `hq_ai_task_cancel` (the 8th RPC); `CancelTaskOptions` with a loose `actorType?: string` boundary (the spine CHECK is the single validator) |
| `server/services/hq-qualification.ts` | +21 / −9 | `qualificationIdentity()` returns `EmployeeIdentity` with `slug: QUALIFICATION_AI_SLUG = "lead-qualification"` |
| `server/services/hq-research.ts` | +22 / −10 | Research identity built with `slug: RESEARCH_AI_SLUG = "research-ai"` |
| `lib/events/registry.ts` | +9 / −4 | TASK verb group 5 → 6 (`task.cancelled`); VERBS 77 → 78 |
| 6 test files | +529 / −27 | `task-cancel.test.ts` (new, +200, full static-SQL lockdown); `task-runner-sdk` security + integration; `task-engine-spine`; `tasks-sdk`; `event-registry` |

**Commit `fe2b5fa`** — *governance reconciliation* (2 files):

| File | Δ | What changed |
|---|---|---|
| `docs/bible/governance/runtime-identity.md` | +60 / −16 | New **§7 Resolution** — records the settled canonical decision (stamped slug wins; `lead-qualification` canonical; history frozen; forward rule = three layers agree); §§1–6 preserved as the historical record. **CEO-ratified.** |
| `docs/crewflow-v1.0-constitution.md` | +1 / −1 | §4 identity-reconciliation rule re-pointed from "deferred to D-04 / #014" to "settled by D-03 / #013" |

**Net new substrate:** one `SECURITY DEFINER` function. No new columns, no enum changes,
no guard-trigger edits, no second queue, no new SDK module — the binding-not-building thesis
made concrete.

---

## 6. Validation summary

All gates green; the figures below were re-verified on the release branch while preparing
this report.

| Gate | Result |
|---|---|
| **Typecheck** (`tsc --noEmit`) | **clean** (exit 0) |
| **Lint** | **0 errors** (3 pre-existing warnings, unrelated to #013) |
| **Unit** (`vitest`, default config) | **138 files / 2660 tests** passing |
| **Security** (`vitest.security.config.ts`) | **36 files / 804 tests** passing |
| **Integration — tasks** (live local Postgres) | **4 files / 43 tests** passing, incl. the cooperative-cancellation proof |
| **Integration — full suite** (this cycle) | **26 files / 170 tests** passing against live Postgres |
| **Production build** (`next build`) | **success** |

**The heaviest #013 coverage — cooperative cancellation — is proven against a live
database, not just source.** The integration case *"cancelTask from OUTSIDE aborts the
running handler's signal (AbortError); the row is cancelled + one `task.cancelled`
event"* exercises the real lease → clear → heartbeat-misses → abort timing end to end
(~1.0s wall). The static-SQL security tier (`task-cancel.test.ts`) independently pins the
migration's additivity and lockdown (SECURITY DEFINER, empty `search_path`,
service-role-only EXECUTE, no `p_lease_owner`, exactly one registered `task.cancelled`
verb, no raw `hq_events` write). The two tiers are complementary and both are required.

---

## 7. Technical debt

Tracked honestly; none of it is load-bearing on the platform's correctness.

- **Spec / SDK-volume prose drift (intentional, doc-only).** `workforce/employees/14-…md`
  still names `qualification-ai`; `substrate/volume-13-ai-sdk.md` names
  `lead-qualification-ai`. They are now the *divergent* layer against the canonical rule;
  aligning the prose to `lead-qualification` is housekeeping outside #013's footprint
  ([`runtime-identity.md`](./runtime-identity.md) §7).
- **`budget` is a bare micros integer, not a `Budget` value object.** ADR Decision 8 froze
  the **name** and the **read-only semantics** but left the representation to the PR; the
  bare `number` is the minimal correct choice. If #014's metering wants `.micros` + spend on
  one value, it can promote the type **behind the frozen `ctx.budget` name**.
- **`capabilities` is sourced from `ai_employees` columns, not a registry.** The resolver is
  a deliberate placeholder (opaque set, `source: "ai_employees" | "registry" | "none"`)
  until #015 sources it. By design — but until then the set reflects scattered columns, not a
  single declarative authority.
- **`as never` cast shim** to read the service-role-only `hq_ai_tasks` table (inherited from
  #012, not introduced here). The house idiom for "read the generic queue"; a generated-types
  pass removes it.
- **Deadline timer 32-bit horizon.** A `deadline_at` beyond the `setTimeout` ceiling
  (~24.8 days) gets no per-run timer; `ctx.deadline` still exposes the true value and the
  lease + reaper bound the run long before then. An honest edge, not load-bearing.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **A handler ignores `ctx.signal`** and runs to lease expiry | Medium | Low | By design — cooperative cancel has no safe hard-kill; the lease + reaper bound the run; the integration suite pins the no-regression case (an ignoring handler is still reaped) |
| **"Budget visible" mistaken for "budget enforced"** | Medium | Medium | `ctx.budget` is documented as a read-only **ceiling, never a meter**; metering + the gateway are #014. Until then nothing stops an employee busting the ceiling — this is the single most important #014 follow-up |
| **Prod migration ledger lag (inherited)** — `hq_ai_task_cancel` is not on prod | Medium | High if unreviewed | Apply at cutover as **one CEO-reviewed push** on a maintenance window, never auto-applied; dry-run on a branch DB first |
| **Branch stacking** — #013 sits on the `#011` integration branch, not `main` | Low–Med | Medium | Cutover `#011 → main` promptly; the merges are clean today |
| **Identity freeze assumes the stamped slug is correct for all 14 seeded rows** | Low | Medium | Verified at N=14 (one split, one Reserved, twelve already consistent); new employees must resolve identity through `EmployeeIdentity` to stay aligned — the forward rule is now the contract |
| **Future facet widens the kernel's ownership rules** | Low | High | Decisions 2–4 are standing principles, enforced by the type surface + security tests; any change to them requires an ADR + architectural review (Freeze §2) |

No **high-likelihood** risk remains open. The dominant residual risk is operational (the
gated production cutover), not architectural.

---

## 9. Future recommendations for Directive #014

1. **Build the SDK-envelope facets (`comms` / `events` / `tools` / `api`) over the frozen
   RunContext by *addition only*.** Never widen the kernel's ownership rules — the three
   standing principles (OS owns execution state, context immutable per invocation, SDK the
   only door) bind every facet #014 adds.
2. **Implement cost metering and the API gateway that *enforces* the `budget` ceiling #013
   made visible.** This is the highest-value follow-up — #013 makes the limit legible; #014
   must make it binding. Consider promoting `budget: number` to a read-only `Budget` value
   object behind the unchanged `ctx.budget` name.
3. **Implement `ctx.tools.invoke` as permission-check + meter + audit at invocation,**
   reading #013's resolved `ctx.capabilities` set as the predicate input. #013 threaded the
   set precisely so #014 can enforce against it without re-plumbing.
4. **Do not source capabilities in #014.** Sourcing is #015's job; #014 only *enforces*
   against #013's threaded set. Keeping that split intact is what preserved the clean
   dependency order.
5. **Add the `comms` / `events` / `tools` / `api` facets and the output envelope under one
   coherent employee SDK,** so `RunContext`, memory, and tasks present a single surface — but
   keep `ctx` infrastructure-free: no client or raw service may become reachable.
6. **Run the spec + SDK-volume prose alignment to `lead-qualification` as a doc-only
   housekeeping pass** before #014 starts relying on identity, so the three layers agree in
   words as well as in code.

---

## 10. Lessons learned

1. **Reserving inert seams a directive early turns the next directive into a binding
   exercise.** #012's foresight (`correlation_id`, `cost_budget_micros`, `deadline_at`,
   `required_capability`, the `cancelled` status + its guard transition) is the entire reason
   #013's schema delta was **one function**. Designing the seam before the feature pays off
   directly and measurably.
2. **A positive ownership rule beats a neutral prohibition.** The CTO amendment turned "the
   context does not drive terminal transitions" into "the OS *owns* execution state; handlers
   *consume*, never own or mutate" — stronger, more testable, and it binds every future
   facet rather than just the present one.
3. **Compose with an existing mechanism instead of adding a parallel one.** Cooperative
   cancellation reused the existing heartbeat — clear the lease, the next heartbeat matches
   zero rows, the runner aborts — adding **zero** new polling queries. The cheapest cancel is
   the one that rides machinery you already have.
4. **Pick the value the data already carries.** Choosing the already-stamped slug as
   canonical made "settle identity" a no-op on the append-only spine. The lowest-blast-radius
   decision was also the correct one — alias or freeze over re-stamp.
5. **Writing the ADR before any code caught the amendments at design time.** The strictest
   document-before-you-build reading surfaced the three principles when they were cheap to
   encode, not in review of a diff where they would have been expensive to retrofit.
6. **Separate the historical record from the forward resolution.** Preserving
   runtime-identity.md §§1–6 as the original record and adding §7 as the resolution kept the
   audit trail intact while updating governance — a distinction the CEO ratified explicitly:
   *"The historical record must remain intact. Only the forward-looking governance has been
   updated."*
7. **A loose boundary type that delegates to the database CHECK is correct, not sloppy.** An
   invalid test fixture (`actor_type='operator'`) surfaced that "operator" is not a
   registered actor type; the fix was **test-only** because the production boundary
   (`actorType?: string` → the spine CHECK as the single validator) was already right. The
   one validator, at the data layer, did its job.

---

*Governance record under CEO Directive #013 (Master Roadmap D-03). Documentation only —
this report changes no code, schema, or configuration. It records a completed directive
for the permanent engineering canon. Authority: [ADR
0007](../decisions/0007-runcontext-runtime-contract.md); canonical numbering:
[`numbering.md`](./numbering.md); the settled identity ledger:
[`runtime-identity.md`](./runtime-identity.md) §7; the capabilities every employee
inherits: [`../workforce/platform-compatibility-matrix.md`](../workforce/platform-compatibility-matrix.md).
RunContext is a protected kernel contract of the CrewFlow Operating System.*
