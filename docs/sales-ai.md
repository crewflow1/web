# Sales AI Platform — engineering reference (CEO Directive 003)

The Sales AI Platform is the company-intelligence database, AI research
store, pipeline, AI task queue, and activity timeline that powers the
CrewFlow sales engine. It is an **HQ-only** feature: nothing here touches
the customer product, customer workflows, or any tenant table.

> **Foundation only.** This is the permanent foundation — "design once,
> scale forever" — for every future autonomous AI sales employee. **No code
> in this module calls a model provider, runs research autonomously, sends
> outreach, or talks to any external integration.** AI-authorable rows
> simply carry `generated_by`, `model`, and `ai_employee_id` so future
> autonomous work is traceable from day one; the AI task queue records work
> but **no worker executes it yet**. Humans drive every write.

The platform shipped in two purely-additive migrations:

1. **Phase 1** (`20260714000000_hq_sales_ai.sql`) — the master company
   record, contacts, permanent research, recommendations, the per-company
   timeline + global feed, and the lead-source lookup.
2. **Scale expansion** (`20260714000001_hq_sales_ai_scale.sql`) — multiple
   locations / channels per company, the AI task queue, reserved Company
   Intelligence signals, the AI Timeline (every AI action is a searchable
   event), and future-integration scaffolding. Purely additive and
   idempotent; the Phase 1 migration is never edited.

---

## Layers

The platform is a clean four-layer stack. Each layer imports only from the
layer below it.

| Layer | File | Responsibility |
|---|---|---|
| **Model** | `lib/sales/model.ts` | Pure, server/client-safe vocabulary + maths. No Supabase. Statuses, timeline kinds (interaction / lifecycle / AI-action), task-queue + channel vocab, seniority, likelihood/risk bands, scoring, funnel maths, facet aggregation, currency/score formatting. |
| **Service** | `server/services/hq-sales.ts` | `server-only`. Service-role data access over the `hq_sales_*` tables. Search (companies **and** timeline FTS), detail load, dashboard, analytics, the audited write functions, and the Shared Memory bridge. |
| **Actions** | `app/admin/sales/actions.ts` | `"use server"`. The **fourteen** state-changing entry points. `requireAdmin()` → validate → service → `recordAdminActivity()` → `revalidatePath()` → `redirect()`. |
| **UI** | `app/admin/sales/**` | Server components only (no client JS). Dashboard, search, company detail, analytics, activity feed (searchable), the AI task queue, and the create/edit form. Styling lives in `_styles.ts`; primitives in `_components.tsx`. |

Why the model layer is pure: the service, the actions, and the React
components all import the same vocabulary and maths from one place, and
the pure functions are exhaustively unit-tested without a database.

---

## Security model

This module is the most sensitive HQ surface — it holds prospect PII and
the entire sales pipeline. The directive's mandate is "HQ only. Super
Admin only. Service-role access only. Audit every change."

- **Route gate.** `app/admin/layout.tsx` runs `requireUser()` +
  `isSuperAdminEmail()` and `notFound()`s every non-allowlisted user, so
  the whole `/admin/sales/**` tree is invisible to customers and staff.
- **Action gate (defence in depth).** Every one of the fourteen server
  actions independently calls `requireAdmin()`, which re-runs
  `requireUser()` and redirects non-super-admins to `/dashboard` **before
  any write**. A request that reaches an action URL directly is still
  blocked.
- **Database gate.** Every `hq_sales_*` table `enable row level security`
  with **zero policies** → service-role-only. The anon/customer JWT client
  cannot read or write a single row. The service layer is `server-only`
  and uses `createAdminClient()` exclusively.
- **Audit.** Every mutation writes a `public.admin_activity_log` row via
  `recordAdminActivity({ actorId, actorEmail, action, targetTable,
  targetId, metadata })` **and** (for company-scoped work) appends a
  per-company timeline event — the company's own audit trail. The two
  together mean every change — human or AI-attributed — is fully
  traceable.

