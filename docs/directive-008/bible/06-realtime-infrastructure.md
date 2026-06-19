# Chapter 06 — Real-time Infrastructure

## Purpose

This chapter specifies how the OS becomes *live*. The thesis (Ch.01) has three clauses; this chapter delivers the second — **"observable everywhere"** — at the level of milliseconds. A fact that exists once on the spine (Ch.04) must surface on every relevant operator's screen without a refresh, a poll loop, or a "go check" elsewhere. That is the difference between a collection of pages and an operating system (Ch.01).

Real-time is the **delivery plane** of Ch.02: it carries *vetted deltas* from the spine to the right authenticated operators, and nothing else. It does not own truth (the data plane does), it does not own narrative (the spine does), and it does not own work (the execution plane does). It is a one-way courier of pre-authorised, pre-shaped facts.

**Where we start — greenfield.** Today CrewFlow HQ has **zero** real-time. Every one of the 24 HQ pages is `export const dynamic = "force-dynamic"` server-side rendering (verified across `app/admin/**`): you navigate, the server queries at request time, it paints a snapshot, you read, you leave. The Command Centre *looks* alive but is not:

- `LiveDot` (`app/admin/command-centre/_counter.tsx`) is a CSS `animate-ping` emerald dot — pure decoration, subscribed to nothing.
- `ExecCounter` (same file) is a `framer-motion` count-up from `0` to a server-rendered figure on mount — a one-shot entrance animation, not a feed.
- The header pill literally reads **"Live · HQ only · Super Admin"** beside a snapshot timestamp ("generated …"). It is aspirational, not factual.
- `@supabase/ssr`'s browser client (`lib/supabase/client.ts`) exists and its doc-comment mentions "realtime subscriptions", but **no `.channel()`, no `postgres_changes`, no `broadcast`** is used anywhere in the codebase. Supabase Realtime is entirely unused. ♻️ The capability is present; this chapter switches it on.

This chapter makes the OS *actually* live, and does so without loosening a single RLS policy.

---

## Goals

- **Make liveness real, not cosmetic.** Replace the decorative `LiveDot`/`ExecCounter` semantics with a genuine subscribed feed — the same surfaces, upgraded (P2, additive).
- **The hybrid model.** Keep the fast, secure server-rendered snapshot *and* add live deltas on top — best of both, never a full-page reload.
- **Honour the critical security decision.** Deliver liveness **without** exposing `hq_events` to client subscriptions (Ch.04 §Real-time publication, Ch.16). Server-authorised broadcast only.
- **A reusable island.** One `<LiveRegion>` / `useLiveEvents()` pattern that any page adopts in a few lines, with reconnect, snapshot-resync, and polling fallback built in.
- **Bounded fan-out.** Channels created on demand and torn down on unsubscribe; the firehose sampled/coalesced so the UI is never flooded.
- **Liveness cost scales with active operators, not data volume** — the key one-million-companies property (see Performance).

**Non-goals:** the event envelope, verbs, outbox, and consumer offsets (all Ch.04 — this chapter *consumes* the spine, it does not define it); the timeline read-model and its rendering (Ch.11); presence-driven collaboration features beyond "who is here" (deferred, see Future expansion); a customer-facing real-time surface (the OS is super-admin only, Ch.01 non-goals); WebSocket transport internals (delegated to Supabase Realtime, ♻️).

---

## Architecture

### The shape: snapshot + island

Every live HQ surface is two cooperating halves, exactly the presentation-plane model of Ch.02:

