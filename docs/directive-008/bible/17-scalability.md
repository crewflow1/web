# Chapter 17 — Scalability

## Purpose

This chapter answers the Golden Rule for the whole OS: *"if CrewFlow had one million companies using it, would we still build it this way?"* — and it answers it not with a promise but with a mechanism. Scalability here is **not** "make everything big from day one." It is the opposite discipline: start with the simplest thing that works on the stack we already operate (Postgres-as-queue, a cron drainer, a single primary, monthly partitions, synchronous tool calls), and **name in advance the exact, observable threshold at which each simple choice graduates to a heavier one**. That is P6 — *Postgres-first; graduate on evidence* — turned into an operations runbook. The signature artifact of this chapter is the **graduation-trigger table** (§3.4, §10): every simple decision, the metric from Ch.15 that watches it, the threshold, and what it becomes. Scaling CrewFlow is therefore a *pre-decided, monitored event*, never a 2 a.m. panic.

The chapter also makes one uncomfortable truth explicit: at a million companies the dominant marginal cost of an AI-employee OS is **LLM tokens, not CPU**. CPU scales horizontally on Vercel for cents; an ungoverned workforce scales its token bill linearly with the customer base. So LLM cost control is treated here as a first-class scalability axis, co-equal with partitioning and load-levelling — the budget governor (Ch.07) is core architecture, not an add-on.

## Goals

- **State the bound for every hot path.** Every surface an operator touches (Mission Control, timeline, search, metric tiles) reads a **projection** whose cost is **O(1) in company count** — never a scan of the raw spine. This is the load-bearing scalability claim and it is asserted, not hoped.
- **Make the spine scale by structure, not luck.** Monthly partitioning, partition pruning, a bigint identity total order, offset-based consumers, and cold-partition archival — so `hq_events` grows to a million companies' worth of history while every *read* stays bounded.
- **Level load between producers and consumers.** The transactional outbox + cron-drainer pattern (♻️ `notifications-drain`, `research-drain`) decouples write bursts from work; AI runs are always asynchronous (schedule/event/manual/delegation), **never inline in a request**.
- **Bound LLM spend by construction.** Model tiering (cheapest model that does the job), per-run and per-day budgets with a circuit breaker (suspend-not-crash), caching, prompt minimisation, the ~$52/day roster ceiling (Ch.08) — and cost as the most-watched metric (Ch.15, P9).
- **Pre-decide every graduation.** A concrete table of *simple choice → watched signal → threshold → graduates to*, each entry deliberate and reversible, each behind a service boundary so the swap touches no call site.
- **Stay stateless.** Vercel serverless scales horizontally with no server affinity; all state lives in Postgres/Realtime; connection pressure is a PostgREST/pooler concern, not a per-function one.

**Non-goals:** the event envelope and delivery semantics (Ch.04, canon — consumed here); the metric registry and SLO definitions (Ch.15, canon — this chapter *watches* those signals, it does not redefine them); the budget governor's internals (Ch.07); the per-employee budgets (Ch.08); real-time channel mechanics (Ch.06); security of the broadcast path (Ch.16). This chapter owns the **scaling strategy and the named exits**; those chapters own the machinery it scales.

---

## Architecture

The one-million-companies analysis is the spine of this section, not a footnote to it. We walk the request path and the write path and, at each component, state how it behaves at 200 companies (today), at 200k, and at 1M — and where the named exit sits.

### The shape that scales: write once to the spine, read from projections

```
  WRITE PATH (bounded, append-only)              READ PATH (always O(1) in company count)
  ─────────────────────────────────             ──────────────────────────────────────────
  state change ─┐                                Mission Control ─▶ hq_metrics (a few rows, Ch.15)
                │ same tx (outbox, Ch.04)         timeline        ─▶ projection by cursor (hot partition, Ch.11)
  hq_events ◀───┘                                search          ─▶ hq_search_index (GIN, Ch.10)
     │ id = total order (bigint identity)         employee view   ─▶ in-flight partial index (Ch.07)
     │ ts = month partition key                          ▲
     ▼                                                    │ never scans the raw spine on the hot path
  pg_notify('hq_events')  ──wakeup──▶ offset consumers ───┘
     │                                 (timeline / metrics / search / trace — Ch.04/15)
     └─ cron drainer (dead-worker safety net, ♻️ research-drain pattern)
```

The single most important scalability decision in the OS is this asymmetry: **the spine is the only thing that grows with the business, and nothing reads it directly on a user's request.** Every operator-facing surface reads a *derived, rebuildable projection* (Ch.01 P1) whose row count is bounded by *what's recent or relevant*, not by *how many companies exist*. A million companies make the spine large; they do **not** make the homepage slow, because the homepage reads a handful of `hq_metrics` rollup rows (Ch.15 §Performance) and a bounded recent-events slice — the same fistful of rows whether there are 200 companies or 1,000,000. This is the architecture *because of* the Golden Rule, not despite it (♻️ the `mission-control` service already commits to this O(1) bound in Ch.05).

### Event-spine scale (the write path)

`hq_events` (Ch.03 §03.1) is engineered to absorb a million companies' worth of history:

