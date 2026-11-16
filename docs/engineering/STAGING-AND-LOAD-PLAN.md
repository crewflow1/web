# Staging environment & progressive load plan (to 50,000 concurrent users)

**Status: PROPOSAL — NEEDS-FOUNDER approval before anything is created or bought.**
Nothing in this document has been provisioned. No load has been run anywhere except the local
laptop baseline in §2. Every price below is an estimate from public list prices as remembered at
the time of writing and is marked **(verify at purchase)** — confirm each on the vendor's pricing
page on the day you buy.

Harness: `load/k6/` (k6 scenarios, personas, model) + `scripts/load/` (seed / teardown / guard /
collectors / local runner). Branch `perf/load-harness-and-staging`.

---

## 1. What we are trying to learn, and what we are not claiming

| Question | How it is answered | Today |
|---|---|---|
| Does the harness drive the real product correctly (sign-in, reads, writes, uploads) with zero cross-tenant reads? | local smoke + local baseline | **VERIFIED locally** (§2) |
| Where does the product bend first, per request type? | local baseline + server-side trace (Supabase round-trips per route) | **VERIFIED locally** — a laptop bottleneck, see §2 |
| How many concurrent users can production-shaped infrastructure serve within budget? | staged gates on a hosted staging copy (§6) | **NOT MEASURED** |
| 50,000 concurrent users | gate G7 (§6) | **NOT MEASURED — no claim is made** |

A laptop runs Next.js, the entire Supabase stack (Postgres, PostgREST, GoTrue, Kong, Storage) **and**
the load generator on one machine over loopback. It validates the harness and exposes the product's
per-request costs; it says nothing about hosted capacity, where every Supabase round-trip pays
Vercel↔Supabase network latency and the database has a different CPU/connection budget.

## 2. Local baseline (measured 2026-11-16) — a laptop, not capacity

**Conditions.** Production build (`next build && next start`, commit on this branch, base `d24295e`)
on `:3000`; the shared local Supabase stack in Docker (Postgres `max_connections` 100, PostgREST,
GoTrue, Kong, Storage); k6 v2.3.0 on the same Apple-silicon 16 GB laptop, which other workstreams
were also using (load average ≈10 when the session started). Dataset: 25 synthetic tenants
(`--orgs 25 --tag lt1`: 195 memberships, 1,021 customers, 2,064 jobs, 1,446 quotes, 1,008 invoices,
~40k rows). Runner: `scripts/load/run-local.sh`; raw output in `load/results/` (gitignored).

### 2.1 Results

| Run | Sessions (VUs) | Think time | Result | RPS (peak hold) | In-flight (derived) | Req / session / min | Latency p50 / p95 / p99 (peak hold, all requests) | Errors |
|---|---|---|---|---|---|---|---|---|
| smoke | 12 | ×1 | **PASS** — all thresholds | 2.1 | 0.2 | 10.7 | 102 / 192 / 219 ms | 0 % 5xx, 0 bounces |
| local | 100 | ×1 (realistic) | **PASS** — all thresholds | **15.7** | 4.7 | **9.4** | **132 / 1,264 / 3,602 ms** (whole run incl. ramp: 135 / 2,522 / 3,893; max 8.0 s) | 0.05 % 5xx · 0 auth bounces · 0.43 % business errors · 103/103 sign-ins |
| local-stress | 100 | ×0.2 (≈500 people) | **FAIL — aborted at 62 s by the auth-bounce threshold** | ≈31 (pre-abort) | ≈16 | n/a (compressed) | whole run 162 / 1,864 / 2,659 ms | 0.19 % 5xx · 3.8 % bounces · 110 of 185 sign-ins failed |

Per request kind, realistic 100-session run (whole run): pages p95 2.07 s (1,650 requests), server
actions p95 2.59 s (411), API p95 1.23 s (475), photo uploads p95 1.61 s (113), end-to-end sign-in
p95 2.48 s (103). Writes: 456 confirmed, 2 with unknown outcome.

**Tenant isolation under load: 0 violations in 2,119 marker-scanned responses; 63/63 cross-tenant
canaries refused (realistic run); 0 / 689 and 11/11 in the stress run.**

Server side (collector, realistic run): Postgres connections peaked at **50 of 100** (PostgREST
pool: 11 idle + ≤8 active; GoTrue ≈20 idle); container CPU peaks — Postgres 250 % (2.5 cores),
GoTrue 175 %, PostgREST 45 %, Next.js 76 % (100 % = one core).

