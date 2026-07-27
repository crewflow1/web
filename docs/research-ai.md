# Company Research AI — engineering reference (CEO Directive 005)

Company Research AI is **the first operational AI employee**. Given a
company website, name, domain, or Companies House number, it builds a
complete intelligence profile — overview, services, construction sector,
size and growth signals, technology stack, decision makers, pain points
and buying signals — then a **transparent buying score**, a cold-call
brief, and **draft** outreach. It runs asynchronously off the AI task
queue, mirrors every step to the company timeline, and stores what it
learns in Shared Memory.

It is an **HQ-only** feature: nothing here touches the customer product,
customer workflows, or any tenant table.

> **Operational, but read + draft only.** Where the Sales AI Platform
> (`docs/sales-ai.md`) is the inert **Foundation** — schema, queue, and
> writers with *no worker* — Research AI is the worker that brings that
> schema to life. It is the first module that actually *executes*. The
> safety envelope is therefore the whole point: it **fetches public
> signals, analyses, scores, and drafts** internal artifacts, and it
> **never** contacts a prospect, never sends a message, never changes a
> customer record, never deletes anything, and never moves money. Every
> outbound artifact is a draft that waits for a human (`requires_approval`).
> And it **never invents data** — when a source is silent the honest value
> is `null` / "unknown", and unknown is a first-class, non-failing result.

Research AI ships in **one purely-additive migration**
(`20260718000000_research_ai_employee.sql`) that creates **no new table**:
it inserts a single `public.ai_employees` row (the twelfth boardroom
member, the first that performs work) and reuses the entire Directive-004
`hq_sales_*` family wholesale. The whole execution engine lives in code.

---

## Layers

A clean, mostly-pure stack. The four `lib/research/*` layers are
server/client-safe (no Supabase, no `server-only`), so the runner, the
prompt builders, and the live UI share one vocabulary, and the pure logic
is exhaustively unit-tested without a database. Everything that touches the
network or the database is `server-only`.

| Layer | File | Responsibility |
|---|---|---|
| **Model** | `lib/research/model.ts` | Pure lifecycle + contracts. The two state vocabularies (`ResearchPhase` coarse / `ResearchStep` fine), the all-nullable AI-output contracts (`CompanyIntelligence`, `DecisionMaker`, `SalesBrief`, `CommsDrafts`), `ResearchRunState` / `ResearchRunSummary`, and pure reducers (`applyStep`, `initialSteps`, `phaseProgress`). |
| **Extract** | `lib/research/extract.ts` | Pure HTML → signal extraction: title / meta, emails, phones, social links, technology fingerprints (`detectTechnologies`), hiring signal, website-quality + digital-maturity heuristics, `extractText` (capped at `MAX_EXTRACT_TEXT` = 12k), `normaliseUrl` / `domainOf`. No inference — just what the page literally says. |
| **Score** | `lib/research/score.ts` | Pure **transparent** scoring. The directive's ten factors, each with its own 0–100 value, weight, plain-English reasoning, and a `known` flag; the composite is blended **only over known factors**, `null` when nothing is known. "No black box." |
| **Prompts** | `lib/research/prompts.ts` | Pure prompt builders + strict parsers. `buildAnalysisMessages` / `parseAnalysis` (intelligence + decision makers), `buildSalesMessages` / `parseSalesPrep` (brief + drafts), `extractJson`, and `analysisHasContent` / `salesPrepHasContent` honesty checks. Parsers re-validate every field and drop anything unsupported. |
| **Fetch** | `server/services/research-fetch.ts` | `server-only`. Real, **SSRF-hardened** network reads of public signals: the company website (homepage + up to `MAX_EXTRA_PAGES` = 3 internal pages) and, when a key + number are present, the public Companies House register. GET-only, body-capped, redirect-re-checked. Returns facts or an honest error — never a fabricated page. |
| **Model (LLM)** | `server/services/research-llm.ts` | `server-only`. The **only** place Research AI calls a model provider — Anthropic Claude Haiku 4.5 → OpenAI gpt-4o-mini fallback. Returns `null` on no-key / timeout / unparseable output (graceful degradation), so the runner falls back to deterministic evidence. |
| **Runner** | `server/services/hq-research.ts` | `server-only`, service-role. The orchestrator. Owns **no tables**: it claims a `research_company` task off `hq_sales_ai_tasks`, drives the lifecycle, checkpoints the task `result` jsonb after every step, mirrors each step to the company timeline, and persists every artifact through the existing `hq-sales.ts` writers + the Shared Memory bridge. |
| **HTTP** | `app/api/admin/research/{run,state}` + `app/api/cron/research-drain` | The run kicker (POST, claims + drives a task), the state poller (GET, reads the checkpointed `result`), and the cron drain (GET, the never-lose-a-task safety net). |
| **Actions** | `app/admin/research/actions.ts` | `"use server"`. Two launcher entry points: `requireAdmin()` → `startResearch()` → `recordAdminActivity()` → `redirect()` to the live run. They enqueue and route; they never block on the 60s pipeline. |
| **UI** | `app/admin/research/**` | Server components. The section home + launcher (`page.tsx`, `_launcher.tsx`), and the live run view (`[taskId]/page.tsx`, `_live.tsx`, `_report.tsx`) that animates the checklist by polling the state endpoint, then renders the finished report. Styling in `_styles.ts`, primitives in `_components.tsx`. |

