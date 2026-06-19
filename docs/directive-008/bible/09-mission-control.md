# Chapter 09 — Mission Control

> **"Mission Control is the centre of CrewFlow. When I log in I should immediately know: what happened, what is happening, and what will happen — without opening another page. Everything should be live. Everything should connect together."** — CEO Directive #008

> Governing philosophy: *every piece of information inside CrewFlow exists once, is observable everywhere, and is actionable by AI.* Mission Control is the **everywhere**. It owns almost no data; it is the place every other system becomes visible and answerable in one glance.

---

## 09.1 Purpose

Mission Control is the **homepage of the operating system** — the first screen a human operator sees at `/admin`, and the one they keep open all day. It answers three questions, continuously and without navigation:

- **What is happening** — right now, live: which employees are working, what they are doing, who is online, is the machine healthy.
- **What needs me** — the human's action queue: approvals awaiting a decision, escalations, anything blocked on a person.
- **What happened / what will happen** — the recent past projected from the event spine, and the near future projected from schedules, queues and deadlines.

Today the `/admin` surface (♻️ `app/admin/`) is a *set of pages* — `overview`, `command-centre`, `health`, `alerts`, `ai-employees`, `research`, `support`, `billing`, `sales/*`, `memory`, `analytics` — each requiring a click to reach. The CEO's complaint is precise: *you must open another page to know anything.* Mission Control's job is to invert that. The essential state of every system is **projected onto the home screen, live**, and every item on it is a **link** back to the page that owns it. You learn the state of the company from the home screen, and you *navigate only to act*.

Mission Control is not a new data store and not a new source of truth. It is a **composition surface**: a read-model that fuses the event timeline (Ch.11), the metric registry (Ch.15), the approval inbox (Ch.13), the AI run table (Ch.07), the workforce roster (Ch.08) and operator presence (Ch.06) into one coherent, live, connected pane of glass.

---

## 09.2 Goals

**Goals.**

1. **Zero-navigation situational awareness.** Within two seconds of loading, the operator knows the health of the company, the work in flight, and what awaits their decision — without clicking.
2. **Live by default.** The page reflects reality as it changes, pushed over Realtime (Ch.06), not via manual refresh. Staleness is always *visible*, never silent.
3. **Everything connects.** Every entity shown — an employee, a job, an org, an approval, a run, an invoice — is a link to its detail surface. The home is the hub of a wheel whose spokes are the existing `/admin` pages.
4. **Actionable, not just observable.** The one thing the operator can *do* from the home — approve or reject — is available inline (delegating to Ch.13), because that is the action that most often blocks the AI workforce.
5. **Composed by registration, not surgery.** Every platform system contributes a *tile* against one contract. New systems appear on Mission Control by registering, never by rewriting the page.
6. **Capability-shaped.** An operator sees exactly the tiles their capabilities (Ch.14) permit — a smaller board is never a broken one.
7. **Sound at one million companies.** The homepage reads only bounded, indexed projections and O(1) counters; it never scans history. Load time is independent of how much has happened.

**Non-goals.**

- **Not a reporting/BI tool.** Deep analysis lives in `/admin/analytics` (Ch.15). Mission Control shows *headline* numbers with click-through, not pivot tables.
- **Not a second source of truth.** It computes nothing authoritative; it projects what the canon already records.
- **Not an editing surface.** Beyond approval decisions and the operator's own layout preferences, Mission Control does not mutate domain state — you navigate to the owning page to edit.
- **Not an AI surface.** Mission Control is the *human's* window onto the workforce. AIs populate it (via events, runs, approvals); no AI principal renders it.

---

## 09.3 Architecture

### 09.3.1 The shape: a server shell of independent client islands

Mission Control is one Next.js App Router page — a **server component shell** (`app/admin/page.tsx`, ♻️) that renders a grid of **client island tiles**. The shell, on the server, gates the page (`requireHqPage()`, ♻️ `server/auth/hq.ts`) and loads each tile's *initial* projection in parallel behind independent Suspense boundaries. Each tile then **subscribes to its own Realtime channel** (Ch.06 island model) and updates itself live, in isolation, for the rest of the session.

The island model (Ch.06) is the load-bearing choice: **no tile can block, stall, or break another.** A slow loader shows a skeleton while its neighbours render; a failed loader shows a degraded tile while the page stays whole; a dropped subscription affects only its own island.

