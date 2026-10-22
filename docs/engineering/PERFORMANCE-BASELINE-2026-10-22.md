# CREWFLOW PERFORMANCE BASELINE — REPORT

Diagnostic only (measure → trace → diagnose → rank). No optimization performed. Evidence labelled **FACT** (directly measured / repo-observed), **INFERENCE** (reasoned from evidence), **UNKNOWN** (not measurable with current access).

## 1. Executive summary
CrewFlow's product is, structurally, in good shape — the slowness is **not** broad. It is **concentrated and specific**: one page (`/dashboard`, the post-login landing every user hits) issues **86 database queries per render** (FACT, measured), and **every** authenticated navigation pays a fixed **2× `getUser` GoTrue round-trip** (middleware + render). Local server response (TTLB) confirms `/dashboard` is the clear outlier at **136 ms p50 warm / 379 ms p50 under concurrency**, versus **60–73 ms** for every list page. Because each of those 86 queries is a separate Next→PostgREST HTTP call that pays the Vercel↔Supabase round-trip in production (invisible locally at ~0.1 ms), the dashboard's query *count* is the dominant prod-latency mechanism. The rest of the product (jobs/invoices/customers/quotes/leads lists = **3–4 queries each**) is lean. React re-rendering, client bundle weight, individual slow queries, RLS/SECDEF overhead, and missing indexes are **NOT** material contributors — each was checked and ruled out with evidence. **The lever is query *volume* × RTT, not the security model, not the frontend.**

## 2. Measurement environment
- **SHA:** `main`/prod/local all `2c8625c1` (prod `/api/health` → `sha:2c8625c`, `db:ok`). Migration tip `20261231000000`, aligned across local/main/prod. **FACT.**
- **Deployment measured:** LOCAL production build (`next build && next start` on `:3000`) against the LOCAL Supabase stack (`127.0.0.1:54321`), seeded **Harrison & Cole** rehearsal org (`hc-owner@crewflow.test`).
- **Dataset:** a *small, realistic single org* — ~62 jobs / 50 customers / 36 invoices / 15 quotes across all local orgs; the H&C org is a new-customer-sized dataset. **Limitation (FACT):** query *counts* are structural (volume-independent) and trustworthy; query *latencies* reflect a small org + loopback RTT (~0.1 ms) and are **not** representative of prod magnitude.
- **Method:** `scripts/perf-evidence.mjs` (TTLB: 1 cold + 2 warmup + 20 warm-seq + 20 warm-c=5, p50/p95/p99/max); a `pg_stat_statements` reset→single-authed-request→read per journey (DB fan-out); `next build` route table (bundle); 4 parallel read-only static-analysis agents (Next.js / React / DB / monitoring). Browser (viewport/cache/network): not separately captured — see §6/§19.
- **Authentication:** GoTrue password grant → `@supabase/ssr` chunked cookie (mirrors `e2e/global-setup.ts`). Read-only GETs only; **no data mutated, no prod access, no indexes created.**

