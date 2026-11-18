# Free performance optimisation — 2026-11-17

Branch `perf/free-optimisation` (base `integration/launch-batch` @ `ff708c60`). Founder decision: paid load
testing is cancelled, so this pass used only existing resources: read-only production statistics, the
isolated local stack `cffresh`, and the k6 harness from `perf/load-harness-and-staging`. Nothing was
provisioned, bought, or run against any hosted system.

**Capacity statement.** Every latency figure below was measured on **one laptop** (Apple silicon, 16 GB,
shared with other agents) running Next.js, the whole Supabase stack and the load generator over loopback.
**No hosted capacity was measured or verified.** Nothing here supports any claim about how many concurrent
users production can serve, and in particular **nothing here supports a 50,000-concurrent-user claim.**
The production section reports read-only database statistics, not load.

Evidence labels: **VERIFIED** = I ran it and saw it · **SIMULATED** = local with an injected delay · **PROPOSED** = not done.

---

## 1. Production evidence (read-only, `supabase db query --linked`, 2026-11-17 00:39–01:11 UTC)

No writes, no `EXPLAIN ANALYZE`, no row data. `pg_stat_statements` **is enabled** (v1.11), cumulative since
2026-08-25 (~84 days, 9.79 M calls, 12.3 h total execution). To separate history from the present I took
three snapshots and diffed them (a 30-minute live window, 00:40→01:10).

### 1.1 Findings — top 5

| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | **Historical #1 consumer already fixed.** `cron_runs … order by started_at desc limit 200` (HQ monitoring sweep): 7,434 calls, **mean 2,306 ms, 38.7 % of all-time DB time** (plus the 288-call variant at 2,461 ms and the windowed variant at 112 ms ×41,810 = 10.6 %). | Plain `EXPLAIN` today: `Index Scan using cron_runs_started_idx` (added by `20261232000000`). Live window: 117–126 ms per call, 2 calls in 30 min. | VERIFIED fixed; no action |
| 2 | **Production DB is essentially idle.** Live window: **8.2 s of execution in 30 min (~0.45 % of one core)**; 99.7 % `service_role` (crons/HQ), **25 ms** from `authenticated`/`anon` user traffic. Cache hit 99.94 % heap / 99.83 % index / 99.96 % database; 22 of 60 connections in use (11 idle PostgREST). DB size 549 MB. | snapshot diff; `pg_statio_user_tables`, `pg_stat_database`, `pg_stat_activity` | VERIFIED |
| 3 | **Production cannot reveal tenant hotspots yet**: tenant tables are near-empty (jobs 1, customers 2, activity_log 24 rows). Every table over 10k rows is internal telemetry: `cron_runs` 169k (176 MB), `hq_timeline` 94k (180 MB), `hq_events_*` partitions 16–33k, `hq_ai_tasks` 31k. | `pg_stat_user_tables` | VERIFIED — tenant hotspots must come from local load (§2) |
| 4 | **Current top consumers are two every-minute HQ functions**: `hq_spine_golden_signals()` 44.5 ms × 30/30 min (16 %) and the spine consumer drain (`p_consumer, p_max_events, …`) 42.7 ms × 30 (16 %); `cron_runs` INSERT 5.4 ms × 242 (16 %; 841k inserts all-time, each maintaining **4 indexes**); `tenant_search_documents` INSERT **92 ms mean** × 12 (13 %). | snapshot diff | VERIFIED — low absolute cost; see §5 |
| 5 | **Index hygiene (no action taken).** 626 non-unique indexes have `idx_scan = 0` (59 MB) — overwhelmingly on empty pre-launch tenant tables, so not evidence of waste. Large never/barely-used: `hq_timeline_search_idx` 28 MB (0 scans), `hq_events_*_actor_type_actor_id_ts_idx` ~14 MB total (0), `cron_runs_route_started_idx` 31 MB (113 scans), `cron_runs_pkey` 16 MB (2). ≥20 exact duplicate index pairs (unique constraint + same-key plain index, e.g. `job_document_versions_doc_idx`, `stock_movements_corrects_idx`, `risk_assessments_series_idx`) — all on tiny tables. | `pg_stat_user_indexes`, `pg_index` | VERIFIED; drops PROPOSED as a reviewed follow-up (drops are not additive) |

