# Lead Qualification AI — engineering reference (CEO Directive 003, Module 3)

Lead Qualification AI is **the decision-maker of the sales pipeline**. Once
Company Research AI (`docs/research-ai.md`, Module 2) has scored a company and
left it at `status = 'new'`, Lead Qualification AI reads the persisted
signals — the AI fit score, how much of the intelligence profile is enriched,
registered territory, construction sector, and decision-maker reach — and
returns **one explainable verdict**: `qualified`, `disqualified`, or
needs-`review`. When the company is still `new` it moves it along the existing
pipeline (qualified or disqualified) and holds anything uncertain at `new` for a
human.

It is an **HQ-only** feature: nothing here touches the customer product,
customer workflows, or any tenant table.

> **Autonomous, but bounded — and deterministic.** Research AI is **read +
> draft only**: it drafts outbound artifacts a human must approve before
> sending (`requires_approval = true`). Lead Qualification AI deliberately
> diverges on **both** axes, and the safety story changes to match:
>
> 1. **It acts without an approval gate** (`requires_approval = false`).
>    Making the qualify/disqualify call autonomously *is* the module — an
>    approval gate would defeat it. That is safe only because its one action is
>    an **internal, reversible classification**: it moves a lead OUT of `new` to
>    exactly one of two qualification statuses, or holds it at `new`. It **never**
>    contacts a prospect, never sends, never drafts outreach, never deletes, and
>    never moves money. The autonomy is bounded **in code** (only
>    `new → qualified | disqualified`; `review` holds; it never skips into
>    outreach), not by a label — and that boundary is pinned in the security tier.
> 2. **It is deterministic — there is no model in the path.** A qualify/disqualify
>    verdict gates a company's place in the pipeline, so the directive's "no black
>    box" bar means it must be **reconstructable from named rules and thresholds**,
>    never an opaque model sample. `model_provider` / `model_name` are NULL: this
>    employee has no model because it uses none. The rubric
>    (`lib/qualification/criteria.ts`) is the whole arbiter.
>
> And like Research AI it **never invents** — a criterion with no evidence is
> listed honestly as Unknown and excluded from confidence, never silently scored.

Lead Qualification AI ships in **one purely-additive migration**
(`20260721000000_lead_qualification_employee.sql`) that creates **no new table**:
it inserts a single `public.ai_employees` row (the thirteenth boardroom member),
plus two existing-lookup rows (a `qualify_company` task type and an
`ai_qualification` timeline source), and reuses the entire Directive-004
`hq_sales_*` family wholesale. The whole execution engine lives in code.

---

## Layers

A clean, mostly-pure stack. The two `lib/qualification/*` layers are
server/client-safe (no Supabase, no `server-only`), so the runner, the UI, and
the tests share one vocabulary, and the pure decision logic is exhaustively
unit-tested without a database. Only the runner and the HTTP/action surface are
`server-only`.

| Layer | File | Responsibility |
|---|---|---|
| **Model** | `lib/qualification/model.ts` | Pure lifecycle + contracts. The phase machine (`QualificationPhase`) and step checklist (`QualificationStepKey` + `QUALIFICATION_STEP_DEFS`, each bound to its timeline `event_type`), the verdict contracts (`QualificationVerdict`, `QualificationCriterion`, `QualificationDecision`), `QualificationRunState` / `QualificationRunSummary`, pure reducers (`applyStep`, `initialSteps`, `phaseProgress`, `completedStepCount`), and **`recommendedStatusFor`** — the function that maps a decision to its one legal transition target. |
| **Rubric** | `lib/qualification/criteria.ts` | Pure, **deterministic** decision engine. `qualifyCompany(input)` is the whole arbiter: `territoryOf` / `sectorOf` classification, the five weighted criteria builders, the decision rule, and the named thresholds (`QUALIFY_THRESHOLD` 60, `DISQUALIFY_FLOOR` 30, `EVIDENCE_FLOOR` 25). No I/O, no clock, no RNG — the same inputs always decide the same. |
| **Runner** | `server/services/hq-qualification.ts` | `server-only`, service-role. The orchestrator. Owns **no tables**: it claims a `qualify_company` task off `hq_sales_ai_tasks`, drives the lifecycle, checkpoints the task `result` jsonb after every step, mirrors each step to the company timeline, records the verdict, and (only when still `new`) transitions the company through the existing `setCompanyStatus` writer. |
| **HTTP** | `app/api/admin/qualification/{run,state}` + `app/api/cron/qualification-drain` | The run kicker (POST, claims + drives a task), the state poller (GET, reads the checkpointed `result`), and the cron drain (GET, the never-lose-a-task safety net). |
| **Actions** | `app/admin/qualification/actions.ts` | `"use server"`. Two launcher entry points: `requireAdmin()` → `startQualification()` → `recordAdminActivity()` → `redirect()` to the live run. They enqueue and route; they never run the rubric inline. |
| **UI** | `app/admin/qualification/**` | Server components. The section home + launcher (`page.tsx`, `_launcher.tsx`), and the live run view (`[taskId]/page.tsx`, `_live.tsx`, `_report.tsx`) that animates the checklist by polling the state endpoint, then renders the finished verdict. Styling in `_styles.ts`, primitives in `_components.tsx`. |

