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

# HQ Event Spine — PR3: Offset Consumer

> Module 1, PR3 (CEO Directive #003, decision **D2** — cron-based offset consumer,
> **no LISTEN/NOTIFY**). PR1 landed the spine's storage and write primitive; PR2
> wired the first producers. PR3 lands the **read side**: a generic SQL drainer
> that reads new events since a durable offset, applies each **idempotently**, and
> advances the offset in the **same transaction** (Ch.04). At-least-once delivery
> over an idempotent apply is **effectively-once** — we never claim exactly-once
> (P8). Consumers order by `id` (the total order), never `ts`.

PR3 ships **dark**. A global kill-switch `event_spine.consumer_enabled` defaults
**off**, so applying the migration changes no behaviour: the cron fires but
short-circuits, and in prod **no consumer is registered yet**, so the drain is
doubly a no-op until PR5 registers the timeline projection. The transactional
core lives in **SQL** (mirroring PR1's `hq_emit_event` and PR2's producer) because
supabase-js has no client-side multi-statement transaction and per **D1** we do
not invent one; the TS/cron layer only *triggers* the drain.

Migration: `supabase/migrations/20260720020000_hq_event_spine_consumers.sql`.

## What PR3 ships

| Object | Kind | Purpose |
|---|---|---|
| `event_spine.consumer_enabled` | flag (in the `hq_settings` singleton JSONB) | The dark-ship / kill-switch. Seeded `false`; flipped at runtime with no deploy. Symmetric with PR2's `dual_write_enabled`. |
| `public.hq_spine_consumer_enabled()` | function (SECURITY DEFINER) | Reads the flag; returns `false` on any miss. `service_role`-only. |
| `public.hq_consumer_register(...)` | function (SECURITY DEFINER) | Registers a consumer at a start offset (`on conflict do nothing`), so a redeploy never rewinds a live consumer. |
| `public.hq_consumer_apply(...)` | function (SECURITY DEFINER) | The apply seam — **static** `CASE` dispatch on consumer name. No dynamic `EXECUTE`. `else null` is the forward-compatible no-op. |
| `public.hq_drain_consumer(...)` | function (SECURITY DEFINER) | The drain engine: gate → lock → bounded id-order read → apply → transactional advance → dead-letter. Returns a jsonb summary. |
| `public.hq_replay_consumer(...)` | function (SECURITY DEFINER) | Rewinds the offset (default 0) and clears retry/dead rows beyond it — the deterministic "drop + replay". |
| `public.hq_spine_golden_signals()` | function (SECURITY DEFINER) | Read-side rollup: throughput windows, per-consumer lag, dead-event count, retry backlog (Ch.15). |
| `public.hq_consumer_retries` | table (RLS:hq) | Transient per-event failure counter — the dead-letter ledger across cron runs. |
| `public.hq_consumer_selftest` | table (RLS:hq) | The conformance read-model for the `__spine_selftest__` fixture (dormant in prod). |
| `server/services/spine-consumer.ts` | TypeScript (`server-only`) | Never-throwing wrappers: `drainRegisteredConsumers()`, `drainConsumer()`, `registerConsumer()`, `replayConsumer()`, `getSpineGoldenSignals()`, `isConsumerEnabled()`. |
| `app/api/cron/spine-drain/route.ts` | route | The guaranteed-delivery cron (`* * * * *`, Bearer `CRON_SECRET`). |

`hq_event_consumers` (the durable offsets) and `dead_events` (the poison side
table) were created **dark** in PR1; PR3 is the code that first writes them.

## The consumer gate — symmetric with the producer gate

The kill-switch lives in the existing `hq_settings` singleton JSONB under the same
non-UI **`event_spine`** section as PR2's `dual_write_enabled` — "maximum reuse,
minimum complexity". It is deliberately **not** in the settings TS `SECTION_IDS`,
so the operator page never renders it: this is a low-level **infra kill-switch**.
It seeds **`false`** without clobbering an operator's value (the seed `UPDATE`
writes only when the key is absent). Flip it on later, at runtime, no deploy:

```sql
update public.hq_settings
  set data = jsonb_set(data, '{event_spine,consumer_enabled}', 'true')
where id = 'singleton';
```

`drainRegisteredConsumers()` reads the gate **first** and, while dark,
short-circuits to `{ ok: true, enabled: false, results: [] }` **without even
reading the registry** — so a dark cron run is one cheap gated RPC.

## Never process an event twice