```
┌─ RSC (server component) ──────────────────────────────────────────────┐
│  requireHqPage()  →  service-role read of read-models (hq_metrics,    │
│  recent hq_events slice via the timeline projection, Ch.11)            │
│  → renders the TRUTH-AS-OF-NOW snapshot (fast first paint, SEO-moot,   │
│    no service-role data or secrets shipped to the browser)            │
│  → embeds a thin "use client" <LiveRegion channel="hq:pulse"          │
│       initialCursor={lastEventId} />                                   │
└───────────────────────────────────────────────────────────────────────┘
        │ hydrate (tiny island; the snapshot is already painted)
        ▼
┌─ <LiveRegion> ("use client") ─────────────────────────────────────────┐
│  useLiveEvents(channel, initialCursor):                                │
│   1. join the Broadcast channel (authenticated super-admin only)       │
│   2. receive vetted deltas → prepend / patch the DOM in place          │
│   3. on reconnect: re-fetch a fresh snapshot from `cursor`, then       │
│      resume the live stream (no gap)                                    │
│   4. if Realtime unavailable: fall back to slow polling of the         │
│      snapshot endpoint                                                  │
└───────────────────────────────────────────────────────────────────────┘
```

The snapshot answers *"what is true now?"* on the server, where the service-role key lives and where sensitive detail can be resolved and stripped before it ever reaches a browser. The island answers *"what changed since?"* — and only ever sees the minimal, vetted delta the server chose to publish. **The client never holds the service-role client and never subscribes to a table.** This is the same division the architecture diagram in Ch.02 draws: "initial snapshot (service-role, server-only)" on one arrow, "live deltas (server broadcast)" on the other.

### The broadcaster — a server process, not a client subscription

The load-bearing component is the **broadcaster**: a server-side, service-role consumer of the spine (a consumer in the exact sense of Ch.04 §Consuming events — it has a durable offset row in `hq_event_consumers`, `consumer = 'realtime'`). It expands the diagram in Ch.04 §Real-time publication:

```
hq_events insert ──pg_notify('hq_events')──▶ broadcaster (server, service-role)
                       (+ 1-min cron drain,        │
                        the dead-worker net ♻️)      │ for each new event:
                                                     │  1. AUTHORIZE for the HQ audience
                                                     │     (visibility='hq' today; per-role later)
                                                     │  2. SHAPE a minimal vetted delta
                                                     │     (ids + display fields, NO raw payload,
                                                     │      NO PII beyond identifiers — Ch.16)
                                                     │  3. ROUTE to the right channel(s)
                                                     ▼
                              Supabase Realtime "Broadcast" channels
                              (join-authorised to authenticated super-admins only)
                                                     ▼
                              <LiveRegion> islands on Mission Control / Timeline /
                              entity pages / Workforce  →  live prepend / patch
```

The broadcaster is the only thing that reads the spine *for the purpose of liveness*, and it runs server-side under service-role. It never grants the browser any read path to `hq_events`. This is the single most important sentence in the chapter and it is consistent with Ch.04, Ch.02's technology table ("Real-time: Supabase Realtime via server-authorised broadcast"), and Ch.16.

**Why not `postgres_changes`?** Supabase's `postgres_changes` streams row mutations to *client* subscriptions, filtered by the subscriber's RLS. To use it on `hq_events` we would have to make `hq_events` **JWT-readable** — i.e. write SELECT policies on the most sensitive table in the company so that a browser-held anon JWT can read it. That directly violates the dominant HQ posture (`RLS:hq`: RLS enabled, **zero policies**, service-role only — Ch.03) and the security model of Ch.16. It is a hard no. 🔬 → resolved: **server-authorised Broadcast is the chosen transport**; this is recorded as the relevant ADR in Ch.20 and is *not* reopened per-page.

### Where the broadcaster runs

The broadcaster is a long-ish-lived server task. Two deployment shapes, graduating on evidence (P6):

