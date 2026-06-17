# Sales AI Platform — engineering reference (CEO Directive 003, Phase 1)

The Sales AI Platform is the company-intelligence database, AI research
store, pipeline, and activity feed that powers the CrewFlow sales engine.
It is an **HQ-only** feature: nothing here touches the customer product,
customer workflows, or any tenant table.

> **Foundation only.** This phase builds the data model, the audited
> operator surface, and the AI-traceability primitives. **No code in this
> module calls a model provider, runs research autonomously, or sends
> outreach.** AI-authored artifacts simply carry `generated_by`, `model`,
> and `ai_employee_id` so future autonomous work is traceable from day
> one. Humans drive every write.

---

## Layers

The platform is a clean four-layer stack. Each layer imports only from the
layer below it.

| Layer | File | Responsibility |
|---|---|---|
| **Model** | `lib/sales/model.ts` | Pure, server/client-safe vocabulary + maths. No Supabase. Statuses, timeline kinds, seniority, likelihood/risk bands, scoring, funnel maths, facet aggregation, currency/score formatting. |
| **Service** | `server/services/hq-sales.ts` | `server-only`. Service-role data access over the six `hq_sales_*` tables. Search, detail load, dashboard, analytics, and the audited write functions. |
| **Actions** | `app/admin/sales/actions.ts` | `"use server"`. The nine state-changing entry points. `requireAdmin()` → validate → service → `recordAdminActivity()` → `revalidatePath()` → `redirect()`. |
| **UI** | `app/admin/sales/**` | Server components only (no client JS). Dashboard, search, company detail, analytics, activity, and the create/edit form. Styling lives in `_styles.ts`; primitives in `_components.tsx`. |

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
- **Action gate (defence in depth).** Every one of the nine server
  actions independently calls `requireAdmin()`, which re-runs
  `requireUser()` and redirects non-super-admins to `/dashboard` **before
  any write**. A request that reaches an action URL directly is still
  blocked.
- **Database gate.** All six `hq_sales_*` tables `enable row level
  security` with **zero policies** → service-role-only. The anon/customer
  JWT client cannot read or write a single row. The service layer is
  `server-only` and uses `createAdminClient()` exclusively.