Three mechanisms compose to make a double-apply impossible (the CEO's hard
invariant), each pinned by the security tier and proven live by the integration
tier:

1. **Strict id-order, bounded read.** The drain reads `where id > v_offset order
   by id asc limit greatest(p_max_events, 1)` — strictly after the offset, in the
   total order, never an unbounded scan.
2. **Single-active-drainer lock.** It selects the consumer's offset row `FOR
   UPDATE SKIP LOCKED`. Two overlapping cron runs can't both drain one consumer:
   the second finds the row locked and leaves (`skipped: 'locked'`) — it never
   double-applies.
3. **Transactional advance.** The offset advances (`v_offset := v_ev.id`) **only
   after** a successful `hq_consumer_apply`, and is persisted back to
   `hq_event_consumers` in the **same call**. A crash mid-drain rolls back both the
   apply and the advance, so the next run resumes exactly where it stopped.

Idempotency is belt-and-braces on top: the selftest projection upserts `ON
CONFLICT (consumer, event_id) DO NOTHING`, so even a re-apply of the same event is
a no-op. An immediate re-drain therefore processes **0** events and advances the
offset by nothing.

## Replay is deterministic — the offset is the only state

`hq_replay_consumer(consumer, to_id => 0)` rewinds the offset to
`greatest(to_id, 0)` and deletes the transient retry + dead rows **beyond** that
point, so a redrive starts clean. Because the apply is idempotent and reads the
immutable, append-only log in id-order, **drop + rewind + redrive rebuilds a
byte-identical read-model** — the bible's effectively-once oracle. The integration
tier proves it: it snapshots the projection, drops it, replays to the suite
baseline, redrives, and asserts the rebuilt projection equals the original.

## Dead-letter handling — one poison event never blocks the stream

Per-event failures are counted in `hq_consumer_retries` across cron runs. The
apply runs in a nested `BEGIN … EXCEPTION` so a throw is caught, not fatal:

- **Below the attempt threshold** the poison event is **head-of-line**: the batch
  stops at it (`stopped: 'retry_pending'`), the offset does **not** pass it, and it
  is retried on the next run. Transient failures heal themselves.
- **At the threshold** (`v_attempts >= greatest(p_max_attempts, 1)`) the event is
  **parked** in `dead_events` (`on conflict (consumer, event_id) do nothing`), the
  offset advances **past** it, and the good events behind it flow again — one bad
  event can never wedge the stream.

When an event is dead-lettered the drain raises `system.alert_raised` **through the
validated `hq_emit_event` entry point** (never a raw `INSERT into hq_events`),
carrying the consumer, event id, verb and attempt count at `critical` severity.
That emit is **best-effort** — wrapped in its own `BEGIN … EXCEPTION WHEN OTHERS
THEN NULL` block — so a telemetry hiccup can never roll back the drain's committed
progress.

## Golden signals — read-side, computed on demand (Ch.15)

`hq_spine_golden_signals()` is a cheap **read rollup**, not a projection: it
computes throughput windows (`last_1m` / `last_1h` / `last_24h` over `hq_events.ts`),
**per-consumer lag** as `max(id) − last_event_id` (the lag canary), the
`dead_event_count` and the retry backlog — in two scalar reads. The cron surfaces
them alongside what it drained so each `cron_runs` row is itself the drainer-health
signal; in prod they read out flat (no consumer, no lag) until PR5.

## The conformance fixture — a dormant idempotency oracle

PR3 ships a generic engine but the timeline projection it will ultimately feed
arrives in PR5. To prove the engine **now** without pre-empting PR5, it carries a
self-test consumer `__spine_selftest__` whose projection (`hq_consumer_selftest`,
PK `(consumer, event_id)`) is naturally idempotent — the bible's byte-identical
oracle for the idempotency and replay tests. It is **dormant in prod**: only the
integration tier ever registers it. A test-only failure injection — an event whose
payload carries `{"__poison__": true}` — forces the selftest apply to throw, so the
dead-letter path is exercised against a live database; the magic key is scoped to
that one consumer so the generic apply path carries no test affordance. The
`CASE` is **static** by design: a `SECURITY DEFINER` function that `EXECUTE`d a
stored handler name would be a privilege-escalation surface, so the whole PR3
migration contains **zero dynamic SQL**. PR5 adds the real `timeline` branch.

## Function hardening & privilege model (PR3)

All six new functions follow the established mould: `SECURITY DEFINER` with a
pinned empty `search_path`, `EXECUTE` revoked from `public, anon` **and**
`authenticated`, granted only to `service_role` (L-4: Supabase's default
privileges grant `EXECUTE` on new public functions directly to the JWT roles, so
revoking from `PUBLIC` alone is not enough). The drain primitive is therefore
**uncallable by any JWT client** — only the service-role cron can drive it. Both
new tables are **RLS:hq** (RLS enabled, zero policies), and no privilege is ever
granted to `anon`, `authenticated` or `public`.

## Test coverage (PR3)

| Tier | File | Proves |
|---|---|---|
| Unit | `__tests__/ops/spine-consumer.test.ts` | Service-layer contract against a mocked admin client: bounded-batch arg mapping + defaults (500/5); the never-throw contract (a rejected RPC ⇒ `ok:false`); `drainRegisteredConsumers` **short-circuits** while dark (never reads the registry); register/replay arg mapping; golden-signals null-on-error; `isConsumerEnabled` fail-dark. |
| Integration | `__tests__/integration/spine/offset-consumer.test.ts` | **Live Postgres**: ships dark (gate off ⇒ `consumer_disabled`, offset untouched); gate on ⇒ drains in id-order, applies, advances to caught-up; an immediate re-drain processes **0** (never twice); replay rebuilds a byte-identical read-model; a poison event stops head-of-line then is dead-lettered after N attempts, the offset advances past it and `system.alert_raised` fires; golden signals read out (throughput, per-consumer lag, dead count). |
| Security | `__tests__/security/event-spine-consumers-invariants.test.ts` | Hermetic pins on the migration text: ships dark (seeds `consumer_enabled` false, never true, off the operator UI, only-when-absent; drain fails-dark); can't double-apply (`for update skip locked`, strict id-order, bounded limit, advance-follows-apply, persists offset); idempotent apply (`on conflict do nothing`, **no** dynamic `EXECUTE`, `else null`); dead-letter (threshold, parks in `dead_events`, alert **through** `hq_emit_event` not a raw `INSERT`, best-effort); replay (rewind + clears retry/dead beyond the point); golden-signals lag formula; `SECURITY DEFINER` + pinned `search_path`; `EXECUTE` revoked from `public, anon, authenticated` and granted only to `service_role`; new tables RLS:hq. |

"Mocks prove intent; real infrastructure proves behaviour" — the unit tier maps
the service contract against a mock; the security tier pins the drain/replay/
dead-letter contract against the migration source; the integration tier proves the
dark-ship, the never-twice guarantee, deterministic replay and dead-lettering
actually hold in a live database.

---

# HQ Event Spine — PR4: Historical Backfill

> Module 1, PR4 (CEO Directive #003, decision **D2** — cron only, no LISTEN/NOTIFY).
> PR1 landed the spine's storage and write primitive; PR2 wired the forward
> producers; PR3 landed the consumer side. PR4 lands the **backfill**: it replays
> the surviving historical rows of the three legacy logs — `activity_log`,
> `admin_activity_log`, `hq_memory_events` — into canonical `hq_events`, so the
> spine's timeline reaches back **before the producers existed**. Each legacy row
> maps to **one** canonical event carrying its **original `ts`**, guarded so a
> re-run can never duplicate (Ch.04 §backfill, Ch.11 §legacy→canonical mapping).
>
> The CEO's four invariants — **fully idempotent / no duplicate events**,
> **replay-safe / restartable at any point**, **deterministic ordering**, **zero
> customer downtime / dark shipped** — are each guaranteed by construction below.

PR4 ships **dark**. A third infra kill-switch `event_spine.backfill_enabled`
defaults **off**, so applying the migration changes no behaviour and emits **not
one event** until an operator opts in — until then every entry point is a single
cheap gated RPC. No tenant table is mutated: the legacy rows are **read, never
changed** (P2), so the change is provably additive.

Migration: `supabase/migrations/20260720030000_hq_event_spine_backfill.sql`.

## What PR4 ships

| Object | Kind | Purpose |
|---|---|---|
| `event_spine.backfill_enabled` | flag (in the `hq_settings` singleton JSONB) | The dark-ship / kill-switch. Seeded `false`; flipped at runtime with no deploy. Symmetric with PR2/PR3. |
| `public.hq_spine_backfill_enabled()` | function (SECURITY DEFINER) | Reads the flag; returns `false` on any miss. `service_role`-only. |
| `public.hq_backfill_state` | table (RLS:hq) | Durable per-source progress: the `(cursor_created_at, cursor_id)` walk position, the once-captured `ceiling`, status (`idle`/`running`/`done`) and counters. |
| `public.hq_backfill_register(...)` | function (SECURITY DEFINER) | Ensures a source's state row exists (`on conflict do nothing`). |
| `public.hq_backfill_emit(...)` | function (SECURITY DEFINER) | The **one** historical-insert primitive: writes a single `hq_events` row carrying the original `ts` + a deterministic `correlation_id`, **only where NOT EXISTS** a prior event with the same backfill key. Returns `true` iff a row was inserted. |
| `public.hq_backfill_drain(...)` | function (SECURITY DEFINER) | Replays one source's next bounded batch in `(created_at, id)` order: gate → lock → capture ceiling → walk → map → emit → transactional cursor advance. Returns a jsonb summary. |
| `public.hq_backfill_reset(...)` | function (SECURITY DEFINER) | Rewinds a source to the sentinels for a from-scratch redrive (the guard keeps it duplicate-free). |
| `public.hq_backfill_status()` | function (SECURITY DEFINER) | Read-side rollup: the gate + every source's status/counters (Ch.15), surfaced by the cron run. |
| `server/services/spine-backfill.ts` | TypeScript (`server-only`) | Never-throwing wrappers: `runBackfill()`, `backfillSource()`, `resetBackfill()`, `getBackfillStatus()`, `isBackfillEnabled()`. |
| `app/api/cron/spine-backfill/route.ts` | route | The guaranteed-delivery cron (`* * * * *`, Bearer `CRON_SECRET`). |

## The backfill gate — symmetric with the producer and consumer gates

The kill-switch lives in the existing `hq_settings` singleton JSONB under the same
non-UI **`event_spine`** section as PR2's `dual_write_enabled` and PR3's
`consumer_enabled` — "maximum reuse, minimum complexity". It is deliberately **not**
in the settings TS `SECTION_IDS`, so the operator page never renders it: a low-level
**infra kill-switch**. It seeds **`false`** without clobbering an operator's value
(the seed `UPDATE` writes only when the key is absent). Flip it on at runtime, no
deploy:

```sql
update public.hq_settings
  set data = jsonb_set(data, '{event_spine,backfill_enabled}', 'true')