Each layer imports only from the layer below it. The runner is the only layer
that knows about Supabase; the two `lib/qualification/*` layers know nothing
about the network or the database — which is exactly why the verdict is
reconstructable and testable without one.

---

## The lifecycle

A coarse, operator-legible **phase** machine plus a fine-grained **step**
checklist so the live view can animate the engine deciding. Both are persisted
in `hq_sales_ai_tasks.result` (jsonb) and polled (~1.2s) — there is no websocket.

### Phases (`QualificationPhase`)

```
queued → running → assessing → deciding → completed
                                        ↘ failed
```

`phaseProgress()` maps each to a monotonic 0–1 value so the progress bar only
ever advances. `completed` and `failed` are terminal. The run is deterministic
and DB-only, so it finishes fast.

### Steps (`QUALIFICATION_STEP_DEFS`)

Five steps, each bound to a phase and to the
`hq_sales_timeline_events.event_type` it is logged under, so the live checklist
and the **permanent** company timeline are written from one definition:

| Step | Phase | Timeline event |
|---|---|---|
| Lead loaded | running | `task_started` |
| Signals gathered | assessing | `system` |
| Criteria evaluated | assessing | `system` |
| Decision recorded | deciding | `scored` |
| Task completed | completed | `task_completed` |

### What each phase does — `runQualificationTask(taskId)`

1. **Claim.** `claimTask` is a **conditional update**: `status → running` only
   succeeds while the row is still `pending`. A double-kick (browser retry *and*
   the cron drain) is therefore harmless — the loser returns a `skipped`
   outcome. This is the whole idempotency guarantee.
2. **Running — load.** Loads the company row (and its contacts) through the
   existing `getCompany` reader; a missing company fails the task honestly.
3. **Assessing — gather + evaluate.** Builds the flat `QualificationInput` from
   the persisted score, `intelligenceCompleteness`, country/location, sector/
   industry, and the contact roll-up, then calls `qualifyCompany` — the
   deterministic rubric. The criteria evaluation is mirrored to the timeline as
   a `system` event carrying the per-criterion evidence.
4. **Deciding — record + transition.** The verdict lands as a **`scored`**
   timeline event (reusing the existing vocabulary; the engine adds no new event
   type), attributed via the `ai_qualification` source + the employee id. **Only
   when `company.status === 'new'` and the decision recommends a terminal status**
   does it call `setCompanyStatus(companyId, verdict.recommendedStatus, actor)` —
   which writes its own `status_change` event and no-ops if the status already
   moved under it. A `review` verdict recommends nothing, so nothing moves.
5. **Completed.** A `QualificationRunSummary` is folded in, the task is stamped
   `completed` + `finished_at`, and a `task_completed` timeline event lands.

Every step calls `checkpoint()` to rewrite the `result` jsonb, so a cold task is
**resumable** and the poller always sees the latest state. Any throw flips the
task to `failed`, records `error_message`, and logs a `task_failed` event — the
run never half-writes silently.

---

## The deterministic rubric — `qualifyCompany`

The whole arbiter, in one pure function. It builds five weighted criteria
(weights sum to **1.0**), computes a confidence (the share of total weight that
was actually evidenced), then applies one decision rule.

| Criterion | Weight | Role |
|---|---|---|
| Fit score | 0.45 | **The arbiter.** The Research AI `ai_qualification_score`. |
| Territory | 0.20 | **The only hard gate.** A confident overseas read disqualifies regardless of fit. |
| Evidence depth | 0.15 | A **guard**, never an arbiter — a strong score on a thin profile is held for review. |
| Sector | 0.10 | Informational — shapes confidence + rationale, never overrides the score. |
| Decision-maker access | 0.10 | Informational — observable even at zero. |

**The decision rule** (in priority order):

1. **Territory hard gate.** `territory === 'overseas'` (a structured, non-empty,
   non-UK country) → **disqualified**, regardless of fit. An *unknown* territory
   never hard-fails — it only lowers confidence.