The authorization boundary is proven in
`__tests__/admin/sales-ai.test.ts`: unauthenticated and non-allowlisted
callers redirect and perform **zero** writes; a super-admin caller
persists the row **and** lands an audit entry.

### Audit actions emitted

| Action | Target table | Fired by |
|---|---|---|
| `hq_sales.company_created` | `hq_sales_companies` | `createCompanyAction` |
| `hq_sales.company_updated` | `hq_sales_companies` | `updateCompanyAction` |
| `hq_sales.status_changed` | `hq_sales_companies` | `setCompanyStatusAction` |
| `hq_sales.contact_added` | `hq_sales_contacts` | `addContactAction` |
| `hq_sales.contact_deleted` | `hq_sales_contacts` | `deleteContactAction` |
| `hq_sales.research_added` | `hq_sales_research_reports` | `addResearchAction` |
| `hq_sales.recommendation_added` | `hq_sales_recommendations` | `addRecommendationAction` |
| `hq_sales.interaction_logged` | `hq_sales_timeline_events` | `logInteractionAction` |
| `hq_sales.research_promoted` | `hq_sales_research_reports` | `promoteResearchAction` |
| `hq_sales.location_added` | `hq_sales_locations` | `addLocationAction` |
| `hq_sales.channel_added` | `hq_sales_channels` | `addChannelAction` |
| `hq_sales.channel_deleted` | `hq_sales_channels` | `deleteChannelAction` |
| `hq_sales.task_enqueued` | `hq_sales_ai_tasks` | `enqueueAiTaskAction` |
| `hq_sales.outcome_promoted` | `hq_sales_timeline_events` | `promoteOutcomeAction` |

---

## Database schema

Two migrations, all tables RLS-on / zero-policy, plus seeded extensible
lookups.

### Phase 1 — `20260714000000_hq_sales_ai.sql`

| Table | Purpose |
|---|---|
| `hq_sales_companies` | The master company-intelligence record — identity, geography, contact + social links, Companies House, website technology, CRM + AI scores, pipeline status, source, assignment, tags. Carries a generated `search_tsv` (tsvector) with a GIN index for full-text search. |
| `hq_sales_contacts` | Decision-makers per company — name, title, seniority, email/phone/LinkedIn, primary + decision-maker flags. |
| `hq_sales_research_reports` | **Permanent** AI/human research — summary, pain points, likelihood score + band, estimated software spend, best angle, opening line, recommended follow-up, risk assessment + level. Optional `memory_id` once promoted to Shared Memory. |
| `hq_sales_recommendations` | Why-buy, key features, likely objections, recommended pricing/plan, best salesperson, best time to call, follow-up schedule. One `active` row per company; older ones become `superseded`. |
| `hq_sales_timeline_events` | The per-company chronological timeline **and** the global activity feed. |
| `hq_sales_sources` | Extensible lead-source lookup (slug → label, category). Seeded with 10 sources. |

### Scale expansion — `20260714000001_hq_sales_ai_scale.sql`

| Table | Purpose |
|---|---|
| `hq_sales_locations` | **Multiple physical sites** per company — label, HQ/primary flags, full address, lat/long, phone, notes. AI-discoverable (traceability triad). |
| `hq_sales_channels` | **ONE polymorphic table** for multiple phones, emails, LinkedIn profiles, and social accounts. Anchored to a company (always), optionally narrowed to a contact or location. `channel_type` FKs the lookup; a case-insensitive unique index dedupes `(company, type, value)`. Status `active`/`inactive`/`invalid`. AI-discoverable. |
| `hq_sales_ai_tasks` | The **AI Task Queue** — every scheduled unit of work. `pending`/`running`/`completed`/`failed`/`cancelled`, priority (`urgent`→`low`) with a generated `priority_rank` for index-ordered dequeue, retry/max-retry counts, assigned AI employee, scheduled/started/finished timestamps, error message, `payload`/`result` JSON, and a `dedupe_key` with a partial-unique index (one live task per key). **No worker runs yet.** |
| `hq_sales_channel_types` | Channel-kind lookup (phone/mobile/email/linkedin/socials/whatsapp/website/…), 12 seeded. |
| `hq_sales_task_types` | Task-kind lookup (research/enrich/score/generate+send email+LinkedIn/cold-call/objection/demo/follow-up/proposal/promote-memory), 15 seeded. |
| `hq_sales_integrations` | Future-connector registry (linkedin, instagram, email, twilio, whatsapp, companies_house, google_maps, website_crawler) — all `planned`. **No network calls.** |
| `hq_sales_external_records` | Future-integration link + raw-snapshot store, deduped per `(integration, external_id)`. Written only when a connector ships. |