## 3. Existing instrumentation (EXISTS / PARTIAL / MISSING)
| Capability | State | Evidence |
|---|---|---|
| Sentry error monitoring | **EXISTS (live in prod)** | `sentry.*.config.ts`; prod `/api/health` `monitoring.enabled:true` |
| Sentry performance tracing | **EXISTS (10% prod)** | `tracesSampleRate: prod?0.1:0.5` (all 3 configs) |
| `/api/health` (liveness/readiness) | **EXISTS (rich)** | `app/api/health/route.ts` (sha, db, crons, monitoring) |
| Uptime monitor (Vercel-independent) | **EXISTS** | `.github/workflows/outage-monitor.yml` (~15 min) |
| Cron/background-job telemetry | **EXISTS** | `lib/ops/cron-telemetry.ts` → `cron_runs.duration_ms`; 47 crons |
| Local perf harness | **EXISTS** | `scripts/perf-evidence.mjs` + `docs/engineering/PERFORMANCE-EVIDENCE.md` |
| `pg_stat_statements` | **PARTIAL** | available locally; manual only, not wired to a script/CI |
| Query-count / fan-out instrument | **PARTIAL** | documented forensics; no reusable committed tool (this report adds one) |
| Web Vitals (field RUM) | **MISSING** | `web-vitals` only transitive via posthog-js; no `useReportWebVitals` |
| Vercel Analytics / Speed Insights | **MISSING** | not a dependency |
| Request-latency / API timing | **MISSING** | `api_request_log` has no duration column; no `Server-Timing` |
| Lighthouse / LHCI | **MISSING** | no config/CI job |
| CI perf gate / bundle budget | **MISSING** | `ci.yml` has no size-limit/perf threshold |
| Bundle analyzer | **MISSING** | no `@next/bundle-analyzer` |
| Load tests (k6/artillery) | **MISSING** | none |
| React profiling | **MISSING** | no `<Profiler>` |
Net: strong **reliability/observability**; thin on **client RUM, request-latency instrumentation, and automated perf gates**.

## 4. Selected journeys (why)
1. **`/dashboard`** — post-login landing; prior leading suspect (~85 queries); heaviest composite.
2. **`/jobs` + `/jobs/[id]`** — core daily workflow; deepest detail page.
3. **`/invoices`** — money surface, high traffic.
4. **`/customers` + `/customers/[id]`** — CRM core; detail aggregates financials+files+comms.
5. **`/quotes`** — sales workflow + the client builder.
6. **`/reports` + `/api/reports`** — aggregate-heavy by nature.
7. **`/api/search`** — cross-entity fan-out by nature (every type queried).
8. **`/me`, `/health-safety`** — representative authed surfaces (and H&S is money-free, a useful contrast).
Selected to span the heaviest composite (dashboard), the lean lists (the bulk of navigation), the deep detail pages, and the two inherently wide endpoints (search, reports) — the spread that explains "feels slow" without testing everything.

## 5. Baseline scorecard (measured; local)
TTLB = server time-to-last-byte (ms). DB = distinct PostgREST data queries for one authed render. LCP/INP/CLS/TTFB(field) = **UNKNOWN** (no prod RUM; local browser timing unrepresentative — §6/§19).

| Journey | TTLB warm-seq p50/p95 | TTLB c=5 p50 | DB queries | Notes |
|---|---|---|---|---|
| `/dashboard` | **136 / 183** | **379** | **86** | the outlier; 5 parallel waves + Suspense briefing |
| `/jobs` (list) | 62 / 71 | 111 | 4 | lean |
| `/jobs/[id]` | — (not TTLB-measured) | — | ~24 (static) | 4 serial waves + Suspense |
| `/invoices` | 61 / 68 | 107 | 3 | lean |
| `/customers` | 60 / 73 | 105 | 3 | very lean |
| `/customers/[id]` | — | — | ~12 (static) | trailing 3 serial services |
| `/quotes` | — | — | 3 | lean |
| `/reports` | 69 / 71 | 148 | 22 | all parallel |
| `/leads` | — | — | 4 | lean |
| `/health-safety` | 64 / 68 | 122 | 12 | — |
| `/me` | 66 / 71 | 120 | 13 | — |
| `/api/health` | 5 / 6 | 6 | 0 | — |
| `/api/search?q=` | 72 / 75 | 141 | 22 | 3 parallel waves, wide fan-out |
| `/api/reports` | 66 / 71 | 123 | ~6 | parallel |
Every route also issues **~10 auth-schema (GoTrue) queries** per request (middleware + render JWT validation). Bundle: **171 kB shared First Load JS**; product routes 172–195 kB; heaviest `/customers/[id]` 195 kB, `/` 198 kB. **FACT.**