Each layer imports only from the layer below it. The runner is the only
layer that knows about Supabase; the four `lib/research/*` layers know
nothing about the network or the database.

---

## The lifecycle

The directive names a coarse, operator-legible **phase** machine; the runner
also keeps a fine-grained **step** checklist so the live view can animate
the AI working. Both are persisted in `hq_sales_ai_tasks.result` (jsonb) and
polled — there is no websocket.

### Phases (`ResearchPhase`)

```
queued → running → researching → analysing → scoring → reasoning → completed
                                                                  ↘ failed
```

`phaseProgress()` maps each to a monotonic 0–1 value so the progress bar only
ever advances. `completed` and `failed` are terminal.

### Steps (`RESEARCH_STEP_DEFS`)

Eleven steps, each bound to a phase and to the
`hq_sales_timeline_events.event_type` it is logged under, so the live
checklist and the **permanent** company timeline are written from one
definition:

| Step | Phase | Timeline event |
|---|---|---|
| Website analysed | researching | `research` |
| Technologies detected | researching | `enriched` |
| Contact channels extracted | researching | `enriched` |
| Companies House checked | researching | `enriched` |
| Company intelligence built | analysing | `enriched` |
| Decision makers identified | analysing | `enriched` |
| AI score calculated | scoring | `scored` |
| Sales brief created | reasoning | `recommendation` |
| Outreach drafts generated | reasoning | `email_generated` |
| Shared Memory updated | reasoning | `system` |
| Task completed | completed | `task_completed` |

### What each phase does — `runResearchTask(taskId)`

1. **Claim.** `claimTask` is a **conditional update**: `status → running`
   only succeeds while the row is still `pending`. A double-kick (browser
   retry *and* the cron drain) is therefore harmless — the loser returns a
   `skipped` outcome. This is the whole idempotency guarantee.
2. **Researching.** `researchWebsite` fetches + extracts the site;
   `researchCompaniesHouse` looks up the register when a number + key are
   present. Pure facts only.
3. **Analysing.** `analyse` interprets the evidence into a
   `CompanyIntelligence` profile — via the LLM when a key is present, else
   the deterministic extraction alone (provenance stamped accordingly).
   `identifyDecisionMakers` adds only people a real source named.
4. **Scoring.** `scoreCompany` blends the ten transparent factors;
   `persistEnrichment` writes the derived signals + `ai_qualification_score`
   back onto the company row so the dashboards are truthful.
5. **Reasoning.** `writeResearchReport` persists the durable report;
   `reasonSalesPrep` drafts the brief + outreach (LLM only — it early-returns
   without a key, so the deterministic path drafts nothing rather than
   inventing); the report is promoted into Shared Memory.
6. **Completed.** A `ResearchRunSummary` is folded in, the task is stamped
   `completed` + `finished_at`, and a `task_completed` timeline event lands.

Every step calls `checkpoint()` to rewrite the `result` jsonb, so a cold
task is **resumable** and the poller always sees the latest state. Any throw
flips the task to `failed`, records `error_message`, increments
`retry_count`, and logs a `task_failed` event — the run never half-writes
silently.

---

## The migration — one employee, no new surface

`supabase/migrations/20260718000000_research_ai_employee.sql` is purely
additive and idempotent:

- **One `insert into public.ai_employees`** (`slug = 'research-ai'`,
  `sort_order` 35), `model_provider = 'anthropic'`,
  `model_name = 'claude-haiku-4-5'`, a full system prompt encoding the hard
  rules, a `tools_allowed` array (fetch / detect / extract / analyse /
  identify / brief / draft / score / write-memory), and
  `memory_scope = 'organization'`.
- **The permission grant** is the read+draft contract, pinned in the security
  tier: `{"can_execute": true, "requires_approval": true, "scopes":
  ["read","research","draft","score","memory"]}`. The scope set structurally
  excludes `send` and `delete` — drafting outreach is `draft`, never `send`.
