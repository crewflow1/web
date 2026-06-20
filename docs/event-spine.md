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

---

# HQ Event Spine — PR2: Domain Event Producers

> Module 1, PR2 (CEO Directive #003, decision **D1**). PR1 landed the spine's
> storage and write primitive **dark**. PR2 wires the first **producers**: it
> generalises the existing `public._record_activity()` chokepoint so that every
> domain mutation which already writes `activity_log` **also** emits the canonical
> `hq_events` row — in the **same database transaction** (Ch.04 "transactional
> outbox"). State and its narrative become inseparable (P1): if the mutation rolls
> back, so does its event. There is **no second event framework** and **no
> client-side transaction layer**.

PR2 ships **dark** too. The dual-write is gated by a feature flag that defaults
**off**, so applying the migration changes no behaviour — `activity_log` is
written exactly as before and not one `hq_events` row is produced until an
operator flips the flag. Backwards compatibility is total: `_record_activity()`'s
existing path is byte-for-byte unchanged; the spine is one additive trailing call
that no-ops while dark or when the action is outside the curated subset.

Migration: `supabase/migrations/20260720010000_hq_event_spine_producers.sql`.

## What PR2 ships

| Object | Kind | Purpose |
|---|---|---|
| `event_spine.dual_write_enabled` | flag (in the `hq_settings` singleton JSONB) | The dark-ship / kill-switch. Seeded `false`; flipped at runtime with no deploy. |
| `public.hq_spine_dual_write_enabled()` | function (SECURITY DEFINER) | Reads the flag; returns `false` on any miss. `service_role`-only. |
| `public.hq_emit_from_activity(...)` | function (SECURITY DEFINER) | The curated activity → canonical-event mapper. No-ops unless the flag is on **and** the action is a curated OPERATIONS verb. Emits **through** `hq_emit_event()`. |
| `public._record_activity(...)` | function (generalised in place) | Reproduced verbatim with ONE additive trailing call to `hq_emit_from_activity()` after the unchanged `activity_log` insert. |

## The dual-write feature flag

The flag lives in the existing `public.hq_settings` singleton JSONB under a
top-level **`event_spine`** section — "maximum reuse, minimum complexity"; no new
flag store is invented. That key is deliberately **not** in the settings TS
`SECTION_IDS`, so the operator settings page never renders it and
`mergeSettings()` ignores it: this is a low-level **infra kill-switch**, not an
operator product flag.

It seeds **`false`** (dark) **without** clobbering a value an operator may already
have set — the seed `UPDATE` only writes when the key is absent, so re-applying
the migration is safe. Flip it on later, at runtime and with no deploy:

```sql
update public.hq_settings
  set data = jsonb_set(data, '{event_spine,dual_write_enabled}', 'true')
where id = 'singleton';
```

A GUC (`ALTER DATABASE … SET`) was **rejected** as the flag store: connection
pooling makes a session GUC unreliable for live toggling. (A GUC is still the
right tool for *correlation* propagation — see below — because that is
per-transaction, not a global switch.)

## The producer contract — a curated mirror, not a copy

`hq_emit_from_activity()` is called once per `_record_activity()` write and is a
**no-op** unless **both** (a) the flag is on **and** (b) the action is one of the
curated **OPERATIONS** verbs in the frozen registry (`lib/events/registry.ts`).
The OPERATIONS group is a deliberate **subset** "mirrored from activity_log", not
the whole activity log — every other action still writes `activity_log` unchanged
and is simply not mirrored to the spine.

The curated map (jobs.status vocabulary is `new | in-progress | completed |
blocked`, so only a transition **to `completed`** yields a canonical job verb;
registry verbs `job.scheduled` / `job.cancelled` have no source action yet and are
not produced):

| activity action | condition | canonical verb |
|---|---|---|
| `customer.created` | — | `customer.created` |
| `customer.updated` | — | `customer.updated` |
| `job.created` | — | `job.created` |
| `job.status_changed` | `metadata->>'to' = 'completed'` | `job.completed` |
| `quote.sent` | — | `quote.sent` |
| `quote.accepted` | — | `quote.accepted` |

When it does emit, it emits **through `hq_emit_event()`** — the same single
validated write entry point the PR1 service path uses, never a raw `INSERT into
hq_events` — in the caller's transaction, so the event is atomic with the state
change. `correlation_id` threads an end-to-end intent from the `hq.correlation_id`
GUC when the caller has set it (Ch.04 coalesce convention), or starts a fresh
trace. `object_type` is the verb namespace (`split_part(verb, '.', 1)`).

## The PII boundary — the spine carries no second copy of tenant PII

The spine is a lean event log, **not** a second copy of tenant PII (Ch.04:
payloads are "small, structured, never PII-heavy"). A naive generalisation would
pass the raw `activity_log` metadata straight through as the payload — but that
metadata **is** PII for several actions: a customer's name/email/phone on
`customer.created`, the changed name on `customer.updated`, a quote signer's name
on `quote.accepted`. So `hq_emit_from_activity()` projects only a **curated,
non-PII** payload — status, identifiers, amounts — and deliberately drops personal
data, which stays in `activity_log` and never crosses into `hq_events`. The
actor's human-readable name is dropped the same way: the event carries
`actor_type` (`human` / `system`) and, for a human, the actor uuid — never the
name. The security suite pins this with a payload-key exclusion on the migration
text, and the integration tier proves it against a live insert.

## Function hardening & privilege model (PR2)

Both new functions follow the PR1 mould: `SECURITY DEFINER` with a pinned empty
`search_path`, `EXECUTE` revoked from `public, anon` **and** `authenticated`, and
granted only to `service_role` (L-4: Supabase's default privileges grant `EXECUTE`
on new public functions directly to the JWT roles, so revoking from `PUBLIC` alone
is not enough). Inside the trigger's `SECURITY DEFINER` chain `current_user` is the
function owner, so the nested `hq_emit_event()` runs as owner — which holds
`EXECUTE` despite the JWT-role revokes and bypasses RLS on the owned
`hq_settings` — under both `service_role`- and `authenticated`-initiated writes.

## Test coverage (PR2)

| Tier | File | Proves |
|---|---|---|
| Integration | `__tests__/integration/spine/domain-producers.test.ts` | **Live Postgres**: flag off ⇒ `activity_log` written, zero events (ships dark); flag on ⇒ the curated OPERATIONS verbs are mirrored, each in the same transaction as the state change; out-of-subset actions (`customer.deleted`, job → `blocked`, `quote.created`) are NOT mirrored; no tenant PII crosses into the payload, yet curated non-PII hints (status, quote number) survive. |
| Security | `__tests__/security/event-spine-producers-invariants.test.ts` | Hermetic pins on the migration text: ships dark (seeds false, never true, stored off the operator UI, only-when-absent); `_record_activity` generalised in place; emits **through** `hq_emit_event` not a raw `INSERT`; correlation coalesce; no PII payload key; the produced verb set is **exactly** the curated OPERATIONS subset and every verb is registered; `SECURITY DEFINER` + pinned `search_path`; `EXECUTE` revoked from `public, anon, authenticated` and granted only to `service_role`. |

"Mocks prove intent; real infrastructure proves behaviour" — the security tier
pins the producer contract against the migration source; the integration tier
proves the dual-write, the dark-ship, the curated subset and the PII boundary
actually hold in a live database.

---

# Roadmap

PR1 (storage + write primitive) and PR2 (producers) are in. Per the locked
implementation order, the following remain:

- **PR3** — Offset consumer: the drainer, replay, lag/dead-letter metrics, golden
  signals, cron integration.
- **PR4** — Historical backfill of `activity_log` / `admin_activity_log` /
  `hq_memory_events` into canonical events (idempotent).
- **PR5** — Timeline / The Pulse (first customer-visible deliverable) +
  `requireHqPage()`.
- **PR6** — Realtime: server-authorised broadcaster + live channels.
- **PR7** — Hooks: notification + AI + automation hooks consume the spine.