## 6. Browser findings
- **Not separately traced.** Authenticated client RUM (LCP/INP/CLS) is **UNKNOWN**: there is no prod field RUM (Web Vitals MISSING), and a local Playwright capture would measure an unrepresentative loopback environment (server ~0.1 ms RTT), not production. **INFERENCE:** since the server TTLB for list pages is 60–73 ms locally and client JS is light (§8/§11), client-side rendering is not the bottleneck; the user-perceived wait is dominated by **server response time**, which in prod is dominated by the per-request DB round-trips (§10). The honest field-RUM gap is the top measurement-infrastructure follow-up (§18).

## 7. Next.js findings
**The layer is well-architected; the committed `docs/ux-rebuild/perf-audit.md` is STALE** (its three headline complaints are all fixed). **FACT:**
- Server-first: zero client `page.tsx`/`layout.tsx` (except the PWA `app/offline/page.tsx`); 188 `"use client"` leaves, none pulling heavy libs into the shell.
- Dashboard reads are **parallelized into 5 `Promise.all` waves** + the ~20–30-query `DailyBriefing` **streams behind Suspense** + a side-effect deferred via `after()` (`dashboard/page.tsx:197-365,445,875-891`) — **not** the old sequential waterfall.
- `React.cache` dedups auth (`server/auth/session.ts`); `staleTimes:{dynamic:30,static:180}` set (`next.config.ts:30`); 55 `loading.tsx` + 42 `Suspense`.
- Heavy libs contained: `@react-pdf`/`xlsx`/`jszip` server-only; `pdfjs`/`WorkflowCanvas` `dynamic ssr:false`; `posthog-js` consent-gated dynamic import.
- **Gaps (not bugs):** middleware calls `getUser()` on **every** matched request *before* the public-route check (`lib/supabase/middleware.ts:99` vs `:120`), so marketing/SEO traffic may pay auth work (cookie-less short-circuit = UNKNOWN); `@dnd-kit` is statically bundled into `/jobs/calendar` (the one heavy lib not code-split); no `optimizePackageImports`/`modularizeImports` (Next defaults cover lucide/framer-motion); no server-data cache (`unstable_cache`/`revalidate` = 0) + 128 `force-dynamic` → every view is full-cost server work.

## 8. React findings
**React re-rendering is NOT a material contributor — by construction. FACT:**
- **No React Context anywhere** (grep: 1 hit, a comment), **no global store** (no zustand/redux/jotai), **server-rendered shell**, and **every un-virtualized list is server-paginated** (customers 200, jobs 100, invoices/inbox 50) so committed trees are bounded. `useVirtualizer` is used exactly where a list is unbounded (HQ `pulse/_feed.tsx`). `React.memo` is unused but moot (no hot/large trees to gate).
- The only reachable per-frame re-render path is the **HQ-only** Pulse feed scroll (unmemoized `motion.div` cards) — admin surface, negligible business impact. Live render COUNTS are UNKNOWN (no profiler run), but the structural verdict is unambiguous: **not the bottleneck.**

## 9. API findings
- Server compute is cheap (list APIs 60–72 ms TTLB locally). **FACT.**
- `/api/search` is a deliberate **22-query** fan-out across 3 parallel waves (every entity type, each an `ilike '%term%'`). `/api/reports` ~6 parallel aggregates. Both parallelized (good) but wide.
- **No per-request/API latency instrumentation** exists on the serving path (no `Server-Timing`, no duration column) — prod API p50/p95/p99 is **UNKNOWN** (the measurement gap, not a code gap).

## 10. Database findings (query fan-out — the core)
**Measured fan-out (FACT, live `pg_stat_statements`):** `/dashboard` **86**, `/reports` 22, `/api/search` 22, `/me` 13, `/health-safety` 12; `/jobs` `/invoices` `/customers` `/quotes` `/leads` **3–4 each**. Static trace corroborates (`/jobs/[id]` ~24, `/customers/[id]` ~12). The dashboard's 86 = many *distinct* reads (invoices×9, quotes×8, jobs×7, invoice_payments×5, memberships×5, customers×4, leads×4, risk_assessments×4, finances×3, …) — one per tile/aggregate, repeated across waves/services for different projections (not deduped, not N+1).