**Company Intelligence columns** (reserved, nullable, added to
`hq_sales_companies`): `revenue_estimate_gbp`, `growth_score`,
`construction_sector`, `software_used[]`, `estimated_software_spend_gbp`,
`fleet_size`, `staff_size`, `website_quality_score`,
`marketing_quality_score`, `hiring_activity_score`,
`digital_maturity_score`, plus a free-form `enrichment` JSONB bag. Null
everywhere today; future enrichment fills them in. Reads list columns
explicitly, so adding more is additive and non-breaking.

**Lookups are data, not code** — a new lead source, channel kind, or task
type is an `INSERT`, never a deploy.

### Indexing for scale

- Company `search_tsv` GIN index backs keyword search; **timeline
  `search_tsv`** (generated, weighted subject/body/outcome+type) gets its
  own GIN index so "everything is searchable".
- B-tree indexes on every company search facet + sort
  (`status`, `industry`, `county`, `region`, `source`,
  `assigned_to_email`, `ai_qualification_score`, `last_researched_at`,
  `created_at`), the intelligence scores (`growth_score`,
  `digital_maturity_score`, `construction_sector`), and the
  `tags` / `website_technology` / `software_used` arrays (GIN).
- Locations + channels indexed by `company_id` (and contact/location/
  type); the AI task queue has a composite **dequeue index**
  `(status, priority_rank, scheduled_at, created_at)` so a future worker
  claims the next task with an index seek, not a `CASE` scan.

---

## Vocabulary (the model layer)

- **Pipeline status** (`PIPELINE_STATUSES`): `new → qualified →
  outreach_ready → contacted → replied → demo_booked → won`, plus the
  terminal-negative `lost` and `disqualified` (off the linear funnel).
- **Funnel maths** (`buildFunnel`): a company currently at stage *N* has
  "reached" stages 1..*N*; `won` is terminal. Conversion is reported from
  the previous stage. `winRate` = won ÷ all; `closeRate` = won ÷ decided
  (won + lost + disqualified).
- **Scoring** (`scoreBand`): CRM + AI scores share one 0–100 banding —
  Hot 80+, Warm 60+, Cool 40+, Cold <40, else Unscored.
- **Likelihood** (`likelihoodBandFromScore`): Very high 80+, High 60+,
  Medium 40+, Low <40, else Unknown — derived on write.
- **Size bands** (`EMPLOYEE_BANDS`): micro/small/medium/large/xlarge/
  enterprise — drive the size facet + "search by size".
- **Timeline categories** (`eventCategory`): every event is an
  `interaction` (a human-logged touch), a `lifecycle` marker (created /
  research / status_change / system), or an **`ai_action`** (the
  autonomous engine's footprint: enriched, scored, email/LinkedIn
  generated + sent, call completed, objection handled, demo booked/
  completed, follow-up created, proposal generated, task lifecycle).
- **Promotable outcomes** (`isPromotableOutcome`): a handled objection,
  completed cold call, or completed demo — the events worth promoting into
  Shared Memory.