- **No `create table`, no `create policy`, no `security definer`, no dynamic
  SQL.** It adds *work*, not a new data surface or an escalation path.
- **`on conflict (slug) do nothing`** — re-running never clobbers operator
  edits made through the HQ UI.

---

## Security model

Research AI is the first module that *executes*, so its trust boundary is
load-bearing. Defence in depth, every layer independent:

- **Route gate (the single chokepoint).** Every `/admin/research/**` page is
  a child of `app/admin/layout.tsx`, which runs `requireHqPage()`
  (`requireUser()` + `isSuperAdminEmail()` → `notFound()`). The surface is
  invisible to customers and staff, and the gate answers **404, not 403** —
  a 403 would announce the surface's existence.
- **Action gate (defence in depth).** Both launcher actions independently
  call `requireAdmin()`, which re-runs `requireUser()` and redirects a
  non-super-admin to `/dashboard` **before** any enqueue. Reaching an action
  URL directly is still blocked.
- **API gate.** The run + state routes authenticate via `requireUser()` and
  reduce to the `isSuperAdminEmail` allowlist, answering **404** (never 403)
  for a non-allowlisted caller, and **400** on a `taskId` that fails the
  `UUID_RE` check before any DB use.
- **Cron gate.** The drain requires the bearer `CRON_SECRET`
  (`isCronAuthorised(request)`) and answers **401** otherwise. It is bounded
  (≤ 5, default 3 tasks) so one invocation can never run away.
- **Database gate.** The runner reaches the DB only through
  `createAdminClient()` (service-role), and the `hq_sales_*` family is
  RLS-on / zero-policy (service-role only). No anon/customer JWT can read a
  row. The runner **never reads a tenant CRM table** (`organizations`,
  `customers`, `leads`, `jobs`, `quotes`, `invoices`) and **never touches the
  spine truth log** (`hq_events`) — research has its own timeline.
- **SSRF guard.** The fetch layer takes operator-supplied URLs, so it refuses
  non-public hosts (`isPrivateHost`: localhost / `.localhost` / `.internal` /
  `.local` / `::1` / RFC-1918 / 127 / link-local 169.254), **re-checks the
  host on every redirect hop** (`redirected-to-private`), caps the response
  body (`MAX_BODY_BYTES` ≈ 1.2 MB), and issues **GETs only** — never POST /
  PUT / DELETE.
- **Traceability.** Every AI-authored artifact carries `generated_by = 'ai'`,
  the `model` string, and the Research AI `ai_employee_id`; every step is a
  timeline row; every launch is an `admin_activity_log` entry
  (`research.start`).

---

## The transparent score (`scoreCompany`)

The directive: *"Every score must include reasoning. No black box."* So the
score is never a bare number — it is the ten factors, each carrying a value,
weight, reasoning string, and a `known` flag. Weights sum to **1.0**:

| Factor | Weight | Known even when empty? |
|---|---|---|
| Revenue fit | 0.14 | no — needs a revenue or software-spend estimate |
| Company size | 0.12 | no — needs headcount or fleet |
| Buying intent | 0.12 | **yes** — absence of signals is itself observable (→ 30) |
| Construction type | 0.10 | no — needs a sector / industry signal |
| Digital maturity | 0.10 | no — needs an assessed score |
| Growth | 0.10 | no — needs growth / recruitment signals |
| Technology | 0.08 | **yes** — "no stack detected" is a real reading (→ 42, greenfield) |
| Location | 0.08 | no — needs a location string |
| Decision-maker access | 0.08 | **yes** — "none identified yet" is observable (→ 30) |
| Engagement | 0.08 | no — needs contact history (relationship score) |

Honesty rules baked in:

- An **unknown factor is still listed** (so the operator sees the gap) but
  marked `known: false` and **excluded from the composite** — an unknown never
  silently drags a score to the middle.
- **`confidence`** reports the share of total weight that was actually known,
  so a thin profile yields a real-but-low-confidence score, not a confident
  guess.
- **When nothing is known the composite is `null`, not 0.**

The score reuses the Sales-AI `IntelligenceFactor` / `scoreBand` contract, so
it renders through the same reasoning UI with no new presentation vocabulary.

---

## Graceful degradation — the deterministic path

The model layer is the *only* provider call, and "no key" is a first-class
path, not an error. When `researchAiEnabled()` is false (no
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), or a call times out (22s) / fails /
returns unparseable JSON:

- `analyse` skips the LLM and builds the profile from the **deterministic
  extraction alone**; provenance is stamped `deterministic`.
