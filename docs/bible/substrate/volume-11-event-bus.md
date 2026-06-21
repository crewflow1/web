# Volume XI — Event Bus

> **Substrate Block, document 3 of 5.** Architecture only. Read `./README.md`
> first; this volume uses the shared primitives (P1–P7) and does not redefine
> them.
>
> *Provisional numbering "XI" per the CEO directive; collides with the existing
> Sales volume. Tracked in the canonical renumber.*

---

## 1. Purpose & scope

**The job, in one sentence:** be the substrate's **nervous system** — the single
append-only stream every state change flows through, that every subsystem
publishes to and subscribes from, with guaranteed ordering, at-least-once
delivery, retry, dead-lettering, replay and monitoring.

This volume is unusual: **most of it is already built.** CrewFlow shipped the
**Event Spine** across five migrations (`20260720000000`–`20260720030000` +
PR5) — the append-only `hq_events` log, the validated write primitive
(`hq_emit_event`), durable consumer offsets, the transactional drainer
(`hq_drain_consumer`) with per-event retry, a poison-event dead-letter side
table (`dead_events`), a replay engine (`hq_replay_consumer`), and read-side
golden signals (`hq_spine_golden_signals`). The Engineering Bible's Ch.03/04/15
*are* this system.

So Volume XI's purpose is twofold: (1) **canonise the Event Spine as the
substrate Event Bus** — promote it from "the HQ Sales timeline's plumbing" to
*the OS-wide message bus every AI employee uses* — and (2) specify the **deltas**
that turn a one-consumer timeline projector into a general, multi-subscriber bus:
a verb registry, a data-driven subscription model, priority lanes, and the SDK
publish/subscribe surface. Every section below is explicit about **what is
shipped** vs **what is a delta**, so no one rebuilds the spine.

**In scope:** event schema & the verb registry; publishers; subscribers &
subscriptions; priorities; retry; DLQ; ordering; correlation; replay; storage &
retention; monitoring.

**Out of scope (owned elsewhere):** the *meaning* of specific verbs (each owning
volume defines its own — `ai.message.*` in IX, `memory.*` in X, `task.*` in XII);
*who* may publish as whom (XIII identity); realtime *push to browsers* (a UI
concern — the Pulse/Realtime track, partially pending as spine PR6).

---

## 2. Where it sits

```
  PUBLISHERS                        THE BUS                         SUBSCRIBERS
  ─────────                    ┌──────────────────┐                ───────────
  DB triggers (BUILT) ───────▶ │   hq_events       │ ──drainer────▶ timeline (BUILT)
  service hq_emit_event ─────▶ │  append-only,     │ ──(delta)────▶ message router (IX)
  SDK events.publish (XIII) ─▶ │  partitioned,     │ ──(delta)────▶ memory consolidator (X)
  IX/X/XII state changes ────▶ │  id = total order │ ──(delta)────▶ task scheduler (XII)
                               │  + offsets, DLQ,  │ ──(delta)────▶ SLA sweep / escalation (IX/XII)
                               │  replay, signals  │ ──(delta)────▶ webhooks/notifiers (future)
                               └──────────────────┘
                                  every verb is a fact of record (C5 single truth)
```

- **Depends on:** Postgres/Supabase (the spine is Postgres-native, by CEO
  decision D1 — no external broker). The Task Engine (XII) *drives* the drain
  tick (a recurring task), closing C3 (it's not a bespoke poller, it's the
  scheduler).
- **Depended on by:** *everything.* IX delivers messages as bus events; X sources
  episodic memory from the stream and emits audit; XII emits task lifecycle and
  consumes triggers; XIII's audit/observability all land here.

---

## 3. Built vs. to-build (the honest ledger)