- **AI task queue** vocab: `AI_TASK_STATUSES`, `AI_TASK_PRIORITIES`,
  `priorityRank` (mirrors the DB generated column — urgent = 0 = first),
  `isOpenTaskStatus` (pending/running), `tallyTaskStatuses` /
  `emptyTaskStatusCounts` for the queue dashboard tiles.
- **Channel categories** (`CHANNEL_CATEGORIES` + `channelCategoryLabel`):
  phone / email / linkedin / social / web / messaging / other — the coarse
  grouping the UI buckets by (the concrete `channel_type` is data).

---

## Pages & routes

All under `/admin/sales` (super-admin only):

| Route | What it does |
|---|---|
| `/admin/sales` | Command dashboard — status counts, funnel, win/close rates, pipeline + won value, weekly/monthly activity, AI productivity (30-day), headline facets, recents. |
| `/admin/sales/companies` | Search — keyword (FTS) + every structured facet (status, industry, county, region, source, salesperson, tag, technology, size band, min AI score) + sort, server-paginated. |
| `/admin/sales/companies/new` | Create a company (identity → size/value → geography → contact/links → scoring/pipeline → Company Intelligence signals). |
| `/admin/sales/companies/[id]` | Company detail — intelligence panel, locations, contact channels, contacts, permanent research reports, recommendations, the AI task queue, the full AI-action timeline, and every inline (audited) write form. |
| `/admin/sales/companies/[id]/edit` | Edit the master record. |
| `/admin/sales/tasks` | The **global AI task queue** — status tiles, status + task-type filters, the priority-ordered queue, and a "schedule a task" form (company-scoped or database-wide). Foundation only; nothing executes. |
| `/admin/sales/analytics` | Funnel + conversion, win/close rates, open-pipeline value, and the full facet set. |
| `/admin/sales/activity` | The global, day-grouped activity timeline across all companies, **with full-text search** over event subject/body/outcome. |

URL params drive search, sort, pagination, the activity window + query,
and the task-queue filters, so a refresh or shared link restores the exact
view.

---

## AI traceability

Every artifact that an AI could author records:

- `generated_by` — `ai` or `human`.
- `model` — the model string (only when `generated_by = ai`).
- `ai_employee_id` — FK to `public.ai_employees` (only when AI-authored).

This triad is on research, recommendations, locations, and channels. The
operator UI only sets `model` / `ai_employee_id` when "AI" is chosen, and
the action enforces it (a human-authored row cannot carry an AI
attribution). AI tasks additionally record `assigned_ai_employee_id`. When
AI work eventually runs autonomously, these columns are already the source
of truth for "which AI did this, with which model".

---

## Shared Memory bridge (Directive 002 integration)

Two paths promote sales knowledge into the company-wide Shared Memory
Engine so every AI employee can read it. Both are **opt-in**,
**idempotent** (an already-linked row returns its existing `memory_id`),
**audited**, and **linked** (the source row stores `memory_id`; the detail
page links straight to `/admin/memory/[id]`).

- **Research** — `promoteResearchAction` → `promoteResearchToMemory`
  promotes a research report. Emits `hq_sales.research_promoted`.
- **Outcomes** — `promoteOutcomeAction` → `promoteOutcomeToMemory`
  promotes a *winning outcome* (a handled objection, completed cold call,
  or completed demo — see `isPromotableOutcome`). Emits
  `hq_sales.outcome_promoted` and a `system` timeline event linking the new
  memory, tagged `sales` + `outcome` so future AI employees learn from real
  wins.

---

## Testing

`__tests__/admin/sales-ai.test.ts` (76 tests) covers:

1. **Authorization boundary** — all fourteen actions, for unauthenticated
   and non-allowlisted callers: each redirects and writes nothing.