Also: `hq_ai_tasks` exact-count reads (HQ admin pages, `count: "exact"`) average 300–400 ms all-time
(e.g. 698 calls × 329 ms) — internal, low frequency. `pg_timezone_names` (PostgREST/Studio introspection)
742 ms × 153 — platform, not app.

---

## 2. Local measurements — **local laptop only**

**Conditions.** Production build (`next build && next start`, `:3000`, via `heavy.sh`) of this branch,
against `cffresh` (ports 553xx, reset with `supabase db reset`, migration tip `20261366000000`; after-run
also had `20261367000000` applied). Dataset: harness seed `--orgs 25 --tag lt1` (heavy-tailed tiers;
195 memberships, 1,021 customers, 2,064 jobs, 1,446 quotes, 1,008 invoices, 16,772 activity rows,
~38k notifications from seed triggers; 40,054 seeded rows), re-seeded from a reset before each k6 run.
Fan-out per request = server-side outbound trace (`scripts/load/trace-fetch.cjs`, plus a scratch variant
that also records each call's start offset so the **sequential depth** — back-to-back round trips — can
be computed: depth(call) = 1 + max depth of calls that finished before it started).

Why depth matters: on loopback a Supabase round trip costs ~0.1 ms, so local latency is CPU-bound and
cannot show round-trip savings. On hosted infrastructure each **sequential** round trip pays one
app↔database RTT; parallel calls overlap. Depth is the deterministic, laptop-independent measure.

### 2.1 Sequential profile — owner of org 3, full-document GET, 8 timed requests per route

| route | Supabase calls / req | depth before → after | server p50 ms before → after (loopback) | server p50 ms with **10 ms injected RTT**, before → after (SIMULATED) |
|---|---|---|---|---|
| `/dashboard` | 82 → 82 | **20 → 15** | 187 → 197 | **366 → 271 (−26 %)** |
| `/jobs/[id]` | 53 → 53 | **11 → 9** (12 → 10 once the job has invoices) | 96 → 90 | **232 → 190 (−18 %)** |
| `/customers/[id]` | 19 → 19 | **13 → 8** | 84 → 67 | **277 → 165 (−40 %)** |
| `/invoices/[id]` | 11 → 11 | **8 → 6** | 79 → 64 | **176 → 132 (−25 %)** |
| `/reports` | 32 → 32 | 7 → 6 | 80 → 69 | 159 → 139 (−13 %) |
| `/api/reports` | 29 → 29 | 8/9 → 7/8 | 76 → 67 | 166 → 145 (−13 %) |
| control: `/me`, `/jobs`, `/customers`, `/quotes`, `/health-safety` | unchanged | unchanged | ±5 | 151→150, 118→118, 117→118, 119→118, 116→113 |

The SIMULATED column ran both builds back to back against the same database state, with a scratch preload
that delays every Node-runtime fetch to the local Supabase API by 10 ms (middleware auth not delayed). The
unchanged control routes show the comparison is stable. 10 ms is an illustrative RTT, **not** a measured
Vercel↔Supabase figure.

### 2.2 k6 — `local` stage (harness cap for local: 100 sessions, think ×1), before vs after

| metric (peak hold unless noted) | before (`20261117T004959Z`) | after (`20261117T010124Z`) |
|---|---|---|
| arrival rate | 15.4 req/s | 16.1 req/s |
| all requests p50 / p95 / p99 | 105 / 223 / 301 ms | 105 / 233 / 306 ms |
| pages p50 / p95 / p99 (whole run) | 99 / 196 / 293 ms | 97 / 194 / 273 ms |
| server actions | 167 / 287 / 407 ms | 164 / 314 / 429 ms |
| API | 76 / 165 / 259 ms | 74 / 150 / 212 ms |
| 5xx | 0.14 % | 0.05 % |
| tenant isolation | 0 violations / 2,124 scanned; canaries 47/47 refused | 0 / 2,165; 45/45 |
| Postgres connections peak | 30 / 100 | 33 / 100 |
| CPU peak (100 % = 1 core) | Postgres 178 %, GoTrue 99 %, Next 119 % | Postgres 152 %, GoTrue 107 %, Next 158 % |
| dashboard depth under load (server trace) | 29 | 24 |
| `/jobs/[id]` RSC depth / server p50 under load | 10 / 131 ms | 8 / 112 ms |