where id = 'singleton';
```

`runBackfill()` reads the gate **first** and, while dark, short-circuits to
`{ ok: true, enabled: false, results: [] }` **without draining a single source**.

## Historical `ts` — why a dedicated INSERT, not `hq_emit_event`

A backfilled event must carry its **original `ts`** (the legacy `created_at`), so it
lands in the right monthly partition and orders correctly on the timeline — and that
determinism is also what makes replay idempotent. But `hq_events` is RANGE
partitioned by `ts`, the validated live entry point `hq_emit_event` has **no `ts`
parameter** (it always defaults `ts = now()`), and PR1's core is **frozen**. So the
backfill path is legitimately distinct: it writes through `hq_backfill_emit` — a
`SECURITY DEFINER`, `service_role`-only INSERT carrying the original `ts` and a
deterministic `correlation_id = md5(source || ':' || id)::uuid` — **never** through
`hq_emit_event`. The append-only guard blocks `UPDATE`/`DELETE`, **not** `INSERT`, so
a direct historical insert is permitted. (History older than the partition runway
lands safely in the `hq_events_default` partition PR1 created for exactly this.)

> **Lesson (Ch.04).** "Emit through the one validated entry point" is the rule for
> *live* events; backfill is the deliberate exception, because the original `ts` is
> load-bearing and the frozen `hq_emit_event` cannot carry it. The exception is
> contained to **one** auditable primitive so the ts / correlation / dedup contract
> lives in exactly one place.

## The replay adapters — mirror the live producer, grounded in the real vocabulary

Each source is mapped from the **real** producer vocabulary, not a guessed catalogue:

- **`activity_log`** mirrors PR2's `hq_emit_from_activity` **exactly** — the same
  curated six verbs (`customer.created/updated`, `job.created`, `job.completed` on a
  status change to `completed`, `quote.sent`, `quote.accepted`), with byte-for-byte
  the same curated non-PII payloads. History therefore looks precisely as if the
  forward producer had always run; when the producer is later expanded, backfill
  follows.
- **`admin_activity_log`** projects **only** the unambiguous canonical billing trio
  (`stripe.invoice_paid → invoice.paid`, `stripe.invoice_failed →
  invoice.payment_failed`, `stripe.subscription_deleted → org.churned`). Operator-
  audit noise (impersonation, notes, CRM, support, alerts) is deliberately **not**
  projected — the spine is the business-event heartbeat, not the operator click
  trail.
- **`hq_memory_events`** maps `created → memory.asserted` and a `status_changed` to
  `superseded → memory.superseded`.

> **Lesson (Ch.11) — the mapping must be grounded in production, not the spec.** The
> Bible's Ch.11 sketch assumed `admin_activity_log` action strings
> (`org.suspended`, `org.trial_converted`-style) that **do not exist** in
> production; the real org/billing lifecycle is Stripe-webhook-shaped. We project
> only what genuinely exists and defer the richer Stripe→canonical mapping
> (subscription modes, checkout/trial detection) to a dedicated billing-producer PR
> rather than force-fit a guessed vocabulary ("rows with no registry verb are not
> projected").

> **Lesson (Ch.11) — one canonical source per verb.** Memory creation is double-
> logged: it appears in `admin_activity_log` as `hq_memory.created` **and** in
> `hq_memory_events`. The memory verbs are owned by the `hq_memory_events` adapter,
> so the admin adapter does **not** project `hq_memory.*` — otherwise the same
> logical event would be emitted twice, and the backfill key (which dedups only
> *within* a source) could not collapse a cross-source duplicate.

## The four invariants — how each is guaranteed

- **Idempotent / no duplicate events.** Every emitted event carries
  `{backfill_source, backfill_source_id}` in its payload, and `hq_backfill_emit`
  inserts **only where NOT EXISTS** a prior event with that key. The spine is
  append-only and can never be reset, so this guard — not a cursor alone — is what
  makes a **full** replay non-duplicating. A point-lookup index
  (`hq_events_backfill_source_idx` on the two payload keys) keeps the probe off the
  partition scan.
- **Replay-safe / restartable at any point.** Progress is a durable per-source
  cursor `(created_at, id)` advanced in the **same transaction** as the inserts
  (PR3's transactional-advance pattern): a crash rolls back **both**, so the next run
  resumes exactly where it stopped. `hq_backfill_reset` rewinds to the sentinels for
  a from-scratch redrive; the NOT EXISTS guard keeps that duplicate-free (a redrive
  re-walks every row but re-inserts nothing).
- **Deterministic ordering.** Each source is walked in strict `(created_at, id)`
  order — `id` is the row's uuid PK, a stable total order with no ties — bounded
  above by a **ceiling** captured **once** at start (`order by created_at desc, id
  desc limit 1`), so backfill only ever touches **history** and never races the
  forward path.
- **Zero customer downtime / dark shipped.** The gate defaults `false` and lives off
  the operator UI; with it off every entry point is a cheap no-op. The cron is
  bounded (`p_max_rows`, default 500) so each run is small and restartable.

## The namespaced provenance key — a collision the integration test caught

The idempotency key travels **in** the payload and is merged **on top** of the
curated mapping payload with jsonb `||`, where the right operand wins on a key
clash. An earlier draft used a **bare** `source` key for the provenance — and
`quote.accepted`'s curated payload already carries its **own** `source` (the
acceptance channel, e.g. `public_link`). The bare key silently **clobbered** the
domain field, overwriting `public_link` with `activity_log` and breaking
forward/backfill parity. The fix is to **namespace** the provenance under
`backfill_source` / `backfill_source_id`, which can never collide with a curated
domain field, so domain payloads survive byte-for-byte.

> **Lesson (Ch.04 + Ch.11) — a provenance/idempotency key merged into a payload must
> be namespaced** so it can never shadow a domain field of the same name. This was
> caught while **designing the integration test** (`quote.accepted` is the one
> curated payload with its own `source`), not by a mock — a concrete instance of
> "real infrastructure proves behaviour": the security suite now pins both the
> namespaced key **and** a regression guard against the bare `source` form.

## Function hardening & privilege model (PR4)

All six new functions follow the established mould: `SECURITY DEFINER` with a pinned
empty `search_path`, `EXECUTE` revoked from `public, anon` **and** `authenticated`,
granted only to `service_role` (L-4: Supabase's default privileges grant `EXECUTE`
on new public functions directly to the JWT roles, so revoking from `PUBLIC` alone
is not enough). The backfill is therefore **uncallable by any JWT client** — only
the service-role cron can drive it. `hq_backfill_state` is **RLS:hq** (RLS enabled,
zero policies). There is **zero dynamic SQL**: every source read is a **static**
`CASE` branch (a `SECURITY DEFINER` function that `EXECUTE`d a source name would be a
privilege-escalation surface we refuse on the spine).

## Test coverage (PR4)

| Tier | File | Proves |
|---|---|---|
| Unit | `__tests__/ops/spine-backfill.test.ts` | Service-layer contract against a mocked admin client: bounded-batch arg mapping + default (500); a **string** `skipped` read as a no-op reason vs a numeric counter; the never-throw contract (a rejected RPC ⇒ `ok:false`); `runBackfill` **short-circuits** while dark (never drains a source); drains all three sources in order; reset/status/`isBackfillEnabled` fail-dark. |
| Integration | `__tests__/integration/spine/backfill.test.ts` | **Live Postgres**: ships dark (gate off ⇒ `backfill_disabled`, zero events, state untouched); deterministic `(created_at, id)` order + bounded batches + cursor resume; the oracle — every legacy row maps to one canonical event with its **original `ts`**, deterministic correlation and curated payload, and `quote.accepted` keeps its own `source` beside the namespaced provenance; **no duplicates** on a full re-drain; **restartable** — reset + redrive re-emits nothing and rebuilds byte-identical events; the legacy rows are never mutated. |
| Security | `__tests__/security/event-spine-backfill-invariants.test.ts` | Hermetic pins on the migration text: ships dark (seeds `backfill_enabled` false, never true, off the operator UI, only-when-absent; drain fails-dark); original `ts` via a direct INSERT **not** `hq_emit_event`; deterministic md5 correlation; the **NOT EXISTS** guard on the namespaced key (+ a regression guard against a bare `source`); deterministic `(created_at, id)` walk, captured ceiling, single-active lock, transactional advance; the three grounded mappings; reset sentinels; **no** dynamic SQL; `SECURITY DEFINER` + pinned `search_path`; `EXECUTE` revoked from `public, anon, authenticated` and granted only to `service_role`; `hq_backfill_state` RLS:hq. |

"Mocks prove intent; real infrastructure proves behaviour" — the unit tier maps the
service contract against a mock; the security tier pins the backfill contract against
the migration source; the integration tier proves the dark-ship, the original-`ts`
replay, deterministic ordering, the no-duplicate guard and restartability actually
hold in a live database — and is where the namespaced-key collision was caught.

> **Lesson (Directive #004, six-gate CI) — an integration fixture must reckon with
> EXACTLY the migration-seeded baseline: no more, and no less.** CI is
> **migrations-only** (a fresh `supabase start`, no `seed.sql`), so the database holds
> precisely what the migrations create — nothing an operator later added in prod, and
> nothing less than the migrations' own seed rows. Two consecutive CI runs each caught
> a different side of this, both invisible to a mock:
>
> 1. **Prod-only data is absent.** The memory fixture used a `memory_type` slug
>    (`fact`) that exists in production — an operator added it through the admin UI,
>    since types are *extensible data* — but that no migration seeds, so it violated
>    the `hq_memory_types` FK. Fix: seed from a **migration-provided** slug
>    (`engineering`). A fixture may assume only what the migrations create.
> 2. **Migration-seeded example data is present.** The shared-memory **seed migration**
>    inserts six example `hq_memory_events`, so the table is **not** empty in CI. The
>    deterministic bounded-batch test asserts whole-*source* drain arithmetic, and the
>    drain walks the entire table — so those six recent-`now()` rows extended the
>    captured ceiling past our year-2000 seeds and leaked an extra batch. Fix: a
>    whole-table assertion must **own the table's contents** — clear every pre-existing
>    row in `beforeAll` so the source holds exactly the fixtures (safe here: no other
>    integration suite reads it and the CI database is ephemeral).
>
> The unifying rule: a real-Postgres fixture is only deterministic if it accounts for
> the migration baseline on both sides. This is exactly the class of gap the
> real-Postgres tier exists to catch — a mock would have sailed past both.

---

# Roadmap

PR1 (storage + write primitive), PR2 (producers), PR3 (offset consumer) and PR4
(historical backfill) are in. Per the locked implementation order, the following
remain:

- **PR5** — Timeline / The Pulse (first customer-visible deliverable) +
  `requireHqPage()`.
- **PR6** — Realtime: server-authorised broadcaster + live channels.
- **PR7** — Hooks: notification + AI + automation hooks consume the spine.