```
            ┌─────────────────────────  /admin  (server shell, requireHqPage) ──────────────────────────┐
            │  ⌘K command palette (Ch.10)        operator · live-connection indicator · clock            │
            ├───────────────  NOW  ───────────────┬────────────────  WHAT NEEDS ME  ─────────────────────┤
            │  ▸ Pulse: runs in flight, presence  │  ▸ Approval inbox (Ch.13) — sorted by risk × expiry  │
            │  ▸ Workforce: 12 employee cards     │      [Approve] [Reject] inline · click → decision     │
            │    status · task · spend/budget     │  ▸ Escalations / blocked-on-human                    │
            ├───────────────  RECENT  ────────────┼────────────────  AHEAD  ────────────────────────────┤
            │  ▸ Activity feed (Ch.11 timeline)   │  ▸ Scheduled runs (Ch.07/08 working hours)           │
            │    last N significant events, live  │  ▸ Approvals nearing expiry · upcoming dunning        │
            │    every entity is a link           │  ▸ Queue depth · SLA timers about to breach           │
            ├──────────────────────────  HEADLINE METRICS  (Ch.15 counters) ─────────────────────────────┤
            │  Revenue · Active orgs · Open jobs · Support backlog · AI spend today/ceiling · Approvals    │
            ├──────────────────────────  SYSTEM HEALTH  (golden signals, Ch.15) ────────────────────────┤
            │  Spine lag · drainer latency · run failure rate · budget headroom · realtime uptime         │
            └───────────────────────────────────────────────────────────────────────────────────────────┘
```

### 09.3.2 The tile-provider registry (the centrepiece)

The page is **not** a hand-wired layout. It is a render of a **tile registry**. Every tile is a value implementing one contract — the same design language as the employee SDK's `defineEmployee()` and the tool registry (Ch.07): *config, not code; registration, not surgery.*

```ts
// server/mission-control/registry.ts  (illustrative)
type Band = 'now' | 'action' | 'recent' | 'ahead' | 'headline' | 'health';

interface MissionControlTile<DTO> {
  id: string;                       // 'now.workforce', 'action.approvals', …
  band: Band;
  title: string;
  requiredCapability: CapabilityKey;        // Ch.14 — the page renders only tiles you may see
  load(ctx: TileContext): Promise<DTO>;     // server projection read — BOUNDED, indexed, never scans the spine
  channels?: RealtimeChannel[];             // Ch.06 island(s) it subscribes to (server-authorised broadcast)
  refresh: { live: boolean; pollMs?: number };   // live, with poll fallback if Realtime is down
  render: ClientComponent<DTO>;             // the island component, hydrated from `load`'s DTO
}
```

The shell's algorithm is the whole page:

```ts
const tiles = registry.filter(t => allow(authorize(operator, t.requiredCapability)));   // Ch.14, fail-closed
const dtos  = await Promise.allSettled(tiles.map(t => t.load(ctx)));                     // parallel, isolated
return <Grid>{tiles.map((t, i) => <Island tile={t} initial={dtos[i]} />)}</Grid>;
```

Consequences that satisfy the directive:

- **Everything connects** because every system *registers a tile* — Mission Control is the union of the platform, by construction.
- **It grows without re-architecting** — a new system (say, a future "Contracts" module) adds one tile and appears on the home; the page code does not change.
- **It is capability-shaped** because the filter is the gate — an operator who lacks `billing.read` simply never sees the dunning tile; the page composes around them.

### 09.3.3 The connective tissue: one entity-link resolver

"Everything should connect together" is implemented as a **single routing function**, not scattered `<Link>`s. Every projection row carries a stable `EntityRef` (the same `{type,id}` refs the event spine and timeline already use, Ch.04/Ch.11). One resolver turns a ref into a route:

```ts
type EntityRef =
  | { type: 'employee'; id: string }   // → /admin/ai-employees/[slug]   (♻️ existing dossier route, Ch.08)
  | { type: 'run';      id: string }   // → /admin/ai-employees/[slug]#run-[id]
  | { type: 'approval'; id: string }   // → /admin/approvals/[id]        (Ch.13)
  | { type: 'job';      id: string }   // → the job's entity-sliced timeline (Ch.11)
  | { type: 'org';      id: string }   // → /admin/organizations/[id]    (♻️)
  | { type: 'customer'; id: string }   // → /admin/customers/[id]        (♻️)
  | { type: 'invoice';  id: string }   // → /admin/billing#invoice-[id]  (♻️)
  | { type: 'memory';   id: string }   // → /admin/memory/[id]           (♻️ Ch.12)
  | { type: 'event';    id: string };  // → the timeline anchored at this event (Ch.11)

function hrefFor(ref: EntityRef): string;   // ONE source of routing truth
```

