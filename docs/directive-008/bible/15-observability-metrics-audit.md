# Chapter 15 — Observability, Metrics & Audit

## Purpose

This chapter specifies the OS's **system monitor** (Ch.01's kernel-model row, Ch.02's Control/Data planes): how an operator answers *what happened, what is happening, what will happen* — and how the AI workforce is measured and held to account — without leaving Mission Control. It is one chapter because its three pillars are one idea seen from three angles:

1. **Observability / tracing.** Because every intent is an event chain sharing a `correlation_id` (Ch.04), *the trace already exists*. We do not bolt tracing on; we **read it out** of the spine. A waterfall viewer reconstructs any chain. `hq_runs`/`hq_spans` (§03.18) generalise the proven `withCronTelemetry`/`cron_runs` pattern across AI runs, cron, webhooks and projections.
2. **Metrics.** Directive 007's *one source, forever* applied to numbers: **one canonical formula per metric**, declared in a **registry** (`hq_metric_definitions`, §03.14), promoting today's `lib/hq/metrics.ts`. Live event-driven counters keep tiles instant; periodic rollups recompute the authoritative value and reconcile counter drift into `hq_metrics` (§03.15).
3. **Audit.** `admin_activity_log` stays the canonical immutable, append-only, service-role-only audit (♻️ `recordAdminActivity`, actor-stamped via `HqActor`), covering every mutation, AI tool call, approval decision, permission change and impersonation — optionally hash-chained for tamper-evidence.

This is P3 (*observable by construction*) and P9 (*cost is a first-class metric*) made into a system. Nothing here is a second source of truth: every signal is a **projection** of the spine (Ch.04) or a derived rollup, and all three pillars are rebuildable.

---

## Goals

- **Tracing falls out of the event model.** Any `correlation_id` reconstructs the full waterfall (webhook → event → run → plan → approval → side-effect → memory) with zero per-step instrumentation.
- **Unify execution telemetry.** One `hq_runs`/`hq_spans` shape covers cron, AI runs, webhooks and projection drains — generalising ♻️ `withCronTelemetry`/`cron_runs`/`automation_runs`, which remain as domain stores.
- **Golden signals, defined and alerted.** Spine throughput, **consumer lag** (the canary, Ch.04), queue depth, run error rate, approval latency, broadcast fan-out, query p95, partition health — each with an SLO and an error budget.
- **One source per metric.** A registry of canonical formulae; two metric classes (business + system); **live counters + authoritative rollups** that reconcile drift, so dashboards are simultaneously *live* and *eventually exact*.
- **A complete, tamper-evident audit.** Every consequential act is recorded immutably with its actor; retention by partitioning; compliance-ready export; the SOC2 trajectory named.
- **Pragmatic externals.** Vercel logs/analytics, Sentry for exceptions, optional OpenTelemetry export 🔬 — the OS owns the *narrative*; externals own *infrastructure noise*.

**Non-goals:** the event envelope/registry (Ch.04, canon — this chapter consumes it); metric *display* widgets (Mission Control, Ch.09); the alert *rules engine* internals (♻️ `lib/hq/alert-rules.ts`, extended here for routing only); the approval workflow (Ch.13); per-employee KPI rubrics (Ch.08 dossiers reference this chapter).

---

## Architecture

### The three pillars over one spine