**A–H classification: H (combination), dominated by B × network RTT.**
- **B (too many fast queries) — PRIMARY.** `/dashboard` 86, `/api/search` 22, `/jobs/[id]` ~24. Each ~0.1–7 ms locally; each a separate Next→PostgREST HTTP call paying one Vercel↔Supabase RTT in prod. **This is the slowness.**
- **C (residual waterfalls) — SECONDARY, specific.** Dashboard sequential tail (`readOrgSettings → VAT → payrollTax → stockCogs`; the last two have no real dependency and are needlessly serial, `page.tsx:541-690`); `computeActivitySummary` 4-deep (`lib/ai/aggregates.ts`); `customers/[id]` trailing `financials → files → comms` serial (`:153/159/168`); `jobs/[id]` 4 serial waves.
- **D (repeated auth/org) — bounded.** **2× `getUser`** per nav (middleware + render; render-side deduped by `React.cache` to 1). The "memberships ~388×" is NOT app-level (app reads it 1–5×/render, `React.cache`-deduped) — it is the **DB-level RLS probe**: `current_org_ids()` runs `select org_id from memberships where user_id=auth.uid()` **once per RLS-protected query**, so ~86× on a dashboard render — but indexed, InitPlan, internal to Postgres (no RTT), so **not** the prod driver. **FACT/INFERENCE.**
- **E (RLS/SECDEF overhead) — LOW/well-built.** `current_org_ids()` wrapped as `org_id in (select …)` → InitPlan, once per query (468× across migrations). `is_org_admin(org_id)` IS a per-row SECDEF on the arg — but only on **UPDATE/DELETE** of hot tables and **SELECT of low-row admin/config tables** (marketplace_*, api_keys, ai_*), never on the hot list SELECTs. Not the bottleneck.
- **F (missing indexes) — largely remediated.** `20260709000000_scale_indexes.sql` gives `(org_id, created_at desc)` composites + `(org_id,status)` + pg_trgm GIN on the searched columns; `memberships(user_id)`/`impersonation_sessions` indexed. Residual minor gaps: ~14 secondary `/api/search` tables do `ilike` with **no trigram index** (per-row scans within the org); `quotes`/`leads` list-by-`created_at` without a status filter can't use their status-leading composite.
- **G (overfetch) — present by design.** `fetchAllRows` (PAGE_SIZE 500) reads whole tables and aggregates in JS for money/profit/VAT/retention tiles (dashboard, reports, snapshots, vat, customer financials). Documented launch-horizon choice; grows with org volume.
- **A (individual slow queries): NO evidence.** EXPLAIN pending (UNKNOWN) but every hot shape is indexed.
- **Security: untouched and not implicated.** No recommendation weakens RLS/tenant isolation.

## 11. Bundle / assets findings
**Not the bottleneck. FACT.** Shared First Load JS **171 kB** (a 113 kB + 54 kB vendor pair); product routes add little (most 172–177 kB; heaviest `/customers/[id]` 195 kB, `/` 198 kB, a few admin 200–203 kB). Heavy libs are server-only or lazy (§7). Minor items to confirm in a bundle-analyzer pass (UNKNOWN bytes): `lucide-react` barrel (72 files, relies on Next-default optimizePackageImports), `@dnd-kit` static on `/jobs/calendar`, the non-virtualized `data-table` on 5 list routes (a render/DOM cost at large orgs, not a byte cost). Assets: minimal `next/image` usage, `next/font` swap — no evidence of image/font/CSS being material.

