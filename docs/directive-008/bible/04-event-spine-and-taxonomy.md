# Chapter 04 — Event Spine & Taxonomy (Canon)

## Purpose

The spine is the heartbeat of the OS: one append-only log into which every meaningful thing that happens is written exactly once, in order, durably. This chapter specifies the event envelope, the **canonical verb registry** (the single source of event names — no producer may emit a verb not listed here), how events are produced (the transactional outbox), how they are consumed (offsets, idempotency, ordering), the delivery guarantees, and how the spine feeds the timeline, metrics, search, real-time, and the AI workforce. Master this chapter and Ch.03 and you can build any other chapter.

## Goals

- Define the **event envelope** precisely (every field, every rule).
- Publish the **canonical verb registry**, organised by domain, as the one source of event names.
- Specify the **producer contract** (outbox) so state and narrative are inseparable (P1).
- Specify the **consumer contract** (offsets, idempotency, ordering, replay) so delivery is reliable (P8).
- Specify the **real-time publication** path (server-authorized broadcast) and the **backfill** of existing logs.

**Non-goals:** table DDL (Ch.03); the timeline UI (Ch.11); metric formulas (Ch.15); the broadcast/RLS security proof (Ch.16).

---

## Architecture

### The event envelope

Every event is a row in `hq_events` (Ch.03 §03.1). The envelope is fixed; only `payload` varies by verb.