Because there is one resolver, "connected" is a property the whole page inherits for free, and adding a new entity type is a one-line change.

### 09.3.4 Reads projections, never the spine

Mission Control is on the hottest path in the product, so it follows Ch.17's read-scaling rule absolutely: **every tile reads a bounded, indexed projection or an O(1) counter — none scans `hq_events`.** The activity tile reads the timeline projection top-N (Ch.11); the headline numbers read `hq_metric_counters` (Ch.15); approvals read the open-queue index (Ch.13); the workforce reads the active-run partial index (Ch.07); "ahead" reads a bounded scheduled-window query. History grows without bound; the homepage's working set does not.

---

## 09.4 Database design

Mission Control **owns almost no tables.** Its power is that it reads everyone else's projections. Tables it *reads* (all defined in their owning canon chapters — Mission Control does not fork their vocabulary):

| Read source | Owner | Used for |
|---|---|---|
| timeline projection over `hq_events` | Ch.11 / Ch.04 | the Recent (activity) tile |
| `hq_metric_counters`, `hq_metrics` | Ch.15 | headline numbers, health signals |
| `hq_approvals`, `hq_approval_policies` | Ch.13 | the "what needs me" inbox + "ahead" expiries |
| `ai_employee_runs` | Ch.07 | the Now pulse + workforce status |
| operator presence | Ch.06 (🔬 `hq_operator_presence`) | who is online now |
| the employee registry (static config) | Ch.08 (`lib/ai-employees/framework/employees/*`, ♻️) | the workforce cards |

The **only** state Mission Control owns is a tiny per-operator personalisation record:

```sql
-- 09.4 hq_operator_dashboard — per-operator home preferences + an unread high-water mark.
-- RLS:hq (service-role only; the HQ plane has few operators). Tiny, hot-read, append-light.
create table hq_operator_dashboard (
  operator_id    uuid primary key references auth.users(id) on delete cascade,
  layout         jsonb       not null default '{}',   -- pinned/ordered/collapsed tiles
  last_seen_event bigint     not null default 0,        -- high-water mark into hq_events.id (Ch.04 total order)
  updated_at     timestamptz not null default now()
);
```

`last_seen_event` is what powers "**N new since you looked**" badges: because `hq_events.id` is a `bigint` identity that is a *total order* (Ch.04), "new" is the single comparison `event.id > last_seen_event` — no timestamps, no races. Advancing the mark is best-effort: losing it only re-shows a badge, never affects domain state.

> 🔬 **Open question (for Ch.20).** Should `hq_operator_dashboard` be its own table, or a per-operator row in `hq_settings`? A dedicated table keeps the hot `last_seen_event` write off the config table; `hq_settings` avoids a new table. Either way this is an **additive** change that must be catalogued in the Ch.03 canon with an ADR (the same discipline applied to `hq_metric_counters` as §03.15b) — no chapter invents a table outside Ch.03.

---

## 09.5 APIs

### 09.5.1 The snapshot loader

The server shell composes the page from per-tile loaders. Each loader is a service function (Ch.05), capability-gated (Ch.14), returning a typed projection DTO. There is no monolithic query — tiles load independently so one slow source cannot delay first paint.

```ts
// server/mission-control/snapshot.ts  (illustrative)
async function loadMissionControl(actor: HqActor): Promise<MissionControlSnapshot> {
  const tiles = registry.filter(t => /* authorize(actor, t.requiredCapability) === allow */);
  const results = await Promise.allSettled(tiles.map(t => t.load({ actor })));
  return { tiles: zipToDtoOrError(tiles, results), generatedAt: now(), since: lastSeen(actor) };
}

// representative per-tile loaders, each requireCapability(...)-gated:
getWorkforceStatus(actor): Promise<WorkforceDTO>       // ai.read     — 12 cards: state, task, spend/budget
getApprovalQueue(actor): Promise<ApprovalQueueDTO>     // approval.read — open approvals awaiting THIS human
getRecentActivity(actor, cursor?): Promise<FeedDTO>    // timeline.read — top-N events, each an EntityRef
getUpcoming(actor): Promise<AheadDTO>                  // ai.read+billing.read — scheduled runs, expiries, dunning
getHeadlineMetrics(actor): Promise<MetricsDTO>         // metrics.read — counters + sparklines
getSystemHealth(actor): Promise<HealthDTO>             // metrics.read — golden signals
```