- **Monthly range partitioning on `ts`.** One child partition per calendar month, created ~2 months ahead by a partition-creator cron, with a default partition catching stragglers (Ch.03 §Failure handling). At 1M companies the spine might write tens of millions of rows per month — but each lands in *one current partition*, keeping the live table's indexes small and inserts fast.
- **Partition pruning on every read.** Because `ts` is the partition key and projections read recent windows (Ch.11 cursor reads), the planner prunes to the hot partition(s) and never touches cold history. A query for "the last 50 events for org X" scans one or two partitions on `hq_events_object_idx`, not the whole log.
- **The bigint identity PK is the total order.** `id bigint generated always as identity` gives a monotonic, gap-detectable, offset-friendly total order (Ch.04 §"Why a bigint id is the order"). Consumers read `WHERE id > last_event_id ORDER BY id LIMIT n` — a bounded index range scan whose cost is the batch size, **independent of total spine size**. This is *the* property that lets offset consumers scale: there is no `OFFSET n` table scan anywhere.
- **Index strategy = covering the access patterns, nothing more.** The five indexes in Ch.03 §03.1 (`object`, `actor`, `corr`, `verb`, and a *partial* `severity` index on `warn|critical` only) each serve a named read; the partial severity index stays tiny because most events are `info`. We add indexes per measured access pattern, never speculatively — an index is a write-amplifier on the hottest write path in the system.
- **Retention & archival of cold partitions.** Partitions older than the retention window (Ch.15) are **detached** to cold/archival storage, never `DROP`ped destructively (Ch.03 §Conventions; ♻️ the existing `docs/activity-log-retention.md` policy). Detaching a partition is an O(1) metadata operation that instantly shrinks the live index set — the spine's working size stays bounded by the retention window, not by company-lifetime history.

**Why this scales to a million companies:** the spine grows monotonically, but every interaction with it is bounded — inserts hit one small current partition, consumer reads are offset-limited index ranges, projection reads are pruned to recent partitions, and cold history is detached out of the hot set. Volume is absorbed by *partitioning + bounded reads + offset consumers*, not by hoping the row count stays small (Ch.04 §Performance).

### Read scaling via projections

No hot path scans `hq_events`. Each read surface is served by a projection maintained off the request path:

| Surface | Reads (projection) | Bound at 1M companies | Ch. |
|---|---|---|---|
| Mission Control tiles | `hq_metrics` (latest row per metric/grain) + `hq_metric_counters` (live hot-counter) | a handful of rows; counter is a single upsert | 09 / 15 |
| Event timeline | timeline projection, cursor over the hot partition | bounded page size; pruned partition | 11 |
| Global search | `hq_search_index` (GIN tsvector + trigram) | index lookup, not a join across domain tables | 10 |
| Employee "what's happening" | `ai_employee_runs` in-flight **partial index** (`where state not in ('idle','done','failed')`) | O(active runs), independent of company count | 07 |
| Metric drill-down | `hq_metrics` time-series by `(metric, grain, ts)` | indexed range; expensive aggregation is amortised in rollups | 15 |

The `hq_metric_counters` table (Ch.03 §03.15b) is the explicit "hot counter" pattern: a churn or signup bumps a single counter row *now* (instant tile movement), while the periodic rollup recomputes the authoritative `hq_metrics` value and reconciles drift (Ch.15 §"The dual path"). The operator gets liveness *and* eventual exactness without ever aggregating the raw spine on a request. **Projections are rebuildable** (Ch.01 P1, Ch.04 replay) — if one is corrupted or its formula changes, we drop and replay it from the spine; it is never a second source of truth that can rot independently.

### Queue load-levelling (decoupling producers from consumers)

Producers (webhooks, state changes, bulk imports) write to the spine in bursts; consumers (projections, AI runs, email sends) must not be coupled to that burst rate. The OS levels the load with the **transactional outbox + drainer** pattern that already runs in production:

- **The outbox decouples.** A producer's only obligation is to append its event in the same transaction as its state change (Ch.04). It never waits for a consumer. The spine *is* the buffer.
- **Two consumer classes, two back-pressure models** (Ch.04 §"Retryable work vs projections"):
  - **Projections** (timeline, metrics, search, trace) drain by offset in bounded batches — back-pressure is simply the batch limit; a burst makes the *lag* grow, which is the watched canary (Ch.15 `consumer_lag`), and the projection catches up at its own controlled rate.
  - **Retryable side-effecting work** (AI runs, email sends) flows through a real queue (`ai_employee_tasks` today; `pgmq` at the named exit) with retries, backoff, dead-lettering, and a **visibility timeout** as back-pressure (Ch.04 §Edge cases).
- **The drainer is the proven mechanism (♻️).** `pg_notify('hq_events')` fires on insert for low-latency wakeups, and a **Vercel cron drainer** runs as the dead-worker safety net — *exactly* the live pattern: `notifications-drain` (`*/15`, drains up to 50 queued Resend rows with exponential backoff) and `research-drain` (`*/5`, bounded to ≤5 tasks per invocation, re-claims tasks stuck in `running` past `STUCK_RUNNING_MS = 5 min`). Both are bounded per invocation so one drain can never run away; both wrap `withCronTelemetry` (♻️ `lib/ops/cron-telemetry.ts`) so their health is observable. The OS generalises this one pattern across every consumer rather than inventing new plumbing.
- **AI runs are async, always.** A run is *never* executed inline in an HTTP request. Every trigger — `schedule` (cron), `event` (spine subscription), `manual` ("run now"), `delegation` (employee-to-employee) — lands a row in `ai_employee_tasks` and an `ai.triggered` event; the runtime drains the queue (Ch.07 §Triggers). A bulk import emitting thousands of `invoice.*` events enqueues thousands of tasks that drain at a controlled rate within per-employee concurrency caps — the workforce degrades to *slower*, never to *overloaded* (Ch.07 §Performance). Rate-limiting is the queue lease + concurrency cap; there is no path by which a producer burst stampedes the model providers.