2. **No score** → **review** (research the company first).
3. **Score ≥ `QUALIFY_THRESHOLD` (60)** → **qualified**, *unless* evidence is
   below `EVIDENCE_FLOOR` (25%), in which case **review** (strong score, thin
   profile — verify first).
4. **Score < `DISQUALIFY_FLOOR` (30)** → **disqualified**.
5. **Anything in between** → **review** (a human should decide).

`recommendedStatusFor(decision)` then maps the verdict to its **one legal
transition target**, typed as `RecommendedStatus = "qualified" | "disqualified"
| null`: qualified → `'qualified'`, disqualified → `'disqualified'`, review →
`null` (hold). This type is the structural proof that the autonomy can *only
ever* land on a qualification status — the runner physically cannot route a lead
into outreach or beyond by following the rubric.

Honesty rules baked in: an **unevidenced criterion is still listed** (so the
operator sees the gap) but marked `known: false` and **excluded from
confidence**; the verdict carries an ordered, plain-English **rationale** (the
decisive rule first, then supporting signals) so it is fully reconstructable.

---

## The migration — one employee, no new surface

`supabase/migrations/20260721000000_lead_qualification_employee.sql` is purely
additive and idempotent. It seeds exactly three existing-lookup rows:

- **`hq_sales_sources` + `'ai_qualification'`** — honest timeline provenance, so
  qualification events are NOT mislabelled as `'ai_research'`. A new provenance
  *channel* is a lookup row (data), not a schema change.
- **`hq_sales_task_types` + `'qualify_company'`** — the kind of work the runner
  claims (the FK target of `hq_sales_ai_tasks.task_type`).
- **`ai_employees` + `'lead-qualification'`** (`sort_order` 36), with
  `model_provider` / `model_name` **NULL** (deterministic — no model),
  `tools_allowed` = load / gather / evaluate / decide / transition, and the
  **permission grant** that is the bounded-autonomy contract, pinned in the
  security tier: `{"can_execute": true, "requires_approval": false, "scopes":
  ["read","score","qualify"]}`. The scope set structurally excludes `send`,
  `draft`, `delete`, and `memory`.

**No `create table`, no `create policy`, no `security definer`, no dynamic SQL.**
It adds *work*, not a new data surface or an escalation path. Every insert is
**`on conflict (slug) do nothing`** — re-running never clobbers operator edits.

---

## Security model

A qualify/disqualify verdict gates a company's place in the pipeline, and the
module acts **without a human approval gate**, so its trust boundary is the most
load-bearing the programme has shipped. Defence in depth, every layer
independent:

- **Bounded autonomy (the headline invariant).** With no approval gate, the
  safety story is "the autonomy is bounded in code". Pinned in the security
  tier: the scope set is exactly `["read","score","qualify"]` and structurally
  excludes `send` / `draft` / `delete` / `memory` / `write`; the one autonomous
  write is **guarded by `company.status === 'new'`** and targets **only**
  `verdict.recommendedStatus` (typed `qualified | disqualified | null`), never a
  hardcoded forward jump into `outreach_ready` / `contacted` / `won` / …; and
  the runner **never** sends, deletes, or moves money.
- **Determinism (no black box).** The migration wires **no model** (NULL
  provider; no `anthropic` / `openai` anywhere in the migration or the runner),
  and the rubric is a **pure** module with **no clock and no RNG** in the
  decision. The same inputs always produce the same verdict — pinned against
  source text so a model can never quietly creep into the path.
- **Route gate (the single chokepoint).** Every `/admin/qualification/**` page
  is a child of `app/admin/layout.tsx`, which runs `requireHqPage()`
  (`requireUser()` + `isSuperAdminEmail()` → `notFound()`). The gate answers
  **404, not 403** — a 403 would announce the surface's existence.
- **Action gate (defence in depth).** Both launcher actions independently call
  `requireAdmin()`, which re-runs `requireUser()` and redirects a
  non-super-admin **before** any enqueue.
- **API gate.** The run + state routes authenticate via `requireUser()` and
  reduce to the `isSuperAdminEmail` allowlist, answering **404** (never 403) for
  a non-allowlisted caller, and **400** on a `taskId` that fails `UUID_RE` before
  any DB use.
- **Cron gate.** The drain requires the bearer `CRON_SECRET`
  (`isCronAuthorised(request)`) and answers **401** otherwise. Bounded (≤ 5,
  default 3) so one invocation can never run away.
- **Database gate.** The runner reaches the DB only through `createAdminClient()`
  (service-role); the `hq_sales_*` family is RLS-on / zero-policy. The runner
  **never reads a tenant CRM table** (`organizations`, `customers`, `leads`,
  `jobs`, `quotes`, `invoices`) and **never touches the spine truth log**
  (`hq_events`) — qualification has its own timeline.
