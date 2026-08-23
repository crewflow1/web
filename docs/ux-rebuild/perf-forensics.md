# Performance forensics — BEFORE baseline (product UX finalisation)

Measured on a **production build** (`next build` + `next start`) against the local
Brightwork seed, Supabase at 127.0.0.1 (NO tunnel — the prior review's tunnel was
the dominant confound and is excluded here). Owner account `demo@brightwork.example`.

Two independent measurements:
- **Route timing** (Playwright, prod server, median of 3 warm full loads): TTFB /
  DCL / load, and client JS transferred.
- **Query count** (Node `fetch` of each route with the auth cookie, counting the
  Supabase Kong access log `/rest/v1` + `/auth/v1` lines fired by ONE server
  render). A raw fetch counts only the render's queries — no browser prefetch noise.

Why query count is the headline metric: locally each Supabase round-trip is ~1ms,
so even 85 queries render in ~290ms and the app "feels fast" here. On
Vercel↔Supabase each round-trip is ~20–40ms, so a route's **sequential** query
count is the real-world latency driver. This is why the app "still feels slow" on
the prod preview despite fast local TTFB.

## BEFORE — query counts per route (the smoking gun)

| Route | REST q | auth q | local ms | worst duplication |
|---|--:|--:|--:|---|
| **Home `/dashboard`** | **85** | 2 | 293 | invoices×9 quotes×8 jobs×7 memberships×6 invoice_payments×5 leads×4 customers×4 risk_assessments×4 organizations×3 finances×3 |
| **Job `/jobs/[id]`** | **51** | 2 | 133 | memberships×4 quotes×4 jobs×3 job_documents×3 + 10 section reads ×2 |
| Site `/health-safety` | 14 | 2 | 101 | risk_assessments×5 memberships×2 |
| Sales `/customers/[id]` | 16 | 2 | 113 | customers×3 memberships×2 conversations×2 |
| Settings | 10 | 2 | 117 | memberships×3 organizations×2 |
| Ops `/stock` `/fleet` | 7 | 2 | 96 | memberships×2 |
| Money `/invoices` `/finances` | 5–6 | 2 | 87 | memberships×2 |
| Sales `/customers` `/quotes` | 5 | 2 | 95 | memberships×2 |
| People `/staff` | 5 | 3 | 77 | memberships×3 |
| Projects `/jobs` (list) | 6 | 2 | 101 | memberships×2 jobs×2 |
| Money `/vat`, People `/timesheets` | 0 | 1 | ~50 | (deferred/empty) |

Route TTFB is 58–115ms everywhere (prod server, warm) — the **server is not the
bottleneck**; the query fan-out is.

## Systemic root causes (fix these before route hacks)

1. **`memberships` re-read 2–6× on every route + `organizations` 2–3×.** The
   auth/org shell resolved memberships twice (getOrgForUser + listOrgsForUser) plus
   a separate organizations single(), and pages re-read memberships for staff
   pickers. React.cache() dedupes a single function, not distinct functions reading
   the same table. → **FIXED**: one cached `loadMembershipsWithOrgs` (memberships +
   embedded organizations) shared by both auth callers. Removes ~2–3 queries from
   EVERY route. (server/auth/session.ts)

2. **Dashboard fires 85 queries** — the landing page. Heavy duplication
   (invoices×9, quotes×8, jobs×7): independent money/pipeline tiles each re-fetch
   the same base tables, largely awaited sequentially. → dedupe shared reads +
   parallelise independent ones + defer below-the-fold tiles behind Suspense.
   Preserve money/VAT freshness (parallelise, never cache stale).

3. **Job page fires 51 queries** — many section reads awaited sequentially. →
   parallelise independent section reads; the heavy below-the-fold sections already
   stream behind a Suspense boundary (prior wave) — extend the dedupe.

4. **Perceived cost**: first navigation to a route waits the full server round-trip
   with no feedback if the route lacks a loading state; on Vercel that's the query
   fan-out × per-query latency. Addressed by (2)/(3) + route-level loading skeletons
   (Phase 3).

## AFTER — same production-build measurement

### Fix 1 — auth/org consolidation (helps EVERY route), measured query drop:

| Route | REST before → after | note |
|---|---|---|
| `/jobs` | 6 → **4** | memberships ×2 → gone |
| `/customers` | 5 → **3** | " |
| `/quotes` | 5 → **3** | " |
| `/invoices` | 5 → **3** | " |
| `/finances` | 6 → **4** | " |
| `/staff` | 5 → **3** | " |
| `/stock` `/fleet` | 7 → **5** | " |
| `/suppliers` | 5 → **3** | " |
| `/settings` | 10 → **8** | memberships ×3→×2, organizations ×2→gone |
| `/health-safety` | 14 → **12** | " |
| `/customers/[id]` | 16 → **14** | " |

Every common route now issues **~2 fewer** Supabase round-trips — a 30–40% cut on
the light routes. `memberships`/`organizations` are read ONCE per render.

### Fix 2 — dashboard wave-merge + streaming (the landing page)
- **Structural, not a count cut** (I parallelised + streamed, didn't drop reads):
  the ~30 page-body reads now fire in **ONE concurrent `Promise.all` wave instead
  of FIVE sequential waves**, and the ~50-read `DailyBriefing` now **streams behind
  `<Suspense>`** — it no longer blocks the KPI grid's first paint.
- Local wall-clock barely moves (293→257ms) **because the local DB is ~1ms away**,
  which masks the waterfall; on Vercel↔Supabase (~20–40ms/RTT) collapsing 5 waves →
  1 and streaming 50 reads off the critical path is worth **seconds** of first-paint.
  The true delta is verified on the Vercel preview (below).
- **Correctness preserved**: live smoke of `/dashboard` renders every KPI tile,
  computes VAT/receivables/retention/payroll identically, **zero console errors**.
  No read removed, nothing cached, money/VAT stay live.

### Deliberately NOT done (correctness > caching)
- The cross-service duplication (invoices×9 / quotes×8: `buildOrgCash`,
  `buildRetentionSnapshot`, `gatherVatQuarterInputs` each re-read the same base
  tables) would cut the dashboard's TOTAL query count, but it means threading
  page arrays into **financial services** — a staleness/correctness risk on VAT/
  cash/retention. Since `DailyBriefing` (which holds `buildOrgCash`) now streams,
  those reads are already off the critical path, so the risk isn't worth the gain.
  Flagged as a separately-reviewed follow-up.
- The job-page W2/W3/W4 merge is a smaller (~2-wave) gain on an already-Suspense-
  streamed page; assessed against the transcription risk of reproducing its
  profitability queries.