### LLM cost control — the dominant scalability axis

At a million companies, **tokens are the bill**. CPU is horizontally cheap on Vercel; an AI workforce that calls a model per company per event has a cost that scales with the customer base — which is, unmanaged, an existential risk (Ch.01 P9). The OS bounds it by construction along five levers, each grounded in the live system or the canon:

1. **Model tiering — the cheapest model that does the job.** Each employee declares a `model` in its image (Ch.07): **Haiku** for high-volume routine work (Research AI runs `claude-haiku-4-5` today, ♻️ `research-llm.ts`; Support AI is Haiku for ticket volume), **Sonnet** for balanced reasoning (Finance, Sales, Marketing, …), **Opus** only for the few low-volume deep-reasoning heads (CEO, CTO, Product). Tier is a config decision reviewed like a hire (Ch.08), and it is the single biggest cost lever — moving routine work off Opus is an order-of-magnitude saving.
2. **The budget governor — per-run + per-day ceilings, circuit-breaker, suspend-not-crash.** The governor checks the ceiling *before* each LLM/tool call (Ch.07 §Failure handling): crossing the warn line emits `ai.budget_warned`, crossing the hard line emits `ai.budget_exceeded`, trips the breaker, and moves the run (and optionally the employee) to **`suspended`** — a parked, resumable state, not a crash (Ch.07 FSM). An employee that overspends pauses; it never silently bankrupts a department. No silent overspend, ever (P9).
3. **Caching.** Provider prompt-caching for the stable prefix (the fixed system prompt + tool schemas, which are identical across an employee's runs) and result-level memoisation for idempotent reads. The image being static config (Ch.07) is what makes the cacheable prefix large and stable.
4. **Prompt minimisation.** Context is **capped at PERCEIVE** (Ch.07 §run loop): bounded memory recall (Ch.12), a small system prompt, compact tool schemas. This bounds cost *and* latency at the source — a single run's token cost is **independent of total company count** because the context is a bounded slice, not a scan.
5. **Cost as a first-class metric.** `ai_cost_per_employee_day` is a registered system metric (Ch.15 §Performance, P9); every `ai_employee_run` records `cost_usd`/tokens (Ch.03 §03.3); the rollup aggregates per employee per day; budgets read it. Cost is *measured like latency*, so a drifting unit cost trips an SLO, not a month-end invoice.

**The honest one-million answer:** the workforce does not scale by running more model calls per company. There are still **twelve** employees at a million companies (not twelve million) — they act on **events** (what changed), drain a **bounded queue**, recall **bounded** context, and spend under **daily ceilings**. The roster's total cost is the **sum of twelve budgets (~$52/day in the Ch.08 plan)**, a bounded constant the operator sets, *independent of company count*; volume raises *queue depth* (absorbed by back-pressure and `pgmq` at the exit), not per-company token cost. An AI workforce is only viable at a million companies because its marginal cost is **governed** — which is why the budget governor is core architecture, not an add-on (Ch.07/08 §Performance).

### Statelessness & connection scaling

The compute tier scales trivially because it holds no state:

- **Vercel serverless scales horizontally, no server affinity.** Every function invocation is stateless; all state lives in Postgres (system of record) and Supabase Realtime (liveness). Adding load adds function instances; there is no sticky session, no in-memory cache that must be coherent across instances, no leader. Horizontal scale is the platform's job, and we do not fight it.
- **Connection pressure is a PostgREST/pooler property, not a per-function one (♻️).** The verified production picture (`docs/connection-pooling-and-scale.md`): the entire app data path goes through **PostgREST over HTTP**, which multiplexes all REST traffic over a small server-side pool (**4 connections** of a 60-connection tier in prod today). A serverless invocation does **not** open a Postgres connection — so the classic "lambda fan-out × cold starts → `too many connections`" failure mode **does not apply** to CrewFlow's data path. Adding companies adds HTTP requests that PostgREST queues, not backend connections.
- **The named footgun stays closed.** Any *future* code that needs a direct Postgres socket (a dedicated worker, a direct-SQL analytics job, the dormant Drizzle deps) **must** use the Supabase pooler (Supavisor) in **transaction mode (port 6543)**, never the direct 5432 string from serverless (♻️ `docs/connection-pooling-and-scale.md`). This is a CI/lint guard, not a hope — it is the one property that, if broken, *can* exhaust the ceiling under fan-out.
- **Query budgets & index discipline.** The `authenticated`/`anon` `statement_timeout` (8s/3s, ♻️) caps any runaway tenant query; HQ projections are designed to covering indexes (Ch.03) so PostgREST pool occupancy stays low. Connection pressure and query efficiency are the same problem from two ends.
- **Realtime scales via the island model + server-authorised broadcast (Ch.06).** Liveness is delivered by **server-authorised broadcast**, never per-client DB subscriptions on `hq_events` (which would demand JWT-readable RLS on the most sensitive table — forbidden, Ch.16). The broadcaster shapes a minimal vetted delta and publishes to scoped channels (`hq:pulse` firehose, `hq:org:{id}` on demand, per-employee). Fan-out cost scales with **active operators**, not data volume; **channel cardinality** is bounded because per-object channels are created on demand and torn down, and the firehose is server-throttled + sampled for display (Ch.04 §Performance). The only unbounded fan-out point in the system is therefore deliberately capped.

### Graduation triggers — the named exits (the chapter's signature)

CrewFlow deliberately starts **simple**: Postgres-as-queue, a cron drainer, a single primary, monthly partitions, synchronous tool calls inside a run. Each simple choice is correct *now* and carries a **named exit**: the exact, observable signal (defined in Ch.15) and the threshold at which it graduates to a heavier mechanism — behind a service boundary, so the swap touches no call site (Ch.05 §"Graduating a subsystem"). The full table is §10; the principle is stated here because it *is* the architecture: **we do not build the heavy version speculatively, and we do not discover the need at 2 a.m. — we watch the signal and graduate deliberately when it crosses the line.** Every graduation is reversible (flag-gated, preview-first, P7) and every trigger is a metric an operator can already see on Mission Control.

---

## Database design

This chapter **owns no tables**; it is a strategy over tables catalogued in Ch.03 (canon). It reads the scaling-relevant ones and watches their growth:

| Table | Scaling role | Ch.03 |
|---|---|---|
| `hq_events` | The only table that grows with the business; monthly-partitioned, cold partitions detached | §03.1 |
| `hq_event_consumers` | Durable offsets; `max(id) − last_event_id` is the **consumer-lag** canary | §03.2 |
| `hq_metrics` | Authoritative rollups; the O(1) read that keeps dashboards flat at 1M companies | §03.15 |
| `hq_metric_counters` | The hot-counter store for instant tiles (single upsert, no spine scan) | §03.15b |
| `hq_search_index` | Denormalised search projection (GIN); the named exit to Typesense/Meilisearch sits behind `searchHq()` | §03.13 |
| `ai_employee_tasks` | The retryable work queue; the named exit to `pgmq` sits behind `enqueueTask()` | §03.6 ♻️ |
| `ai_employee_runs` | Per-run `cost_usd`/tokens — the substrate of every cost SLO; in-flight partial index is O(active) | §03.3 |
| `hq_runs` / `hq_spans` | Execution telemetry; the named exit to an OTel backend sits behind `getTrace()` | §03.18 |

**Partitioning discipline (the one DDL idea this chapter leans on):**

```sql
-- ILLUSTRATIVE (not production). Monthly child partition, created ~2 months ahead
-- by the partition-creator cron. Detaching a cold partition shrinks the live
-- index set in O(1) — retention without a destructive DROP (Ch.03 §Conventions).
create table hq_events_2026_07 partition of hq_events
  for values from ('2026-07-01') to ('2026-08-01');

-- graduation seam: when a monthly partition's size/write-rate crosses the §10
-- threshold, the SAME mechanism creates WEEKLY partitions — no schema reshape,
-- only a change in the partition-creator's cadence.
alter table hq_events detach partition hq_events_2025_01 concurrently;  -- → cold storage
```

Access pattern is uniform: **append to the current partition, read pruned recent partitions, detach cold ones.** No chapter alters a tenant table; every scaling table is `RLS:hq` (service-role only), so JWT clients never read a scaling-relevant row (Ch.16).

---

## APIs

This chapter defines **no new public API**. Its contribution to the API layer is a single rule and the service-boundary seams that make graduation invisible to callers:

- **Every new service must state its bound at 1M companies, or it does not ship** (♻️ the rule already asserted in Ch.05 §Performance). A service whose cost is a function of company count is a defect, not a feature awaiting optimisation.
- **The graduation seams are existing service boundaries** — graduating a subsystem swaps the implementation *behind* the abstraction without touching call sites (P6, Ch.05 §"Graduating a subsystem"):

```ts
// ILLUSTRATIVE — the contracts stay identical across every graduation in §10.
// Callers never learn whether the backend is Postgres or something heavier.

enqueueTask(t: TaskInput): Promise<{ taskId: string }>;   // ai_employee_tasks → pgmq (same signature)
emitEvent(tx, e: EventInput): Promise<{ id: number }>;    // partitioned Postgres → broker (same signature)
searchHq(q: SearchQuery): Promise<SearchHit[]>;           // hq_search_index → Typesense/Meili (same signature)
getTrace(correlationId: string): Promise<TraceTree>;      // hq_events read → OTel backend (same signature)
getMetricsSnapshot(): Promise<Record<string, number>>;    // primary rollup → read replica (same signature)
```

- **A scalability "API" that does exist is observational, not mutational:** the golden-signal metrics (Ch.15) that the graduation table reads — `consumer_lag`, `queue_depth`, `run_error_rate`, `query_p95`, `ai_cost_per_employee_day`, `partition health`. The "call" is a dashboard read; the "response" is a graduation decision.
- **Error shapes / versioning:** graduation is governed by an **ADR** (Ch.20), not an API version bump — because the contract does not change, only the backend behind it. The day a swap ships, the only externally visible artifact is a `system.flag_changed` event and a decision-log entry.

---

## UI behaviour

Scalability is mostly invisible to the operator — and that invisibility is the point — but it surfaces in three deliberate places, all *inside* Mission Control (Ch.09), never a separate "ops" app:

- **The graduation cockpit (read-only signals).** Each named exit's watched signal is a tile or sparkline already on the observability surface (Ch.15): consumer lag, queue depth, run error rate, query p95, cost/employee/day, partition health. An operator *sees a signal approaching its threshold before it crosses* — the graduation is anticipated, not discovered. States: **live** (signals subscribed via broadcast, Ch.06), **warn** (a signal in its error-budget burn zone, styled `warn`), **critical** (threshold crossed → `system.alert_raised`, Ch.15 routing).
- **Degradation is legible, never silent.** When a simple mechanism is under pressure but not yet graduated, the operator sees the *symptom* honestly: a rising "as of HH:MM" staleness on a tile when a rollup lags; a "queue depth: N backlog" badge when work is levelling behind a burst; a suspended-employee chip when a budget breaker trips (Ch.07/08). The system degrades to *slower and labelled*, never to *wrong and quiet* (P10 — you always know what's happening).
- **Graduation itself is a flagged, audited event.** Flipping a subsystem to its heavier backend is a feature-flag toggle (♻️ `hq_settings`, P7) with a preview and a written backout; it emits `system.flag_changed` and lands an `admin_activity_log` decision entry. The operator can see *that* CrewFlow graduated, *when*, and *why*, and can flip it back in seconds.
- **Accessibility:** every signal that uses colour for severity is paired with text and an icon (♻️ the 007 design-system discipline, Ch.15 §UI); threshold-crossing announcements use `aria-live="polite"`.

---

## Permissions

Scalability touches authority only through the controls that *enact* it; capabilities flow through the single `authorize()` chokepoint (Ch.14):

| Action | Capability | Who |
|---|---|---|
| View scaling signals (lag, depth, cost, partition health) | `observability.read` / `metrics.read` | all super-admins (default) |
| Toggle a subsystem's graduation flag | `ops.graduate` (new, senior-only) | senior operators only — it is an infrastructure change (ADR) |
| Adjust an employee's budget ceiling | `ai.budget.admin` | senior operators only; the change is audited |
| Resume a budget-suspended employee/run | `ai.run.resume` | operators; the resume is audited (Ch.07) |
| Edit a metric **definition** (the formula a threshold reads) | `metrics.admin` | senior operators only — a "one source" change (Ch.15) |

- **Default policy:** read-broad, mutate-narrow. Every operator can *see* the scaling posture; only senior operators can *change* it (graduate a subsystem, raise a budget). This mirrors the rest of the OS (Ch.15 §Permissions).
- **AI employees may read scaling signals, never enact scaling.** A Finance AI may inspect its own `cost_usd` (Ch.15), but no AI holds `ops.graduate` or `ai.budget.admin` — capacity decisions are a human prerogative. The budget governor *suspends* an AI automatically (a guardrail), but *raising* its ceiling is a deliberate, audited human grant (P4/P9).
- **No ambient scaling authority.** There is no "auto-scale the budget" path; graduation and budget changes are explicit, gated, reversible decisions — the blast radius of a wrong capacity call is a million companies (Ch.01 P4), so it is gated like any dangerous action.

---

## Failure handling

Scaling mechanisms fail in characteristic ways; each degrades gracefully because the spine is the recovery anchor (Ch.02) and every consumer is idempotent (P8):

- **A consumer falls behind (lag spikes).** Expected under a burst. The projection is not lost — it drains at its controlled rate and catches up; the rising `consumer_lag` is the **canary** (Ch.04/15) that warns *before* a tile goes stale. If lag persistently exceeds the §10 threshold, that *is* the graduation signal (cron drainer → `LISTEN`/dedicated worker), not an incident to firefight.
- **The cron drainer misses a wakeup.** `pg_notify` is best-effort; the drainer is the dead-worker safety net that guarantees delivery within its interval regardless (♻️ exactly `research-drain`'s contract: most runs are kicked immediately, the cron catches whatever was enqueued-but-never-kicked). A missed wakeup costs latency, never a lost event.
- **A run crashes mid-flight (serverless timeout/redeploy).** The persisted FSM `state` is the recovery point (Ch.07); the drainer finds in-flight runs older than the threshold (♻️ `STUCK_RUNNING_MS`) and resumes from the last committed phase. Idempotent transitions ⇒ no double side-effect.
- **A budget breaker trips.** The employee/run moves to `suspended` (parked, resumable) — a *contained* failure: the company degrades to *slower in one function*, never to *unsafe* or *overspent* (Ch.07/08). A suspended Finance/Support AI is itself a `warn` signal (oversight/responsiveness paused).
- **A bulk import stampedes producers.** Producers batch-insert to the spine; consumers read bounded batches; side-effecting work is absorbed by the queue's visibility timeout (Ch.04 §Edge cases). The burst raises *lag* and *queue depth* (both watched), never overruns the model providers or the database.
- **A graduation goes wrong.** Because every graduation is flag-gated with a written backout (P7), the failure mode is "flip it back" — seconds, not a rollback deploy. The heavy backend and the simple one both sit behind the same service contract, so reverting is a config change.
- **The primary saturates under rollup load.** The rollup jobs run off the request path; if they strain the primary, the named exit is a **read replica / dedicated analytics path** (§10) — until then, a straining rollup raises `system.cron_failed` (Ch.15), and the prior `hq_metrics` rows stand (stale "as of", not wrong).

---

## Edge cases

- **A partition that doesn't exist yet** (inserts racing ahead of the creator cron): the default partition catches stragglers safely and a monitor (Ch.15 `partition health`) fires `critical` if next month's partition is missing — caught before inserts reach the gap (Ch.03 §Failure handling).
- **Causation pointing at a pruned/detached partition** (the cause is older than retention): the trace edge renders "(beyond retention)"; the chain is intact within the window, cold storage holds the rest (Ch.15 §Edge cases). Archival is not deletion.
- **A single org generating pathological event volume** (a runaway integration emitting thousands of events): per-aggregate ordering still holds (monotonic ids, Ch.04); the burst raises lag/queue depth (watched), and the loop breaker (Ch.07) stops an AI from amplifying its own events into a storm.
- **Counter vs rollup disagree at a rollup boundary** (an event lands mid-rollup): the rollup is computed `as_of` a fixed `id` watermark, so the boundary is deterministic and the next rollup absorbs the straggler (Ch.15 §Edge cases) — drift self-heals, it is not a scaling failure.
- **A graduation threshold is crossed transiently** (a one-off spike, not a sustained trend): thresholds are read against an **error budget over a window** (§10, Ch.15), not a single sample — a momentary spike burns budget but does not auto-graduate; sustained breach is what triggers the deliberate decision. Graduation is never automatic.
- **Channel cardinality explosion** (every org page open at once spawning `hq:org:{id}` channels): channels are created on demand and torn down on disconnect (Ch.06); the firehose is sampled; fan-out is server-throttled — the bound is active operators, and a per-operator channel cap is the seam if even that is pressured.
- **The dormant Drizzle deps get imported** (the named footgun): a CI/lint guard rejects any direct Postgres client that doesn't use the transaction-mode pooler string (♻️ `docs/connection-pooling-and-scale.md`) — the one way to break the connection-safety property is structurally prevented.

---

## Performance

This is where the one-million-companies analysis is made concrete and where the **graduation-trigger table** lives. The budgets restate the canon (Ch.05/11/15) as a single scaling contract; the table is the chapter's signature.

**The bounds, restated as a contract (all O(1) in company count unless noted):**

| Path | Budget | Why it holds at 1M companies |
|---|---|---|
| Mission Control snapshot | < 50 ms server-side | reads a handful of `hq_metrics` rows + counters; aggregation amortised in rollups (Ch.15) |
| Timeline page | bounded cursor read | pruned to the hot partition on `hq_events_object_idx` (Ch.11) |
| Global search | < 100 ms | single GIN lookup on `hq_search_index`, not a cross-domain join (Ch.10) |
| `getTrace(correlationId)` | p95 < 150 ms | indexed lookup on `hq_events_corr_idx`, bounded by one intent's events (Ch.15) |
| Consumer lag check | two scalar reads | `max(id) − last_event_id` — the canary, constant cost (Ch.04) |
| Spine insert | one indexed append | lands in one small current partition (Ch.03) |
| One AI run's token cost | bounded by capped context | context capped at PERCEIVE; independent of company count (Ch.07) |
| Roster total spend | ~$52/day, a set constant | sum of twelve budgets; volume raises queue depth, not per-company cost (Ch.08) |

### §10.1 — The graduation-trigger table (the named exits)

Every simple choice, the **observable signal** that watches it (a registered metric, Ch.15), the **threshold** (read over an error-budget window, not a single sample), what it **graduates to**, and the **service seam** behind which the swap happens. Each is deliberate, reversible (P7), and ADR-governed (Ch.20).

| # | Simple choice (today) | Watched signal (Ch.15) | Threshold (graduate when…) | Graduates to | Seam |
|---|---|---|---|---|---|
| 1 | **Cron drainer** (`pg_notify` + `*/5`–`*/15` cron, ♻️ `research-drain`/`notifications-drain`) | `consumer_lag` p95 (the canary) | drain-latency p95 sustainedly exceeds the freshness budget (e.g. lag > 500 events or > 60 s, beyond error budget) | a persistent **`LISTEN`/dedicated worker** (long-lived listener, no cron gap) | the `drain()` loop (Ch.04) |
| 2 | **Postgres-as-queue** (`ai_employee_tasks` state machine) | `queue_depth` + task throughput | sustained backlog/throughput strains plain-table contention (e.g. depth > N k or lease contention measurable) | **`pgmq`** (visibility timeouts, DLQ, fairness), then Redis Streams | `enqueueTask()` (Ch.07) |
| 3 | **Single primary** for reads | `query_p95` + rollup CPU on primary | read load / rollup aggregation sustainedly strains the primary (p95 > 200 ms attributable to read contention) | **read replica(s) / dedicated analytics path** | `getMetricsSnapshot()` / service layer (Ch.05/15) |
| 4 | **Monthly partitions** on `hq_events` | partition size + write-rate per partition | a monthly partition's size/write-rate exceeds the comfortable index-maintenance window | **weekly partitions** (same creator cron, finer cadence — no schema reshape) | the partition-creator cron (Ch.03) |
| 5 | **Synchronous tool calls** within a run (max-steps loop) | run duration p95 + step-budget exhaustion rate | run wall-clock sustainedly exceeds the serverless window / runs routinely hit the step ceiling | a **durable workflow engine** (checkpointed long-running steps) behind the FSM | `runEmployee()` / the FSM (Ch.07) |
| 6 | **Partitioned Postgres as the event bus** | `spine throughput` (events/min) | sustained event rate exceeds what partitioned Postgres comfortably serves | a **dedicated broker** (NATS / Kafka) — `emitEvent`/`drain` contracts unchanged | `emitEvent()` / `drain()` (Ch.04) |
| 7 | **`hq_search_index`** (GIN tsvector + trigram) | search `query_p95` + relevance ceiling | search latency/relevance hits a ceiling at scale | **Typesense / Meilisearch** behind the same search API | `searchHq()` (Ch.10) |
| 8 | **HNSW vector index** on `hq_memories.embedding` | vector recall latency p95 | recall latency exceeds budget after HNSW tuning is exhausted | a **dedicated vector store** (only if forced) | the memory recall service (Ch.12) |
| 9 | **Internal trace viewer** (read `hq_events`/`hq_runs`) | trace-read p95 + trace volume | Postgres trace reads outgrow comfort | an **OpenTelemetry backend** (Honeycomb / Tempo) behind `getTrace()` | `getTrace()` (Ch.15) 🔬 |
| 10 | **Provider prompt-cache + per-employee budgets** | `ai_cost_per_employee_day` (P9) | sustained cost/employee/day trends toward the roster ceiling despite tiering | **renegotiated tiers / batch API / cheaper model mix** (a config change, reviewed like a hire) | the model adapter / employee image (Ch.07/08) |

**Ten named exits.** Each row is a *pre-made decision*: the operator does not improvise under load — they watch the signal (already on Mission Control, §6), and when it crosses its budget they execute the named graduation deliberately, behind a flag, with a backout. The signals are real metrics from Ch.15; the seams are real service boundaries from Ch.05; the thresholds are tuned from load tests (♻️ the `docs/connection-pooling-and-scale.md` load-test discipline) and recorded as ADRs (Ch.20). This table *is* CrewFlow's scaling plan — finite, observable, and reversible.

### The one-million verdict

Walk the rule one last time. At 1M companies: the **spine** is large but every read is bounded (partition pruning + offset consumers + cold-partition archival); every **operator surface** reads an O(1) projection, not the raw log; **producers and consumers** are decoupled by the outbox so bursts raise watched lag, not outages; the **workforce** costs a set ~$52/day because it acts on events with bounded context under daily ceilings, not per-company; **compute** scales horizontally and statelessly with no connection-exhaustion failure mode (PostgREST/pooler-safe, ♻️); and **every simple choice has a named, observable, reversible exit**. The answer to "would we still build it this way?" is **yes** — because the design's scalability is not an aspiration, it is a watched set of bounds and a finite list of pre-decided graduations.

---

## Security

Scaling must never widen a trust boundary (Ch.16):

- **Every scaling table is `RLS:hq`** (service-role only) — `hq_events`, `hq_metrics`, `hq_search_index`, `ai_employee_tasks`, `hq_runs`. No JWT client reads a scaling-relevant row; growth does not create a new exposure surface (Ch.03/16).
- **Graduating a subsystem inherits the same posture.** A `pgmq` queue, a read replica, a Typesense index, or an OTel collector is provisioned under service-role/secured infrastructure with the **same payload policy** as the spine — *no PII beyond identifiers* (Ch.04/15 Security). A heavier backend never becomes a softer one: the external search index stores titles/ids, not sensitive detail; the OTel export carries the spine's payload policy.
- **Liveness at scale stays server-authorised.** Real-time fan-out grows via the broadcaster (Ch.06), never by exposing `hq_events` to client subscriptions — the most sensitive table never becomes JWT-readable just because there are more operators (Ch.16).
- **Cost controls are a security control too.** The budget governor bounds the blast radius of a compromised or injected employee to its (small) capability set *and* its daily ceiling — an attacker who hijacks an employee cannot run up an unbounded token bill any more than they can exceed its capabilities (Ch.07/16). Cost governance is part of containment.
- **Capacity changes are gated and audited.** `ops.graduate` and `ai.budget.admin` are senior-only, audited capabilities (§7); a wrong capacity decision at a million companies is gated like any dangerous action (P4/P5).
- **The connection-safety property is enforced, not trusted.** The lint/CI guard against un-pooled direct Postgres clients (♻️ `docs/connection-pooling-and-scale.md`) is a security control as much as a scaling one — fan-out exhaustion is a denial-of-service vector, structurally prevented.

---

## Testing

Scalability is tested by *proving the bounds hold* and *proving graduation is a no-op to callers*:

- **Bound tests (the Golden-Rule gate).** For each hot-path service, a test asserts the query plan/row count is **independent of company count** — e.g. seed 200 vs 200k orgs and assert `getMetricsSnapshot()` reads the same handful of `hq_metrics` rows (no full scan), and the timeline cursor read prunes to the hot partition. A service that scans more rows as orgs grow **fails CI** (the "state your bound at 1M or don't ship" rule, §5).
- **Partition tests.** Migrations create partitions and route inserts to the correct month; detaching a cold partition leaves recent reads correct; a missing-partition scenario hits the default partition and raises the monitor (Ch.03 §Testing).
- **Offset-consumer scale tests.** Assert `WHERE id > offset ORDER BY id LIMIT n` is a bounded index range regardless of spine size; assert idempotent re-apply of a redelivered batch yields an identical projection (♻️ the byte-identical-oracle style from 007, Ch.04).
- **Load-levelling tests.** Simulate a producer burst (thousands of events) and assert consumers drain in bounded batches, queue depth rises and falls, no work is lost, and the cron drainer re-claims a "stuck" task past the dead-worker threshold (♻️ `research-drain` behaviour).
- **Budget-breaker tests.** A run scripted to exceed its ceiling trips at the boundary, emits `ai.budget_exceeded`, moves to `suspended`, and executes **no** further tool — asserted, not assumed (♻️ Ch.07 §Testing).
- **Graduation-seam tests (contract stability).** A fake heavy backend behind `enqueueTask`/`emitEvent`/`searchHq`/`getTrace` proves the contract is **identical** to the Postgres implementation — callers cannot tell which backend answered. This is what makes a future graduation safe.
- **Connection-safety guard test.** A CI/lint rule rejects any new direct Postgres client not using the transaction-mode pooler string (♻️ `docs/connection-pooling-and-scale.md`) — the footgun cannot be reintroduced silently.
- **Load test at the next milestone (♻️ the existing discipline).** Before each order-of-magnitude growth, a load test drives the heavy surfaces (Mission Control, timeline, search, run throughput) and reads the graduation signals (PostgREST pool utilisation, CPU, lag, query p95) to *tune the §10 thresholds from evidence*, exactly as the F-9 review prescribes for 200 orgs.
- **CI gates:** the validation triplet (tsc / lint / tests) + Vercel build, as every chapter (Ch.15).

---

## Monitoring

Scalability has **no private metrics** — by design, every signal it acts on is a registered golden signal from Ch.15, so the scaling posture is visible on the same Mission Control surface as everything else (P3, observable by construction). This chapter specifies *which* signals are the graduation triggers and *what crossing each means*:

| Signal (Ch.15) | Scaling meaning | Triggers graduation row (§10.1) |
|---|---|---|
| **`consumer_lag`** (the canary) | projections falling behind the write rate | #1 cron drainer → worker |
| **`queue_depth`** | retryable work backing up | #2 Postgres queue → `pgmq` |
| **`query_p95`** + primary CPU | read/rollup load on the primary | #3 single primary → read replica |
| **partition size / write-rate** | a partition outgrowing its maintenance window | #4 monthly → weekly partitions |
| **run duration p95** + step-budget exhaustion | runs outgrowing the serverless window | #5 sync calls → durable workflow |
| **`spine throughput`** (events/min) | the bus approaching Postgres comfort | #6 partitioned PG → broker |
| **search `query_p95`** / relevance | search hitting its ceiling | #7 GIN → Typesense/Meili |
| **vector recall p95** | recall latency after HNSW tuning | #8 HNSW → vector store |
| **trace-read p95** + volume | trace reads outgrowing Postgres | #9 internal viewer → OTel 🔬 |
| **`ai_cost_per_employee_day`** (P9) | the dominant cost trending up | #10 cost controls / tier renegotiation |
| **`partition health`** | next month's partition exists | safety monitor (not a graduation — a `critical` gap alert) |

- **Each signal carries an SLO and an error budget (Ch.15).** A graduation threshold is "the error budget is *burnt*, not momentarily spiked" — sustained breach over a window, so a transient spike never auto-graduates (§9). Burning a budget escalates the signal's severity and gates risky changes (P7) until recovered.
- **Alert routing reuses the existing path (♻️).** Threshold crossings raise `system.alert_raised` with `severity`; `critical` notifies the operator, `warn`/`info` surface on the dashboard (♻️ `hq-alerts-scheduler` + `admin_alert_state`, Ch.15). A graduation signal in its burn zone is a standing dashboard `warn` long before it pages.
- **Events emitted by this chapter's *actions* (Ch.04):** `system.flag_changed` (a graduation toggled), `system.alert_raised`/`system.alert_resolved` (a signal crossing/recovering), `ai.budget_warned`/`ai.budget_exceeded`/`ai.suspended` (cost-axis scaling events). The scaling story is itself on the spine — *what happened, what is happening, what will happen* (P10) applies to scaling too.
- **Golden signals for the chapter as a whole:** cost burn-rate (is the workforce trending toward the roster ceiling?), consumer lag (is any projection falling behind?), queue depth (is the workforce keeping up with events?), and partition health (is the spine's runway intact?). The first two are existential at scale; both page the operator.

---

## Future expansion

The seams are deliberately left, unused, until measurement demands them — that *is* the chapter's thesis, so "future expansion" here is the same list as the named exits, viewed as roadmap rather than runbook:

- **The §10 exits, taken in order of evidence.** Each graduation (worker, `pgmq`, read replica, weekly partitions, durable workflow, broker, external search, vector store, OTel) ships *when its signal crosses*, behind a flag, behind an unchanged service contract — never a sprint sooner (Ch.05 §"Graduating a subsystem").
- **Multi-region** — explicitly a non-goal today (Ch.01 §non-goals). The seam is the stateless compute + single system-of-record: when a region's latency or residency requirement forces it, the spine's append-only, totally-ordered shape is what makes a replicated/regional topology tractable. Named, not built.
- **Auto-tuning thresholds** — once `hq_metrics` has enough history, the graduation thresholds themselves can be set from a baseline-deviation model (Ch.15 §Future) rather than hand-tuned constants — *measure → bound → predict*, closing the P9/P6 loop. The graduation stays a human decision; only the *alerting* becomes predictive.
- **Cost forecasting as a capacity input** — `ai_cost_per_employee_day` history feeds a projected-spend metric (Ch.15 §Future) so the roster ceiling and per-employee budgets are *set from evidence and trend*, and row #10's graduation is anticipated months out.
- **Batch/async LLM APIs** — as provider batch endpoints mature, routine high-volume work (Research, Support triage) can move to a batch tier for a further step-change in token cost — a config change in the employee image (Ch.07), reviewed like any hire, sitting behind the model adapter seam.

The data model is designed so the next decade is **more tables at the edges and heavier backends behind stable seams**, never a reshaping of the core (Ch.03 §Future). Scalability, like the rest of the OS, is *one source, forever* — applied to the act of growing.