```
                          ┌──────────────────── hq_events (the spine, Ch.04) ────────────────────┐
                          │  every act → one event · correlation_id = trace · causation_id = edge  │
                          └───────┬───────────────────────┬───────────────────────────┬───────────┘
                                  │ (projection)           │ (projection)              │ (projection)
                      ┌───────────▼──────────┐  ┌──────────▼───────────┐   ┌───────────▼────────────┐
                      │ TRACING              │  │ METRICS              │   │ AUDIT                   │
                      │ trace consumer reads │  │ counter consumer     │   │ admin_activity_log      │
                      │ corr/causation →     │  │ bumps live tiles;    │   │ (immutable, ♻️) — the   │
                      │ waterfall viewer.    │  │ rollup cron writes    │   │ legal record, optional  │
                      │ hq_runs/hq_spans     │  │ hq_metrics (authority)│   │ hash chain, partitioned │
                      │ (generalise          │  │ from hq_metric_       │   │ retention.              │
                      │ ♻️ cron_runs)        │  │ definitions registry. │   │                         │
                      └───────────┬──────────┘  └──────────┬───────────┘   └───────────┬────────────┘
                                  │                         │                           │
                                  └──────────── golden signals + SLOs + error budgets ──┘
                                                            │
                              ┌─────────────────────────────▼──────────────────────────────┐
                              │ ALERTING — route by severity (♻️ hq-alerts-scheduler +       │
                              │ admin_alert_state). critical → notify; warn/info → surface.  │
                              │ Externals: Vercel logs/analytics · Sentry · OTel export 🔬   │
                              └──────────────────────────────────────────────────────────────┘
```

Three consumers (Ch.04 *projection* class: pure, fast, offset-driven, idempotent) read the same spine. None is a source of truth; each is droppable and replayable. The whole monitor is *derived*.

### Pillar 1 — Tracing: the trace is the event chain

A trace is **not a new artifact** — it is a `SELECT` over `hq_events`:

```sql
-- the entire story of one intent, as a causal tree
select id, ts, verb, actor_type, actor_id, severity, causation_id, payload
from hq_events
where correlation_id = $1
order by id;                       -- id is the total order (Ch.04)
```