2. **Super-admin happy paths** — company create/update/status, contact
   add/delete, research, recommendation, interaction, location, channel
   add/delete, AI task enqueue (company-scoped **and** global), and
   idempotent outcome promotion: the correct table write **plus** the
   matching `admin_activity_log` audit row, with AI attribution suppressed
   for human-authored artifacts, the task row queued `pending`/`manual`,
   and a company-scoped task leaving a `task_scheduled` timeline marker
   (a global task leaving none).
3. **Validation** — empty name, bad status enum, non-UUID id, missing
   contact name, non-interaction event type, an empty location, an empty
   channel value, an out-of-range task priority, a non-UUID outcome event
   id, and a non-promotable outcome: all rejected before any write.
4. **Pure model logic** — funnel/win/close maths, facet aggregation,
   pipeline value, activity windows, scoring/likelihood/size banding, the
   formatting/parsing helpers, event categorisation (interaction /
   lifecycle / **ai_action**), the AI-task-queue vocab (`priorityRank`,
   `tallyTaskStatuses`, status/priority labels, `isOpenTaskStatus`), and
   the channel + promotable-outcome helpers.

Supabase admin is a queue-based chainable stub; `redirect()` is stubbed to
throw (mirroring Next.js halting the action).

### Security trust-boundary tier (gate 5)

`__tests__/security/hq-sales-intelligence-invariants.test.ts` (42 tests) pins
the database + service contract against **source text** — hermetic, no
database, run via `npm run test:security`. It mirrors the five
`event-spine-*-invariants` suites so the most sensitive HQ surface is held to
the same bar as the spine:

1. **RLS:hq on all 17 tables** — every `hq_sales_*` table is created **and**
   `enable row level security`, and the family declares **zero** `create
   policy`. `service_role` (BYPASSRLS) is the only reader; no anon /
   authenticated JWT can read a row.
2. **No escalation surface** — no dynamic SQL (`execute format(` / `execute
   '`) and **no `SECURITY DEFINER` function**. Access is gated by RLS:hq + the
   service-role client, not a definer RPC, so there is no unhardened privilege
   path to pin.
3. **Decoupled from tenant RLS** — no `hq_sales_*` table has a foreign key
   into a customer/tenant table (`organizations`, `customers`, `leads`,
   `jobs`, `quotes`, `invoices`). HQ never re-couples to customer RLS.
4. **AI traceability** — the `generated_by` / `model` / `ai_employee_id` triad
   is present, and the canonical AI artifact (`hq_sales_research_reports`)
   carries all three.
5. **Search integrity** — the company `search_tsv` is a GENERATED weighted
   tsvector that can never drift from its source columns.
6. **Service boundary** — `server/services/hq-sales.ts` is `server-only`,
   reaches the DB only through `createAdminClient()`, **never** reads a tenant
   table, and **never** touches the spine truth log (`hq_events`).
7. **The single HQ gate** — the `/admin/sales/**` tree inherits
   `requireHqPage()` at `app/admin/layout.tsx`, and the gate answers **404,
   not 403** (`isSuperAdminEmail` → `notFound()` / `status: 404`; never 403,
   which would announce the surface's existence).

### Integration tier (gate 4)

`__tests__/integration/sales/hq-sales-rls.test.ts` (8 tests) proves the
BEHAVIOUR the source check cannot — against a **live Postgres** with the real
migrations applied, run via `npm run test:integration` (CI, or any disposable
Supabase; self-skips locally with no DB, fails loudly in CI if the DB is
missing):

1. **RLS:hq is real** — a `service_role` client (BYPASSRLS) reads a
   representative slice of the family, but neither an **anonymous** JWT nor a
   minted **authenticated** (customer/staff) JWT reads a single row — even from
   the tables the migrations **seed** (`hq_sales_sources`, `_call_scripts`,
   `_objections`, `_learnings`), so "zero" is a true denial, never a vacuously
   empty table.
2. **Write denial** — an anon insert is rejected and creates no row.
3. **Generated search** — the company `search_tsv` is computed by Postgres and
   is full-text queryable (`websearch_to_tsquery`).
4. **Schema defaults** — the AI-traceability columns round-trip and the
   defaults Postgres applies (`generated_by` → `ai`, `likelihood_band` →
   `unknown`, `risk_level` → `medium`, `status` → `final`) are asserted on
   real rows, not the app's idea of them.
5. **Intra-family cascade** — deleting a company cascades to its contacts: the
   family's foreign keys stay **inside** `hq_sales_*` (the runtime mirror of
   "no FK into a tenant table").