1. **Phase-1 (launch):** the broadcaster is woken by `pg_notify` inside the same Next.js/Vercel runtime that already drains consumers, and also kicked every minute by Vercel Cron as the safety net (♻️ the `research-drain` / `withCronTelemetry` pattern). Each wake drains the spine from `hq_event_consumers['realtime'].last_event_id`, publishes deltas, and advances the offset. Serverless invocations are short, so "live" here means *near-real-time with ≤ a few seconds of worst-case latency*, which is well within the operator-experience budget.
2. **Graduation (Ch.17):** when measured fan-out or latency demands it, the broadcaster becomes a small standing worker (or Supabase Edge Function with a persistent socket) that holds the Realtime connection open and pushes within ~100 ms. The **contract is unchanged** — it is still "service-role consumer → authorise → shape → broadcast"; only the host changes. 🔬 The exact graduation trigger (sustained p95 delivery latency, or N concurrent operators) is an open question for Ch.17.

Publishing a Broadcast message from the server uses Supabase Realtime's server-side broadcast (an authenticated `realtime.broadcast_changes`-style send, or a direct HTTP `POST` to the Realtime broadcast endpoint with the service-role key). Either way the *send* is server-side and authenticated; the *receive* is gated by channel authorisation (Permissions).

---

## Database design

Real-time is a **reader**; it owns almost no schema. Per Ch.03 it adds nothing to the spine's shape.

- **`hq_events`** (Ch.03 §03.1) — read-only here, drained by offset like any consumer. The broadcaster never writes it (except its own observability events, below, via the normal outbox).
- **`hq_event_consumers`** (Ch.03 §03.2) — the broadcaster owns one row, `consumer = 'realtime'`, giving it durable resumption exactly like the timeline/metrics consumers. If the broadcaster restarts it resumes from its offset; no event is skipped (Ch.04 §Failure handling).
- **`admin_activity_log` / `hq_settings`** ♻️ — the broadcaster reads `hq_settings` for the `realtime.enabled` feature flag (P7 kill switch) and for sampling/fan-out parameters; it writes nothing to the audit log directly (its actions are pure delivery, not side-effects).

**No new tables.** Presence is held in Supabase Realtime's in-memory presence state, not in Postgres — presence is ephemeral "who is here right now" and is deliberately *not* a durable fact (it is not on the spine; it is not truth, it is liveness). 🔬 Open question (Ch.20): if we later want a durable "last seen" per operator, that is a small `hq_operator_presence` table — deferred until a feature needs it.

**Access pattern:** one indexed, bounded read per wake — `select … from hq_events where id > $offset order by id asc limit $batch` (the covering `hq_events` PK / `id` order from Ch.03). Identical cost profile to the timeline consumer; O(batch), never O(company count).

---

## APIs

### Server: the broadcaster (service-role, server-only)

```ts
// illustrative — server-only; runs under the service-role client
// (the SAME client the data-plane aggregator uses; NEVER the browser client)
async function runBroadcaster(): Promise<void> {
  if (!(await flag('realtime.enabled'))) return;            // P7 kill switch ♻️ hq_settings
  const from = await getOffset('realtime');                 // hq_event_consumers
  const batch = await readEventsAfter(from, BROADCAST_BATCH); // ORDER BY id ASC (Ch.04)
  for (const ev of coalesce(sample(batch))) {               // backpressure (Performance)
    const audience = authorizeForHqAudience(ev);            // ♻️ visibility='hq' today (Ch.14)
    if (!audience.visible) continue;                        // never broadcast a private event
    const delta = shapeDelta(ev);                           // minimal, vetted (Security)
    for (const ch of channelsFor(ev)) {                     // hq:pulse + targeted (Channel design)
      await realtimeBroadcast(ch, 'event', delta);          // server-side authenticated send
    }
  }
  await setOffset('realtime', batch.at(-1)?.id ?? from);    // advance like any consumer
}
```