**Reading it honestly:** under the realistic local load the whole-request percentiles are **unchanged
within noise** (machine load average 1.6 → 3.6 between runs from other agents). That is expected: the
fixes remove round trips, which cost ~nothing on loopback. Per-route server percentiles (from the trace)
are in the run folders (`load/results/…`, gitignored).

**Both runs FAIL the harness's `business_errors < 5 %` threshold (23.8 % / 22.9 %) for reasons unrelated to
performance:** (a) 109–115 × `POST /api/jobs/[id]/photos` → **415** "could not be processed as an image" —
the RC now re-encodes uploaded photos and the harness's synthetic upload bytes are not a decodable image
(harness fixture needs a real JPEG; SCALE agent); (b) 2–6 × `PUT /api/schedule/[id]` → **500** from check
constraint `jobs_span_forward` (the harness moves a start past the end; the route maps a validation error
to 500 instead of 4xx — P3).

---

## 3. Fixes (commits `29554154`, `97b0c4ea`)

All fixes keep queries, active-org pins, RLS and loud-read semantics identical. Each early-started read
sits behind the same org-pinned existence gate as before and is still awaited — and its error still thrown —
at its original site; `.catch(() => {})` only marks the in-flight promise handled so an earlier throw cannot
leave an unhandled rejection.

1. **`/dashboard`** (`app/(app)/dashboard/page.tsx`): org settings → VAT-quarter inputs (chained on the
   one real dependency, `vat_scheme`), payroll tax profiles and stock COGS now start with the five data
   waves instead of serially after them. Depth 20 → 15.
2. **`/jobs/[id]`** (`app/(app)/jobs/[id]/page.tsx`): the cost wave (time entries / hourly pay / stock COGS)
   and the commitment wave (retention releases / purchase orders) start alongside the summary wave.
   Depth 11 → 9.
3. **`/customers/[id]`**: history rollups, money rollup, portal files and comms timeline start together
   after the customer + portal-token gate (both unchanged and still first). Depth 13 → 8.
4. **`/invoices/[id]`**: job picker, payments and line-item snapshot start together after the org-pinned
   invoice read. Depth 8 → 6.
5. **`vatPerQuarter`** (`lib/reports/aggregates.ts`, `/reports` + `/api/reports`): org settings read
   overlaps the finances read. Depth −1.
6. **Migration `20261367000000_activity_log_org_feed_idx.sql`** — `activity_log (org_id, created_at desc,
   id desc)`. The dashboard feed orders by `created_at desc, id desc`; with no index supplying that order
   the planner walks the **global** `activity_log_created_at_idx` backwards and filters on org, so a quiet
   tenant's feed cost grows with every other tenant's activity. Local `EXPLAIN ANALYZE` (small org):
   **6.2 ms, 2,976 rows removed by filter → 0.16 ms index scan, no sort**. Under k6 this read family had
   the highest mean of any app query (~15 ms vs 1–2 ms). Additive, idempotent, query unchanged; production
   build is instantaneous (24 rows). Rollback: `docs/engineering/release/rollback-20261367000000.sql`.
   **Applied to `cffresh` only** (not the shared local DB, not production).

Guard ledger: two F-1 bare-select allowlist anchors re-keyed with notes (same reads moved verbatim):
`jobs/[id]#retention_releases` and `invoices/[id]#invoice_payments`.