### E2E auth-wall tier (gate 6)

`e2e/sales.spec.ts` (2 tests) boots the **real production build** (`next
start`) on the real Supabase stack and proves the anonymous front door: every
`/admin/sales` page (the command dashboard and the company-intelligence search)
is caught by middleware and **307-redirected to `/login`** with the destination
preserved, so the prospect surface never paints. Unlike the Pulse, this surface
exposes **no** anonymous JSON API — it is SSR + server actions under the single
HQ-gated `app/admin/layout.tsx`, so the page wall *is* the network boundary. The
404-not-403 contract for an **authenticated** non-allowlisted caller is pinned
in the security tier (it needs a real super-admin-vs-not session the anonymous
e2e deliberately does not build).

### Engineering lesson — retro-fitting the six-gate bar

The Company Intelligence Database **predates** the mandatory six-gate CI
regime (Directive #004). It shipped genuinely production-grade on the model /
service / UI / **unit** axes, yet cleared only **3 of the 6** gates
(typecheck, lint, unit): it had **no** security trust-boundary, real-Postgres
integration, or e2e auth-wall suite — even though the event spine (a later,
less sensitive surface) had all three. The lesson: a module being "done and
shipped" is not the same as it meeting the *current* bar; when the bar rises,
the **most sensitive** surfaces are retro-fitted first. Closing the security
tier touched **zero production code** — it is pure additive coverage that pins
existing, already-correct behaviour, so it is safe under the Foundation's
maintenance-mode / code-freeze. The integration (gate 4) and e2e (gate 6)
tiers were closed the same way — pure additive coverage, **zero production code
touched** — bringing the Company Intelligence Database to the full six-gate bar
the rest of the Foundation already meets.

---

## Validation gate (run before every PR)

```bash
npm run typecheck         # gate 1 — tsc --noEmit — clean
npm run lint              # gate 2 — eslint . — clean
npm run test              # gate 3 — unit suite — green
npm run test:integration  # gate 4 — real-Postgres (CI; self-skips with no DB)
npm run test:security     # gate 5 — trust-boundary invariants — green
npm run test:e2e          # gate 6 — auth wall on the real build (CI)
npm run build             # production build — passes
```

---

## Extending (future phases)

- **Autonomous research / outreach.** Wire an AI employee to call
  `addResearchReport` / `addRecommendation` / `addLocation` / `addChannel`
  with `generated_by = "ai"`. The traceability columns and audit trail
  already exist — no schema change needed.
- **An autonomous worker.** Poll `hq_sales_ai_tasks` via the dequeue index,
  claim a task (`pending → running`), do the work, write `result` +
  `finished_at` (`completed`/`failed`, honouring `retry_count`/
  `max_retries`), and append the matching AI-action timeline event. The
  queue, timing, retries, and dedupe guard are already in place.
- **A real integration.** Flip an `hq_sales_integrations` row to
  `connected` and write link/snapshot rows to `hq_sales_external_records`.
  No schema change.
- **New lead source / channel kind / task type.** `INSERT` into the
  relevant lookup. No deploy.
- **New timeline event type.** Add to `TIMELINE_EVENT_TYPES` +
  `EVENT_LABELS` (and `INTERACTION_EVENT_TYPES` / `AI_ACTION_EVENT_TYPES`
  as appropriate), the DB `event_type` check constraint, and an icon in
  `_components.tsx`.
- **Contact editing.** `updateContact` already exists in the service; it
  only needs an action + form to surface.