### 2.2 Fan-out — the number that turns into latency on hosted infrastructure

Server-side trace of the realistic run (`scripts/load/trace-fetch.cjs`): **5,071 app requests made
53,144 Supabase calls — 10.5 per request**: 9,884 Auth calls (`GET /auth/v1/user` = exactly **2 per
authenticated request**: middleware + render) and 42,876 PostgREST calls. Heaviest renders:
`/jobs/[id]` ≈ 39 calls (RSC navigation; one full render traced at 49 — ~30 module tables, most
read twice), `/dashboard` ≈ 37 (RSC) / ≈ 80 (full document, matching the 2026-10-22 baseline's 86),
`/me` ≈ 10 (RSC) / 16 (full), `/quotes/new` 13, `createQuote` 21; lists 4–6. On loopback each call
costs ~0.1 ms of network; hosted, each pays a Vercel↔Supabase round trip.

### 2.3 Bottleneck observed (on the laptop)

1. **The Auth path failed first.** Under compressed load (≈31 RPS → ≈60 GoTrue requests/s) the local
   GoTrue returned HTTP 500 on 21 % of `getUser` and 60 % of sign-in calls; its log shows
   `dial tcp …:5432: connect: cannot assign requested address` (1,544×) — GoTrue opening Postgres
   connections faster than the Docker network recycles ports. Failed `getUser` → the middleware
   treats the user as signed out → redirect to `/login` → the run's abort threshold fired. This
   failure mode is specific to the local Docker stack, but the cause — **two Auth round-trips on
   every authenticated request** — is product behaviour and will load hosted Auth the same way.
2. **Postgres CPU from fan-out.** At only 15.7 RPS the database container peaked at 2.5 cores;
   p50 stays ~130 ms but p95/p99 jump to 1.3–3.6 s across every route at once during the sign-in
   ramp — a shared-CPU stall on one machine (app + DB + Auth + generator + other agents), not a
   per-route defect.
3. **Not the bottleneck locally:** Postgres connections (≤50/100), PostgREST pool (≤8 active),
   tenant isolation (0 leaks), product rate limiters (4 × 429 in the realistic run).

### 2.4 Data hygiene (verified on the shared local database)
Seed of 25 tenants: 4.2 s, ~40k rows; re-running it is a no-op (0.4 s, identical counts — only the
newly added admin-grant rows were inserted). `scripts/load/teardown.mjs --tag lt1` afterwards removed
every tagged row (including the rows the runs created: quotes, invoices, clock entries, leads,
RAMS sign-offs) and the 147 uploaded photos via the Storage API, with **zero** orphan-sweep deletions
and the non-synthetic organisation / user counts unchanged before vs after. A 2-tenant `lt9` seed →
teardown cycle showed the same. `01-mark-staging.sql` run against the local database refused
(non-synthetic organisations present) and refused the production ref; it created nothing.

**What this does NOT show:** anything about hosted capacity or 50,000 concurrent users. The laptop
saturates near ~30 RPS because one machine runs everything; hosted infrastructure has separate,
much larger budgets for each tier — and also adds network latency to every one of the 10.5
Supabase calls per request. Only the staged gates in §6 can answer the capacity question.

## 3. The load model — three different numbers

Defined in `load/k6/lib/model.js` and reported separately by every run (`k6-summary.md`):

| Number | Meaning | k6 | What it loads |
|---|---|---|---|
| **Concurrent sessions** | signed-in people with the app open at the same moment — what "50k users" means | VUs (each VU owns one seeded identity and keeps one session across many tasks) | Auth sessions + token refreshes and sign-in waves; no per-session server memory (the app is stateless) |
| **Requests per second** | arrival rate those sessions generate | `http_reqs` rate | Vercel function invocations + middleware, PostgREST queries, GoTrue `getUser` calls |
| **In-flight requests** | requests being served at one instant | derived: RPS × mean latency (Little's law) | function instances, PostgREST pool slots, Postgres backends |

Sessions are the input (closed model, `ramping-vus`); RPS and in-flight requests are outputs.
The bridge is **requests per session per minute** measured at realistic think time
(`THINK_SCALE=1`): expected RPS at a gate ≈ sessions × that rate ÷ 60. Compressing think time
(`THINK_SCALE<1`) makes each VU behave like several people — a stress tool, never a user count.

**Persona mix** (per 1,000 concurrent sessions; `PERSONA_SLOTS`): 580 field staff (my day, assigned
jobs, clock in/out, RAMS sign-off, photo upload, timesheet), 200 office admins (quotes, quote →
job + invoice, invoice from quote, reschedule, rota, create job, search), 120 owners (dashboard,
reports, lists, detail pages, search), 98 unauthenticated prospects (marketing pages, tenant enquiry
page, occasional enquiry), 2 HQ operators. Think times are per action (2–75 s; e.g. pricing a quote
20–75 s, reading a method statement 15–60 s), each VU signs out and back in every 10–50 tasks, and a
sign-in budget keeps every identity under the product's own 5-per-10-minutes limiter.

**Safety interlocks (all VERIFIED by unit tests + `k6 inspect`, `__tests__/load/guard.test.ts`):**
production project ref / `*.crewflow.uk` refused with no override (k6 init context and every Node
script); a non-local target needs `LOAD_STAGING_HOST` + `LOAD_STAGING_REF` naming it; Node tooling
additionally needs a database sentinel (`scripts/load/staging/01-mark-staging.sql`) bound to that
ref, which itself refuses any database holding a non-synthetic organisation; k6 `setup()` aborts
unless the app accepts a session minted by the guarded Supabase project and renders a seeded tenant
(proves the app deployment is wired to the same database); every sign-in must be a
`@loadtest.crewflow.invalid` identity; local runs above 200 VUs are refused.

**Correctness signals during load:** every seeded tenant's text carries a unique marker
(`ltm_<12 hex>`); any response containing another tenant's marker aborts the run
(`tenant_isolation_violations`, `abortOnFail`, 0 s delay). ~3% of tasks also fire a cross-tenant
canary (a request for another tenant's record by its deterministic id) that must be refused
(`canary_leaks == 0`, same abort).

## 4. Staging architecture (proposed)

```
 load generators (k6, self-hosted, 1–12 VMs, eu-west)        ← never run from a laptop above 200 VUs
        │  HTTPS
        ▼
 Vercel project  "crewflow-load"  (same team, region dub1 = prod's region, production build of the
        │                          branch under test, Fluid compute, own env vars, no custom domain)
        │  HTTPS (PostgREST / GoTrue / Storage)
        ▼
 Supabase project "crewflow-load"  (separate project, same region as prod, Pro org, compute tier
                                    resized per gate, synthetic data only)
```

- **Separate Supabase project** created from the repo's migrations (`supabase db push` against the
  staging ref, never `--linked` to prod). It holds **only** synthetic `lt-*` tenants seeded by
  `scripts/load/seed.mjs` (`--orgs 2000 --fast` scale for the top gates). Marked with
  `01-mark-staging.sql`. Never restored from a production backup.
- **Separate Vercel project** pointing at the same repo/branch, with its **own** environment:
  `NEXT_PUBLIC_SUPABASE_URL` / anon / service-role keys of the staging project only;
  `CREWFLOW_SUPERADMIN_EMAILS` = the synthetic HQ emails only.
- **Providers sandboxed / absent:**
  - Email (Resend) / SMS + voice (Twilio) / WhatsApp / push (VAPID): **no keys set** → the product's
    senders no-op (the same posture as the sanitised local env). Supabase Auth SMTP **off** (synthetic
    users are created confirmed; no auth emails).
  - AI (Anthropic): **no key** → AI features stay disarmed; the AI cost governor is irrelevant.
  - Stripe: **unset**, or test-mode keys only if a billing journey is ever added to the mix (it is not
    today). Never a live key.
  - Monitoring: Sentry DSN unset (or a separate staging DSN with sampling ≤ 1%) so load does not burn
    the production Sentry quota; PostHog unset.
  - Crons: the 48 Vercel crons stay **disabled** on the staging project (no `crons` in its config or
    `CRON_SECRET` unset) except for a deliberate "crons during peak" variant of G5+.
- **Isolation proofs before every gate** (record the output in the gate log):
  1. `scripts/load/_guard.mjs` + k6 `classifyTarget` refuse the production ref (unit tests green on the
     commit under test);
  2. sentinel present and bound to `LOAD_STAGING_REF` (seed/teardown refuse otherwise);
  3. staging env var *names* match production's list but every Supabase/Stripe/Resend/Twilio value
     differs (a human compares in the Vercel UI — values are never printed or copied);
  4. k6 `setup()` session proof passes (aborts otherwise);
  5. `select count(*) from organizations where slug not like 'lt-%'` = 0 on staging.

## 5. Monitoring during a gate

| Layer | Signal | Where |
|---|---|---|
| Client (k6) | p50/p95/p99 by kind and phase, RPS, in-flight (derived), 5xx, auth bounces, 429s, isolation/canary counters, write confirmations | `k6-summary.{json,md}`; optional k6 → Prometheus remote-write |
| Vercel | invocations, function duration, concurrency, cold starts (init duration), errors, middleware latency | Vercel Observability for the staging project |
| PostgREST / Postgres | CPU, memory, disk IO budget, connections by role (PostgREST pool = the app's whole data path, see `docs/connection-pooling-and-scale.md`), `pg_stat_statements` top-N (reset allowed on staging only), lock waits, statement timeouts (8 s authenticated / 3 s anon) | Supabase dashboard + Prometheus metrics endpoint; `scripts/load/collect.mjs --db <staging pooler URL>` (it skips the docker/ps parts off-laptop) |
| Auth (GoTrue) | request rate, latency, 429s | Supabase dashboard (Auth) — every authenticated navigation makes ~2 Auth calls (middleware + render) |
| Data correctness | after each gate: `seed.mjs --verify` floors, write reconciliation (writes_ok vs new rows), teardown dry count | `scripts/load/seed.mjs` |

## 6. Progressive gates

Each gate runs only after the previous one passed **and** the founder approved its spend. Profiles are
defined (config only, never run locally) in `STAGES` (`load/k6/lib/model.js`); every staged profile has
a ≥10-minute peak hold, then drops to 20 % and holds (**recovery**), then ends.

Expected RPS = sessions × **9.4** requests/session/minute (measured, realistic think time, §2.1) ÷ 60.
Expected Supabase calls ≈ 10.5 × RPS, of which ≈ 2 × RPS hit Auth (§2.2). Tier = the Supabase compute
tier to start the gate on (resize up only after ruling out a code fix). Budgets = page p95 / p99.

| Gate | Sessions | Expected RPS (peak) | Duration | VU-hours | App requests | Supabase tier to start | p95 / p99 budget | Generators | Est. cost (verify at purchase) |
|---|---|---|---|---|---|---|---|---|---|
| G1 | 100 | ~16 | 18 min (peak 10) | 22 | ~0.01 M | same tier as production | 1.5 / 3 s | 1 (workstation OK) | $0–1 |
| G2 | 500 | ~78 | 27 min (peak 15) | 163 | ~0.09 M | prod tier → Large | 2 / 4 s | 1 | $1–2 |
| G3 | 1,000 | ~157 | 33 min (peak 15) | 377 | ~0.21 M | Large | 2 / 4 s | 1 | $1–2 |
| G4 | 5,000 | ~783 | 59 min (peak 20) | 3,150 | ~1.8 M | XL → 2XL | 2.5 / 5 s | 1 VM | $8–19 |
| G5 | 10,000 | ~1,567 | 71 min (peak 20) | 7,150 | ~4.0 M | 2XL → 4XL | 3 / 6 s | 2 VMs | $17–63 |
| G6 | 25,000 | ~3,917 | 82 min (peak 20) | 19,917 | ~11.2 M | 4XL → 8XL | 3 / 6 s | 5 VMs | $42–132 |
| G7 | 50,000 | ~7,833 | 128 min (peak 30) | 63,167 | ~35.6 M | 8XL → 16XL | 3 / 6 s | 10 VMs | $110–336 |

At G7 that is ≈ 82,000 Supabase calls/s, ≈ 15,700 of them Auth `getUser` — which is why §8 item 1
(local JWT verification) and the fan-out work should be evaluated **before** G6, not after.
Entry conditions for every gate: previous gate PASS (§7), isolation proofs (§4) recorded, budget
approved. G1 additionally re-validates the harness against hosted latency at the same tier as
production, so its numbers are directly comparable with production behaviour today.

## 7. Pass / fail criteria and abort conditions

**A gate PASSES only if all of these hold over its peak hold and recovery hold:**

| # | Criterion | Source |
|---|---|---|
| P1 | 0 tenant-isolation violations and 0 canary leaks (any one = immediate abort + P0 incident) | k6 `tenant_isolation_violations`, `canary_leaks` |
| P2 | 5xx + transport failures < 1 % of requests | `server_errors`, `http_req_failed` |
| P3 | page p95 ≤ the profile budget (1.5 s at G1 → 3 s at G5–G7) and p99 ≤ 2× that | `http_req_duration{kind:page}` |
| P4 | server-action p95 ≤ the page budget; API p95 ≤ 0.75 × budget | `{kind:action}`, `{kind:api}` |
| P5 | auth bounces < 2 %, sign-in failures < 1 % | `auth_bounces`, `login_failures` |
| P6 | recovery: in the 20 % hold, page p95 returns to within 20 % of the same gate's ramp-phase p95 within 5 minutes; no residual error rate | phase-tagged sub-metrics |
| P7 | Postgres CPU < 80 % sustained at peak, no `statement_timeout` (8 s) errors, no lock-wait build-up | Supabase metrics, collector |
| P8 | writes: `writes_unknown` = 0 and the rows created reconcile with `writes_ok` | k6 + `seed.mjs --verify` |
| P9 | no surprise spend: Vercel and Supabase usage within the gate's approved budget | Vercel/Supabase usage pages |

**Automatic aborts (k6 `abortOnFail`, in `thresholdsFor`):** any isolation violation or canary leak
(0 s); 5xx rate ≥ 10 % (after 60 s); HTTP failure rate ≥ 15 % (60 s); auth-bounce rate ≥ 2 % (60 s);
page p95 ≥ 4 × budget (120 s).
**Manual aborts (operator watching dashboards):** Postgres CPU ≥ 95 % for 5 min or disk-IO budget
exhausted; Supabase Auth returning 429 to the app; Vercel spend alert or concurrency limit reached;
any outbound call to a real provider observed; the load generators themselves CPU-bound (≥ 80 %) —
then the result measures the generator, not the product.
**A FAIL is not a crash:** the gate's output is the bottleneck and its evidence. Fix (query/code
first — "rule out a query fix before a tier change", `docs/connection-pooling-and-scale.md`), then
repeat the gate. Only after a code fix is ruled out do we raise the compute tier.

## 8. Expected bottlenecks (in the order we expect to meet them)

Ranked from repository evidence and the local trace; each is a hypothesis for staging to confirm.

1. **Supabase Auth (GoTrue) on every navigation.** Middleware calls `getUser()` on every matched
   request and the render validates again (`lib/supabase/middleware.ts`, `server/auth/session.ts`);
   the local trace shows exactly 2 `GET /auth/v1/user` calls per authenticated request (§2.2), and
   the local Auth path was the first thing to fail (§2.3). At G7 that is ≈15,700 Auth requests per
   second, each a Postgres read in the `auth` schema. Cheapest lever if it binds:
   validate the JWT locally (signing keys / `getClaims`) in middleware instead of a network
   `getUser()` per request — a code change with security review, not a tier change.
2. **PostgREST pool + Postgres CPU, driven by query fan-out.** The app reaches Postgres only through
   PostgREST over HTTP (no direct connections — `docs/connection-pooling-and-scale.md`), so the
   "connection limit" that matters is PostgREST's own pool (sized by compute tier), not Supavisor.
   `/dashboard` makes ~80 PostgREST calls per full render (measured locally, matches the
   2026-10-22 baseline's 86) and ~37 per client navigation; `/jobs/[id]` ~39–49; `/me` 10–16;
   lists 4–6 (§2.2). Owners land on `/dashboard` at sign-in, so a
   Monday-morning login wave multiplies this. Expect pool queueing (latency) well before errors.
3. **RLS evaluation cost.** Every RLS-protected query runs the `current_org_ids()` InitPlan
   (cheap, indexed); at high RPS it is CPU, not correctness. `pg_stat_statements` on staging will show
   whether the hottest statements are RLS-dominated.
4. **Vercel function concurrency and cold starts.** In-flight requests (RPS × latency) map onto
   function instances; Fluid compute shares instances across concurrent requests, but a fast ramp
   still causes cold starts (init duration) and the plan's concurrency ceiling applies
   (verify the current Pro limit at purchase). Latency to Supabase lengthens every request and so
   raises in-flight count for the same RPS.
5. **Per-IP rate limits in front of a few load generators.** Supabase Auth rate-limits sign-ins and
   token refreshes per IP; with server-side sign-in (`signInWithPassword` in a server action) the
   caller IP Auth sees is a Vercel egress IP, so a real login storm also concentrates on few IPs —
   confirm how hosted Auth keys its limiter (and raise the staging limits for the test). The product's
   own limiters are per identity (auth) or per client IP (`/api/public/lead`, 5 / 10 min) — the latter
   will 429 most synthetic enquiries; that is measured, not failed.
6. **Persistent rate-limit writes.** The durable limiter (`rate_limit_hit` RPC) writes a counter row
   per limited call; under a login storm that is a hot write path worth watching in
   `pg_stat_statements`.
7. **Storage uploads** (site photos; 150 KB synthetic, 2–4 MB real): Storage API throughput and
   egress. Raise `PHOTO_KB` to 2048 for one G5 variant to see the real cost.
8. **Realtime: not applicable today** — the product does not use Supabase Realtime channels
   (no `.channel(` / `postgres_changes` in `app/`, `lib/`, `components/`, `server/`), so realtime
   connection caps are not a constraint for the current product.
9. **Background work during peak:** 48 Vercel crons (`vercel.json`) share the same database; a G5+
   variant runs with crons enabled to measure interference.

## 9. Cost estimate — every price **(verify at purchase)**

### 9.1 Assumptions
- Supabase **Pro** org already exists (production). The staging project is an additional project in it:
  compute is billed **hourly** at the chosen tier; Pro projects cannot be paused, so between phases the
  project is either kept on the smallest tier or deleted and re-created from migrations.
- Each gate is run inside a **~4-hour window** at the gate's tier (resize ≈ minutes of restart, seed,
  warm-up, the run, one re-run, verify); the rest of the time the project sits on Micro.
- Vercel **Pro** team already exists; a second project adds no seat cost — only usage (function
  active CPU, provisioned memory, invocations, edge requests/middleware, data transfer) beyond the
  plan's included usage.
- Request volume per gate = the profile's VU-hours × measured requests/session/minute × 60 (§2);
  ~5 Supabase calls per app request on average (local trace) and ~100 ms of function CPU per request.
- Load generators **self-hosted** on general-purpose VMs in eu-west (close to dub1): ~5,000 VUs per
  8 vCPU / 32 GB VM with this script (validated at G4 before scaling out); k6 is free (AGPL binary).
- Excludes engineering time, and excludes any plan upgrade (listed separately as optional).

### 9.2 Indicative list prices used (all **verify at purchase**)
| Item | Price used |
|---|---|
| Supabase compute, per hour (≈ per month) | Micro ~$0.0134 (~$10) · Small ~$0.0206 (~$15) · Medium ~$0.0822 (~$60) · Large ~$0.1517 (~$110) · XL ~$0.2877 (~$210) · 2XL ~$0.562 (~$410) · 4XL ~$1.32 (~$960) · 8XL ~$2.56 (~$1,870) · 12XL ~$3.84 (~$2,800) · 16XL ~$5.12 (~$3,730) |
| Supabase egress / disk / MAU | 250 GB egress included per org then ~$0.09/GB; 8 GB disk included then ~$0.125/GB-month; 100k MAU included (check whether per org or per project) |
| Vercel Pro usage | active CPU ~$0.128/h; provisioned memory ~$0.0106/GB-h; invocations ~$0.60/M; edge requests ~$2/M beyond included; fast data transfer ~$0.15/GB beyond 1 TB; plan includes a monthly usage credit |
| Load-generator VM | ~$0.40–0.50/h per 8 vCPU / 32 GB on-demand (Hetzner-class providers are cheaper) |
| Grafana Cloud k6 (alternative) | ~$0.15 per VU-hour beyond a small free allowance |

### 9.3 Per-gate estimate
Per gate (§6 table): Supabase = tier hourly rate × 4 h (×1.5 for the high end); Vercel = app requests
× $2–7 per million (invocation + ~100 ms active CPU + memory + middleware/edge request); generators =
VMs × ~$0.45/h × 4 h (×2 for the high end); +$20 egress allowance at G5+. G1–G3 likely fit inside the
plans' included usage.

### 9.4 Totals
- **One pass of G1–G7: roughly $180–$560** (sum of §6; Supabase compute ~$40–130, Vercel usage
  ~$100–330, generators ~$20–110, egress allowance ~$40–60).
- **Recommended budget cap: ~$1,500** to cover re-runs after fixes (expect at least one at G4–G6) and
  one "crons during peak" / "real 2–4 MB photo" variant at G5. Set Vercel spend management and
  Supabase spend alerts before G4.
- **Idle cost while staging exists:** ~$10–15/month (Micro compute + small disk).
- **Optional, only if a gate needs it (verify at purchase):** Supabase Team plan (~$599/month) for
  support/SLA during the 25k–50k gates; Vercel Enterprise only if the Pro concurrency ceiling blocks
  G7. Grafana Cloud k6 for the whole ladder (~94k VU-hours ≈ ~$14k) is **not recommended** —
  self-hosted generators do the same job for ~1 % of the cost.

## 10. What needs founder approval (nothing below has been done)

1. **Create the staging Supabase project** (Pro org, same region as prod) and the **staging Vercel
   project**; authorise the ~$10–15/month idle cost.
2. **Choose the load-generator account** (cloud provider + billing) and a hard spend cap.
3. **Per-gate spend approval**, in order: G1 → G7 (§9.3); G4 and above only after G1–G3 pass and the
   cheap code levers in §8 (Auth `getUser` per request, dashboard fan-out) have been evaluated.
4. **Raise Auth rate limits on the staging project only** (sign-in / token refresh per IP) for the test.
5. **Notify Supabase and Vercel** before G5+ per their current load-testing / fair-use policy
   (verify what each requires — some require advance notice or a support ticket).
6. **Confirm the success definition**: the page p95/p99 budgets and error budgets in `STAGES` are
   proposals; the founder may tighten or relax them before G1.

## 11. Runbook (commands)

Local (laptop) — the only thing that has been run:
```sh
source ~/Code/cf-wt/_shared/local-env.sh; export DB_URL API_URL ANON_KEY SERVICE_ROLE_KEY
bash ~/Code/cf-wt/_shared/heavy.sh npm run build                 # production build
DATABASE_URL="$DB_URL" node scripts/load/seed.mjs --orgs 25 --tag lt1      # idempotent
bash ~/Code/cf-wt/_shared/heavy.sh bash scripts/load/run-local.sh smoke 1 lt1
bash ~/Code/cf-wt/_shared/heavy.sh bash scripts/load/run-local.sh local 1 lt1     # 100 sessions, realistic
bash ~/Code/cf-wt/_shared/heavy.sh bash scripts/load/run-local.sh local 0.2 lt1   # 100 VUs ≈ 500 people (stress)
DATABASE_URL="$DB_URL" node scripts/load/teardown.mjs --tag lt1             # removes only lt-lt1-* rows
```
Output lands in `load/results/<timestamp>-<stage>-t<think>/REPORT.md` (gitignored).

Staging (after approval; nothing here has been run):
```sh
export LOAD_STAGING_REF=<staging ref> LOAD_STAGING_HOST=<staging vercel host>
psql "$STAGING_DB_URL" -v staging_ref=$LOAD_STAGING_REF -f scripts/load/staging/01-mark-staging.sql
LOAD_DATABASE_URL="$STAGING_DB_URL" LOAD_USER_PASSWORD=<generated, ≥12 chars> \
  node scripts/load/seed.mjs --orgs 2000 --staff 12 --fast --tag g1
node scripts/load/discover-actions.mjs   # from the SAME commit's build, or rely on setup() discovery
BASE_URL=https://$LOAD_STAGING_HOST SUPABASE_URL=https://$LOAD_STAGING_REF.supabase.co \
  SUPABASE_ANON_KEY=<staging anon> LOAD_USER_PASSWORD=<same> STAGE=100 LOAD_TAG=g1 \
  MANIFEST=$PWD/load/k6/.manifest/g1.json RESULTS_DIR=$PWD/load/results/g1 \
  k6 run load/k6/scenarios/mixed.js
node scripts/load/collect.mjs --db "$STAGING_DB_URL" --out load/results/g1   # alongside, Ctrl-C to stop
```
Distributed generators (G4+): run the same script on N VMs with `--execution-segment` /
`--execution-segment-sequence` so VU ids stay globally unique (each VU owns one identity); confirm
uniqueness in the G4 log before G5.