Each DTO is a **view model**, not a row dump: pre-resolved display strings, an `EntityRef` for linking, a `severity`, and a `freshAt`. Error shapes follow Ch.05: a failed tile resolves to `{ tile, error: 'unavailable' }` and renders degraded, never throws the page.

### 09.5.2 The only writes

Mission Control performs exactly two kinds of write, both narrow:

- **Approval decisions** — delegated *entirely* to Ch.13's `decideApproval(approvalId, 'approve'|'reject', actor)` action. Mission Control renders the button; Ch.13 owns the capability check, the dual-control rule, the CAS single-decision and the side effect. Mission Control never executes the approved effect itself.
- **`markSeen(actor, eventId)`** — advances `hq_operator_dashboard.last_seen_event`. Best-effort, idempotent (monotonic `max`), no domain impact.

### 09.5.3 The live layer

After hydration, each island opens its Realtime subscription (Ch.06) to a **server-authorised broadcast** channel. Channels are *few and shared* (island model), e.g. `mc:activity`, `mc:workforce`, `mc:approvals`, `mc:metrics`, `presence:hq` — not per-row. The server is the only publisher; the browser is read-only on these channels (see §09.11). On a message, the island applies a minimal patch to its DTO and re-renders just itself.

---

## 09.6 UI behaviour

### 09.6.1 Layout — the three questions, made spatial

The grid maps directly onto the CEO's three questions: **NOW** and **WHAT NEEDS ME** on top (present + the human's queue), **RECENT** and **AHEAD** below (past + future), then **HEADLINE METRICS** and **SYSTEM HEALTH** as the footer band. The single most important tile — *what needs me* — sits top-right in the eye's natural resting place, because an unattended approval is the workforce's most common blocker.

### 09.6.2 States — every tile, independently

Each island renders one of four states, and a tile's state never infects its neighbours:

- **Loading** — a content-shaped skeleton (never a spinner-on-blank); the rest of the board is already usable.
- **Empty** — a *calm, designed* empty state. "No approvals awaiting you" is a feature, not a void: the machine is healthy and you are caught up. Empty states orient ("employees run on schedule — next at 09:00"), they do not look broken.
- **Error** — a degraded tile with a retry and a last-known-good timestamp; the page stays whole.
- **Live** — the steady state, with a subtle freshness indicator (a quiet pulse + "updated 3s ago") so the operator trusts that what they see is now.

### 09.6.3 The live model — honest about staleness

Liveness is authoritative-push with graceful fallback (Ch.06): Realtime pushes truth; the island reconciles. On reconnect, the island refetches its snapshot and catches up from `last_seen_event` (Ch.04 total order makes catch-up exact — no gap, no dup). If Realtime is unavailable, the tile falls back to polling at `refresh.pollMs` and shows a clear banner: *"Reconnecting — showing last-known state at 14:32."* **Silent staleness is forbidden** — if we cannot prove the data is live, we say so.

### 09.6.4 Keyboard & accessibility

- **⌘K** opens the global command palette (Ch.10) from anywhere — search any entity, jump to any page, run any quick action the operator's capabilities permit.
- **j/k** move through the activity feed; **Enter** opens the focused entity via `hrefFor`; number keys jump between bands.
- **Live regions** are announced `aria-live="polite"` and **coalesced** — a screen reader hears "3 new events" once, not thirty interruptions. Every tile is a landmark region with a heading.
- **Colour is never the only signal.** Health and severity carry an icon + text label as well as colour, so red/amber/green is legible to colour-blind operators and in greyscale.

---

## 09.7 Permissions

Mission Control is gated at three layers, all resolving to Ch.14's single `authorize()` chokepoint:

1. **The page** requires a base capability `mission_control.view` (held by every HQ role; `requireHqPage()` remains the coarse gate, ♻️, with `requireCapability()` its successor per Ch.14).
2. **Each tile** declares a `requiredCapability`; the registry filter renders only the tiles the operator may see. There are no "forbidden, blanked-out" tiles — a tile the operator cannot see is simply absent, and the grid reflows.
3. **Each action** (an approval decision) re-checks at execution inside Ch.13 — the button being visible never substitutes for the server-side capability check. **Fail-closed**: any error in resolving a capability hides the tile / denies the action.