Order by `id` (the monotonic identity, never `ts` — Ch.04's clock-skew rule). `causation_id` turns the flat list into a tree, so the viewer renders a **waterfall**, not a log. The dunning walk-through of Ch.02 §"Data flow" — `invoice.payment_failed` → `ai.run_started` → `ai.planned` → `approval.requested` → `approval.granted` → `ai.tool_called` → `email.sent` → `memory.asserted` — is one such trace, reconstructed for free.

**`hq_runs`/`hq_spans` — the unified execution telemetry (§03.18).** The spine records *business facts*; `hq_runs`/`hq_spans` record *execution mechanics* (timings, sub-steps, attrs) for the four kinds of work the OS runs. This **generalises ♻️ `withCronTelemetry`** (which writes one `cron_runs` row per cron route) into one shape for `kind ∈ {cron, ai_run, webhook, projection}`, all stitched to the spine by `correlation_id`:

```ts
// illustrative: the generalisation of withCronTelemetry (lib/ops/cron-telemetry.ts ♻️)
// same "never throw; best-effort write" contract, now span-aware and kind-agnostic.
async function withRunTelemetry<T>(
  kind: 'cron' | 'ai_run' | 'webhook' | 'projection',
  name: string,
  correlationId: string,
  fn: (span: SpanRecorder) => Promise<T>,
): Promise<T> {
  const run = await openRun({ kind, name, correlationId, status: 'running' });
  try {
    const out = await fn(makeSpanRecorder(run.id));   // span() opens/closes hq_spans rows
    await closeRun(run.id, { status: 'ok' });
    return out;
  } catch (e) {
    await closeRun(run.id, { status: 'error', error: String(e) });
    throw e;                                            // telemetry never swallows the business error here
  }
}
```

| kind | What a run is | Spans (sub-steps) | ♻️ Today |
|---|---|---|---|
| `cron` | One Vercel cron invocation | per-phase work (fetch, compute, write) | `withCronTelemetry` → `cron_runs` |
| `ai_run` | One employee execution attempt (= `ai_employee_runs`, §03.3) | perceive / plan / gate / act / record (Ch.07 FSM) | `automation_runs`, `hq-research.ts` |
| `webhook` | One inbound webhook (Stripe) | verify → state-write → outbox emit | `stripe-webhook-handler.ts` |
| `projection` | One consumer drain batch (Ch.04) | read-batch → apply → advance-offset | `research-drain` pattern |

`cron_runs`/`automation_runs` are **not retired** (P2) — they stay authoritative for their domains; `hq_runs` is the *unified observability view* the trace viewer reads, exactly as the spine is the unified *timeline* view over the two activity logs (Ch.04 backfill).

### Pillar 2 — Metrics: one source per number

The 007 ethos — one canonical definition, enforced — applied to numbers. **`hq_metric_definitions`** (§03.14) is the registry: one row per metric, naming the **single canonical formula** (`formula_ref` → a pure function, promoting ♻️ `computeMetrics()` in `lib/hq/metrics.ts`). No surface re-derives a number; every tile reads the registry's metric. MRR is computed *one way, in one place* (P1) — never differently on `/admin/billing` and the CEO board.

```ts
// illustrative: every metric is a registered definition with ONE formula.
type MetricClass = 'business' | 'system';
interface MetricDefinition {
  metric: string;                          // 'mrr' | 'approval_latency_p95' | ...
  klass: MetricClass;
  unit: 'gbp' | 'count' | 'ratio' | 'ms' | 'usd';
  grains: ReadonlyArray<'minute'|'hour'|'day'>;
  formula: (ctx: RollupContext) => number; // the ONE canonical compute (♻️ lib/hq/metrics.ts)
  counterVerbs?: ReadonlyArray<Verb>;       // spine verbs that bump the live counter
}
```

**Two classes, both registered:**

| Class | Examples | Authoritative source |
|---|---|---|
| **Business** | `mrr`, `arr`, `active_orgs`, `trials`, `setup_fees_earned`, `churn_rate`, `trial_conversion`, `forecast_mrr` (♻️ all already in `HqMetrics`) | rollup over domain tables + spine |
| **System** | `task_throughput`, `approval_latency_p95`, `ai_cost_per_employee_day` (P9), `run_error_rate`, `consumer_lag`, `dead_event_count` | rollup over `hq_events` / `hq_runs` / `ai_employee_runs` |

**The dual path — live *and* eventually exact** (resolves the classic counter-vs-truth tension):

```
                   ┌── event-driven COUNTER ──┐         ┌── periodic ROLLUP (Vercel cron) ──┐
verb on spine ────▶│ +1 to the live tile      │  ...    │ recompute authoritative value via  │
(e.g. org.churned) │ (instant; may drift)     │         │ registry.formula → write hq_metrics │
                   └──────────┬───────────────┘         │ → RECONCILE: tile := authoritative   │
                              ▼                          └───────────────┬────────────────────┘
                    Mission Control tile (live)  ◀───── reconcile ───────┘
```

- **Counters** make tiles move the instant something happens (a churn shows immediately) — the *observable everywhere, live* half of the thesis.
- **Rollups** (a `withRunTelemetry('cron', …)` job, ♻️ the cron pattern) recompute the *authoritative* value from the registry formula, write `hq_metrics` at each grain, and **reconcile counter drift** (counters can double-count under at-least-once delivery, P8; the rollup is the truth that corrects them). This is the metrics analogue of Ch.04's "drop + replay a projection."
- `hq_metrics` is a **time-series rollup** keyed `(metric, grain, ts, dims)` (§03.15): minute (live-ish), hour, day. The homepage reads *day* rows — O(1) (see Performance).

### Pillar 3 — Audit: the immutable record

**`admin_activity_log` stays the canonical HQ audit** (♻️ `recordAdminActivity`, §03 "Reused"): append-only, **service-role-only** (`RLS:hq`, zero policies), actor-stamped with `HqActor={id,email}` from `server/auth/hq.ts`. It is distinct from the spine by *intent*: the spine is the **operational** narrative (drives projections, real-time, AI); the audit log is the **legal/compliance** record (who did what, immutably, forever-until-retention). They are written together, never instead of each other.

The audit covers **every**:
- **state mutation** (org suspended, invoice voided) — ♻️ already wired through `recordAdminActivity`;
- **AI tool call** (`ai_employee_tool_calls`, §03.4) — the AI "syscall" log;
- **approval decision** (granted/rejected/edited, Ch.13) — with `decided_by`;
- **permission change** (`permission.role_granted`/`revoked`, Ch.14);
- **impersonation** (♻️ `impersonation_sessions` — `admin_user_id`, `admin_email`, `target_org_id`, `reason`, `started_at`/`ended_at`): every action taken *while impersonating* is audited under the human actor, never the tenant.

**Optional hash-chaining for tamper-evidence** 🔬. Each row stores the hash of the previous row, making the log **append-only-provable**: any deletion or edit breaks the chain.

```sql
-- illustrative: tamper-evident chain over the existing audit table (additive columns)
alter table admin_activity_log
  add column prev_hash text,
  add column row_hash  text;     -- = sha256(prev_hash || actor_id || action || target || metadata || ts)
-- a verifier walks the chain; a broken link localises tampering to a row.
```

Whether to enable the chain (cost: a hash per write + a periodic verifier job) is open (🔬, Ch.20) — the *seam* is specified now; the spine being append-only (no update/delete grants, Ch.04 Security) already gives strong evidence, so the chain is a belt-and-braces upgrade on the SOC2 path, not a day-one need.

---

## Database design

All tables `RLS:hq` (service-role only). This chapter **owns** §03.18 and is the primary reader of §03.14–§03.15; it adds optional columns to the ♻️ audit table. No table is invented outside Ch.03.

| Table | Role here | Ch.03 |
|---|---|---|
| `hq_events` | The spine — source of every trace, counter, and audit cross-check | §03.1 |
| `hq_event_consumers` | Offsets for the trace/counter consumers; **consumer lag = `max(id) − last_event_id`** | §03.2 |
| `hq_runs` / `hq_spans` | **Owned here.** Unified execution telemetry across cron/ai/webhook/projection | §03.18 |
| `hq_metric_definitions` | The metric registry — one canonical formula per metric | §03.14 |
| `hq_metrics` | Authoritative rollups `(metric, grain, ts, dims)` | §03.15 |
| `admin_activity_log` | ♻️ The canonical immutable audit; **+ optional `prev_hash`/`row_hash`** | §03 reused |
| `admin_alert_state` | ♻️ Alert lifecycle (notified/snoozed/resolved) for routing | §03 reused |
| `impersonation_sessions` | ♻️ Oversight audit input | §03 reused |
| `cron_runs` / `automation_runs` | ♻️ Domain telemetry stores, *kept*; surfaced via `hq_runs` | §03 reused |

**Supporting structure (owned by Ch.03 §03.15b — reproduced for grounding, not redefined):**

```sql
-- a tiny live-counter store the rollup reconciles against (drift is expected, not a bug)
create table hq_metric_counters (
  metric text not null references hq_metric_definitions(metric),
  dims   jsonb not null default '{}',
  value  numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (metric, dims)
);
-- dead_events side-table (Ch.04) is also a monitoring input: dead_event_count > 0 ⇒ alert.
```

**Access pattern.** Writes: the trace consumer (`hq_runs`/`hq_spans` already written inline by `withRunTelemetry`); the counter consumer (`hq_metric_counters`); the rollup cron (`hq_metrics`); `recordAdminActivity` (audit). Reads: the trace viewer (by `correlation_id`), the metric tiles (latest `hq_metrics` per grain), the audit explorer (by actor/target/time), the alert router.

---

## APIs

Service-layer, server-only (Ch.05 conventions). Signatures illustrative.

```ts
// ── Tracing ──────────────────────────────────────────────────────────────
// reconstruct a full causal waterfall from the spine (no new storage read).
function getTrace(correlationId: string): Promise<TraceTree>;          // events + hq_runs/spans, tree by causation_id
function listRecentTraces(filter: { verb?: Verb; severity?: Severity;  // the "recent activity" index
  actor?: ActorRef; sinceId?: number; limit?: number }): Promise<TraceSummary[]>;
function getRun(runId: string): Promise<{ run: HqRun; spans: HqSpan[] }>;

// the generalised telemetry wrapper (♻️ withCronTelemetry → kind-agnostic, span-aware)
function withRunTelemetry<T>(kind: RunKind, name: string, correlationId: string,
  fn: (span: SpanRecorder) => Promise<T>): Promise<T>;

// ── Metrics ──────────────────────────────────────────────────────────────
function getMetric(metric: string, grain: Grain, range: TimeRange): Promise<MetricSeries>;  // reads hq_metrics
function getMetricsSnapshot(): Promise<Record<string, number>>;        // latest-per-metric for the homepage (O(1))
function bumpCounter(metric: string, dims: Json, delta: number): Promise<void>; // counter consumer (idempotent)
function runRollup(grain: Grain, asOf: Date): Promise<RollupReport>;   // cron: recompute + RECONCILE drift
function reconcileCounters(metric: string): Promise<{ before: number; after: number }>;

// ── Audit (the read side; writes go through ♻️ recordAdminActivity) ─────────
function listAudit(filter: { actorId?: string; targetTable?: string;  // generalises ♻️ listAdminActivity
  targetId?: string; action?: string; range?: TimeRange }): Promise<AuditRow[]>;
function exportAudit(filter: AuditFilter, format: 'csv'|'jsonl'): Promise<SignedUrl>;  // compliance export
function verifyAuditChain(range: TimeRange): Promise<{ ok: boolean; brokenAt?: string }>; // hash-chain check 🔬
```

**Contracts & error shapes.** Read APIs return `{ data }` or an empty projection — **never throw to the UI** (♻️ the established "empty array on failure" posture of `listAdminActivity`/snapshot services). Telemetry/counter writers are **best-effort and never throw on the telemetry write** (♻️ exactly `withCronTelemetry`'s "never let telemetry break the run") — but `withRunTelemetry` *does* re-raise the wrapped **business** error so the caller's failure is real. **Idempotency:** `bumpCounter` and the rollup are keyed so re-delivery/re-run is a no-op or a recompute-to-same-value (P8). **Versioning:** metric formulae are versioned in the registry; changing a formula is an ADR (Ch.20) + a `system.projection_rebuilt`-style backfill of `hq_metrics`.

---

## UI behaviour

Surfaced inside Mission Control (Ch.09), not as a separate app — *observable everywhere*, never a page you must "go check."

- **Trace / waterfall viewer.** Open any event, run, approval or audit row → "View trace" → a waterfall keyed by `correlation_id`: rows are events/spans, indented by `causation_id`, coloured by `severity` (♻️ the `info`/`success`/`warn`/`critical` palette from Ch.04 and `lib/hq/alert-rules.ts`), annotated with per-span latency and (for `ai_run`) tokens/cost. States: **loading** (skeleton waterfall), **empty** (a single-event trace renders as one row), **error** (the spine read failed → "trace unavailable", page still renders), **live** (an in-flight trace appends spans via broadcast, Ch.06).
- **Metric tiles.** Counters move **live** (subscribed island prepends/increments); a small "as of HH:MM" reflects the last rollup; hovering a tile reveals its **registry definition** (formula + grain) — the number explains itself. Drill-down opens the `hq_metrics` series (sparkline, ♻️ the no-dependency `sparklinePoints` SVG approach in `lib/hq/metrics.ts`).
- **Audit explorer.** Filter by actor / target / action / time; each row links to its trace. Read-only, paginated, never editable in the UI (immutability is visible, not just enforced).
- **Keyboard / a11y.** Trace viewer is keyboard-navigable (↑/↓ rows, → expand); severity is conveyed by icon + text, never colour alone (WCAG); tiles announce live updates politely (`aria-live="polite"`).

---

## Permissions

Capabilities via the single `authorize()` chokepoint (Ch.14); the canonical gate is ♻️ `isSuperAdminEmail()` / `requireHqPage()` today, widening to capability RBAC.

| Action | Capability | Who |
|---|---|---|
| View traces / runs | `observability.read` | all super-admins (default) |
| View metric tiles | `metrics.read` | all super-admins (default) |
| Edit a metric **definition** (formula) | `metrics.admin` | senior operators only — it is a "one source" change (ADR) |
| Read audit log | `audit.read` | super-admins; scoped sub-roles later (Ch.14) |
| **Export** audit (compliance) | `audit.export` | senior operators only; the export is itself audited |
| Verify hash chain | `audit.verify` | senior operators / automated verifier job |

**Default policy:** read-broad, mutate-narrow. **Nobody — human or AI — can write or alter `admin_activity_log` through the API**: it is service-role append-only via `recordAdminActivity`, with *no* update/delete path exposed (the immutability guarantee). AI employees may **read** observability (a Finance AI inspecting its own run cost) but never write audit or edit a metric formula.

---

## Failure handling

Each pillar degrades independently; the spine is the recovery anchor (Ch.02).

- **Trace consumer down / lagging.** Traces simply read `hq_events` directly (the consumer only maintains the *recent-traces index*); a missed index entry is backfilled by replay (Ch.04). Worst case: the "recent" list is stale; individual `getTrace(correlationId)` is always live.
- **Telemetry write fails** (`hq_runs`/`cron_runs`): swallowed and logged — **never breaks the business run** (♻️ `withCronTelemetry`'s exact contract). A silent telemetry gap beats a 500.
- **Counter drift / double-count** (at-least-once redelivery, P8): *expected*; the next **rollup reconciles** the tile to the authoritative `hq_metrics` value. Counters are advisory; rollups are truth.
- **Rollup job fails** (a `withRunTelemetry('cron', …)` run): the prior `hq_metrics` rows stand; the cron retries next tick; a failed rollup raises `system.cron_failed` → alert (♻️ the alerts path). Missing a grain is visible (stale "as of"), not silent.
- **Audit write fails:** logged + swallowed (♻️ `recordAdminActivity`) so the primary action still completes — but audit-write failures are themselves a **monitored signal** (a rising audit-error rate is a `critical` alert, because an audit gap is a compliance event).
- **Poison metric** (a formula throws on bad data): the registry isolates it — one metric's rollup failing never blocks the others; the bad metric tile shows "unavailable" and alerts.
- **Dead events** (Ch.04 `dead_events`): `dead_event_count > 0` is a standing alert; the trace of the poison event is preserved for debugging.

---

## Edge cases

- **Trace with no `correlation_id`** (a legacy/backfilled row): backfill assigns a synthetic correlation (Ch.04 backfill); such traces are single-node and labelled "backfilled."
- **Very long trace** (a bulk import emitting thousands of events under one correlation): the viewer paginates the waterfall by `id` window; the summary shows counts, not every leaf.
- **Causation pointing at a pruned partition** (the cause is older than retention): the edge renders as "(beyond retention)" — the chain is intact within the window; cold storage holds the rest (export to inspect).
- **Clock skew** across serverless invocations: ordering is always by `id` (Ch.04), so a span with an earlier `ts` than its parent still renders in causal order.
- **Counter vs rollup disagree at the boundary** (an event lands mid-rollup): the rollup is computed `as_of` a fixed `id` watermark, so the boundary is deterministic and the next rollup absorbs the straggler.
- **Metric formula change** mid-day: old `hq_metrics` rows keep the old definition's value; a backfill recomputes history under the new formula with an ADR — never silently mutating past numbers.
- **Impersonated AI-less action vs AI action**: audit always records the *human* `HqActor` for impersonation; AI runs record the employee slug as actor and the approver as a separate field — the two are never conflated.

---

## Performance

**The Golden Rule answer:** dashboards are O(1) in company count, and AI spend is bounded by construction.

- **Rollups keep dashboards O(1).** The homepage reads a *handful* of latest `hq_metrics` rows (one per tile per grain) — a few indexed lookups regardless of whether there are 200 or 1,000,000 companies. The expensive aggregation lives in background rollup crons, amortised, off the request path (Ch.02 Performance). At 1M companies the tile read is *unchanged*; only the rollup job scans more, and it does so over partitioned, bounded windows.
- **Cost observability bounds AI spend at scale (P9).** `ai_cost_per_employee_day` is a first-class metric: every `ai_employee_run` records `cost_usd`/tokens (§03.3); the rollup aggregates per employee per day; budgets and circuit breakers (Ch.07) read it. Because cost is *measured like latency*, an employee whose unit cost drifts is caught by an SLO breach, not a month-end bill. At 1M companies the marginal AI cost is the existential risk — and it is the most-watched tile.
- **Traces are bounded reads.** `getTrace` is an indexed lookup on `hq_events_corr_idx` (§03.1) — bounded by one intent's event count, not total volume. The recent-traces index reads the hot (current-month) partition only.
- **Consumer lag is cheap and constant** — `max(id) − last_event_id`, two scalar reads. It is the **canary** (Ch.04): a rising lag warns *before* users notice a stale tile.
- **Audit** is append-only with no read-amplification on the hot path; the explorer's filters hit covering indexes (actor/target/time); partitioning keeps the queried window small.

**Budgets:** homepage metric snapshot < 50ms server-side; `getTrace` p95 < 150ms; rollup cron well within its Vercel window; counter bump < 5ms (single upsert).

---

## Security

- **`RLS:hq` everywhere** — every observability/metrics/audit table is service-role-only; no JWT client can read a trace, a metric row, or an audit entry (Ch.03/16).
- **No PII in the spine or metric payloads beyond identifiers** (Ch.04 Security) — traces show *what* happened to *which* entity by id; sensitive detail is fetched from the domain table under service-role only when rendering, never stored in the event/metric/audit `payload`.
- **The audit log is immutable by construction** — append-only, no update/delete grant exposed; optional hash-chaining makes tampering *provable*, not just *prohibited* 🔬.
- **Export is privileged and self-auditing** — `audit.export` is senior-only and every export writes its own audit row (who exported what, when), so the compliance trail includes its own access.
- **The trace viewer is a read of vetted data**, delivered (when live) via server-authorized broadcast, never by exposing `hq_events` to client subscriptions (Ch.04/06/16).
- **Externals receive scrubbed data** — Sentry gets exceptions with identifiers, never PII; any OpenTelemetry export 🔬 carries the same payload policy as the spine.

---

## Testing

- **Trace-reconstruction tests:** given a fixture event chain (the Ch.02 dunning flow), assert `getTrace` yields the exact waterfall tree (causation edges correct, ordered by `id`) — a deterministic oracle (♻️ 007's byte-identical-oracle style).
- **Telemetry-wrapper tests:** assert `withRunTelemetry` writes the run/span rows on success *and* failure, **never swallows the business error**, and never lets a telemetry-write failure break `fn` (♻️ the `withCronTelemetry` contract, generalised).
- **Counter↔rollup reconciliation tests:** deliberately double-count via a redelivered event, run the rollup, assert the tile reconciles to the authoritative `hq_metrics` value (proves drift self-heals, P8).
- **Metric formula tests:** exercise each registry `formula` against synthetic snapshots (♻️ exactly how `__tests__` drive `computeMetrics` today) — one canonical number, pinned.
- **Audit immutability/RLS tests:** assert no anon/JWT client can read `admin_activity_log`; assert no API path updates/deletes it; if enabled, a hash-chain test mutates a row and asserts `verifyAuditChain` localises the break 🔬.
- **Golden-signal tests:** assert `consumer_lag`, `dead_event_count`, `run_error_rate` compute correctly from fixture spines and trip the right severity.
- **CI gates:** the validation triplet (tsc / lint / tests) + Vercel build, exactly as 007 and Ch.02.

---

## Monitoring

This chapter *is* the monitoring chapter, so here it specifies the **golden signals, SLOs, error budgets, and alert routing** the rest of the Bible points to.

**Golden signals (per plane, Ch.02/04) — each a registered system metric:**

| Signal | Definition | SLO (initial) | Severity if breached |
|---|---|---|---|
| Spine throughput | `hq_events`/min | informational baseline | info |
| **Consumer lag** (the canary) | `max(id) − last_event_id` per consumer | < 500 events / < 60s | warn → critical |
| Queue depth | pending `ai_employee_tasks` | < 100 backlog | warn |
| Run error rate | failed `hq_runs` / total, per kind | < 1% | warn → critical |
| Approval latency | `approval.granted.ts − approval.requested.ts` p95 | < 30 min business-hours | warn |
| Broadcast fan-out / reconnect | deltas/s; reconnects/min | reconnect < 5%/min | warn |
| Query p95 | server query time | < 200ms | warn |
| Partition health | next month's `hq_events` partition exists | always ahead | critical |
| **AI cost/employee/day** (P9) | `sum(cost_usd)` per employee per day | per-employee budget (Ch.07/08) | warn → critical |
| Dead-event count | `count(dead_events)` | 0 | critical if > 0 |
| Audit-write error rate | failed `recordAdminActivity` / total | ≈ 0 | critical |

**Error budgets.** Each SLO carries a budget (e.g. consumer lag may exceed its target 0.1% of minutes/month); burning the budget escalates the signal's severity and gates risky changes (P7) until recovered — the SRE discipline applied to an AI-operated company.

**Alert routing (♻️ `hq-alerts-scheduler` + `admin_alert_state`).** Signals raise `system.alert_raised` events (Ch.04) carrying `severity`. Routing reuses the existing path exactly: **`critical` → emit an HQ notification** (♻️ `maybeEmitForAlert` only notifies on `critical` to keep volume sane); **`warning`/`info` → surface on the dashboard, no ping**. `admin_alert_state` provides notified/snoozed/resolved lifecycle so an operator isn't paged twice for the same condition. Severity vocabulary is the canon `critical`/`warning`/`info` (♻️ `ALERT_RULE_SEVERITY`), aligned with the spine's `severity` field.

**Externals (pragmatic, P6 — buy infrastructure noise, build the narrative):**
- **Vercel logs & analytics** — request-level logs, function durations, Web Vitals for the presentation plane; the OS does not reinvent these.
- **Sentry** — exception capture and grouping for unhandled errors (the *unexpected*); the spine handles the *expected* narrative. Sentry issues link back to a `correlation_id` so an exception jumps straight to its trace.
- **OpenTelemetry export** 🔬 — an optional adapter emitting `hq_runs`/`hq_spans` as OTLP spans to an external collector (Honeycomb/Grafana Tempo) *if and when* a measured need arises (Ch.17 graduation). The internal trace viewer is the day-one tool; OTel is the seam, not the default — open question in Ch.20.

---

## Future expansion

- **Anomaly detection on metrics** — once `hq_metrics` has history, a baseline-deviation detector raises `system.alert_raised` automatically (the registry + rollups are the substrate; no schema change).
- **SOC2 trajectory** — the immutable audit + optional hash chain + privileged self-auditing export are deliberately the controls an auditor asks for; enabling the chain and a scheduled `verifyAuditChain` job is the next step on that path 🔬 (Ch.20).
- **Per-role observability visibility** — when sub-admin roles arrive (Ch.14), the spine's `visibility` field and `audit.read` scoping let a role see only its slice of traces/audit — the seam exists, unused, today.
- **Graduate the trace store** — if Postgres trace reads outgrow comfort (Ch.17 trigger), the OTel export becomes the primary trace backend behind the same `getTrace`/viewer API (P6) — the contract is stable, only the transport changes (mirroring Ch.04's broker-graduation promise).
- **Cost forecasting** — `ai_cost_per_employee_day` history feeds a projected-spend metric so budgets (Ch.07) are set from evidence, closing the P9 loop from *measure* → *bound* → *predict*.