Considered and **not** changed: the second `GET /auth/v1/user` on every authenticated request (middleware +
render — 2 sequential auth round trips, 17–40 ms each locally, the slowest calls on every route). Removing it
means trusting a middleware-derived identity or switching to local JWT verification — a security boundary,
so reported, not touched.

---

## 4. Tests run

- `npm run typecheck` (heavy.sh): pass. `npm run build` (heavy.sh): pass. ESLint on changed files: clean.
- Targeted security (14 files incl. F-1 guards, loud-read, active-org, portal file scope, job budgets): 501 pass
  after the two honest re-anchors.
- Targeted unit (19 files touching the edited pages / loaders / reports): 412 pass.
- Integration on `cffresh` (active-org list scoping, reports windowed aggregates, audit-log grant lockdown,
  customer snapshot members): 153 pass.
- Full unit suite (heavy.sh): **777 files / 12,563 tests pass**. Full security suite (heavy.sh): **366 files / 8,941 tests pass**.

---

## 5. Remaining hotspots, ranked

1. **Two sequential Auth round trips per authenticated request** (middleware `getUser` + render `getUser`).
   Largest per-request cost locally and on every route; security boundary → founder/lead decision
   (options: `getClaims()` local JWT verification with asymmetric keys, or a verified hand-off). PROPOSED.
2. **`/notifications` is an unbounded read**: `getLatestNotificationsForCustomer` pages the org's *entire*
   notification history (F-1 "complete" by design, to derive counts). Seed triggers alone produce up to
   12k notifications for a large org; that page renders in **678 ms locally** (org 23) vs ~255 ms for a
   small org, and grows forever (no retention). Fix = page the list (latest N + "load more") and take counts
   from `count: "exact", head: true` (`getUnreadCountForCustomer` already exists). Product + F-1 contract
   change → PROPOSED.
3. **`computeActivitySummary` (`lib/ai/aggregates.ts`) reads activity_log → quotes → invoices → jobs
   serially** — now the dashboard's critical path (3 of its 15 hops) and also `/insights`. A `Promise.all`
   would take the dashboard to ~12. File is AI-agent-owned → PROPOSED to that owner. Its
   `order by id` on a `created_at` window also lets the planner walk the pkey for large orgs (6.6 ms
   locally); ordering by `created_at, id` would ride the existing index.
4. **Dashboard fan-out**: 82–92 Supabase calls per full render (≈ 30 independent module reads in the
   briefing/insights section). Depth is now the smaller problem; the call count costs DB work per landing.
   Consolidating into one or two read-only RPCs is the next lever — larger change, PROPOSED.
5. **`/jobs/[id]` duplicate panel reads**: ~12 module tables are read twice per render (timeline panel +
   each module panel, different column sets; parallel, so no depth cost). Sharing one read per table would
   cut ~20 calls. PROPOSED.
6. **Server actions are deep**: `POST /quotes/[id]` depth 18, `POST /jobs/new` 15, `POST /quotes/new` 13
   (3 auth calls each: action + re-render). Worth the same overlap treatment. PROPOSED.
7. **Production internals (low absolute cost today)**: every-minute `hq_spine_golden_signals()` and spine
   drain (~43 ms each), `tenant_search_documents` insert 92 ms, `cron_runs` 4 indexes × ~10k inserts/day with
   two of them (`route_started` 31 MB, `pkey` 16 MB) barely scanned. Index drops are reviewed follow-ups.
8. `/invoices/[id]` job picker (`jobs … limit 50`) is RLS-scoped but not active-org pinned — a multi-org user
   could see another org's jobs in the picker. Not performance; flagged for the security owner.

## 6. Reproduce (local only)

`supabase db reset` (cffresh) → `node scripts/load/seed.mjs --orgs 25 --tag lt1 --db $DB_URL` →
`heavy.sh npm run build` (with `fresh-env.sh` sourced) → `heavy.sh bash scripts/load/run-local.sh local 1 lt1`
(the run for this report used a scratch copy that points the collector at the `*_cffresh` containers and
loads the depth-recording tracer variant; scratch tooling is not committed).