- **Traceability.** The verdict carries the `ai_qualification` source + the Lead
  Qualification AI `ai_employee_id`; every step is a timeline row; every launch
  is an `admin_activity_log` entry (`qualification.start`).

---

## Pages & routes

All UI under `/admin/qualification` (super-admin only):

| Route | What it does |
|---|---|
| `/admin/qualification` | Section home — the launcher (qualify an existing, ideally-researched company), live outcome metrics (qualified / disqualified / needs-review / transitioned / in-flight / avg confidence), a one-click candidate list of `new` leads, and recent verdicts. |
| `/admin/qualification/[taskId]` | The **live run view** — kicks the worker on mount, polls `state/[taskId]` (~1.2s) to animate the phase + step checklist, then renders the finished verdict: the dial, the five weighted criteria laid bare, the ordered rationale, and the pipeline outcome. |

HTTP surface:

| Endpoint | Method | Gate | Notes |
|---|---|---|---|
| `/api/admin/qualification/run` | POST | super-admin → 404 on miss | Claims + drives a task to completion; `maxDuration = 30`; 400 on a non-UUID `taskId`. Fire-and-forget safe (idempotent claim). |
| `/api/admin/qualification/state/[taskId]` | GET | super-admin → 404 on miss | Reads the checkpointed `result` jsonb; one indexed row read; always JSON. |
| `/api/cron/qualification-drain` | GET | `CRON_SECRET` → 401 | The never-lose-a-task net: runs tasks enqueued but never kicked, and re-queues anything stuck in `running` past the 5-minute dead-worker threshold. Bounded per call. |

---

## Testing — the six-gate bar

| Gate | Suite | Proves |
|---|---|---|
| **3 · unit** | `__tests__/qualification/{model,criteria}.test.ts` (34 tests) | The pure layers in isolation — lifecycle reducers + phase/step maths, and the rubric: every branch of the decision rule, the territory hard gate, the evidence guard, weights summing to 1.0, confidence as the share of known weight, and unknowns excluded. |
| **4 · integration** | `__tests__/integration/qualification/qualification-runner.test.ts` (7 tests) | The runner against a **live Postgres** with the real migrations. |
| **5 · security** | `__tests__/security/lead-qualification-invariants.test.ts` (36 tests) | The execution-layer trust boundary, pinned against **source text**. |
| **6 · e2e** | `e2e/qualification.spec.ts` (2 tests) | The anonymous front door against the **real production build**. |

### Integration tier (gate 4)

Runs only against a live DB (`describeIntegration`): self-skips locally with no
DB, fails loudly in CI if the DB is missing. Because the engine is deterministic
there is **nothing to mock** — instead it seeds **two opposite, certain
verdicts** and asserts each lands exactly: (a) a UK construction company with a
strong fit score and an enriched profile → **qualified**, the company moves to
`status = 'qualified'`, the verdict is a `scored` event sourced
`ai_qualification` with a non-null `ai_employee_id`, all five steps' timeline
events land, and the read-side reconstructs the run from the persisted jsonb
(transitioned true, five criteria, confidence > 0); and (b) an overseas company
→ **disqualified** via the territory hard gate, moving to `status =
'disqualified'`. It also pins the metrics aggregation, the **idempotent** re-run
(`skipped`), and the bounded cron drain. Teardown deletes both probe companies,
whose FKs cascade to their tasks, timeline, and contacts.

### Security trust-boundary tier (gate 5)

`__tests__/security/lead-qualification-invariants.test.ts` pins the contract
against source text — hermetic, no database — mirroring the Research-AI
invariants with the two Module-3 divergences front and centre. The assertions
that would be a hole if they ever silently flipped: the migration growing a
table / policy / escalation surface; the **scope set widening** to send / draft
/ delete / memory while approval stays off; a **model creeping into the path**
(a non-NULL provider, or `anthropic` / `openai` appearing in the migration or
runner); the rubric gaining I/O, a clock, or an RNG; the autonomous transition
losing its `status === 'new'` guard or gaining a hardcoded forward jump; the
runner reading a tenant table or touching `hq_events`; an `/admin/qualification`
route or action escaping the allowlist or answering 403 instead of 404; a run
kicker / poller accepting an unvalidated id, or the cron drain losing its secret.

### E2E auth-wall tier (gate 6)

