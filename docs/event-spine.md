# HQ Event Spine — PR1: Spine Core

> Module 1 of the HQ programme (CEO Directive #003). The Event Spine is the one
> append-only log that becomes CrewFlow's heartbeat: every meaningful thing that
> happens becomes an **event**, and that single stream powers HQ, the Timeline,
> notifications, automation, reporting, AI and future intelligence — **without a
> second event framework**. One architecture, one source of truth.
>
> Engineering Bible references: **Ch.03** (data model), **Ch.04** (event spine &
> taxonomy), **Ch.16** (append-only & retention).

PR1 lands the spine's **storage** and its **write primitive** and **nothing
customer-facing**. No producers are wired yet (table triggers arrive in PR2,
consumers in PR3), so it ships **dark**: applying it changes no existing
behaviour and touches no tenant table. Customers must never know the spine
exists; the first customer-visible deliverable is the Timeline in PR5.

## What PR1 ships

| Object | Kind | Purpose |
|---|---|---|
| `public.hq_events` | table (RANGE-partitioned by `ts`, monthly) | The append-only log. A monotonic `bigint id` is **the total order**; consumers order by `id`, never `ts`. |
| `public.hq_create_events_partition(timestamptz)` | function (SECURITY DEFINER) | Idempotent monthly-partition creator. Enables RLS on each partition it makes. |
| monthly partitions + `hq_events_default` | tables | Current month + 6 ahead, plus a DEFAULT catch-all so an insert can never fail on a missing partition. |
| append-only guard | triggers | `BEFORE UPDATE`/`BEFORE DELETE` reject mutation **even under service_role**. |
| `public.hq_emit_event(...)` | function (SECURITY DEFINER) | The single validated write entry point. Returns the new `bigint id`. |
| `public.hq_event_consumers` | table | Durable per-consumer offsets (written by the drainer in PR3). |
| `public.dead_events` | table | Poison-event side table (written by the drainer in PR3). |
| `lib/events/registry.ts` | TypeScript | The canonical verb registry — the single source of event names. |
| `server/services/event-spine.ts` | TypeScript (`server-only`) | `emitEvent()` write primitive + `ensureSpinePartitions()`. |
| `app/api/cron/spine-partitions/route.ts` | route | Daily cron that keeps partitions ~2 months ahead of need. |

Migration: `supabase/migrations/20260720000000_hq_event_spine_core.sql`.

## The event envelope

`hq_events` carries a deliberately small, stable envelope (Ch.04):

| Column | Notes |
|---|---|
| `id` | `bigint generated always as identity`. **The** total order. |
| `ts` | `timestamptz` — the partition key. **Display only**; never an ordering key. |
| `actor_type` | `human` \| `ai_employee` \| `system` \| `tenant` (CHECK-constrained). |
| `actor_id` | Free text: `HqActor.id`, employee slug, cron/job name, or org id. |
| `verb` | `domain.action`, past tense. Validity is enforced by the TS registry (below), not a DB constraint. |
| `object_type` / `object_id` | The thing the event is *about*. |
| `target_type` / `target_id` | Optional secondary subject. |
| `correlation_id` | `uuid not null`. Every event in one end-to-end intent shares it. |
| `causation_id` | `bigint`. The id of the event that directly caused this one. |
| `severity` | `info` \| `success` \| `warn` \| `critical` (CHECK-constrained). |
| `payload` | `jsonb` — small, structured, never PII-heavy. |
| `visibility` | `hq` today; the seam for per-role scoping later (Ch.14). |

The `actor_type` and `severity` CHECK lists mirror `ACTOR_TYPES` / `SEVERITIES`
in the registry exactly; the security suite pins the two together so SQL and TS
can't drift.

## The verb registry — one source of event names

`lib/events/registry.ts` is the **single source** of event names (Ch.04). A
producer may only emit a verb listed there: `emitEvent()` types its `verb`
against the `Verb` union, so **an unregistered verb will not compile**. The flat
`VERBS` tuple is derived from ten domain groups (`org`, `billing`, `operations`,
`support`, `ai`, `approval`, `memory`, `permission`, `system`, `notification`),
so there is exactly one place to edit. Adding or renaming a verb is a deliberate
change: it requires an ADR (Ch.20) and updates the registry contract test, which
locks the registry size and per-group counts as a tripwire.

The module is intentionally free of `server-only` and of any I/O — it is pure
data + types, so the Timeline UI (PR5) can import the `Verb` union and the
groupings to build typed filters without pulling in server code.

## Writing an event

```ts
import { emitEvent } from "@/server/services/event-spine";

const res = await emitEvent({
  actorType: "system",
  verb: "system.cron_ran",          // compile error if unregistered
  objectType: "system",
  objectId: "spine-partitions",
  // severity defaults to "info", visibility to "hq", payload to {},
  // correlationId is generated fresh when omitted (starts a new trace).
});
if (!res.ok) {
  // res.error — emission never throws; the caller decides if a miss is fatal.
}
```

`emitEvent()` is the **service-emitted** half of the producer contract — the
path for events that have no owning table mutation (a cron that ran, an alert
raised, a webhook received). It calls `hq_emit_event` as a single-statement RPC,
so a standalone event is atomic in itself. There is deliberately **no `tx`
parameter**: supabase-js has no client-side multi-statement transactions, and
per CEO decision **D1** we do not invent one. Events that accompany a state
change are written transactionally by AFTER triggers on the mutating table
(PR2) — the path that gives the "state and narrative are inseparable" guarantee
without a client-side transaction layer.

Emission failures are logged and returned as `{ ok: false, error }`; they never
throw, so a spine hiccup can never break the primary action that asked for the
event.

## Partition maintenance

`hq_events` is partitioned monthly by `ts`. The migration pre-creates the
current month + 6 ahead and a DEFAULT catch-all. The daily cron
(`/api/cron/spine-partitions`, `15 4 * * *`, Bearer `CRON_SECRET`) calls
`ensureSpinePartitions(2)` to keep ~2 months of runway ahead of need
(Ch.03 "partition-creator cron runs ahead of need"). It is idempotent — the SQL
creator is a no-op when the partition already exists — so running it daily is
cheap and the DEFAULT partition stays empty in normal operation.

Anchors are pinned to the 1st of each month at midday UTC, so adding months can
never overflow a short month (the Jan‑31 + 1‑month pitfall), and the SQL
truncates to the UTC month regardless of session timezone.

## Security model

Every base table is **RLS:hq** — Row Level Security **enabled** with **zero
policies**. The Supabase `service_role` has `BYPASSRLS`, so server code
reads/writes while every JWT client (`anon`/`authenticated`) is denied. No
tenant table is touched, so PR1 is provably additive.

- **Partitions carry their own RLS.** A partitioned parent's RLS-enabled flag is
  **not inherited** by its partitions. In this Supabase/PostgREST version only the
  partitioned **parent** is exposed over the REST API — a direct read of a child
  partition returns "not found" (`PGRST205`) — so the API read surface is the
  parent, which RLS:hq denies to every JWT client. RLS is still enabled on every
  partition (the initial runway, the DEFAULT, and each one the creator function
  makes) as **defence-in-depth**: it costs nothing and closes the path for any
  future config that *does* expose a child, or a non-service direct connection.
  The integration tier proves anon is denied at the parent; the security tier
  pins per-partition RLS from the migration text.
- **Append-only.** `BEFORE UPDATE`/`BEFORE DELETE` triggers raise
  `restrict_violation` and reject mutation **even under service_role**
  (`BYPASSRLS` does not bypass triggers). Partition retention uses `DETACH`
  (DDL), not row `DELETE`, so cold-storage rollover is unaffected (Ch.16).
- **Emit is service_role-only.** `hq_emit_event` and
  `hq_create_events_partition` are `SECURITY DEFINER` with `search_path = ''`;
  `EXECUTE` is revoked from `PUBLIC`, **`anon` and `authenticated`** and granted
  only to `service_role`. Revoking from `PUBLIC` alone is **not** enough —
  Supabase's default privileges grant `EXECUTE` on new public functions directly
  to the JWT roles — so the revoke names them explicitly. Functions have no RLS,
  so the grant *is* the gate; no JWT client can emit an event or create a
  partition.

## Test coverage (six gates)

| Tier | File | Proves |
|---|---|---|
| Unit | `__tests__/lib/event-registry.test.ts` | Registry invariants: no duplicates, `domain.action` format, flat tuple == groups, locked size/counts, runtime guard. |
| Unit | `__tests__/ops/event-spine.test.ts` | `emitEvent()` envelope mapping, defaults, correlation-id generation, result contract — against a mocked RPC (no DB). |
| Integration | `__tests__/integration/spine/hq-events.test.ts` | **Live Postgres**: service emits & reads back; id is monotonic; anon denied at the parent; anon can't call either `SECURITY DEFINER` function; append-only UPDATE/DELETE rejected; creator idempotent; consumers/dead_events RLS. |
| Security | `__tests__/security/event-spine-invariants.test.ts` | Hermetic pins on the migration text: RLS:hq everywhere, no policies, partition-level RLS, append-only guard, SECURITY DEFINER + pinned `search_path`, EXECUTE revoked from `public, anon, authenticated` and granted only to `service_role`. |

"Mocks prove intent; real infrastructure proves behaviour" — the unit tier maps
the envelope against a mock; the integration tier proves the storage, RLS,
append-only guard and privilege model actually hold in a live database.

## What PR1 does NOT do

Per the locked implementation order, the following are explicitly later PRs:

- **PR2** — Domain event producers: generalise `_record_activity()` to dual-write
  `hq_events` in the same transaction as `activity_log` (flag-gated).
- **PR3** — Offset consumer: the drainer, replay, lag/dead-letter metrics, golden
  signals, cron integration.
- **PR4** — Historical backfill of `activity_log` / `admin_activity_log` /
  `hq_memory_events` into canonical events (idempotent).
- **PR5** — Timeline / The Pulse (first customer-visible deliverable) +
  `requireHqPage()`.
- **PR6** — Realtime: server-authorised broadcaster + live channels.
- **PR7** — Hooks: notification + AI + automation hooks consume the spine.
