# Chapter 11 — Event Timeline

## Purpose

The timeline is the OS made visible. It is the literal realisation of the thesis clause **"observable everywhere"** (Ch.01): one global, append-only stream of everything that has happened, plus a *filtered slice* of that same stream attached to every entity in the system — every organisation, customer, employee, job, invoice, approval, memory. There is exactly one timeline. The global feed and every per-entity feed are the **same data, read through different filters**.

Critically, the timeline is **not a second source of truth**. It owns no rows of its own. It is a **projection** over the event spine, `hq_events` (Ch.04 §the event envelope; Ch.03 §03.1) — a read-model in the strict sense of Ch.01's glossary: *derived, rebuildable, never authoritative*. Every fact it shows already exists once on the spine; the timeline is the lens that makes that fact observable on the org's page, the customer's page, the global Pulse, and the employee's audit trail simultaneously, without a refresh, without a second query against a divergent store.

This chapter specifies the read-models (the feeds), the UI surface that renders them ("The Pulse"), how the three legacy audit logs are unified into the spine *additively* (P2 — nothing removed), and how all of this stays bounded at one million companies.

---

## Goals

- Define the **one timeline** as a projection over `hq_events`, and the three feed shapes it serves: **global**, **per-entity**, **per-employee**.
- Specify the **entity slice** rule precisely: an entity's timeline is its events where it is the **object** *or* the **target** — "things it did" *and* "things done to it".
- Specify the **additive unification** of the three existing audit logs (`activity_log`, `admin_activity_log`, `hq_memory_events`) via idempotent backfill adapters and forward dual-write — **originals are never removed** (P1, P2).
- Specify **cursor pagination** by event `id` (the spine's total order, Ch.04) — never offset, never `ts`.
- Specify **The Pulse**: the virtualized live UI, correlation grouping, filtering, severity styling, and every interaction state.
- Answer the **Golden Rule**: bounded cursor reads on the hot partition + covering indexes; the one-million analysis.

**Non-goals:** the event envelope, the verb registry, the producer/consumer contracts (all Ch.04 — this chapter *consumes*, it does not define events); the real-time transport internals (Ch.06); the immutable audit posture of `admin_activity_log` (Ch.15); metric rollups (Ch.15); search (Ch.10).

---

## Architecture

### One spine, three feeds, one slice rule

```
                              ┌───────────────────────────────────────┐
                              │            hq_events  (Ch.03/04)        │
                              │     the spine — append-only, ordered    │
                              │     by id, month-partitioned by ts      │
                              └───────────────┬─────────────────────────┘
                                              │  (no copy — read in place)
            ┌─────────────────────────────────┼─────────────────────────────────┐
            ▼                                 ▼                                 ▼
   ┌──────────────────┐            ┌──────────────────────┐          ┌────────────────────┐
   │  GLOBAL feed     │            │  PER-ENTITY feed     │          │  PER-EMPLOYEE feed │
   │  ORDER BY id DESC│            │  object OR target    │          │  actor_type=        │
   │  (the firehose)  │            │  = (type,id)         │          │   'ai_employee'     │
   │                  │            │                      │          │  AND actor_id=slug  │
   └────────┬─────────┘            └──────────┬───────────┘          └─────────┬──────────┘
            │                                  │                                │
            ▼                                  ▼                                ▼
     hq:pulse channel              hq:org:{id} / hq:customer:{id} …       hq:employee:{slug}
     (Ch.06 broadcast)             (per-object channel, on demand)        (episodic memory +
            │                                  │                            audit trail)
            └──────────────────────────────────┴────────────────────────────┘
                                       │ live prepend
                                       ▼
                              ┌───────────────────┐
                              │   "The Pulse" UI   │  virtualized infinite list
                              └───────────────────┘
```

The timeline is therefore **three SQL shapes over one table**, not three tables:

1. **Global feed** — `SELECT … FROM hq_events ORDER BY id DESC LIMIT n` (with an optional `WHERE id < :cursor`). This is the Pulse firehose: everything, newest first.
2. **Per-entity feed** — the slice. For an entity `(type, id)`, return every event where **it is the object** (`object_type = :type AND object_id = :id`) **OR it is the target** (`target_type = :type AND target_id = :id`). An org's feed shows both `org.suspended` (done *to* it, as object) and, say, an `approval.requested` whose target is one of its runs (about it, as target). This dual-sided slice is what makes a fact *observable everywhere it is relevant* — the thesis, in a query.
3. **Per-employee feed** — `actor_type = 'ai_employee' AND actor_id = :slug`, ordered by `id DESC`. This single feed **doubles as two things at once**: the employee's **episodic memory** (the ordered narrative of what it did — feeding Ch.12) and its **audit trail** (every action it took, for oversight — Ch.15). One projection, two consumers; "exist once" applied to the workforce's own history.

### Why a projection and not a table

A naive design would denormalise timeline rows into a `timeline_items` table. We **reject** that (it violates P1 — a second source of truth that can drift from the spine). The spine already carries everything the timeline needs in indexed columns (`object_*`, `target_*`, `actor_*`, `verb`, `severity`, `correlation_id`, `ts`, `payload`). The timeline is served by **reading those columns directly through covering indexes** (Ch.03 §03.1 declares them). The only durable state the timeline owns is the **consumer offset** for its real-time fan-out (`hq_event_consumers`, consumer = `'timeline'`, Ch.03 §03.2) — and even that is just a cursor, not data.

If a future read pattern proves too expensive to serve live from the spine (🔬 see Future expansion), the answer is a *materialised* projection that is **still rebuildable by replay** (Ch.04 §replay) — never a hand-maintained second truth.

### The two truths the timeline unifies (♻️, additive)

Three audit stores exist today and **stay as their domains' sources of record** (Ch.03 §"The two truths the OS unifies as views"):

- ♻️ `activity_log` (`RLS:tenant`, trigger-written by `_record_activity()`, org-scoped read policy) — the per-tenant product audit (`job.created`, `quote.accepted`, `invoice.paid`, `finance.updated`, …).
- ♻️ `admin_activity_log` (`RLS:hq`, service-role only, generic `target_table`/`target_id`/`metadata`) — the cross-tenant HQ audit (demo moves, org status flips, impersonation, settings saves).
- ♻️ `hq_memory_events` (`RLS:hq`, service-role only) — the per-memory timeline (`created`/`updated`/`viewed`/`ai_accessed`/`status_changed`/…).

The OS **ingests** all three into the spine so the timeline is unified, **without removing any of them** (P2). The originals remain authoritative for their domains; the spine becomes authoritative *only for the timeline view*. The next section specifies the mapping exactly.

---

## Database design

### Tables touched (all defined in Ch.03 — none invented here)

| Table | Role in the timeline | Reference |
|---|---|---|
| `hq_events` | The one source the timeline projects. Read in place. | Ch.03 §03.1 |
| `hq_event_consumers` | The `'timeline'` offset for live fan-out. | Ch.03 §03.2 |
| ♻️ `activity_log` | Legacy per-tenant audit — backfilled + dual-written. **Kept.** | existing |
| ♻️ `admin_activity_log` | Legacy HQ audit — backfilled + dual-written. **Kept.** | existing |
| ♻️ `hq_memory_events` | Legacy memory timeline — backfilled + dual-written. **Kept.** | existing |

The timeline introduces **no base table of its own.** This is the chapter's defining constraint.

### The covering indexes the feeds ride (♻️ already declared in Ch.03 §03.1)

```sql
-- already in Ch.03 — the timeline is designed AROUND these, adds none:
create index hq_events_object_idx   on hq_events (object_type, object_id, ts desc);
create index hq_events_actor_idx    on hq_events (actor_type, actor_id, ts desc);
create index hq_events_verb_idx     on hq_events (verb, ts desc);
create index hq_events_severity_idx on hq_events (severity, ts desc)
                                     where severity in ('warn','critical');
```

One gap: the **target side** of the entity slice. The object slice is covered by `hq_events_object_idx`; the target side needs its mirror so the `OR` does not degrade to a scan. The timeline therefore proposes **one additive index** (an ADR against Ch.03, since Ch.03 is canon for indexes):

```sql
-- 11.A  proposed addition to hq_events (ADR in Ch.20): mirror the object index
--       for the target side so the entity-slice OR is two index scans, not a seq scan.
create index hq_events_target_idx on hq_events (target_type, target_id, id desc)
  where target_type is not null;
```

> 🔬 **Open question (Ch.20):** the entity slice is `object OR target`. Postgres serves an `OR` across two columns best as a **`UNION ALL` of two index scans merged and re-sorted by `id`**, or via a `BitmapOr`. Do we (a) keep the slice as a planner-trusted `OR` with both indexes present, (b) author the read as an explicit `UNION ALL … ORDER BY id DESC LIMIT n` in the service layer, or (c) add a generated `participants text[]` column (`{object:…, target:…}`) with a GIN index and query `participants @> …`? Option (b) is the safe default (deterministic plan, bounded by `LIMIT` on each arm); (c) is the cleanest read but adds a column to the spine (a canon change). Decide before the per-entity feed ships.

### Ordering and keys

- **Order is always by `id` descending** (the spine's monotonic total order, Ch.04 §"Why a bigint id is the order"). The indexes above are declared `ts desc` for partition-pruning friendliness, but **the feed's canonical sort and cursor are `id`** — `ts` is display-only. Where an index is `ts desc`, the planner still bounds the read to the hot partition and the final `ORDER BY id DESC LIMIT n` is over a tiny, already-near-sorted set (monotonic `id` tracks `ts`). Index 11.A is therefore declared on `id desc` deliberately.
- **No new primary keys, no soft-delete.** The spine is append-only; the timeline never updates or deletes (Ch.04 §Security).

### The legacy → canonical **mapping table** (the heart of unification)

Each legacy row maps to exactly one canonical verb in the registry (Ch.04). The adapter is **idempotent**, keyed by `(source, source_id)` carried in the event payload, so a re-run never duplicates (Ch.04 §Backfill). `source` ∈ `{'activity_log','admin_activity_log','hq_memory_events'}`; `source_id` is the legacy row's `id`.

**`activity_log.action` → verb** (object = `target_table`/`target_id`; `actor_type='human'` when `actor_id` present, else `'system'`; `actor_id`=`actor_name` fallback; `payload`=`metadata` + `{source, source_id}`):

| `activity_log.action` | canonical `verb` | object_type | severity |
|---|---|---|---|
| `job.created` | `job.created` | `job` | info |
| `job.status_changed` → `to='completed'` | `job.completed` | `job` | success |
| `job.status_changed` → `to='cancelled'` | `job.cancelled` | `job` | warn |
| `job.status_changed` (other) | `job.scheduled` | `job` | info |
| `job.assigned` / `job.rescheduled` / `job.photos_changed` | `job.scheduled` ‡ | `job` | info |
| `job.deleted` | `job.cancelled` | `job` | warn |
| `quote.created` | *(no registry verb)* — `quote.sent` only on send † | `customer` | info |
| `quote.sent` | `quote.sent` | `customer` | info |
| `quote.accepted` | `quote.accepted` | `customer` | success |
| `quote.viewed` / `quote.declined` | *(retained in `activity_log`; not projected — no verb)* † | — | — |
| `invoice.created` | `invoice.created` | `invoice` | info |
| `invoice.sent` | `invoice.created` ‡ | `invoice` | info |
| `invoice.paid` | `invoice.paid` | `invoice` | success |
| `invoice.overdue` | `invoice.payment_failed` ‡ | `invoice` | warn |
| `finance.created` / `finance.updated` / `finance.deleted` | *(retained; not projected — no `finance.*` verb)* † | — | — |

**`admin_activity_log.action` → verb** (the HQ audit; `actor_type='human'`, `actor_id=actor_email`; object from `target_table`/`target_id`):

| `admin_activity_log.action` (observed family) | canonical `verb` | object_type | severity |
|---|---|---|---|
| org status flip → suspended | `org.suspended` | `organization` | warn |
| org status flip → active/unsuspended | `org.unsuspended` | `organization` | success |
| trial → converted | `org.trial_converted` | `organization` | success |
| org marked churned | `org.churned` | `organization` | warn |
| org reactivated | `org.reactivated` | `organization` | success |
| impersonation started/ended | *(retained in `impersonation_sessions` + audit; projected as)* `system.alert_raised`? → **no**; surfaced via per-actor feed only | `organization` | info |
| settings save (`hq_settings`) | `system.flag_changed` | `system` | info |
| demo_request move | *(retained; not projected — pre-org, no timeline entity)* † | — | — |

**`hq_memory_events.event_type` → verb** (memory timeline; `actor_type='ai_employee'` when `ai_employee_id` set, else `'human'` via `actor_email`; object=`memory`/`memory_id`):

| `hq_memory_events.event_type` | canonical `verb` | object_type | severity |
|---|---|---|---|
| `created` | `memory.asserted` | `memory` | info |
| `status_changed` → `superseded` | `memory.superseded` | `memory` | info |
| `linked` | `memory.edge_added` | `memory` | info |
| `ai_accessed` | `memory.access_granted` ‡ (sampled) | `memory` | info |
| `updated` / `viewed` / `pinned` / `unpinned` / `unlinked` / `version_restored` | *(retained; not projected — low-signal for the timeline)* † | — | — |

> **‡ Lossy-by-design collapse.** Several legacy actions map to a coarser canonical verb because the registry is deliberately curated (Ch.04 §"sprawl is the enemy"). The **full fidelity is never lost** — it remains in the legacy row (kept forever, P2) and in the event `payload` (which carries the original `action`/`event_type` and `metadata`). The timeline shows the canonical verb; a drill-in can read the legacy detail.
> **† Not projected.** Rows with no registry verb (e.g. `finance.*`, `quote.viewed`, demo moves) are **not** force-fitted into the spine. They stay in their legacy log and surface on their domain page. Adding a verb for them later is an ADR + a replay-backfill (Ch.04) — additive, no rework.

### Backfill adapter (illustrative, idempotent)

```ts
// illustrative — NOT production. One adapter per legacy source.
// Idempotency key: (source, source_id) in payload; a unique partial index or
// a NOT EXISTS guard prevents re-insert on replay (Ch.04 §Backfill).
async function backfillActivityLog(batchAfter: string /* row id cursor */) {
  const rows = await readLegacy('activity_log', batchAfter, LIMIT);   // ORDER BY id ASC
  for (const r of rows) {
    const mapped = mapActivityLog(r);                  // the table above
    if (!mapped) continue;                             // † not projected
    await emitEvent(tx, {                              // Ch.04 emitEvent contract
      actorType: r.actor_id ? 'human' : 'system',
      actorId:   r.actor_id ?? r.actor_name ?? undefined,
      verb:      mapped.verb,
      objectType: mapped.objectType, objectId: r.target_id,
      correlationId: deterministicCorrelation('activity_log', r.id), // stable on replay
      severity:  mapped.severity,
      ts:        r.created_at,                          // preserve original time
      payload:   { ...r.metadata, source: 'activity_log', source_id: r.id,
                   legacy_action: r.action, org_id: r.org_id },
    });
  }
}
```

**Forward dual-write.** Going forward, the *same* trigger/service path that writes a legacy row also emits the canonical event in the **same transaction** (Ch.04 §producer outbox — generalising `_record_activity()`). During the transition both exist; afterwards the spine is authoritative for the *timeline* and the legacy log for its *domain* (Ch.04 §Backfill step 3). No window where a fact is in one but not the other (P1).

---

## APIs

All reads are **service-role, server-only** (the spine is `RLS:hq`; no JWT client ever touches it — Ch.03/16). The timeline is exposed to the UI through three server functions + the live channel; the UI never queries the spine directly.

```ts
// illustrative service-layer contracts (server/services/timeline.ts) — NOT production.

type TimelineCursor = string;            // opaque; encodes the last seen event id
type Severity = 'info' | 'success' | 'warn' | 'critical';

interface TimelineFilter {
  verbs?:        string[];               // verb registry values (Ch.04)
  severities?:   Severity[];
  actorTypes?:   ('human'|'ai_employee'|'system'|'tenant')[];
  actorId?:      string;
  objectTypes?:  string[];
  since?:        string;                 // ts lower bound → prunes partitions
}

interface TimelinePage {
  items:      TimelineItem[];            // newest first
  nextCursor: TimelineCursor | null;     // null = caller has reached the tail
  // NB: no total count — unbounded, and a count would scan (Golden Rule).
}

// 1) GLOBAL feed — the Pulse firehose.
function getGlobalFeed(args: {
  cursor?: TimelineCursor; limit?: number; filter?: TimelineFilter;
}): Promise<TimelinePage>;

// 2) PER-ENTITY feed — the slice: object OR target = (type,id).
function getEntityFeed(args: {
  objectType: string; objectId: string;
  cursor?: TimelineCursor; limit?: number; filter?: TimelineFilter;
}): Promise<TimelinePage>;

// 3) PER-EMPLOYEE feed — actor_type='ai_employee' AND actor_id=slug.
//    Doubles as episodic memory (Ch.12) + audit trail (Ch.15).
function getEmployeeFeed(args: {
  slug: string; cursor?: TimelineCursor; limit?: number; filter?: TimelineFilter;
}): Promise<TimelinePage>;

// 4) THREAD — expand one correlation_id as a causal tree (Ch.04 causation_id).
function getCorrelationThread(correlationId: string): Promise<TimelineItem[]>;
```

### Cursor pagination — by `id`, never offset

```sql
-- illustrative GLOBAL page (newest first), keyset on the spine's total order:
SELECT id, ts, actor_type, actor_id, verb, object_type, object_id,
       target_type, target_id, correlation_id, causation_id, severity, payload
FROM   hq_events
WHERE  (:cursor IS NULL OR id < :cursor)        -- keyset, not OFFSET
  AND  (:since  IS NULL OR ts >= :since)        -- partition pruning
  AND  (:verbs  IS NULL OR verb = ANY(:verbs))
ORDER BY id DESC
LIMIT :limit;                                    -- always bounded
```

- **Why keyset, not `OFFSET`:** `OFFSET n` reads and discards `n` rows — O(n) and unstable under concurrent inserts. Keyset (`id < :cursor`) is O(log n) on the index and **stable** even as the firehose grows beneath the reader. This is the only paging model that survives the Golden Rule.
- **`nextCursor`** is the smallest `id` in the returned page; the next call passes it as `:cursor`. `null` when fewer than `limit` rows returned (tail reached).
- **No total count** is ever returned — counting an unbounded, partitioned log is a scan. The UI shows "load more", not "page 7 of 9,412".
- **Live and historical are disjoint:** the cursor walks *backwards* through history; new events arrive *forwards* via the live channel (below). The UI merges them at the head (de-duped by `id`).

### Error shapes & versioning

- Errors follow the OS envelope (Ch.05): `{ ok: false, code, message }` with codes `TIMELINE_BAD_CURSOR` (malformed/opaque-cursor tampered), `TIMELINE_FILTER_INVALID` (unknown verb/severity), `TIMELINE_RANGE_TOO_WIDE` (a `since` older than the warm-partition window → caller is told to narrow or accept cold-storage latency, see Performance).
- **Versioning:** the feed item shape is a contract (Ch.04 envelope is stable for the decade); additive fields only. The `verb` set grows via the registry (Ch.04) — the UI treats an unknown verb forward-compatibly (renders a generic row), exactly as consumers do (Ch.04 §Edge cases).

---

## UI behaviour — "The Pulse"

The Pulse is the universal observability surface (Ch.01 §"observable everywhere"; embedded in Mission Control, Ch.09, and on every entity page as a slice). It is a **virtualized, infinite, live** list.

### Live model

- **Initial snapshot:** the server renders the first page (RSC, service-role) — fast first paint of real rows, no spinner-on-empty (Ch.02 §Performance).
- **Live prepend:** the island subscribes to the relevant **Ch.06 broadcast** channel — `hq:pulse` for the global Pulse, `hq:org:{id}` / `hq:customer:{id}` / … for an entity slice, `hq:employee:{slug}` for the workforce view. Each vetted delta (already authorised + minimised server-side, Ch.04 §real-time, Ch.06) is **prepended** to the head with a brief highlight animation. No refresh, ever (the thesis).
- **Backfill on scroll:** scrolling down calls `get*Feed({ cursor })` for older pages. Head (live) and tail (keyset) never collide — de-dupe by `id`.
- **Resync after reconnect:** if the socket drops, on reconnect the island fetches everything with `id >` the last-seen id (Ch.06 §reconnect/snapshot-resync) and reconciles, so no live event is missed during a blip.

### Correlation grouping (expand an intent as one thread)

Events sharing a `correlation_id` are **one story** (Ch.04 §correlation vs causation — the dunning flow: `invoice.payment_failed` → `ai.run_started` → `approval.requested` → `approval.granted` → `email.sent`). The Pulse:

- **Collapses** a correlation into a single **thread row** showing the originating event + a count ("Finance AI · dunning · 5 events"), newest activity timestamp, and the aggregate severity (the max severity in the thread).
- **Expands** on click into the causal tree (using `causation_id`, Ch.04) — a nested, indented list, root-cause at top. This is `getCorrelationThread()`.
- **Grouping is a view toggle:** "Grouped" (by correlation) vs "Flat" (raw `id DESC`). Default is Grouped on the global Pulse (legible), Flat on a narrow entity slice (already small).

### Filtering

A filter bar maps 1:1 to `TimelineFilter`:

- **By verb** — multi-select from the registry (Ch.04), grouped by domain (`org.*`, `billing.*`, `ai.*`, …).
- **By severity** — `info`/`success`/`warn`/`critical` chips; selecting `warn`+`critical` rides the partial index `hq_events_severity_idx` (Ch.03) — a fast "show me only problems" view.
- **By actor** — actor type (human / AI employee / system / tenant) and a specific actor (an employee slug, an operator).
- **By object type** — organisation / customer / job / invoice / approval / memory / …
- Filters compose (AND across dimensions, OR within a dimension) and are reflected in the URL (shareable, back-button-safe). Live prepend **respects the active filter** — a delta that doesn't match is dropped client-side (or, for `hq:pulse` at volume, the server pre-filters the channel, Ch.06).

### Severity-driven styling

`severity` drives the row's accent (the only place styling is data-driven, per Directive 007 tokens — no hardcoded colour): `info` neutral, `success` positive accent, `warn` amber accent + icon, `critical` red accent + persistent until acknowledged. Critical rows also surface a toast on live arrival (Ch.09).

### States

| State | Behaviour |
|---|---|
| **Loading** | Skeleton rows (not a spinner) while the first server page streams; subsequent pages show an inline "loading older…" at the tail. |
| **Empty** | A specific empty copy per feed ("No activity yet for Acme Ltd" / "The Pulse is quiet"), never a blank panel. An entity with zero events is normal, not an error. |
| **Error** | The panel keeps the last good page and shows a non-blocking banner with retry; a feed error never blanks Mission Control (Ch.02 §"a plane degrades, the OS stays up"). |
| **Live** | A subtle "live" indicator (pulsing dot) when the channel is connected; degrades to a "paused — reconnecting" pill if the socket drops, with polling fallback (Ch.06). |
| **Live-paused** | If the operator has scrolled down (reading history), new events **buffer** behind a "↑ 12 new events" pill rather than yanking the scroll position; clicking it jumps to head and flushes the buffer. |

### Keyboard & accessibility

- **Keyboard nav:** `j`/`k` move selection down/up; `o`/`Enter` expand a correlation thread; `f` focuses the filter bar; `g g` jumps to head (live); `.` toggles grouped/flat. (♻️ consistent with the ⌘K palette conventions, Ch.10.)
- **Accessibility:** the feed is an ARIA `feed` (`role="feed"`) with each row a `role="article"`; live prepends announce via an `aria-live="polite"` region (critical via `assertive`); severity is conveyed by **icon + text**, never colour alone (WCAG); virtualization preserves correct `aria-setsize`/`aria-posinset` semantics; full keyboard reachability; reduced-motion disables the prepend highlight animation.

---

## Permissions

- **Read** is gated by the existing super-admin chokepoint — ♻️ `requireHqPage()` / `isSuperAdminEmail()` (Ch.02, Ch.14). Today every super-admin sees every feed. The spine's `visibility` field (`'hq'` today, Ch.04) is the **seam** for per-role scoping when sub-admin roles arrive (Ch.14): a future `timeline.read` capability could scope which `object_type`s or which `visibility` tiers a role sees, applied as an additional `WHERE` and as a channel-authorisation rule (Ch.06).
- **No write capability exists** — the timeline is read-only by construction (it owns no rows; events are written by producers under their own capabilities, Ch.04). There is nothing to authorise on write because there is no write path.
- **AI access:** an AI employee reading its **own** per-employee feed as episodic memory (Ch.12) needs no extra capability — it is reading its own narrative. Reading *another* entity's slice is a `customer.read` / `org.read`-class capability (Ch.14), checked at the tool gate, because that is reading tenant-adjacent facts. Default policy: **least privilege** (P5) — an employee sees its own trail freely, others' only with an explicit capability.
- **Channel authorisation** mirrors read authorisation: joining `hq:pulse` / `hq:org:{id}` / `hq:employee:{slug}` is authorised server-side by the same gate (Ch.06 §authorization reuses the existing gate). A client cannot subscribe to a feed it could not query.

---

## Failure handling

- **Spine unreadable** (DB blip): the panel serves its last server-rendered snapshot and shows the reconnect banner; Mission Control stays up (Ch.02). No timeline failure cascades — the timeline is a *reader*, never in any write path.
- **Broadcaster down** (Ch.06): liveness degrades to **polling** — the island periodically calls `get*Feed()` with the last-seen `id` as a floor and prepends the diff. The Pulse keeps moving, just less instantly (Ch.04 §"Broadcaster down").
- **Backfill adapter fails mid-run:** idempotency by `(source, source_id)` means a re-run resumes safely and never double-inserts (Ch.04 §Backfill). The legacy rows are untouched (P2), so a failed backfill loses nothing — re-run it.
- **Dual-write divergence guard:** because the forward event is written in the **same transaction** as the legacy row (Ch.04 outbox), there is no partial state — either both commit or neither. A constraint failure on the event fails the legacy write too (Ch.03 §"Constraint violations on outbox writes fail the whole transaction").
- **Poison event in the feed** (a malformed `payload` a renderer can't parse): the row renders in a **degraded generic form** (verb + actor + time, raw payload hidden) rather than crashing the list — the UI mirrors the consumer rule "ignore what you can't handle" (Ch.04 §Edge cases). It does **not** dead-letter (that is a *consumer* concern, Ch.04; the timeline is a pure read).
- **Cursor tampering:** an opaque cursor that doesn't decode to a valid `id` returns `TIMELINE_BAD_CURSOR`; the client falls back to a fresh head fetch.

## Edge cases

- **Self-referential event** (object == target, e.g. an org acting on itself): the slice de-duplicates — one row, not two, even though both arms of the `OR`/`UNION` match. De-dupe by `id` in the merge (the `UNION ALL` arm overlap is removed).
- **Event whose object no longer exists** (an org hard-deleted in a domain table — rare, since HQ prefers `archived_at`, Ch.03): the spine row **survives** (append-only) and the timeline still shows it; the row links to a "no longer present" entity gracefully rather than 404-ing. The narrative outlives the entity, by design (P1/P3).
- **Cross-type id collision** (`object_id` is `text`; a customer uuid could textually equal a job uuid): impossible to confuse because the slice always filters **`object_type` AND `object_id`** together (Ch.03 §"Cross-type ids" edge case). The type is never dropped from the predicate.
- **Very chatty correlation** (a bulk import emits thousands of events under one `correlation_id`): the grouped thread row shows a capped count ("999+") and the expand is itself paged (`getCorrelationThread` is `LIMIT`-bounded) — a thread never renders ten thousand nested rows.
- **Live event older than the head** (clock skew makes a delta's `ts` < a displayed row's `ts`): ordering is by **`id`**, not `ts` (Ch.04), so it inserts at the correct ordinal position regardless of wall-clock; `ts` is display-only.
- **Filter that matches nothing live for minutes:** the "live" indicator stays connected (the channel is healthy) even though no row arrives — connection state and data flow are shown separately, so silence reads as "quiet", not "broken".
- **Backfilled vs native event with the same meaning during transition:** the backfill (historical, original `ts`) and the forward dual-write (going forward) are partitioned in time and both carry `(source, source_id)` — the idempotency key prevents a backfill from re-creating an event the dual-write already wrote for the same legacy row.

## Performance

The timeline is the OS's highest-read surface, so it answers the **Golden Rule** directly: *every timeline read is bounded, indexed, and confined to the hot partition.*

- **Budgets:** entity-slice page p95 **< 50 ms**, global page p95 **< 80 ms** (server query time, hot partition); first-paint TTFB **< 200 ms** (server-rendered first page); live-prepend render **< 16 ms** (one row into a virtualized list).
- **Bounded reads only:** every query has `LIMIT :limit` (default 50) and a keyset `id < :cursor`. There is **no unbounded scan and no `COUNT`** anywhere in the timeline (counts are the classic Golden-Rule failure). Paging cost is independent of total spine size.
- **Hot-partition confinement:** `hq_events` is **month-partitioned by `ts`** (Ch.03 §03.1). A default feed (no `since`, newest-first) reads only the **current month's** partition — the planner prunes the rest. A `since` filter prunes to exactly the partitions it spans. Old partitions are **detached to cold storage** (Ch.03 §partitioning; Ch.15 retention) — present for deep history but off the hot path; a query reaching into cold storage returns `TIMELINE_RANGE_TOO_WIDE` guidance or accepts higher latency explicitly.
- **Covering indexes carry every shape:** global → the partition's `id` order; entity slice → `hq_events_object_idx` + the proposed `hq_events_target_idx` (11.A); per-employee → `hq_events_actor_idx`; severity filter → the partial `hq_events_severity_idx`; verb filter → `hq_events_verb_idx` (all Ch.03 §03.1). The slice's `OR` is resolved as two bounded index scans merged by `id` (the 🔬 above pins the exact form).
- **Liveness scales with operators, not data** (Ch.02 §Performance): the live cost is a subscription per active operator, not a poll over the table. One operator or a million companies — the firehose channel is **server-throttled and sampled for display** (Ch.04 §Performance), so the UI never tries to render thousands of rows/second.
- **Virtualization:** the client renders only the ~30 rows in the viewport regardless of how many are loaded; memory and paint are O(viewport), not O(history).

### The one-million-companies analysis

At one million companies the spine is the largest table in the system (billions of rows over its lifetime). The timeline still works because **the read pattern never grows with the table**:

| Concern | At 1M companies | Why it holds |
|---|---|---|
| **Global page** | Reads ≤ `limit` rows from the current-month partition via the `id` index. | Keyset + `LIMIT` + partition pruning → O(log n) on one partition, constant in company count. |
| **Entity slice** | Reads ≤ `limit` rows for one `(type,id)` via object/target indexes. | A single org/customer has a *bounded* event rate; its slice is tiny and indexed. |
| **Per-employee** | Reads ≤ `limit` via the actor index. | One employee's history is bounded by its run rate, not the customer count. |
| **Live fan-out** | One throttled, sampled channel per active operator. | Cost ∝ operators (a handful), not ∝ events (billions). |
| **Storage** | Current + a few warm months hot; everything older cold-stored, never dropped. | Retention is partition-detach (Ch.15), so the hot path stays small forever. |
| **Counts/aggregates** | Never computed on the read path. | Any "how many events" lives in `hq_metrics` rollups (Ch.15), not a timeline scan. |

The verdict: **yes, we build it this way at one million companies** — because the timeline is bounded reads over a partitioned, indexed, append-only log, with liveness priced per operator. Nothing in the hot path is O(total events).

## Security

- **The spine is `RLS:hq`** (Ch.03/16) — no JWT/anon client can read a single timeline row. The UI reaches the timeline **only** through server functions (service-role, server-only) and the **server-authorized broadcast** (Ch.06) — never `postgres_changes` on `hq_events` (which would demand JWT-readable RLS on the most sensitive table; forbidden, Ch.04 §real-time, Ch.16).
- **No PII leakage:** event `payload` is identifiers + small metadata only (Ch.04 §Security; the legacy-row backfill copies `metadata` which already obeys this). When the UI needs richer detail (a customer's name on a row), it is fetched **on render** under service-role from the domain table, not stored in the event. The timeline shows *what happened to whom by id*; the labels are resolved server-side.
- **Tamper-evidence:** the timeline never mutates the spine; the spine is append-only (no update/delete grants except partition retention, Ch.04). The legacy `admin_activity_log` it unifies may itself be hash-chained (Ch.15) — the timeline simply reflects it.
- **Channel scoping is authorisation:** per-object and per-employee channels are joinable only after the same gate that authorises the equivalent query (Ch.06). A delta is **vetted and minimised server-side** before broadcast — the client receives only fields it is allowed to see.
- **Cursor opacity:** cursors are opaque (signed/encoded `id`) so a client cannot probe arbitrary ranges by crafting offsets; a tampered cursor is rejected (`TIMELINE_BAD_CURSOR`).

## Testing

- **Projection-from-fixture (oracle) tests** (♻️ the byte-identical-oracle style from 007's token tests; Ch.03 §Projection tests): seed a fixture spine, run each feed, assert the returned page **exactly** matches a hand-written oracle — including order (by `id`), slice membership (object-or-target), and grouping.
- **Backfill idempotency tests** (Ch.04 §Testing §backfill): run each adapter over a fixture of legacy `activity_log` / `admin_activity_log` / `hq_memory_events` rows; assert (a) the resulting timeline matches an oracle, (b) **re-running produces zero new rows** (the `(source, source_id)` key holds), (c) every legacy row is still present and unmodified afterwards (P2 verified by test, not just by intent).
- **Mapping-table tests:** a table-driven test asserting every legacy `action`/`event_type` maps to exactly the verb in the mapping table above (or is explicitly `† not projected`) — drift in the adapter fails CI, the same way an event-contract drift does (Ch.04).
- **Slice correctness tests:** assert an org's feed includes an event where it is the **target** (not just object), and de-duplicates a self-referential event to one row.
- **Cursor tests:** keyset paging returns each event exactly once with no gaps and no repeats under concurrent inserts (a writer appends while a reader pages backwards).
- **RLS tests** (♻️, Ch.03 §RLS tests): assert `hq_events` is unreadable by anon/JWT and the timeline server functions refuse a non-super-admin caller.
- **Live-merge tests:** simulate a reconnect with a gap; assert resync fetches `id >` last-seen and the merged list has no duplicate or missing rows.
- **Accessibility tests:** `role="feed"` semantics, `aria-live` announcement on prepend, keyboard nav (`j`/`k`/`o`), reduced-motion path.

## Monitoring

Everything the timeline needs is already on the spine and in the consumer offsets — observability falls out for free (P3):

- **Timeline consumer lag** — `max(hq_events.id) − hq_event_consumers.last_event_id` for consumer `'timeline'` (Ch.04 §Monitoring). Rising lag means live prepend is falling behind *before* operators notice; it is the canary.
- **Feed query p95** per shape (global / entity / employee) against the budgets above (Ch.15 metric registry).
- **Broadcast fan-out + reconnect rate** for the Pulse channels (Ch.06) — a spike in reconnects signals a transport problem degrading liveness.
- **Backfill progress** during transition — rows ingested per source vs total legacy rows; a stalled backfill alerts.
- **Cold-partition reach rate** — how often queries hit `TIMELINE_RANGE_TOO_WIDE` / cold storage; a rising rate suggests operators need a deeper warm window (a retention tuning signal, Ch.15).
- **Events emitted by the timeline itself:** none on read (it is a pure projection). The backfill/replay path emits `system.projection_rebuilt` (Ch.04 registry) when a feed is rebuilt from history — the audit trail of the audit surface.
- **Golden signals / SLO:** *liveness* (consumer lag p95 < 2 s), *latency* (entity-slice query p95 < 50 ms), *correctness* (zero duplicate/missing rows in the keyset test gate). An SLO breach on lag pages before the Pulse visibly stalls.

## Future expansion

- **Per-role timeline scoping** (Ch.14): the `visibility` field is the reserved seam — when sub-admin roles arrive, a `timeline.read`-class capability scopes object types / visibility tiers per role, as an extra `WHERE` and a channel-auth rule. No reshaping of the spine.
- **Materialised feeds if measurement demands** (P6, Ch.17): if a future read pattern (e.g. a heavily-filtered global feed at extreme volume) outgrows live-from-spine reads, introduce a **materialised** projection table that is *still rebuildable by replay* (Ch.04) — a cache in front of the spine, never a second source of truth. The service API (`get*Feed`) is unchanged; only the implementation behind it swaps. 🔬 the trigger threshold (events/min, p95 budget breach) is an open question for Ch.17/Ch.20.
- **New domains, new verbs** (Ch.04 §Future expansion): a new product area adds verbs to the registry and they appear in the timeline automatically — the feed reads `verb` generically, the UI renders unknown verbs forward-compatibly, and a richer renderer/mapping ships later as an additive ADR. The timeline never needs a structural change to absorb a new domain.
- **Saved views & alerts on filters:** a future "save this filter as a named view" and "alert me when a `critical` event matches X" — both are thin layers over the existing `TimelineFilter` + the severity index + Ch.15 alerting; deliberately deferred, with the filter contract as the seam.
- **Threaded export / trace handoff:** `getCorrelationThread()` is the seam for exporting a full intent as a portable trace (for support, post-incident review, or AI reflection, Ch.12/Ch.15) — the causal tree is already reconstructable from `causation_id`; only the export format is deferred.
