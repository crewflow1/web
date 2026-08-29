# Performance Evidence — measured, local conditions (L12)

**Date:** 2026-08-29
**Harness:** `scripts/perf-evidence.mjs` (zero-dependency; Node fetch + timers)
**Verdict summary:** the roadmap's `<200ms average API` and `<2s page load` targets are **MET under the local conditions defined below** and **UNPROVEN at production topology and at scale**. This document does not claim production performance.

---

## 1. Conditions (exactly what was measured)

| Condition | Value |
|---|---|
| Build | `npm run build` production build, served by `next start` on `http://localhost:3000` |
| App revision | branch `roadmap/final-completion` (web-audit worktree) |
| Database | **local** Supabase stack (`http://127.0.0.1:54321`, Postgres in Docker `supabase_db_crewflow`) |
| Machine | Apple M3, 16 GB RAM, macOS (Darwin 24.2.0), Node v26.8.1 |
| Data | seeded **Harrison & Cole** rehearsal org (`harrison-cole`, 7 members, customer-#1-scale data) — realistic single-tenant volume, not synthetic bulk |
| Auth | real authenticated session: GoTrue password grant as `hc-owner@crewflow.test`, session minted into the `@supabase/ssr` chunked `sb-127-auth-token` cookie (same encoding as `e2e/global-setup.ts`), so all SSR pages render authenticated (verified: `/dashboard` returns 200, not a redirect) |
| Method per route | 1 recorded **cold** request → 2 unrecorded warmups → **20 timed sequential** (concurrency 1) → **20 timed via 5-wide pool** (concurrency 5) |
| Metric | TTLB of the full response body (`fetch` start → body fully drained), `redirect: "manual"` so an auth bounce counts as a failure, never as a fast 30x |
| Percentiles | nearest-rank on sorted samples |

This is deliberately **realistic Customer-#1 scale** (one org, one signed-in owner, ≤5 concurrent requests), not a load test.

## 2. Results

All figures in milliseconds. `warm seq` = 20 sequential requests; `warm c=5` = 20 requests at concurrency 5. Non-200 counts cover all 40 timed samples per route.

| route | kind | cold (ms) | warm seq p50/p95/p99/max (ms) | warm c=5 p50/p95/p99/max (ms) | non-200 |
|---|---|---|---|---|---|
| `/dashboard` | page | 184 | 111 / 123 / 126 / 126 | 319 / 331 / 333 / 333 | 0/40 |
| `/jobs` | page | 69 | 60 / 79 / 81 / 81 | 110 / 127 / 128 / 128 | 0/40 |
| `/invoices` | page | 57 | 58 / 62 / 63 / 63 | 102 / 106 / 106 / 106 | 0/40 |
| `/customers` | page | 56 | 57 / 59 / 61 / 61 | 105 / 120 / 120 / 120 | 0/40 |
| `/me` | page | 121 | 62 / 65 / 65 / 65 | 109 / 119 / 120 / 120 | 0/40 |
| `/reports` | page | 64 | 66 / 71 / 71 / 71 | 137 / 148 / 148 / 148 | 0/40 |
| `/health-safety` | page | 59 | 57 / 64 / 68 / 68 | 110 / 132 / 132 / 132 | 0/40 |
| `/api/health` | api | 6 | 4 / 5 / 5 / 5 | 5 / 7 / 7 / 7 | 0/40 |
| `/api/search?q=fitz` | api | 69 | 66 / 74 / 95 / 95 | 123 / 133 / 135 / 135 | 0/40 |
| `/api/reports` | api | 60 | 65 / 69 / 70 / 70 | 111 / 118 / 118 / 118 | 0/40 |

**Error rate: 0 non-200 responses in 400 timed samples** (plus 10 cold + 20 warmup requests, all 200).

### Postgres query behaviour snapshot (`pg_stat_statements`, reset before the run)

Extension enabled; captured immediately after the run. Top queries by mean execution time (auth-schema inserts excluded from commentary; all app queries via PostgREST):

| calls | mean ms | query (truncated) |
|---|---|---|
| 43 | 1.03 | `SELECT jobs.id, status, scheduled_date …` |
| 44 | 0.97 | `SELECT activity_log.id, actor_id …` |
| 87 | 0.96 | `SELECT memberships.user_id, role …` |
| 44 | 0.88 | `SELECT jobs.id, status, scheduled_date …` (variant) |
| 44 | 0.85 | `SELECT jobs.id, status, assigned_to …` |
| 44 | 0.74 | `SELECT jobs.id, assigned_to, scheduled_date …` |
| 44 | 0.70 | `SELECT quotes.id WHERE org_id = …` |
| 44 | 0.67 | `SELECT customers.id WHERE org_id = …` |
| 388 | 0.46 | `SELECT memberships.org_id, role …` (per-request auth/org read) |
| 388 | 0.01 | `SELECT finances.id, amount …` (and 2 more finance-family queries at 388 calls each) |

Two structural observations, both consistent with the known production history:

1. **Every individual query is fast locally** — the slowest app query averages ~1 ms; nothing pathological in the planner.
2. **The fan-out is real and visible**: the harness issued ~430 page/API requests but Postgres served **~8,000 PostgREST queries** (~18 per request on average; several queries ran 388 times, i.e. on effectively every authenticated request, and `/dashboard` alone triggers ~9+ distinct query families per render). At ~0.1 ms local round-trip this is invisible; at Vercel↔Supabase round-trip latency (order 5–30 ms each) the *same* fan-out is exactly the mechanism previously measured to turn a cheap-locally dashboard into a seconds-long production render (dashboard ≈85 queries/render at its worst; memberships re-read per route — see the product+HQ perf finalisation history).

## 3. Verdicts vs roadmap targets — under these conditions only

| Target | Result under local conditions | Classification |
|---|---|---|
| `<200 ms` average API response | `/api/health` mean ~4 ms, `/api/search` ~66 ms, `/api/reports` ~65 ms warm-sequential; worst API sample anywhere (incl. cold, incl. c=5) = 135 ms | **MET — under local conditions** |
| `<2 s` page load | Worst page sample of the whole run = 333 ms (`/dashboard`, c=5 max); worst cold = 184 ms; all warm p99s ≤ 148 ms sequential / ≤ 333 ms at c=5 | **MET — under local conditions** (server TTLB; see caveat 2) |
| Either target **in production** (Vercel ↔ Supabase) | not measured here | **UNPROVEN** |
| Either target **at scale** (>1 org, >5 concurrent, cold serverless) | not measured here | **UNPROVEN** |

## 4. Caveats — read before citing these numbers

1. **This is not production topology.** App and database shared one M-series machine over loopback; network round-trip is ~0.05 ms. Production is Vercel serverless ↔ hosted Supabase, where per-query RTT is orders of magnitude higher and the measured ~18-queries-per-request fan-out multiplies directly into user-visible latency. The dashboard query fan-out has *already* been observed to cost seconds in production while being cheap locally. Local numbers therefore bound the compute cost, not the production experience.
2. **"Page load" here = server TTLB of the SSR HTML document**, fetched programmatically. It excludes client-side JS download/parse/hydration, images, and fonts. A real-browser `<2s` claim (LCP/TTI) would need a Lighthouse/WebVitals pass; that is not this harness.
3. **No serverless cold starts.** `next start` is a warm long-lived process; the "cold" column is first-hit route instantiation, not a Vercel lambda cold start.
4. **Concurrency 5, one tenant.** Deliberately Customer-#1 scale. Nothing here speaks to multi-tenant contention, connection-pool exhaustion, or RLS cost at data volumes beyond the seeded org.
5. Numbers vary run-to-run by a few ms; treat them as a band, not a constant.

## 5. Reproduce

```sh
# local Supabase up, harrison-cole org seeded
npm run build && npm run start &
docker exec supabase_db_crewflow psql -U postgres -d postgres -c 'select pg_stat_statements_reset();'
node scripts/perf-evidence.mjs          # markdown table on stdout
docker exec supabase_db_crewflow psql -U postgres -d postgres \
  -c 'select calls, mean_exec_time, query from pg_stat_statements order by mean_exec_time desc limit 10;'
```

The harness refuses non-local targets, performs only read-only GETs, and mutates nothing.