- **Audit.** Every mutation writes a `public.admin_activity_log` row via
  `recordAdminActivity({ actorId, actorEmail, action, targetTable,
  targetId, metadata })` **and** appends a per-company timeline event (the
  company's own audit trail). The two together mean every change — human
  or AI-attributed — is fully traceable.

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

---

## Database schema

Migration: `supabase/migrations/20260714000000_hq_sales_ai.sql`. Six
tables, all RLS-on / zero-policy, plus a seeded extensible lookup.

| Table | Purpose |
|---|---|
| `hq_sales_companies` | The master company-intelligence record — identity, geography, contact + social links, Companies House, website technology, CRM + AI scores, pipeline status, source, assignment, tags. Carries a generated `search_tsv` (tsvector) with a GIN index for full-text search. |
| `hq_sales_contacts` | Decision-makers per company — name, title, seniority, email/phone/LinkedIn, primary + decision-maker flags. |
| `hq_sales_research_reports` | **Permanent** AI/human research — summary, pain points, likelihood score + band, estimated software spend, best angle, opening line, recommended follow-up, risk assessment + level. Optional `memory_id` once promoted to Shared Memory. |
| `hq_sales_recommendations` | Why-buy, key features, likely objections, recommended pricing/plan, best salesperson, best time to call, follow-up schedule. One `active` row per company; older ones become `superseded`. |
| `hq_sales_timeline_events` | The per-company chronological timeline **and** the global activity feed — interactions (email/call/LinkedIn/…) and lifecycle markers (created/research/recommendation/status_change/system). |
| `hq_sales_sources` | Extensible lead-source lookup (slug → label, category). "New lead sources are data, not code." Seeded with 10 sources. |

**Lead sources are data, not code** — adding a source is an `INSERT`, not
a deploy.

### Indexing for scale

- `search_tsv` GIN index backs keyword search.
- B-tree indexes on `status`, `industry`, `county`, `region`, `source`,
  `assigned_to_email`, `ai_qualification_score`, `last_researched_at`,
  `created_at`, and the `tags` / `website_technology` arrays (GIN) — so
  every search facet and sort hits an index.
- Timeline is indexed by `company_id` and `occurred_at`.

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
- **Timeline events** are either `interaction` (a logged touch) or
  `lifecycle` (an engine-emitted milestone); `eventCategory` decides.

---

## Pages & routes

All under `/admin/sales` (super-admin only):

| Route | What it does |
|---|---|
| `/admin/sales` | Command dashboard — status counts, funnel, win/close rates, pipeline + won value, weekly/monthly activity, AI productivity (30-day), headline facets, recents. |
| `/admin/sales/companies` | Search — keyword (FTS) + every structured facet (status, industry, county, region, source, salesperson, tag, technology, size band, min AI score) + sort, server-paginated. |
| `/admin/sales/companies/new` | Create a company. |
| `/admin/sales/companies/[id]` | Company detail — intelligence panel, contacts, permanent research reports, recommendations, full timeline, and every inline (audited) write form. |
| `/admin/sales/companies/[id]/edit` | Edit the master record. |
| `/admin/sales/analytics` | Funnel + conversion, win/close rates, open-pipeline value, and the full facet set (status, source, salesperson, county, region, industry, size). |
| `/admin/sales/activity` | The global, day-grouped activity feed across all companies. |

URL params drive search, sort, pagination, and the activity window, so a
refresh or shared link restores the exact view.

---

## AI traceability

Every artifact that an AI could author records:

- `generated_by` — `ai` or `human`.
- `model` — the model string (only when `generated_by = ai`).
- `ai_employee_id` — FK to `public.ai_employees` (only when AI-authored).

The operator UI only sets `model` / `ai_employee_id` when "AI" is chosen;
the action enforces this (a human-authored report cannot carry an AI
attribution). When AI work eventually runs autonomously, these columns
are already the source of truth for "which AI did this, with which model".

---

## Shared Memory bridge (Directive 002 integration)

A research report can be **promoted** into the company-wide Shared Memory
Engine (`promoteResearchAction` → `promoteResearchToMemory`), so its
findings become reusable knowledge every AI employee can read. The bridge
is:

- **Opt-in** — an operator clicks "Promote to Shared Memory".
- **Idempotent** — a report already linked to a memory returns the
  existing `memory_id`.
- **Audited** — emits `hq_sales.research_promoted` + a `system` timeline
  event linking the new memory.
- **Linked** — the report stores `memory_id`; the detail page then links
  straight to `/admin/memory/[id]`.

---

## Testing

`__tests__/admin/sales-ai.test.ts` (49 tests) covers:

1. **Authorization boundary** — all nine actions, for unauthenticated and
   non-allowlisted callers: each redirects and writes nothing.
2. **Super-admin happy paths** — create/update/status/contact/delete/
   research/recommendation/interaction: the correct table write **plus**
   the matching `admin_activity_log` audit row, with AI attribution
   suppressed for human-authored artifacts.
3. **Validation** — empty name, bad status enum, non-UUID id, missing
   contact name, non-interaction event type: all rejected before any
   write.
4. **Pure model logic** — funnel/win/close maths, facet aggregation,
   pipeline value, activity windows, scoring/likelihood/size banding, and
   the formatting/parsing helpers.

Supabase admin is a queue-based chainable stub; `redirect()` is stubbed to
throw (mirroring Next.js halting the action).

---

## Validation gate (run before every PR)

```bash
npm run typecheck   # tsc --noEmit — clean
npx next lint       # ESLint — clean
npx vitest run      # full suite — green
npm run build       # production build — passes
```

---

## Extending (future phases)

- **Autonomous research.** Wire an AI employee to call `addResearchReport`
  / `addRecommendation` with `generated_by = "ai"`. The traceability
  columns and audit trail already exist — no schema change needed.
- **New lead source.** `INSERT` into `hq_sales_sources`. No deploy.
- **New timeline event type.** Add to `TIMELINE_EVENT_TYPES` + `EVENT_LABELS`
  (and `INTERACTION_EVENT_TYPES` if a human can log it) and an icon in
  `_components.tsx`.
- **Contact editing.** `updateContact` already exists in the service; it
  only needs an action + form to surface.
```