- **`shapeDelta(ev)`** is the security chokepoint. It returns *only* identifiers + display-safe fields the snapshot already exposes (verb, severity, object_type/id, a pre-rendered one-line label, ts). It **never** returns the raw `payload` (which, although identifier-only by policy — Ch.04 — is still server-resolved before display). Anything richer is fetched by the client from a server endpoint that re-authorises. 🔬 Whether `shapeDelta` reuses the timeline projection's row-shaping (Ch.11) verbatim is an open question — strong preference is yes, **one shaping function, one source** (P1).
- **`channelsFor(ev)`** maps an event to its channels (see Channel design). Pure, deterministic.
- **Idempotency.** Re-broadcasting an event is harmless: the client dedups by `ev.id` (the spine's total order, Ch.04). At-least-once + client-side dedup = effectively-once delivery to the DOM (P8).

### Client: `useLiveEvents()` and `<LiveRegion>`

```ts
// illustrative — "use client"; the ONLY real-time surface the browser touches
function useLiveEvents(channel: string, initialCursor: number): {
  events: LiveDelta[];        // newest-first, capped (Performance)
  status: 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';
  resyncedAt: number | null;  // last successful snapshot re-fetch
};

// Reusable wrapper any page drops in:
function LiveRegion(props: {
  channel: string;            // 'hq:pulse' | `hq:org:${id}` | `hq:employee:${slug}` | ...
  initialCursor: number;      // lastEventId baked into the RSC snapshot
  render: (events: LiveDelta[], status: Status) => React.ReactNode;
  onPatch?: (delta: LiveDelta) => void; // optional in-place patch (e.g. a metric tile)
}): JSX.Element;
```

Lifecycle inside the hook:

1. **Join** `supabase.channel(channel)` (the browser client, ♻️ `lib/supabase/client.ts`) with the auth token attached; the server authorises the join (Permissions). On `'event'` messages, prepend the delta (deduped by `id`, capped to a bounded buffer).
2. **Reconnect with backoff.** On socket drop, retry with exponential backoff + jitter (e.g. 1s → 2s → 4s → max 30s). The `LiveDot` finally earns its name — its colour is driven by `status` (live = emerald, reconnecting = amber, polling/offline = slate), so the operator can *trust* it.
3. **Snapshot-resync on reconnect (no gap).** On every (re)connect after the first, before resuming the live stream, re-fetch the snapshot endpoint from `cursor` (the highest `id` seen). This closes any window of events missed while disconnected — the spine's `id` total order (Ch.04) makes "everything after `cursor`" exact and gap-free. Then resume live deltas. This is the island analogue of a consumer resuming from its offset.
4. **Polling fallback.** If the channel cannot be joined at all (Realtime down, network policy blocks WebSockets), degrade to polling the same snapshot endpoint on a slow interval (e.g. 15–30 s). The page is *never broken* — at worst it is as live as it is today (i.e. on navigation), and usually better. This satisfies the Ch.02 promise: "If real-time fails, islands fall back to polling and pages still render their server snapshot."

### The snapshot/resync endpoint (server, service-role)

```ts
// illustrative route handler — GET /api/hq/live/snapshot?surface=pulse&cursor=<id>
// requireHqPage()-equivalent gate; service-role read; returns the SAME shape as shapeDelta
async function liveSnapshot(surface: Surface, cursor: number): Promise<{
  events: LiveDelta[];   // events with id > cursor, vetted/shaped, newest-first, capped
  cursor: number;        // new high-water mark
}>;
```

This is the one HTTP contract the island depends on; it is re-authorised on every call (never trusts the client's claimed identity), and it returns *exactly* the `shapeDelta` shape so the client merges snapshot + live deltas through one code path. **Versioning:** the delta shape is a contract (Ch.05); a field is only ever added, never repurposed; older islands ignore unknown fields (forward-compatible, mirroring Ch.04 consumer discipline).

---

## UI behaviour

What the operator sees, by state — the live model made concrete on Mission Control (Ch.09) and the Timeline (Ch.11):

- **First paint (snapshot):** instant. The RSC snapshot renders the truth-as-of-now (metrics, recent events). No spinner for the data the snapshot already has; this is unchanged from today's fast SSR.
- **Connecting:** the snapshot is fully usable; the `LiveDot` shows *connecting* (amber, subtle). No layout shift.
- **Live:** new events **prepend** to the feed with a brief highlight-then-settle animation; metric tiles **patch in place** (the genuine successor to today's `ExecCounter` — but now the number *moves when the business moves*, not just on mount). The `LiveDot` is emerald and, for once, true. No full reload, ever (P10).
- **Reconnecting:** `LiveDot` amber; the feed freezes (shows last-known) rather than clearing — stale-but-labelled beats empty. On reconnect, the resync quietly back-fills anything missed, newest-first, with the same highlight so the operator sees what happened while they were away.
- **Polling (fallback):** `LiveDot` slate with a tooltip "Updating periodically"; the feed refreshes on the slow interval. Honest about degraded liveness.
- **Empty:** "No activity yet" — but the channel is joined, so the first real event animates in live.
- **Error/offline:** `LiveDot` slate-red, tooltip explains; the snapshot remains readable. The OS never shows a broken page because liveness failed.

**Accessibility:** the live feed container is an ARIA live region (`aria-live="polite"`, `aria-relevant="additions"`) so screen readers announce new events without stealing focus; `critical`-severity events may use `assertive`. All animation respects `prefers-reduced-motion` (♻️ the existing `ExecCounter` already does this with `useReducedMotion` — reuse the pattern). **Keyboard:** the feed is scrollable and focusable; a "pause live updates" control lets a keyboard/AT user freeze the stream while reading (prepends queue and flush on resume). **Tab/visibility:** when the tab is backgrounded, the island drops to polling (or unsubscribes) to save fan-out, and resyncs on refocus.

---

## Permissions

Real-time introduces **no new authority** — it reuses the single existing gate (P1, ♻️). Three checkpoints, all the same predicate:

1. **Snapshot/resync endpoint:** `requireHqPage()`-equivalent server gate (♻️ `server/auth/hq.ts`) — non-super-admins 404, exactly as the pages do. The service-role read happens only after the gate passes.
2. **Channel join authorisation:** Supabase Realtime channel authorisation is configured so that **only an authenticated super-admin may join any `hq:*` channel**. The check reuses `isSuperAdminEmail()` (♻️ `server/auth/superadmin.ts`) against the joining user's verified JWT. A non-allowlisted JWT (or anon) is refused the join — it never receives a single delta. This is the client-side counterpart to `RLS:hq`.
3. **What is on the wire:** even an authorised joiner only ever receives `shapeDelta` output — never raw payloads, never service-role data. Authorisation to *join* is necessary but not sufficient; the delta is *already minimal* by construction (defence in depth, Ch.16).

**Capabilities (Ch.14):** today there is one human role (super-admin) and `visibility='hq'`, so all authorised operators see the same firehose. The **seam** for per-role event visibility is the spine's `visibility` field (Ch.04) + a capability check inside `authorizeForHqAudience(ev)`: when sub-admin roles arrive (Ch.14), the broadcaster filters per-subscriber audience and routes to role-scoped channels. No redesign — a filter swap. **AI actors** are *producers* into the spine (Ch.07), not subscribers; the live plane is a human-operator surface. Default policy: **deny join** unless super-admin; **deny field** unless explicitly in the vetted delta shape.

---

## Failure handling

The broadcaster is a **reader, never in the write path** (Ch.02, Ch.04) — so every real-time failure degrades liveness without touching truth.

| Dependency fails | Behaviour | Recovery |
|---|---|---|
| **Broadcaster down / crashed** | No live deltas flow. Snapshots still render (SSR). Islands fall back to polling. | On restart, resumes from `hq_event_consumers['realtime']` offset; the cron drain (♻️) guarantees it catches up within a minute even if a `pg_notify` wake was missed (Ch.04). |
| **Supabase Realtime outage** | Channel joins fail. | Islands detect join failure → **polling fallback**; no operator action needed. `LiveDot` shows slate/polling honestly. |
| **A single operator's socket drops** | Their island reconnects with backoff; queues nothing client-side beyond the cap. | On reconnect, **snapshot-resync from `cursor`** back-fills the gap exactly (no missed events, no duplicates). |
| **`pg_notify` wake lost** | Latency rises (event waits for the next drain). | The 1-minute cron drainer is the safety net — delivery is guaranteed, latency bounded (Ch.04 §Failure handling). |
| **Poison/oversized event** | The broadcaster skips it (logs + `system.alert_raised`, Ch.04) and advances; it never blocks the stream. | One bad event never stalls liveness — same poison-handling discipline as projection consumers. |
| **Fan-out overload** (too many channels/messages) | Sampling + coalescing kick in (Performance); the firehose is throttled before the socket is. | Bounded by design; alerts on fan-out (Monitoring) precede user-visible impact. |

**Idempotency (P8):** redelivery is harmless — the client dedups by `ev.id`. **Degradation (P2/P7):** the whole real-time plane is behind the `realtime.enabled` flag; flip it off and every page silently reverts to today's snapshot-only behaviour with zero regression. That is the backout plan.

---

## Edge cases

- **Operator opens five tabs.** Five channel joins, five presence entries, but each tab's island is bounded and backgrounded tabs drop to polling — fan-out stays small. Presence de-dupes by operator id for the "who's here" count (one human, not five).
- **Reconnect storm** (Realtime blips for everyone at once): backoff **with jitter** spreads reconnects; the resync endpoint is a cheap bounded read; the snapshot is cache-friendly. No thundering herd.
- **Event arrives between snapshot render and channel join** (the classic gap): impossible to miss — the snapshot bakes in `lastEventId` as `initialCursor`, and the first post-join action is a resync from that cursor. The `id` total order makes the join seamless.
- **Out-of-order delivery** on the wire: the client orders by `ev.id`, never by arrival or `ts` (Ch.04 — `ts` is display-only). A late delta slots correctly or is deduped.
- **Very high burst** (bulk import emits thousands of events, Ch.04 edge case): the broadcaster **coalesces** (e.g. "1,240 customers imported" as one rolled-up delta) and **samples** the firehose so the UI shows a meaningful summary, not 1,240 prepends. The full detail is always available on the Timeline (Ch.11) via its own paginated read — the firehose is a *notice*, not the system of record.
- **A delta references an entity the operator can't yet see** (future per-role world): `authorizeForHqAudience` filters it out *before* it reaches that subscriber; the seam is already there.
- **Clock skew across serverless invocations:** never a problem — ordering and cursors are `id`-based, not wall-clock (Ch.02/Ch.04).
- **Stale island after a deploy** (delta shape gained a field): forward-compatible — unknown fields ignored; the next snapshot reconciles. No hard break.

---

## Performance

**The Golden Rule, answered explicitly: at one million companies, would we still build it this way? Yes — because the cost of liveness scales with the number of *active operators*, not with the volume of data or companies.** This is the single most important property in the chapter.

- A million companies generate a large spine, but each live surface reads a **bounded** slice: the snapshot is a handful of `hq_metrics` rows + a capped recent-events window (Ch.03/Ch.09 — O(1) in company count), and the island receives a **sampled, coalesced** delta stream, not the raw firehose.
- The fan-out cost is `O(active operators × channels they hold)`. There is one operator role and a handful of humans today; even at scale, the number of *humans simultaneously watching HQ* is tiny relative to a million companies. **Liveness is a subscription, not a poll, and not a scan** — exactly the Ch.02 Performance claim, realised.
- **Bounded channels.** Per-object channels (`hq:org:{id}`) exist only while at least one operator is on that entity's page; they are created on subscribe and torn down on unsubscribe. We never hold a million org channels open — only the ones someone is actually looking at.
- **Backpressure / coalescing / sampling.** The broadcaster caps messages-per-second per channel; over the cap it coalesces same-verb/same-object events into a rollup delta and samples the firehose for the global `hq:pulse`. The UI is *informed*, never *flooded*; the operator's browser is never the bottleneck.
- **Budgets:** snapshot TTFB inherits the existing fast SSR path (no regression — same `force-dynamic` reads, plus a tiny `initialCursor`); delivery latency p95 ≤ a few seconds in Phase-1 (cron-net bounded), ≤ ~250 ms after graduation (Ch.17); resync is one bounded indexed read (single-digit ms server-side). Hydration cost is one small island, not a heavy SPA bundle (Ch.02 rejected the SPA precisely to avoid this).
- **Caching:** the snapshot endpoint can be briefly micro-cached per surface (the read-models change on a rollup cadence, Ch.15); deltas are never cached (they are the cache-busting signal).

**Conclusion:** the expensive work (aggregation) stays amortised in background rollups (Ch.15); the request path stays O(1); liveness adds a bounded subscription whose cost tracks operators, not the business. We build it this way *because* of the Golden Rule.

---

## Security

Real-time is a security-sensitive plane because it pushes data *to browsers*. The design is defence-in-depth, and every layer is consistent with Ch.16 and Ch.04 §Security.

- **No JWT-readable HQ table — ever.** The headline decision: `hq_events` (and every `hq_*` table) stays `RLS:hq` (RLS enabled, **zero policies**, service-role only — Ch.03). We never write a SELECT policy to satisfy `postgres_changes`. The browser has **no** read path to the spine. ♻️ This preserves the dominant HQ posture intact.
- **Server-authorised broadcast only.** The only thing that reads the spine for liveness is the server-side broadcaster under service-role. The browser receives *pushed, pre-vetted* deltas; it never pulls from a table.
- **Minimal vetted delta.** `shapeDelta` ships identifiers + display-safe fields only — no raw `payload`, no PII beyond identifiers (Ch.04 payload policy), no service-role data. Even if a delta leaked, it carries nothing a snapshot didn't already show that operator. Sensitive detail is resolved server-side at render, never on the wire.
- **Channel join authorisation.** Only authenticated super-admins may join `hq:*` channels (reuses `isSuperAdminEmail()` ♻️). An anon or non-allowlisted JWT is refused — it receives nothing. Two independent gates (join-auth *and* delta-minimality) must both fail for any exposure.
- **Trust boundary.** The browser is **untrusted** (Ch.16): the snapshot/resync endpoint re-authorises every call and never trusts a client-supplied identity or cursor beyond using it as a `> id` filter (a malicious cursor at most re-fetches public-to-that-operator deltas). No mutation flows over real-time — it is delivery-only, so there is no injection/abuse vector into state (commands are server actions, Ch.05, separately gated).
- **Secrets.** The service-role key lives only in the broadcaster/server (♻️ `lib/env.ts`, Zod-validated, server-only); the browser holds only the public anon key (♻️ `lib/supabase/client.ts`), which grants nothing on `hq_*`.
- **Tamper-evidence:** real-time emits no audit (it is pure delivery); the underlying events are already on the append-only spine (Ch.04). Liveness can be turned off instantly via the flag (P7) with no data consequence.

---

## Testing

- **RLS guard (the cornerstone):** a test asserts that an anon/JWT client **cannot** read `hq_events` and **cannot** join any `hq:*` channel (♻️ the existing RLS-test pattern, Ch.03/Ch.16). This test failing is a release blocker — it is the proof the critical security decision holds.
- **Authorisation tests:** a non-super-admin JWT is refused the channel join and receives zero deltas; the snapshot endpoint 404s for them (mirrors `requireHqPage()` behaviour).
- **Delta-shape contract tests:** for each broadcast verb, assert `shapeDelta` output contains *only* whitelisted fields and **no** raw payload / PII — the real-time analogue of the event-contract tests (Ch.04). A drift that leaks a field fails CI.
- **Resync correctness:** simulate a disconnect across a known set of spine events, reconnect, assert the island ends in exactly the state of a fresh snapshot (no gap, no duplicate) — the byte-identical-oracle style (♻️ 007's token tests, Ch.03/Ch.04).
- **Idempotency:** deliver the same `ev.id` twice, assert the DOM/feed is unchanged (P8).
- **Fallback:** with Realtime stubbed unavailable, assert the island enters polling and still reflects new events within the poll interval.
- **Backpressure:** feed a burst of N events, assert coalescing/sampling caps messages-per-second and the UI shows a rollup, not N prepends.
- **Fixtures:** a deterministic in-memory fake of the Realtime channel (join/auth/broadcast) so islands are testable without a live socket. **CI gates:** the validation triplet (tsc / lint / tests) + Vercel build, exactly as 007 (Ch.02).

---

## Monitoring

Liveness has its own golden signals, all derived from events and surfaced in observability (Ch.15) — observability falls out of the architecture (P3).

- **Events emitted (Ch.04):** the broadcaster is a consumer, so it contributes to consumer-lag metrics under `consumer='realtime'`; channel lifecycle and overload conditions raise `system.alert_raised` / resolve with `system.alert_resolved`. (It deliberately does **not** spam the spine with a per-delivery event — delivery is not a business fact.)
- **Metrics (Ch.15):** **broadcast fan-out** (messages/s, channels open), **active operators / active channels** (the quantity that drives cost — watch it, not data volume), **delivery latency** (event `id` committed → delta sent: p50/p95/p99), **reconnect rate** and **join-failure rate** (the canary for a Realtime outage), **polling-fallback ratio** (how many islands are degraded right now), **broadcaster consumer lag** (`max(hq_events.id) − realtime offset` — a rising lag means liveness is falling behind *before* operators notice).
- **Alerts / SLOs:** alert if reconnect/join-failure rate spikes (Realtime degraded), if consumer lag exceeds a threshold (broadcaster stuck — the cron net should prevent this), or if fan-out approaches the configured ceiling (graduate per Ch.17). Target SLO: p95 delivery latency within budget (Phase-1: seconds; post-graduation: sub-second) and ≥ 99% of operator-seconds in the `live` (not `polling`) state.
- **The `LiveDot` as a monitor:** because the dot's colour is driven by real `status`, every operator is a passive monitor — a room full of amber dots is an incident signal before the alert fires.

---

## Future expansion

The plane boundaries (Ch.02) are the seams; real-time grows by addition, never reshape.

- **Per-role / per-tenant-scoped visibility:** the `visibility` field (Ch.04) + `authorizeForHqAudience` filter + role-scoped channels light up when sub-admin roles arrive (Ch.14). No transport change.
- **Collaborative presence & cursors:** presence already tells us *who* is here; the seam to *what they're doing* (viewing the same org, editing an approval) is additive on top of presence — deferred until a collaboration feature needs it. 🔬 Durable "last seen" (`hq_operator_presence`) is the open question deferred above.
- **Optimistic local echo:** an operator's own action could echo locally before the spine round-trips; deliberately deferred — correctness-via-spine first, latency polish later.
- **AI-employee liveness:** the live plane is human-facing today; AIs consume the spine directly (Ch.07). The seam to surface AI *attention* ("Finance AI is looking at Acme") is presence-shaped and additive.
- **Graduating the transport (Ch.17):** if Supabase Realtime's fan-out is ever outgrown, the broadcaster's `realtimeBroadcast()` is swapped for another transport (a managed pub/sub) **behind the same contract** — producer-side `shapeDelta` and client-side `useLiveEvents` are unchanged (P6, named exit). The island pattern is the stable seam for the decade; only the wire beneath it may change.