## 12. Load findings
**Not run** (PHASE 11 is gated to after single-user understanding + needs on-demand k6). Methodology proposed in §17/§18: local-only target, safe read-only endpoints (`/api/health`, authed GET `/api/search`/`/api/reports`, `/dashboard`), conservative ramp (≤50 VU), capture throughput/p50/p95/p99/error-rate + **Postgres active-connections vs max** (pool exhaustion is the expected knee, driven by the dashboard fan-out under concurrency — hinted by `/dashboard` c=5 p50 jumping 136→379 ms). **UNKNOWN** until run.

## 13. Top bottlenecks (ranked)
1. **`/dashboard` 86-query fan-out × Vercel↔Supabase RTT** — *Layer: DB/API/network.* *Evidence:* 86 queries measured (FACT); TTLB 136 ms seq → 379 ms c=5 (FACT); parallelized but still 86 HTTP round-trips. *Affected:* every user, every login (the landing page). *Impact:* dominant; local ~136 ms, prod INFERENCE hundreds of ms–>1 s (86 × ~20 ms RTT, pool-bounded in waves). *Confidence: HIGH.* *Fix class (do not implement): collapse tiles into DB-side SQL aggregates / a few RPCs.*
2. **Per-navigation auth: 2× `getUser` GoTrue round-trips** — *Layer: Next/network.* *Evidence:* `lib/supabase/middleware.ts:99` + `server/auth/session.ts:162` (FACT); ~10 auth-schema queries/request (FACT). *Affected:* every authenticated navigation, even lean pages. *Impact:* fixed ~2-RTT floor per page. *Confidence: HIGH.* *Fix class: validate the JWT in middleware without a second full getUser / share the validation across the seam.*
3. **`/api/search` 22-query fan-out + ~14 un-trigram-indexed `ilike` tables** — *Layer: DB.* *Evidence:* 22 queries (FACT); missing GIN (FACT). *Affected:* global Cmd+K search. *Impact:* moderate; per-type scans grow with org volume. *Confidence: HIGH.* *Fix class: narrow the default type set / add trigram indexes / unify into fewer queries.*
4. **All-dynamic rendering + zero server-data cache** — *Layer: Next.* *Evidence:* 128 `force-dynamic`, 0 `unstable_cache`/`revalidate` (FACT). *Impact:* every view is full-cost server work; no amortization; amplifies #1/#2. *Confidence: MEDIUM* (architectural ceiling, partly inherent to RLS-per-user data). *Fix class: short-TTL caching of safely-cacheable org-scoped reads.*
5. **Residual serial waterfalls (C)** — dashboard tail (payrollTax + stockCogs needlessly serial), `customers/[id]` trailing 3 services, `computeActivitySummary` 4-deep. *Confidence: HIGH* (code-visible). *Impact: low–moderate*, additive RTT hops. *Fix class: collapse independent awaits into `Promise.all`.*
6. **`fetchAllRows` whole-table JS aggregation (G)** — scales with org volume (small today). *Confidence: HIGH.* *Impact: low now, high at 10k+ rows/org.* *Fix class: DB-side aggregates.*
**Ruled out (evidence):** React re-render (#8 non-issue), bundle weight (contained), individual slow queries (indexed), RLS/SECDEF correctness cost (InitPlan, well-built), missing indexes on hot paths (remediated).

## 14. Quick wins (low risk, measurable — NOT implemented)
- Collapse the 2 needlessly-serial dashboard tail awaits (`getPayrollTaxProfilesForOrg`, `loadStockCogsCostRows`) into the adjacent `Promise.all` — removes ~2 serial RTT hops on the heaviest page.
- Collapse `customers/[id]`'s trailing `financials → files → comms` into one `Promise.all` — removes ~2 serial hops.
- Add pg_trgm GIN indexes to the ~14 secondary `/api/search` `ilike` tables (index-only change, no app/RLS change) — but see "measure first" caveat (verify seq-scan cost at volume).
- Add `optimizePackageImports` for any non-default barrel dep; make `@dnd-kit` on `/jobs/calendar` a `dynamic` import.

## 15. Structural issues (careful implementation, own slices)
- **Dashboard query-count reduction** (86 → ~10) via DB-side aggregate RPCs for the money/profit/VAT/retention/activity tiles — the single biggest win, but touches data-access for the most-watched page (needs rigorous before/after + RLS-preserving RPCs).
- **Per-navigation auth round-trip reduction** — changing the middleware↔render auth pattern is subtle (must not weaken auth); high blast radius (every page).
- **A server-data caching layer** for safely-cacheable org-scoped reads (short TTL + tag invalidation) — architectural.
- **`fetchAllRows` → SQL aggregates** for the money tiles (removes the volume-scaling overfetch).

## 16. Proposed performance budgets (observe first, then gate)
Honest starting lines for a TTFB-dominated B2B authed ERP; **re-base after 1–2 weeks of prod RUM.** Separate **TARGET** (observe) from **FAIL-CI** (hard gate) — most start as observe-only.
| Metric | TARGET | FAIL-CI (eventually) |
|---|---|---|
| LCP (app routes, mobile p75) | ≤ 2.5 s | observe first |
| INP (p75) | ≤ 200 ms | observe first |
| CLS (p75) | ≤ 0.1 | observe first |
| TTFB (app routes p75) | ≤ 600 ms | observe first |
| Route transition (soft nav) | ≤ 1 s p75 | observe first |
| JS First Load (per route) | ≤ 300 kB (shared ≤ 200 kB — **currently 171 kB ✓**) | **gate now** (cheap, deterministic) |
| API latency | p50 ≤ 150 ms / p95 ≤ 500 ms / p99 ≤ 1 s | observe first |
| DB p95 per query | ≤ 50 ms | observe first |
| **DB queries / journey** | **dashboard ≤ 25, other pages ≤ 10** (today: dashboard **86** ✗) | **gate after #1 lands** |
| Slow-query (>100 ms) count | 0 at customer-#1 scale | observe first |
| Error rate (representative load) | 5xx < 0.5% | observe first |
The two immediately gate-able, deterministic budgets: **per-route First-Load-JS** (already within budget — lock it so it can't regress) and, once the dashboard is fixed, a **queries-per-journey** ceiling enforced by the fan-out harness this report adds.

## 17. Recommended optimisation programme (atomic slices — DO NOT IMPLEMENT)
- **P0 (enabler, no app change): measurement infrastructure.** Web Vitals → Sentry (already armed) / PostHog; Lighthouse CI on a preview; the committed fan-out harness (§18) + a queries-per-journey assertion; a First-Load-JS bundle-budget gate. *Why first:* every later slice must prove BEFORE→AFTER. *Security: none. Tests: CI gates. Metrics: establishes field RUM + the gate.*
- **P1 — Dashboard fan-out (86 → ~10).** *Problem:* 86 per-tile queries × RTT. *Files/arch:* `app/(app)/dashboard/page.tsx`, the money/profit/VAT/retention tile services, `lib/supabase/paginate.ts` usage → new DB-side aggregate RPCs (SECURITY INVOKER, RLS-respecting) or grouped SQL. *Expected:* dashboard prod TTFB −50–70% (INFERENCE). *Security risk:* must keep RLS (RPCs run as caller / `org_id in (select current_org_ids())`). *Tests:* RLS/tenant-isolation integration + a fan-out-count regression + before/after TTLB & query count. 
- **P2 — Per-navigation auth round-trips (2× → ~1).** *Problem:* middleware + render both `getUser`. *Files:* `lib/supabase/middleware.ts`, `server/auth/session.ts`. *Expected:* −1 GoTrue RTT on *every* page. *Security risk:* HIGH sensitivity — must not weaken JWT validation; verify signature locally only if provably safe. *Tests:* full auth/session + security suite; e2e auth-wall. 
- **P3 — `/api/search` fan-out + trigram indexes.** *Problem:* 22 queries + 14 un-indexed `ilike`. *Files:* `app/api/search/route.ts`; a forward-only index migration. *Expected:* search latency −30–50% at volume. *Security risk:* none (indexes). *Tests:* search integration + the migration guards. 
- **P4 — Collapse residual serial waterfalls + money-tile SQL aggregates.** *Files:* dashboard tail, `customers/[id]`, `lib/ai/aggregates.ts`. *Expected:* −2–4 serial RTT hops on two heavy pages. *Security risk:* low. *Tests:* page integration + before/after.
Each slice: atomic branch, before/after metrics required, no security regression, do not bundle.

## 18. Measurement infrastructure changes (this workstream)
- **Added (atomic PR, see §PR):** `docs/engineering/PERFORMANCE-BASELINE-2026-10-22.md` (this durable baseline) + `scripts/perf-fanout.mjs` (reusable, local-only-guarded DB-fan-out harness so every future perf PR can prove BEFORE→AFTER query counts). Diagnostic/infra only — no application code, query, index, RLS, or caching change.
- **Recommended (future slices, not added now):** Web Vitals reporter → Sentry/PostHog; Lighthouse CI job; a bundle-size budget gate; wiring `pg_stat_statements` deltas into the fan-out harness output.

## 19. Unknowns (not provable with current access)
- **Production field RUM** (LCP/INP/CLS/TTFB from real browsers) — no Web Vitals in prod; the #1 gap.
- **Actual Vercel↔Supabase RTT** and whether Vercel functions co-locate with Supabase's region (`vercel.json` pins no `regions`) — the exact multiplier turning 86 cheap queries into prod seconds.
- **Prod API/DB p50/p95/p99** — no serving-path latency instrumentation; Sentry traces at 10% exist in prod but were not queryable from here.
- **Cold-start frequency/duration** (128 force-dynamic routes) — untested.
- **`EXPLAIN (ANALYZE)` plan confirmation** on hot shapes (index-scan vs seq+sort; InitPlan vs per-row) — not run (read-only, no prod).
- **Whether cookie-less marketing traffic pays the middleware `getUser` network call** — needs a running-app network trace.
- **Behaviour at realistic (hundreds-of-companies, thousands-of-rows) data volume** — local is a small org; `fetchAllRows` overfetch and exact-counts scale with volume.

## 20. Final verdict
**What is actually making CrewFlow feel slow (evidence-based hierarchy):**
1. **The dashboard.** The post-login landing page issues **86 database queries per render** (measured), each a Next→PostgREST round-trip that is ~free locally but pays the Vercel↔Supabase network RTT in production. It is the one page every user hits first, and it is 2–6× heavier than everything else even locally. This is the dominant cause.
2. **The fixed per-navigation auth tax:** every authenticated page pays **2 `getUser` GoTrue round-trips** (middleware + render) before any data — a constant floor felt on every click.
3. **The wide search endpoint** (`/api/search`, 22 queries) and a handful of **collapsible serial waterfalls** (dashboard tail, `customers/[id]`) add secondary RTT hops.
Everything else people usually blame — React re-rendering, bundle size, slow SQL, RLS overhead, missing indexes — was checked and is **not** the problem; the product's list pages are genuinely lean (3–4 queries).

**If we fixed only THREE things:**
1. **Collapse the dashboard's 86 queries into a few DB-side aggregates/RPCs** (biggest single win — fixes the page every user lands on).
2. **Cut the per-navigation auth from 2 round-trips to 1** (fixed-cost win on *every* page in the app).
3. **Reduce the `/api/search` fan-out (and add the missing trigram indexes) + collapse the two needless serial waterfalls** (dashboard tail and `customers/[id]`).

Confidence HIGH on the hierarchy; the per-fix magnitudes are INFERENCE until prod RUM + per-query RTT are measured (the P0 measurement slice closes that).

---

PERFORMANCE BASELINE COMPLETE — READY FOR OPTIMISATION REVIEW
