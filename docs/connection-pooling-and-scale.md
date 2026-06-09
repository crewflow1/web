# Connection pooling & DB scale review (F-9)

Concern: at 200 paying companies on serverless (Vercel) functions, does
CrewFlow exhaust Postgres connections? This documents the **verified**
architecture, why the usual serverless connection-exhaustion failure mode does
**not** apply, the real levers, and one latent footgun to keep closed.

## Verified architecture — the app holds no direct Postgres connections

Every database call in the app goes through **PostgREST over HTTP**, not a
direct Postgres socket:

- `lib/supabase/server.ts` — user-context client via `@supabase/ssr`
  `createServerClient` (anon key + caller JWT, RLS enforced).
- `lib/supabase/admin.ts` — service-role client via `@supabase/supabase-js`
  `createClient` (HTTP, RLS bypassed).

A repo-wide search confirms **no runtime import** of `postgres` (postgres.js)
or `drizzle-orm`, and **no Drizzle config** exists. `DATABASE_URL` /
`DIRECT_URL` are declared **optional** in `lib/env.ts` and feed only the
vestigial `db:migrate` / `db:studio` tooling scripts — nothing in the request
path opens a `pg` connection.

**Consequence:** a Vercel function invocation does *not* open a Postgres
connection. It makes an HTTPS request to PostgREST, which multiplexes all REST
traffic over its own small, server-side pool. So the classic
"lambda fan-out × cold starts → `too many connections`" failure mode **is not
present** in CrewFlow's data path.

## Verified production picture

Read-only checks against prod (`pg_stat_activity`, `pg_settings`):

| Signal | Value |
|---|---|
| `max_connections` | **60** (smallest compute tier) |
| Total connections in use | ~15 of 60 |
| `authenticator` / `postgrest` | **4** — the entire app data path |
| `supabase_admin` (platform, exporter, cron/net workers) | ~9 |
| `service_role` `statement_timeout` | none (cron/maintenance not capped) |
| `authenticated` / `anon` `statement_timeout` | 8s / 3s |

The whole application is served by PostgREST's **4-connection** pool. Adding
customers adds HTTP requests, which PostgREST queues and multiplexes — it does
**not** translate one customer (or one request) into one Postgres connection.
The 60-connection ceiling is shared across that PostgREST pool, platform
internals (cron/net background workers, metrics exporter), the SQL editor, and
migrations.

## Will 200 companies exhaust connections?

**Not through the app.** The PostgREST pool size is fixed by the compute tier,
independent of customer count. The levers that actually matter at 200 orgs:

1. **Compute tier.** `max_connections=60` is the smallest instance. As traffic
   grows, the constraint shows up first as **CPU/RAM and PostgREST pool
   saturation** (requests queue → latency, the 8s `statement_timeout` starts
   tripping), *before* raw connection exhaustion. The fix is a bigger compute
   add-on, which raises CPU/RAM, `max_connections`, and the PostgREST pool
   together. This is a **dashboard setting, not a code change**.
2. **The shared pooler (Supavisor).** For any *future* code that needs a direct
   Postgres connection (a worker, a direct-SQL analytics job, or wiring up the
   currently-dormant Drizzle deps), it **must** use the Supabase pooler
   connection string in **transaction mode** (port 6543) — never the direct
   5432 string from serverless. Transaction-mode pooling is what keeps a fleet
   of short-lived functions from each holding a backend connection.
3. **Query efficiency.** The F-1/F-4/F-5/F-7 work (composite indexes, trigram
   GIN, paged reads, no unbounded selects) keeps individual queries fast and
   short-lived, which keeps PostgREST pool occupancy low. Connection pressure
   and query efficiency are the same problem from two ends.

## Recommendations before / at 200 orgs

- [ ] **No application code change is required for pooling** — the HTTP/PostgREST
      design is already the serverless-correct pattern.
- [ ] **Right-size compute** ahead of launch. Move off the 60-connection tier;
      pick a tier from a load test (see below) so PostgREST has pool headroom.
      Dashboard → Settings → Compute.
- [ ] **Guard the footgun.** The unused `postgres` + `drizzle-orm` /
      `drizzle-kit` dependencies are a latent trap: the first person to import
      them into a server action introduces direct, un-pooled connections that
      *can* exhaust the 60-connection ceiling under serverless fan-out. Either
      **remove these unused deps**, or add a lint/CI guard that any direct
      Postgres client must use the **transaction-mode pooler** string. (Tracked
      as a follow-up; removing dead deps is low-risk but out of scope for the
      F-1..F-9 scale PRs.)
- [ ] **Load test** at ~200-org traffic to find the real ceiling (drive list
      pages, dashboard, search, document upload). Watch in the dashboard:
      PostgREST pool utilisation, CPU, and the `authenticated` 8s-timeout error
      rate. Size compute so peak pool utilisation stays well under 100%.
- [ ] **Alert** on `pg_stat_activity` saturation and on the 8s statement-timeout
      error rate (surface via `/admin/ops` or external monitoring).

## Bottom line

F-9 is **not a code defect** and needs no code fix. CrewFlow's data path is
already connection-pool-safe by virtue of going through PostgREST over HTTP.
The work before 200 orgs is operational: right-size the compute tier from a
load test, keep direct Postgres connections out of serverless paths (or force
them through the transaction-mode pooler), and remove/guard the dormant Drizzle
dependencies so that property can't be broken silently.