`e2e/qualification.spec.ts` boots the real production build (`next start`) on the
real Supabase stack and proves the anonymous front door: both the section home
and a live run view (`/admin/qualification/<uuid>`) are caught by middleware and
**307-redirected to `/login`** with the destination preserved, so the surface
never paints. Like the Research surface it exposes no anonymous JSON API — it is
SSR + server actions under the single HQ-gated `app/admin/layout.tsx`, so the
page wall *is* the network boundary.

### Engineering lessons

- **Removing a human gate means adding a code gate — and pinning it.** Research
  AI's safety story was `requires_approval = true`: a human approves before
  anything leaves. Module 3 deliberately drops that gate, because the
  qualify/disqualify call *is* the module. The lesson learned wiring it: an
  un-gated employee is only safe if its autonomy is bounded **structurally**, and
  every part of that bound is pinned in the security tier — (1) **tight scopes**
  that exclude every outbound/irreversible capability, (2) a transition **guarded
  by `status === 'new'`**, and (3) a transition **target made unreachable by
  type** (`RecommendedStatus = qualified | disqualified | null`) so the code
  *cannot* route a lead into outreach even if a future edit tried. Removing
  approval without all three would be the hole.
- **Determinism is a security property, not just a design taste.** For a *gating*
  decision, "no black box" is an invariant you can test, not a nicety. We pin it
  three ways: the migration wires **no model** (NULL provider, no provider name
  anywhere in the path), and the rubric is a **pure** module with **no clock and
  no RNG** in the decision. Together they guarantee the same inputs always
  produce the same, reconstructable verdict — and the security suite fails the
  build if a model ever creeps in. Treating determinism as merely "how we chose
  to build it" would let that guarantee erode silently.
- **A new provenance channel is data, not schema.** The verdict had to be
  attributed honestly (not mislabelled as research) without growing the
  `event_type` check constraint. The answer was to **reuse** the existing
  `scored` event type and add a new `hq_sales_sources` **row**
  (`ai_qualification`) — provenance as a lookup row. Reach for the existing
  vocabulary before touching a constraint.
- **The deterministic test seeds opposites instead of mocking.** Research AI's
  integration test had to *mock* the LLM to force a deterministic path. A
  deterministic engine needs no mock — the sharper design is to seed **two
  certain, opposite inputs** (a strong UK lead and a confident overseas one) and
  assert each verdict + transition exactly. One subtlety carried from research:
  the evidence criterion keys off `last_researched_at`, which `companyPayload`
  does not write, so the test must patch it via the service client or the
  verdict shifts — when an input is derived from a column a writer doesn't set,
  set it explicitly in the fixture.

---

## Validation gate (run before every PR)

```bash
npm run typecheck         # gate 1 — tsc --noEmit — clean
npm run lint              # gate 2 — eslint . — clean
npm run test              # gate 3 — unit suite — green
npm run test:integration  # gate 4 — real-Postgres runner (CI; self-skips with no DB)
npm run test:security     # gate 5 — trust-boundary invariants — green
npm run test:e2e          # gate 6 — auth wall on the real build (CI)
npm run build             # production build — passes
```

> **Build needs env at module-load.** `lib/env.ts` validates `process.env` on
> import with **no `SKIP_ENV_VALIDATION` bypass**, so `next build` fails fast
> ("Invalid environment variables") unless the three strictly-required vars are
> present — `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
> `NEXT_PUBLIC_SUPABASE_ANON_KEY` (everything else is optional/defaulted). CI and
> Vercel supply them from project settings; to build locally, export placeholders
> first. The routes are `force-dynamic`, so no real Supabase connection is made at
> build time — the validation is the only thing that needs the values.

---

## Extending (future modules)

- **A new criterion.** Add a `CriterionSpec` to `criteria.ts` (re-balancing the
  weights to sum 1.0) — it flows into the verdict, the live view, and the metrics
  automatically; the unit test pins the new weight. Keep it pure.
- **A different threshold or band.** The thresholds are named, exported constants
  (`QUALIFY_THRESHOLD` / `DISQUALIFY_FLOOR` / `EVIDENCE_FLOOR`); change one and
  the UI explanation, the rationale, and the tests move with it.
- **A new transition target.** Widen `RecommendedStatus` *and* the security
  invariant that pins it together — the type is deliberately the chokepoint, so
  any new autonomous destination is a conscious, reviewed change.
- **The next AI employee (Module 4+).** Qualification AI extends the Research AI
  template to an *autonomous* employee: one `ai_employees` row, a `server-only`
  runner that claims its own task type off `hq_sales_ai_tasks`, pure `lib/*`
  layers shared with the UI, and the same six-gate coverage — but when it acts
  without an approval gate, bound the autonomy in code and pin the bound. No new
  data surface required.
```