| Capability | State | Where |
|------------|-------|-------|
| Append-only event log, partitioned monthly by `ts`, `id` = total order | **Built** | `hq_events`, `hq_create_events_partition`, default catch-all partition |
| Append-only guard (rejects UPDATE/DELETE even under service-role) | **Built** | `hq_events_block_mutation` triggers |
| Validated write primitive | **Built** | `hq_emit_event` (SECURITY DEFINER, service-role-only) |
| Durable per-consumer offsets + registry | **Built** | `hq_event_consumers`, `hq_consumer_register` |
| Transactional drainer (lock, ordered batch, apply+advance atomically) | **Built** | `hq_drain_consumer` (`FOR UPDATE SKIP LOCKED`) |
| Per-event retry counter + backoff | **Built** | `hq_consumer_retries` |
| Dead-letter queue + poison threshold + standing alert | **Built** | `dead_events`, `system.alert_raised` emit |
| Replay engine (reset offset, redrive deterministically) | **Built** | `hq_replay_consumer` |
| Golden signals (throughput, per-consumer lag, dead count, retry backlog) | **Built** | `hq_spine_golden_signals` |
| Producers (dual-write DB triggers, dark-shippable) | **Built** | spine PR2 (`..producers.sql`) |
| One real consumer (timeline projection / The Pulse) | **Built** | spine PR3+PR5 |
| Global kill-switches (dual-write, consumer drain) | **Built** | `event_spine.*` settings flags |
| **Verb registry** (typed catalogue + schema versions) | **Delta** | today a TS registry + contract test; §4 |
| **Data-driven subscriptions** (verb→consumer routing) | **Delta** | today static dispatch in `hq_consumer_apply`; §6 |
| **Priority lanes** (critical drained first) | **Delta** | §7 |
| **SDK publish/subscribe surface** | **Delta** | §12 / XIII |
| **Realtime push to UI** | **Pending** | spine PR6 (Realtime), PR7 (Hooks) — out of substrate scope |

> **The spine is the bus.** This volume does not propose a new bus. It elevates
> the existing one to substrate status and adds four deltas (registry,
> subscriptions, priority, SDK surface). Everything in §§4–11 marked **Built**
> ships today; treat it as the contract, not a proposal.

---

## 4. Event schema & the verb registry

### 4.1 The envelope — **Built** (P1)

`hq_events` is the canonical envelope, specified in `./README.md` §P1 and shipped
in `..core.sql`. The substrate's universal "something happened" record:
`id, ts, actor_type, actor_id, verb, object_type/id, target_type/id,
correlation_id (uuid, NOT NULL), causation_id (bigint), severity, payload (jsonb),
visibility`. **Append-only, transactional-outbox, `id` is the total order.** No
volume changes this shape; they only add verbs.

### 4.2 The verb registry — **Delta**