Humans render Mission Control; **no AI principal does.** AIs are the *subjects* of the board (their runs, their spend, their pending approvals), never its viewers. No AI holds `mission_control.*` or `permission.*` (Ch.14).

---

## 09.8 Failure handling

| Failure | Behaviour |
|---|---|
| One tile's loader throws | That island renders the **error** state with retry; all other tiles render normally (island isolation). |
| Realtime is down | Tiles fall back to **polling** (`refresh.pollMs`) and show the reconnecting banner; no data is lost, only freshness degrades — visibly. |
| A projection consumer lags (e.g. timeline behind) | The tile shows its **true** `freshAt` and a lag chip; it does *not* pretend to be current. The lag is the same signal Ch.11/Ch.15 already alert on. |
| `markSeen` write fails | Swallowed; the only effect is a re-shown "new" badge. Never blocks render. |
| An approval is decided elsewhere mid-view | The card transitions to **decided** live (Ch.13 CAS); the inline buttons disable; no stale action is possible. |
| The snapshot loader partially fails | `Promise.allSettled` guarantees a partial board, never a white screen. |

Every read path is **idempotent and side-effect-free**, so retry and reconnect are always safe.

---

## 09.9 Edge cases

- **Event storm.** A thousand events in a second must not thrash the UI. The activity island **coalesces** updates (batched on an animation frame) and headline numbers move via `hq_metric_counters` increments (O(1)), never per-event recomputation.
- **Approval expires while viewed.** The card flips to *expired* live; per Ch.13 expiry carries no side effect; the operator cannot act on a lapsed item.
- **Employee suspended mid-run** (budget governor, Ch.07). The workforce card flips to *suspended* with the reason and remaining budget; the run also appears in Recent as *suspended* — one truth, two views.
- **Two operators race the same approval.** Presence (Ch.06) shows both are online; the first decision wins by CAS (Ch.13); the item vanishes from the other's queue live. Presence exists precisely to prevent duplicated human effort.
- **Overdue "ahead" items.** A scheduled run that should have fired but hasn't is bucketed honestly as *overdue*, not hidden in the future — the "ahead" band tells the truth about lateness.
- **Narrow-capability operator.** Someone with only `support.*` sees a coherent, smaller board (support activity, support approvals) — never a grid of permission-denied boxes.
- **Cold start (no events yet).** A first login on a quiet day shows a designed welcome state that orients the operator (what each band will show, when the next scheduled run is), not a blank page.
- **Clock skew across operators.** All "new"/ordering is by `hq_events.id` (total order), not wall-clock, so two operators agree on what is new regardless of local clocks.

---

## 09.10 Performance

**Budgets.** Server snapshot TTFB **< 200 ms** (all reads are indexed top-N or counter reads, parallelised); all tiles hydrated **< 1 s**; a live update applied **< 250 ms** end-to-end from event to pixel.

**The one-million-companies test.** *If CrewFlow had one million companies, would Mission Control still load instantly?* **Yes — by design**, because nothing on the page grows with history or tenant count:

- The activity tile is **top-N by `hq_events.id` desc** — a bounded index scan, constant cost whether the spine holds ten thousand or ten billion rows (Ch.11/Ch.17).
- Headline numbers are **O(1) reads of `hq_metric_counters`** (Ch.15), not aggregations over event history.
- The approval queue reads the **open-set partial index** (Ch.13) — proportional to *open* approvals (small), not all approvals ever.
- Workforce status reads the **active-run partial index** (Ch.07) — proportional to runs *in flight* (≤ the roster), not all runs.
- The "ahead" band is a **bounded scheduled-window** query (the next few hours), not the whole schedule.

The only cost that *could* grow is Realtime fan-out. The **island model** (Ch.06) contains it: a handful of shared, server-authorised channels with coalesced broadcasts, not a subscription per row or per tenant. Per-operator snapshots are briefly cacheable; the live layer carries deltas. **History scales; the homepage does not.** That is the whole performance thesis, and it is why Mission Control can be the always-open home at any scale.

---

## 09.11 Security