- `reasonSalesPrep` early-returns — **no brief, no drafts** are written
  (drafting needs a model; the honest alternative is nothing, not invention).
- The transparent score still runs: on a website-less company the three
  always-known factors (buying intent, technology, decision-maker access)
  guarantee a **real, non-null composite** with honest low confidence.

So a degraded run still completes, still scores, still writes a durable
report attributed `model = 'deterministic'`, and writes **nothing it cannot
stand behind**. Provenance is one of `anthropic` / `openai` / `deterministic`
on every artifact and in the live metrics.

---

## Shared Memory bridge (Directive 002 integration)

The final reasoning step promotes the durable research report into the
company-wide Shared Memory Engine (`promoteResearchToMemory`) so every AI
employee can reuse it. It is opt-in by virtue of being the last pipeline
step, idempotent (an already-linked report returns its existing `memory_id`),
and **degrades gracefully**: if the memory engine is unavailable the step is
marked `skipped`, not failed — the run still completes.

---

## Pages & routes

All UI under `/admin/research` (super-admin only):

| Route | What it does |
|---|---|
| `/admin/research` | Section home — the launcher (research a new prospect by name / website / Companies House number) plus live Research AI metrics and recent runs. |
| `/admin/research/[taskId]` | The **live run view** — kicks the worker on mount, polls `state/[taskId]` (~1.2s) to animate the phase + step checklist in real time, then renders the finished intelligence report (profile, decision makers, transparent score factors, brief, drafts). |

HTTP surface:

| Endpoint | Method | Gate | Notes |
|---|---|---|---|
| `/api/admin/research/run` | POST | super-admin → 404 on miss | Claims + drives a task to completion; `maxDuration = 60`; 400 on a non-UUID `taskId`. Fire-and-forget safe (idempotent claim). |
| `/api/admin/research/state/[taskId]` | GET | super-admin → 404 on miss | Reads the checkpointed `result` jsonb; one indexed row read; always JSON. |
| `/api/cron/research-drain` | GET | `CRON_SECRET` → 401 | The never-lose-a-task net: runs tasks that were enqueued but never kicked, and re-queues anything stuck in `running` past the 5-minute dead-worker threshold. Bounded per call. |

---

## Testing — the six-gate bar

| Gate | Suite | Proves |
|---|---|---|
| **3 · unit** | `__tests__/research/{model,extract,prompts,score}.test.ts` (58 tests) | The pure layers in isolation — lifecycle reducers + phase/step maths, HTML extraction (emails / phones / tech / quality), prompt building + strict parsing + honesty checks, and the transparent ten-factor score (weights sum to 1, unknowns excluded, `null` when nothing known). |
| **4 · integration** | `__tests__/integration/research/research-runner.test.ts` (8 tests) | The runner against a **live Postgres** with the real migrations. |
| **5 · security** | `__tests__/security/research-ai-invariants.test.ts` | The execution-layer trust boundary, pinned against **source text**. |
| **6 · e2e** | `e2e/research.spec.ts` (2 tests) | The anonymous front door against the **real production build**. |

### Integration tier (gate 4)

Runs only against a live DB (`describeIntegration`): self-skips locally with
no DB, fails loudly in CI if the DB is missing. It forces the **deterministic
path** (mock `research-llm` to the no-key outcome) and seeds a website-less
company, so the run touches **no network** and makes **no paid model call**,
yet still has to, against real rows: complete end-to-end with a real,
transparent, non-null score; write exactly **one** report attributed
`generated_by = 'ai'` / `model = 'deterministic'`; enrich the company
(`last_researched_at` + `ai_qualification_score`, `source = 'ai_research'`);
mirror the lifecycle to the timeline (`task_scheduled` → `task_started` →
`scored` → `task_completed`); write **nothing it cannot stand behind** (no
fabricated brief, no invented contacts); reconstruct the terminal run from the
persisted jsonb (all ten score factors present, the three always-known ones
known, brief/drafts null); aggregate into live metrics; and stay **idempotent**
(re-running a finished task is a `skipped` no-op). Teardown deletes the probe
company, whose FKs cascade to its task, report, contacts, timeline, and
recommendations.

### Security trust-boundary tier (gate 5)

`__tests__/security/research-ai-invariants.test.ts` pins the contract against
source text — hermetic, no database — mirroring the Sales-AI invariants. The
assertions that would be a hole if they ever silently flipped: the migration
growing a table / policy / escalation surface, or the employee losing
`requires_approval` / its read-draft-only scope set; the runner reading a
tenant table, touching `hq_events`, or becoming client-importable; the fetch
layer losing its SSRF guard (private-host block, redirect re-check, body cap)
or gaining a write method; the model layer throwing instead of degrading to
`null`; an `/admin/research` route or action escaping the allowlist or
answering 403 instead of 404; a run kicker / poller accepting an unvalidated
id, or the cron drain losing its secret. Migration checks run over SQL with
`--` comments stripped; TS checks over code with comments stripped — so the
prose that *documents* a rule can never satisfy or trip a match.