A *verb* is a past-tense fact name (`task.completed`, `ai.message.sent`,
`memory.written`). Today verb validity is enforced at the producer by a
TypeScript registry + a contract test (Ch.04) — *not* a DB constraint (so a bad
deploy can't wedge the log). The substrate keeps that posture and formalises the
registry as the **shared catalogue** every volume registers into:

```
hq_event_verbs (the catalogue — DATA, not code; new verbs are rows)
  verb            text primary key  check (verb ~ '^[a-z][a-z0-9_.]{1,79}$')
  domain          text not null     -- 'ai' | 'memory' | 'task' | 'sales' | 'system' | ...
  description     text not null
  default_severity text not null    check (... 'info'|'success'|'warn'|'critical')
  payload_schema  jsonb             -- JSON Schema for payload (validated at SDK publish)
  schema_version  integer not null default 1
  is_active       boolean not null default true
```

- **Schema versioning.** `payload` carries `schema_version`; the registry holds
  the JSON Schema per version. Consumers branch on it. Adding a field is a new
  version, never an in-place break — events are immutable history, so old events
  must stay readable forever (replay, §10).
- **Validation at the edge, not the centre.** The SDK validates a publish against
  the registry's schema *before* `hq_emit_event` (fail fast at the producer). The
  DB keeps only the cheap CHECKs (actor_type/severity) so a malformed envelope
  still can't land, but verb/payload validity is a producer contract — exactly
  the spine's current split.
- **Why a registry at all.** It is the contract that lets subscriptions be data
  (§6), lets the docs auto-list every verb a volume emits, and lets a new AI
  employee discover "what events exist that I might care about."

---

## 5. Publishers

Three publisher kinds, all converging on `hq_emit_event` (the one validated
write). **All Built** except the SDK surface.

1. **Database triggers (Built).** Dual-write triggers on source tables emit an
   event when a row changes (spine PR2). Dark-shippable behind the
   `event_spine.dual_write_enabled` flag. This is how *existing* state changes
   (a company status flip, a task transition) become events without rewriting the
   writer. The transactional-outbox guarantee is structural: the trigger fires in
   the writer's own transaction.
2. **Service-layer emits (Built).** Server code calls `hq_emit_event(...)`
   directly inside the same transaction as its write (the established pattern in
   `server/services/*`). Used when the event is richer than a row diff.
3. **SDK `events.publish()` (Delta, XIII).** The AI-employee path: an employee
   never calls `hq_emit_event`; it calls the SDK, which validates against the
   verb registry (§4.2), stamps `actor_type='ai_employee'`, `actor_id=<slug>`,
   inherits the ambient `correlation_id`/`causation_id` (P2), and then calls the
   entry point. This is where "the AI publishes facts" becomes audited and
   un-spoofable (P5).

**The transactional-outbox rule (P1) is non-negotiable for all three:** an event
is emitted in the *same transaction* as the state change it records, so the log
can never disagree with reality.

---

## 6. Subscribers & subscriptions

### 6.1 The consumer model — **Built**

A *consumer* is a named, durable reader with its own offset (`hq_event_consumers`)
drained by `hq_drain_consumer`: it reads `id > offset ORDER BY id`, applies each
event idempotently, and advances the offset **in the same transaction** as the
apply (the resume-exactly guarantee). One consumer (`timeline`) is live today.

### 6.2 The dispatch delta — **Delta**

Today `hq_consumer_apply` uses **static dispatch** (a `CASE` on consumer name) —
a deliberate security choice (no dynamic SQL in a SECURITY DEFINER function). The
substrate keeps the security posture but makes *which verbs a consumer wants*
**data-driven**, so adding a subscriber doesn't require editing the dispatcher's
filter:

```
hq_event_subscriptions (DATA — who wants what)
  consumer        text not null references hq_event_consumers(consumer)
  verb_pattern    text not null         -- exact verb or a prefix glob: 'ai.message.%'
  priority_lane   text not null default 'normal'  check ('critical'|'normal'|'bulk')
  max_attempts    integer not null default 5
  is_active       boolean not null default true
  primary key (consumer, verb_pattern)
```

- The **handler stays static** (a `WHEN consumer THEN ...` branch in
  `hq_consumer_apply`, or a registered server-side handler the drainer dispatches
  to) — the *subscription* (which events reach that handler, at what priority,
  with what retry budget) is the row. Adding the IX message-router or the X
  consolidator is: register the consumer + insert its subscription rows + add its
  apply branch. No change to the drain engine.
- **Forward-compatibility is preserved.** The spine's `else → null` no-op branch
  (a registered consumer with no projection yet just advances its offset) is the
  safety net: a subscription can exist before its handler does.

### 6.3 Push vs. pull

The bus is **pull-based at the core** (the drainer reads in id-order — this is
what makes ordering, replay and at-least-once tractable in Postgres). The drain
*tick* is driven by a recurring Task (XII) — which is precisely why "nothing
polls" is honoured (C3): there is **one** scheduler driving drains, not 13
bespoke pollers. **Push to the browser** (a live Pulse feed) is a thin Realtime
layer over the same log (spine PR6, pending) — out of substrate scope, but it
reads the same `hq_events`, so there is still one source of truth.

---

## 7. Priorities — **Delta**

Two kinds of priority, kept distinct:

- **`severity`** (Built) — *editorial* importance of the fact (`info`…`critical`).
  Already on every event; drives alerting and the `warn/critical` partial index.
- **`priority_lane`** (Delta) — *delivery* urgency, per subscription (§6.2):
  `critical` | `normal` | `bulk`. The drainer drains lanes in order so a
  `critical` event (a security alert, an escalation) is projected before a `bulk`
  backfill, even under load.

Implementation keeps the spine's single-transaction drain: the drainer runs one
bounded batch **per lane** in priority order (critical → normal → bulk), each
lane an independent consumer-offset pass. No lane can starve another beyond one
batch (fairness via bounded batches), and a slow `bulk` consumer never delays
`critical` delivery. Lanes are a routing attribute, not new infrastructure.

---

## 8. Retry rules — **Built** (documented here as the contract)

The drainer's failure handling (`hq_drain_consumer`) is the retry engine:

- An apply that throws is caught in a savepoint (the partial apply rolls back);
  the failure is recorded in `hq_consumer_retries` (attempt count + last error).
- **Head-of-line by default:** a transient failure *stops the batch* at that
  event and leaves the offset before it — the next drain retries it. The cron
  interval is the backoff. This preserves strict per-consumer ordering.
- After `max_attempts` (per-subscription, §6.2), the event is **dead-lettered**
  (§9) and the offset advances *past* it — one poison event never blocks the
  stream forever.
- Retry is **per (consumer, event)** — the same event poisoning consumer A does
  not affect consumer B, which has its own offset and retry rows.

> The substrate makes `max_attempts` and the head-of-line-vs-skip policy
> **configurable per subscription** (the delta), but the engine is the shipped
> drainer. We never claim exactly-once: at-least-once + idempotent =
> effectively-once (the spine's P8).

---

## 9. Dead-letter queue — **Built**

`dead_events` (Built) is the DLQ: `(consumer, event_id)` unique (idempotent
parking), with `verb`, `error`, `attempts`, `payload`, `created_at`. When a
consumer exhausts attempts on an event:

1. the event is parked in `dead_events`;
2. the offset advances past it (the stream keeps flowing);
3. a `critical` `system.alert_raised` event is emitted (best-effort — a failed
   alert never aborts the drain), which raises the standing DLQ alarm on the
   golden signals.

**Inspection & redrive** (Delta — operational tooling): an operator surface lists
dead events; *redrive* is either (a) `hq_replay_consumer` to a point before the
parked event after a fix (re-attempt in order), or (b) a targeted re-apply of a
single parked event once its handler is patched. Both reuse shipped primitives;
the delta is the HQ surface, not new engine.

---

## 10. Ordering, correlation & replay

- **Ordering (Built).** `hq_events.id` (a parent-identity bigint) is the **total
  order**; consumers order by `id`, never by `ts`. Per-object ordering is implied
  (events for one `object_id` appear in id-order). The substrate does **not**
  promise cross-consumer or cross-object global *processing* parallelism beyond
  this — if a future consumer needs per-key parallel lanes, that is a documented
  extension (partition the consumer by `object_id` hash), not a change to the log.
- **Correlation (Built, P2).** `correlation_id` (the saga) + `causation_id` (the
  parent event id) are first-class. The whole substrate's traceability rests on
  this: "everything that happened because of request X" = `WHERE correlation_id
  = X ORDER BY id`; the causal DAG is the `causation_id` chain.
- **Replay (Built).** `hq_replay_consumer(consumer, to_event_id)` resets an
  offset (default 0 = from the beginning) and clears that consumer's retry/dead
  rows, so redriving rebuilds a deterministic read-model from history. Uses:
  rebuild a projection after a logic fix; recover a consumer; time-travel
  debugging. **Determinism** holds because the offset is the only state and
  applies are idempotent — the spine's core guarantee.

---

## 11. Storage & retention — **Built**

- **Partitioned monthly by `ts`** (RANGE), with the current month + 6 ahead
  pre-created and a `DEFAULT` catch-all so an insert can never fail on a missing
  partition. A daily **partition-creator cron** (a recurring task, XII) stays ~2
  months ahead (`hq_create_events_partition`).
- **Per-partition RLS** is enabled in its own right (partitions don't inherit the
  parent's RLS flag) — defence-in-depth (the spine's security note).
- **Retention via DETACH, not DELETE.** Cold partitions are *detached* to cold
  storage (the append-only guard blocks row DELETE even under service-role;
  retention is DDL, not DML). The retention policy (how many hot months before
  detach/archive) is an operator setting — flagged as a decision (§16), since the
  bus is now OS-wide and busier than the sales timeline alone.

---

## 12. Interfaces

### 12.1 SQL entry points — **mostly Built** (P5)

```
-- BUILT (the spine):
hq_emit_event(actor_type, actor_id, verb, object_type, object_id,
              correlation_id, target_type, target_id, causation_id,
              severity, payload, visibility) returns bigint   -- the write
hq_consumer_register(consumer, start_event_id) returns void
hq_drain_consumer(consumer, max_events, max_attempts) returns jsonb -- the drainer
hq_replay_consumer(consumer, to_event_id) returns jsonb
hq_spine_golden_signals() returns jsonb
hq_create_events_partition(anchor) returns text

-- DELTA (this volume):
hq_event_verb_register(verb, domain, description, default_severity,
                       payload_schema, schema_version) returns void  -- §4.2
hq_subscription_upsert(consumer, verb_pattern, priority_lane, max_attempts) returns void -- §6.2
hq_drain_all(max_events) returns jsonb   -- drains every registered consumer,
                                         -- lane-ordered (§7); the tick's entry point
```

All entry points: `SECURITY DEFINER`, `set search_path=''`, `EXECUTE` revoked
from `public, anon, authenticated`, granted only to `service_role` (P5).

### 12.2 TypeScript SDK surface (XIII)

```ts
interface Events {
  // Publish a fact. The SDK validates `verb`+`payload` against the registry,
  // stamps actor=this employee, inherits correlation/causation (P2), then emits.
  publish(opts: {
    verb: string; object: Ref; target?: Ref;
    payload: unknown; severity?: Severity;
  }): Promise<EventId>;

  // Subscribe declaratively (registers the consumer + subscription rows). The
  // handler is wired server-side (a drainer apply-branch), not arbitrary code
  // injected at runtime — the security posture of static dispatch is preserved.
  subscribe(opts: {
    consumer: string; verbs: string[]; lane?: PriorityLane;
    maxAttempts?: number;
  }): Promise<void>;

  // Read-side helpers.
  trace(correlationId: string): Promise<EventRow[]>;     // the whole saga, ordered
  signals(): Promise<GoldenSignals>;                     // hq_spine_golden_signals
}
```

---

## 13. Worked flow — one fact, many subscribers

```
1. Lead Qualification AI completes → SDK.events.publish('lead.qualified', …)
   → hq_emit_event (one txn with the task result write)  → hq_events.id = 5012
2. hq_drain_all tick (a recurring task, XII) drains each consumer, lane-ordered:
   • timeline consumer  → projects a Pulse row (BUILT)
   • task scheduler (XII) → sees 'lead.qualified', spawns an 'outreach.prepare' task
   • memory consolidator (X) → records an episodic memory of the qualification
   each applies idempotently, advances its own offset in its own txn.
3. A redeploy fixes the timeline projection → hq_replay_consumer('timeline', 0)
   → it re-derives every Pulse row deterministically from history; other
     consumers are untouched (independent offsets).
```

One emit; three independent, ordered, idempotent, individually-replayable
reactions. That is the bus.

---

## 14. Observability — **Built**

`hq_spine_golden_signals()` (Ch.15) returns: throughput (1m/1h/24h), **per-
consumer lag** (`max(id) − offset` — the canary), dead-event count + oldest,
retry backlog. The substrate adds (delta): per-**lane** lag, per-**verb**
throughput, and publish-validation rejections. Surfaced on **The Pulse** (spine
PR5, Built). Alert thresholds: lag over budget, any dead event, non-empty retry
backlog trending up.

---

## 15. Testing (the six gates) — largely **Built**

| Gate | What it proves |
|------|----------------|
| 1 typecheck | `Events` SDK surface, verb/payload typing. |
| 2 lint | conventions. |
| 3 unit | verb-pattern matching, lane ordering, subscription resolution — pure `lib/*`. |
| 4 integration (real Postgres) | **Built and passing**: idempotent apply (same event twice → identical read-model), resume-exactly after a simulated crash, poison → DLQ + offset-advance, replay determinism. The deltas add: multi-consumer fan-out, lane priority under load, data-driven subscription routing. |
| 5 security | **Built**: RLS:hq on `hq_events` + every partition (anon/authenticated denied at the parent, PGRST205 on a child); entry-point `EXECUTE` revoked from JWT roles; pinned per-partition RLS in the migration text. |
| 6 e2e | **Built**: the Pulse surface behind the auth wall (`pulse.spec.ts`). |

The bus already meets the bar on real infrastructure — the substrate's job is to
keep it there as consumers multiply.

---

## 16. Conflicts resolved & open questions

**Resolves:**
- **C3 ("nothing polls")** — the bus is the event-driven backbone; the single
  drain tick is the scheduler (XII), not a poller; existing cron pollers migrate
  to **consumers** incrementally (reclassified, not ripped out — protecting
  production). The architecture is push-shaped even though the core is pull-based.
- **C5 (parallel audit logs)** — `hq_events` is the **system of record**;
  `activity_log` and the `*_timeline_events` tables are **projections** (built by
  consumers), not independent truths. One log, many read-models.

**Open questions for a future directive:**
1. **Retention policy at OS scale.** The sales-era retention assumed timeline-only
   volume. As *every* substrate action emits, hot-partition count, detach cadence
   and cold-storage target need an explicit operator policy. *Recommendation:
   keep N hot months online, detach older to cold storage, never delete.*
2. **Verb registry: data vs. code.** §4.2 proposes a DB catalogue *plus* the
   existing TS registry/contract test. Confirm we keep validation at the producer
   (fail-fast) and the DB CHECKs minimal — i.e. the catalogue is documentation +
   subscription routing, **not** a hot-path DB constraint that a bad verb could
   wedge the log on. *Recommendation: yes — producer-validated, DB-permissive.*
3. **External broker, ever?** CEO decision D1 made this Postgres-native (no
   Kafka/SQS). If throughput ever exceeds what partitioned Postgres serves, an
   external broker is a *future* volume — explicitly not assumed here.

---

*Volume XI of the AI Substrate. Architecture only — no code, no production change,
no PR. Continues into Volume XII (Task Engine), which drives the drain tick and
emits the `task.*` verbs catalogued here.*