| Field | Rule |
|---|---|
| `id` | DB-assigned `bigint`, monotonic. **The total order.** Consumers order by `id`, never by `ts`. |
| `ts` | Wall-clock for display only. Never used for ordering or correctness. |
| `actor_type` / `actor_id` | Who acted: `human` (HqActor.id), `ai_employee` (slug), `system` (cron/job name), `tenant` (org id). |
| `verb` | A value from the **canonical registry** below. `domain.action`. Required. |
| `object_type` / `object_id` | The primary subject. `object_id` is `text` so any entity qualifies (Ch.03 edge-case note). |
| `target_type` / `target_id` | Optional secondary subject (e.g. an approval's run). |
| `correlation_id` | The trace. **Every event in one end-to-end intent shares it.** Generated at the ingress that starts the intent; propagated through every downstream event. |
| `causation_id` | The `id` of the event that *directly* caused this one. Lets a trace be reconstructed as a tree, not just a flat list. |
| `severity` | `info`/`success`/`warn`/`critical` — drives timeline styling and alert routing. |
| `payload` | `jsonb`. Identifiers + small metadata only. **No PII beyond identifiers, no blobs** (Ch.16). The verb determines the shape; contract tests pin it. |
| `visibility` | `hq` today; the seam for per-role scoping later (Ch.14). |

**Correlation vs causation, by example** (the dunning flow of Ch.02): the Stripe webhook starts a `correlation_id`; `invoice.payment_failed` carries it with `causation_id=null`; `ai.run_started` carries the same correlation, `causation=invoice.payment_failed.id`; `approval.requested` causation = the run-started event; `approval.granted` causation = the request; `email.sent` causation = the grant. One correlation, a causal chain — the whole story, reconstructable (Ch.15).

### Why a bigint id is the order, not the timestamp

Serverless functions have skewed clocks; two events "at the same time" need a deterministic order; replays must be deterministic. A single monotonic identity column gives a **total order** that is stable, gap-detectable, and offset-friendly. `ts` is a human convenience. This is a small decision with large consequences — it is why consumers are reliable.

---

## The canonical verb registry

This is the **single source of event names**. A producer may only emit a verb listed here; adding a verb is an edit to this table + an ADR (Ch.20). Verbs are stable contracts — renaming one is a breaking change handled like a schema migration. Grouped by domain; `{…}` marks the principal object.

### `org.*` — organisation lifecycle `{organization}`
`org.created` · `org.trial_started` · `org.trial_converted` · `org.trial_expired` · `org.subscription_changed` · `org.churned` · `org.reactivated` · `org.suspended` · `org.unsuspended` · `org.health_changed`

### `billing.*` — money `{organization | invoice}`
`invoice.created` · `invoice.payment_succeeded` · `invoice.payment_failed` · `invoice.paid` · `invoice.voided` · `billing.refund_issued` · `billing.dunning_started` · `billing.dunning_resolved` · `billing.dispute_opened`

### `customer.*` / `job.*` — tenant operations (mirrored from `activity_log`) `{customer | job}`
`customer.created` · `customer.updated` · `job.created` · `job.scheduled` · `job.completed` · `job.cancelled` · `quote.sent` · `quote.accepted`

### `support.*` `{support_ticket}`
`support.ticket_opened` · `support.ticket_replied` · `support.ticket_escalated` · `support.ticket_resolved` · `support.csat_recorded`

### `ai.*` — the workforce `{ai_employee}` (target: `run`/`task`)
`ai.triggered` · `ai.run_started` · `ai.planned` · `ai.tool_called` · `ai.run_completed` · `ai.run_failed` · `ai.budget_warned` · `ai.budget_exceeded` · `ai.suspended` · `ai.escalated`

### `approval.*` — human-in-the-loop `{approval}` (target: `run`)
`approval.requested` · `approval.granted` · `approval.rejected` · `approval.edited` · `approval.expired` · `approval.escalated`

### `memory.*` — knowledge `{memory}` (target: entity)
`memory.asserted` · `memory.superseded` · `memory.edge_added` · `memory.access_granted` · `memory.access_revoked`

### `permission.*` — authority `{principal}` (target: role/capability)
`permission.role_granted` · `permission.role_revoked` · `permission.capability_used` (sampled, for high-risk caps)

### `system.*` — the machine itself `{system}`
`system.cron_ran` · `system.cron_failed` · `system.webhook_received` · `system.alert_raised` · `system.alert_resolved` · `system.flag_changed` · `system.projection_rebuilt`

### `notification.*` `{notification}`
`notification.created` · `notification.emailed` · `notification.read`

> **Naming discipline:** `domain.action`, past tense (events are facts that *happened*). Commands ("do X") are never events. The registry is curated; sprawl is the enemy of "one source."

---

## APIs

### Producing events — the transactional outbox

The cardinal rule (P1): **an event is written in the same transaction as the state it describes.** Two mechanisms, one guarantee.

1. **Trigger-emitted (preferred for table mutations).** AFTER triggers on key tables append the canonical event automatically — generalising the existing `_record_activity()`/`notify_*` pattern (♻️). The producer just writes its row; the event is guaranteed.

```sql
-- illustrative: emit org.trial_started whenever an org enters trialing
create function emit_org_trial() returns trigger as $$
begin
  insert into hq_events(actor_type, actor_id, verb, object_type, object_id, correlation_id, payload)
  values ('system','billing', 'org.trial_started', 'organization', new.id::text,
          coalesce(current_setting('hq.correlation_id', true)::uuid, gen_random_uuid()),
          jsonb_build_object('plan', new.plan));
  return new;
end $$ language plpgsql security definer;
```

2. **Service-emitted (for logic-level events).** A thin `emitEvent()` helper called inside the same DB transaction as the state change, in the service layer (Ch.05).

```ts
// illustrative service-layer contract (server-only)
async function emitEvent(tx, e: {
  actorType: 'human'|'ai_employee'|'system'|'tenant'; actorId?: string;
  verb: Verb;                       // typed against the registry — compile-time safety
  objectType: string; objectId: string; targetType?: string; targetId?: string;
  correlationId: string; causationId?: number;
  severity?: 'info'|'success'|'warn'|'critical'; payload?: Json;
}): Promise<{ id: number }>;
```

`Verb` is a TypeScript union generated from the registry, so an unregistered verb **won't compile** — the "one source" rule enforced by the type system, exactly as 007 enforced the design tokens in ESLint.

### Consuming events — offsets, idempotency, ordering

A consumer is a worker that reads new events since its `last_event_id`, processes them idempotently, and advances the offset transactionally.

```ts
// illustrative consumer loop (e.g. the timeline projection)
async function drain(consumer: string) {
  const from = await getOffset(consumer);               // hq_event_consumers
  const batch = await readEventsAfter(from, LIMIT);     // ORDER BY id ASC
  for (const ev of batch) {
    await withTx(async (tx) => {
      await applyIdempotent(tx, consumer, ev);          // keyed by (consumer, ev.id)
      await setOffset(tx, consumer, ev.id);             // advance in the SAME tx
    });
  }
}
```

- **At-least-once + idempotent = effectively-once.** A redelivery re-applies the same `(consumer, event.id)` no-op. We never claim exactly-once (a fiction, P8); we make duplicates harmless.
- **Ordering** is by `id` (the total order). Per-aggregate ordering (all events for one org, in order) falls out because ids are monotonic.
- **Wakeups:** `pg_notify('hq_events')` triggers a drain immediately; a **Vercel cron drainer** runs every minute as the dead-worker safety net (♻️ exactly the `research-drain` pattern). So latency is low *and* delivery is guaranteed even if a wakeup is missed.
- **Replay:** set a consumer's offset back to rebuild its read-model from history. This is how a corrupted projection is repaired (drop + replay), and how a *new* projection backfills.

### Retryable work vs projections

Two consumer classes:
- **Projections** (timeline, metrics, search) are pure and fast; they use the offset-drain above.
- **Side-effecting work** (AI runs, email sends) needs retries with backoff and dead-lettering; it uses the **queue** (`ai_employee_tasks` now; `pgmq` at scale, Ch.17), not the projection drain. The spine *triggers* the enqueue; the queue *manages* the work.

---

## Real-time publication (delivery to the UI)

The spine reaches operators through **server-authorized broadcast**, never by exposing `hq_events` to client subscriptions (which would demand JWT-readable RLS on the most sensitive table — forbidden, Ch.16).

```
hq_events insert ──pg_notify──▶ broadcaster (server, service-role)
                                   │  authorize for HQ audience
                                   │  shape a minimal, vetted delta
                                   ▼
                        Supabase Realtime "Broadcast" channels
                        (joinable only by authenticated super-admins)
                                   ▼
                        Mission Control / Timeline islands  (live prepend)
```

Channels are scoped: a global `hq:pulse` channel for the firehose, per-object channels (`hq:org:{id}`) created on demand for entity pages, and per-employee channels for the workforce view (Ch.06). Authorization reuses `isSuperAdminEmail()`/`requireHqPage()` — the single existing gate.

---

## Backfill — unifying the existing logs (additive)

Two audit logs exist (`activity_log`, `admin_activity_log`) plus `hq_memory_events`. The spine becomes the unified *view* without removing them (P2):

1. **Adapters** map each historical row to a canonical event (mapping table in Ch.11), writing into the spine with a synthetic `correlation_id` and the original `ts`.
2. **Backfill is idempotent** — keyed by `(source, source_id)` so re-runs don't duplicate.
3. **Going forward**, the same triggers that write the originals also emit the canonical event (dual-write during transition, then the spine is authoritative for the *timeline*; the originals stay authoritative for their domains).

---

## Failure handling

- **Poison event** (a consumer keeps failing on one event): after N attempts the event is moved to a `dead_events` side-table with the error, the offset advances past it, and a `system.alert_raised` fires — one bad event never blocks the stream.
- **Producer succeeds, notify lost:** the cron drainer catches it within a minute (guaranteed delivery without relying on `notify`).
- **Consumer crashes mid-batch:** the offset only advanced for events whose transaction committed; the next run resumes exactly where it stopped (no gap, no double-apply).
- **Broadcaster down:** UI liveness degrades to polling/snapshot; the spine and projections are unaffected (the broadcaster is a *reader*, never in the write path).

## Edge cases

- **Duplicate producer** (a webhook delivered twice by Stripe): the *state* write is idempotent (existing handler) and the event carries the provider idempotency key; the consumer dedups. No double dunning.
- **Causation cycle** (A causes B causes A): impossible by construction — `causation_id` references a strictly smaller `id`.
- **Very high burst** (a bulk import emits thousands of events): producers batch-insert; consumers read in bounded batches; the queue absorbs side-effecting work. Backpressure is the queue's visibility timeout (Ch.17).
- **Unknown verb at a consumer** (event newer than the consumer's code): consumers ignore verbs they don't handle (forward-compatible); the projection for that verb ships later and backfills by replay.

## Performance

- **Write cost:** one indexed insert appended to the state transaction — negligible.
- **Read cost:** bounded batches over the hot (current-month) partition on covering indexes.
- **At 1M companies:** the spine is high-volume, but every read is bounded (offset + limit, recent partition) and old partitions are cold-stored; the firehose channel is the only unbounded fan-out and it is server-throttled + sampled for display. The design answers the Golden Rule: the spine scales by *partitioning + bounded reads + offset consumers*, not by hoping volume stays small.

## Security

- **No PII in payloads beyond identifiers** — enforced by review + a lint check on `emitEvent` payload shapes **and**, for the trigger-emitted SQL producers (`_record_activity()` → `hq_emit_from_activity()`), a curated non-PII projection *at the producer*: the migration whitelists only status/identifier/amount hints, pinned by the security tier on the migration text and proved by the integration tier against a live insert (§20.6 L-6). A TS-level lint cannot see a payload built in SQL, so each producer path carries its own proof. Sensitive detail lives in the domain table, fetched under service-role when rendering.
- **The spine is `RLS:hq`** — unreadable by any JWT client. Delivery is via authorized broadcast only (Ch.16).
- **Tamper-evidence:** the audit projection (`admin_activity_log`) may be hash-chained (Ch.15); the spine itself is append-only (no update/delete grants, even to service-role, except partition retention).

## Testing

- **Event-contract tests:** for each verb, a fixture asserting the `payload` shape — the spine's analogue of an API contract; a producer that drifts fails CI.
- **Consumer idempotency tests:** apply the same event twice, assert the read-model is identical (the byte-identical-oracle style from 007).
- **Ordering tests:** interleave events for two aggregates, assert per-aggregate order preserved.
- **Backfill tests:** run an adapter over a fixture of legacy `activity_log` rows, assert the resulting timeline matches an oracle and re-running doesn't duplicate.

## Monitoring

Golden signals (Ch.15): **spine throughput** (events/min), **consumer lag** (per consumer: `max(id) − last_event_id`), **dead-event count** (alerts if > 0), **broadcast fan-out** + reconnect rate, **drainer health** (♻️ `cron_runs`). Lag is the canary: a rising lag means a projection is falling behind before users notice.

## Future expansion

- **Graduation to a broker** (NATS/Kafka) when measured throughput exceeds partitioned-Postgres comfort (Ch.17) — the producer (`emitEvent`) and consumer (`drain`) contracts stay identical; only the transport behind them changes.
- **Per-role event visibility** when sub-admin roles arrive (Ch.14): the `visibility` field is the seam.
- **New domains** add verbs to the registry (with an ADR) and a projection — never a change to the envelope. The spine's shape is meant to be stable for the decade; the *vocabulary* grows.