### E2E auth-wall tier (gate 6)

`e2e/research.spec.ts` boots the real production build (`next start`) on the
real Supabase stack and proves the anonymous front door: both the section home
and a live run view (`/admin/research/<uuid>`) are caught by middleware and
**307-redirected to `/login`** with the destination preserved, so the surface
never paints. Like the Sales surface it exposes no anonymous JSON API — it is
SSR + server actions under the single HQ-gated `app/admin/layout.tsx`, so the
page wall *is* the network boundary. The 404-not-403 contract for an
*authenticated* non-allowlisted caller is pinned in the security tier (it
needs a real super-admin-vs-not session the anonymous e2e deliberately does
not build).

### Engineering lessons

- **Retro-fitting the six-gate bar.** Research AI (Directive 005, merged
  before the mandatory six-gate regime + living-knowledge-base rule) shipped
  genuinely production-grade on the model / service / UI / **unit** axes, yet
  cleared only 3 of 6 gates — it had **no** real-Postgres integration,
  security trust-boundary, or e2e auth-wall suite. The hardening closed all
  three the same way the Company Intelligence Database was closed: **pure
  additive coverage that pins existing, already-correct behaviour, touching
  zero production logic** (the only source change was deleting four genuinely
  dead symbols flagged by lint — `scoreBand` / `RESEARCH_STEP_LABEL` /
  `WriteResult` imports and an unused `SYSTEM_ACTOR` const). Safe under
  maintenance-mode / code-freeze. The lesson stands: "done and shipped" is not
  the same as "meets the current bar"; when the bar rises, the most sensitive
  surfaces are retro-fitted first — and the *executing* surface is the most
  sensitive of all.
- **The `NEXT_PUBLIC_SUPABASE_URL` CI-env bridge.** `createAdminClient()`
  reads `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, but the
  integration CI job exports only the bare `SUPABASE_URL` (via `supabase
  status`). The runner would otherwise write to a different (or empty) URL
  than the one the assertions read. The integration suite bridges the one name
  the runner needs (`NEXT_PUBLIC_SUPABASE_URL ← SUPABASE_URL`) in `beforeAll`,
  ensuring the runner writes to the very DB the test reads. Any future suite
  that drives a service-role writer through CI must do the same.
- **The polymorphic memory-link teardown.** The pipeline's last step promotes
  the report into Shared Memory, and the memory↔company link is **polymorphic
  (not a FK)**, so an `hq_memories` row would **survive** a company delete and
  leak across the serial integration run. The fix keeps the run hermetic
  without weakening it: partial-mock `createMemory` to the "engine unavailable"
  outcome, which *also* exercises the runner's real graceful-skip branch and
  leaves no row to clean up. The lesson: when teardown leans on FK cascade,
  any polymorphic (non-FK) link is a leak you must mock out or delete
  explicitly.
- **Asserting an honest score without coupling to it.** On an empty profile
  exactly three factors are always known (buying intent, technology,
  decision-maker access), so the composite is a real number — but its exact
  value depends on whether a fourth factor (engagement) happens to be known.
  The integration test asserts the score is a **number in `[0, 100]`** and
  that those three factors are `known`, never a hard-coded value — pinning the
  honesty contract without becoming brittle to a weight tweak.

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

---

## Extending (future modules)

- **More signals.** Add an extractor to `lib/research/extract.ts` (pure,
  unit-tested) and surface it in `gatherSiteContent`; the analyse step and
  score read it with no schema change.
- **A new score factor.** Add a `FactorSpec` to `score.ts` (re-balancing the
  weights to sum 1.0) — it flows into the report, the live view, and the
  metrics automatically; the unit test pins the new weight.
- **A real Companies House / enrichment connector.** The fetch layer already
  isolates the network behind typed `*Facts` shapes; a new public source is a
  new fetcher + extractor, still GET-only and SSRF-guarded.
- **A different model.** Swap `ANTHROPIC_MODEL` / `OPENAI_MODEL` in
  `research-llm.ts`; the runner, contracts, and provenance are model-agnostic.
- **The next AI employee.** Research AI is the template: one `ai_employees`
  row, a `server-only` runner that claims its own task type off
  `hq_sales_ai_tasks`, pure `lib/*` layers it shares with the UI, and the same
  six-gate coverage. No new data surface required.