- **Read-mostly, fully gated.** Every loader is capability-checked at the single chokepoint (Ch.14) and **fails closed**; the only writes are the Ch.13-owned approval decision and the operator's own `markSeen`/layout.
- **Server-authorised broadcast (Ch.06).** Browsers *subscribe* to Mission Control channels but **cannot publish** to them. A compromised or malicious client cannot inject a fake event, a fake approval, or a fake number onto any operator's board — the server is the sole publisher, and what it publishes is derived from the canon.
- **No secrets, no PII in URLs.** Entity links carry only `{type,id}` refs resolved server-side; sensitive payloads never travel in query strings (privacy rule). The page renders no API keys or service-role material.
- **Least privilege shapes the view.** Because tiles are filtered by capability, an operator is structurally unable to observe a system they have no right to — Mission Control cannot become a side-channel around RBAC.
- **AI containment is inherited.** Mission Control shows what the workforce *did* and *proposes*; it is downstream of the gate (Ch.07/Ch.14). An injected instruction to an AI cannot manufacture a Mission Control action, because the AI cannot render or act on this surface at all (Ch.16).

---

## 09.12 Testing

- **Unit.** The DTO view-model mappers (row → display model + `EntityRef`); the `hrefFor` resolver for every entity type; the "new since `last_seen_event`" computation (boundary at equal/greater ids).
- **Integration.** Each loader against a seeded ephemeral Postgres returns the correct *bounded* set and is **capability-filtered** — a `support`-only actor's snapshot contains support tiles and no billing tile.
- **RLS (Ch.18).** Negative tests prove an under-privileged or anon principal receives nothing from any loader (RLS:hq is service-role-only; the page composes around denied capabilities rather than leaking).
- **Realtime.** A server-authorised broadcast reaches the right island and patches it; a **client publish attempt is rejected** (the core security assertion of §09.11).
- **Snapshot/visual.** The "calm empty" states and the degraded-tile state render as designed; an **event-storm** test asserts the activity island coalesces and does not re-render per event.
- **End-to-end.** Log in → see the three bands populated → click an entity → land on its `/admin` detail page; decide an approval inline → it leaves the queue **live** in a second browser context (proving Realtime + CAS).

---

## 09.13 Monitoring

Mission Control is primarily a **consumer** of the entire event/metric system, so it emits little of its own. What it contributes to observability (Ch.15):

- **Metrics:** time-to-first-tile, live-update latency (event→pixel), per-tile load time and error rate, Realtime connection uptime, and the **approvals-awaiting depth** (also a workforce KPI in Ch.08) — the single number that best predicts whether the human is becoming the bottleneck.
- **Golden signals** for the page itself: snapshot p95, tile-error rate, subscription drop rate. These feed the System Health tile, closing the loop — *Mission Control monitors itself, on itself.*
- **Alerts** are shared, not duplicated: a lagging projection that dims the activity tile is the *same* alert Ch.11/Ch.15 raise; Mission Control surfaces it rather than inventing a parallel one.
- **Engagement (optional).** A single `mission_control.opened` event would let us measure whether the home truly replaces navigation. 🔬 *Open question (Ch.20): is per-open instrumentation worth the event volume, or is session-level telemetry enough?*

---

## 09.14 Future expansion

The composition-by-registry architecture is the seam: **the home grows by registering tiles, never by surgery.** Deliberately deferred, with the seam already in place:

- **Saved layouts & pinned tiles.** `hq_operator_dashboard.layout` already exists; the UI to reorder/pin/collapse is the only addition.
- **Focus / war-room mode.** A single-incident view that promotes one entity and its live context — a tile *arrangement*, not a new system.
- **Department drill-downs.** Per-department Mission Controls (a Support home, a Finance home) are the same registry filtered by department — no new plumbing.
- **Predictive "ahead" band.** The future band today reads deterministic schedules and deadlines; the seam is a `UpcomingProvider` interface, so forecasting (predicted churn, predicted dunning failures, predicted SLA breaches) plugs in as new providers without touching the page.
- **Mobile / condensed home.** The same DTOs render a compact, glanceable layout for a phone — the data layer is already view-model-shaped.
- **Multi-operator HQ.** Presence and per-operator queues are built in from day one (Ch.06), so when HQ grows beyond a handful of operators, assignment and "who's handling this" need only UI, not re-architecture.

Mission Control's promise is structural: it is the one screen that makes the whole operating system **visible, live, and connected** — and because every system reaches it by registration, it stays that way as CrewFlow grows toward a million companies. *This is the centre. Everything connects here.*
