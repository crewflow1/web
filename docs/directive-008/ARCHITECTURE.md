# CrewFlow Operating System — Architectural Blueprint

**CEO Directive #008 · Technical Blueprint · Planning Artifact (no implementation)**

| | |
|---|---|
| **Status** | Proposal — awaiting CEO approval. No production code. |
| **Prerequisite** | Directive 007 (Design System) merged + production-verified. |
| **Author** | HQ Engineering |
| **Scope** | The super-admin HQ (`/admin`) only. Tenant product untouched except via read aggregation. |
| **Golden Rule** | *Every decision is tested against one question: "Does this make CrewFlow feel more like an operating system than a collection of software pages?"* |

---

## 0. How to read this document

This is a blueprint, not a backlog. It describes **architecture** — the boundaries, the data, the control flow, the failure modes — at the level of detail an engineer needs to start building, and at the level of clarity the CEO needs to approve direction. Every table sketch, every component, every phase is **additive and reversible**: nothing here removes a working surface, breaks tenant isolation, or requires a "big bang" cutover.

The design is deliberately **Postgres-first**. CrewFlow already runs a sophisticated Supabase/Postgres + Vercel stack with disciplined patterns (RLS, triggers, transactional outbox-style fan-out, service-role aggregators, cron telemetry). We extend those patterns rather than import a new infrastructure zoo. Where a heavier technology (a dedicated broker, a search engine, a vector store) earns its place at scale, we name the **measured threshold** that triggers the graduation — never speculative complexity.

A through-line from Directive 007 carries forward: **one source of truth, forever.** 007 gave us one source for colour. #008 gives us one source for *events*, one source for *metrics*, one source for *memory*, one source for *permission*. The OS is what you get when every fact in the company has exactly one home and one timeline.

---

## 1. Vision & operating principles

Today the HQ is 24 excellent pages. Each answers a question ("what's our MRR?", "what is Sales AI doing?", "which orgs are unhealthy?") by querying the database at request time and rendering a snapshot. It is a *collection of software pages*: correct, fast, beautiful — and inert. You look at it; it does not look back.

The CrewFlow Operating System is the same data, reorganised around three ideas:

1. **Everything that happens is an event on one spine.** A trial starts, an invoice fails, an AI employee drafts an email, a human approves a refund — all of it lands in a single append-only event log. Every page becomes a *view* over that spine. The company has one heartbeat, and you can watch it.

2. **AI employees are first-class processes, not data rows.** Each of the 12 employees has a lifecycle (idle → triggered → planning → awaiting-approval → executing → reflecting), a budget, a permission set, a memory, and an audit trail. The OS *runs* them the way a kernel runs processes — scheduling them, gating their side-effects, accounting their cost, and recording everything.

3. **Humans are always in the loop, by construction.** Every consequential AI action passes through an approval the way a syscall passes through the protection ring. Oversight is not a feature bolted on; it is the execution model.

### Operating principles

- **Additive, never destructive.** New tables, new services, new islands. Existing pages keep working on day one and get *upgraded* to live, not *replaced*.
- **One source per fact.** One event spine, one metric registry, one memory graph, one permission chokepoint. No parallel truths.
- **Observable by construction.** If it isn't an event with a correlation id, it didn't happen. Tracing, audit, and metrics fall out of the event model for free.
- **Least privilege, dual-control for danger.** Both humans and AIs hold scoped capabilities; high-risk actions require a second decision.
- **Postgres until measured otherwise.** Graduate infrastructure on evidence, not anticipation.
- **Preview-first, CEO-gated, reversible.** Every phase ships behind a flag, to preview first, with a written backout. Exactly the discipline that made 007 a clean release.

---

## 2. Overall architecture

The OS is four planes over one spine. The spine is the event log; the planes are data, execution, control, and presentation.

```
                          ┌─────────────────────────────────────────────┐
                          │             PRESENTATION PLANE               │
                          │  Mission Control · Workforce · Timeline ·    │
                          │  Approvals Inbox · Global Search (⌘K) ·      │
                          │  Memory Graph explorer · Observability       │
                          │  (Next.js RSC snapshot  +  realtime islands) │
                          └───────────────▲──────────────▲──────────────┘
                                          │ snapshot      │ live deltas
                                          │ (service-role)│ (server broadcast)
        ┌─────────────────────────────────┴──────┐  ┌─────┴───────────────────────┐
        │           CONTROL PLANE                 │  │     REAL-TIME INFRA          │
        │  Permissions / capability authorize()   │  │  Supabase Realtime           │
        │  Approval policy engine + inbox         │  │  (server-authorized          │
        │  Human oversight & impersonation        │  │   broadcast channels)        │
        └─────────────────▲───────────────────────┘  └──────────────▲──────────────┘
                          │ gate                                       │ publish
        ┌─────────────────┴───────────────────────────────────────────┴──────────┐
        │                          EXECUTION PLANE                                  │
        │  AI Employee Runtime (perceive → plan → gate → act → record → reflect)    │
        │  Tool registry · cost/budget · workers (cron-drained queue)               │
        │  [generalised from the proven Research AI executor]                       │
        └─────────────────────────────────▲────────────────────────────────────────┘
                                          │ append (transactional outbox)
        ┌─────────────────────────────────┴────────────────────────────────────────┐
        │                              THE SPINE                                     │
        │   hq_events  (append-only, partitioned, correlation/causation chained)     │
        │   + pg_notify wakeups  + Realtime publication                              │
        └─────────────────────────────────▲────────────────────────────────────────┘
                                          │ projections / read-models
        ┌─────────────────────────────────┴────────────────────────────────────────┐
        │                              DATA PLANE                                    │
        │  System of record: Supabase Postgres (existing tenant + HQ tables)         │
        │  Read-models: hq_metrics · hq_search_index · timeline projections          │
        │  Memory graph: hq_memories + edges + pgvector embeddings                    │
        │  Service-role aggregator layer (server/services/*  +  lib/hq/*)            │
        └────────────────────────────────────────────────────────────────────────────┘
```

### The kernel metaphor, made literal

| OS concept | CrewFlow OS realisation | Reuses today |
|---|---|---|
| Kernel log | `hq_events` append-only spine | new (greenfield) |
| Processes | AI employees with a lifecycle FSM | `lib/ai-employees/framework` SDK |
| Scheduler | event/cron/manual/delegation triggers | Vercel Cron + `withCronTelemetry` |
| Syscall + protection ring | tool calls gated by `authorize()` + approvals | extends `server/auth/hq.ts` |
| Shared memory | the memory graph (`hq_memories` + edges + vectors) | `hq-memory.ts` engine (26KB) |
| System monitor | observability + metrics dashboards | `cron_runs`, `deriveHealth()` |
| Shell / desktop | Mission Control homepage | generalise `hq-executive.ts` |
| Audit subsystem | `admin_activity_log` (append-only, actor-stamped) | already canonical |

**The single most important architectural decision in this document:** introduce the event spine *first*, and make every other capability a consumer or projection of it. Mission Control, the timeline, search, metrics, observability, and the AI runtime are all — at their core — different reads and writes of the same log. Build the log right and the rest becomes composition.

---

## 3. System boundaries

Boundaries are where security and clarity live. Five of them matter.

1. **HQ ↔ Tenant.** The OS is super-admin-only. It reads tenant data exclusively through the **service-role aggregator layer** (`server/services/*`, all `import "server-only"`, using `createAdminClient()`), never by relaxing tenant RLS. No HQ surface, event, or search result is ever reachable by a JWT (customer) client. This boundary already exists and is load-bearing; #008 does not move it.

2. **JWT client ↔ Service role.** Every HQ table follows the established **RLS-enabled / zero-policy** pattern: deny-all to JWT clients, readable only by the service-role admin client on the server. All new #008 tables inherit this posture verbatim. The service-role key never reaches the browser.

3. **Deterministic infra ↔ AI execution.** The spine, projections, search, metrics, and timeline are deterministic, idempotent, replayable. AI execution is non-deterministic and side-effectful. The boundary between them is the **approval/permission gate**: AI plans on one side, the world changes only after crossing the gate. This keeps the system reasoning-about-able even though parts of it are an LLM.

4. **Foundation ↔ Live employees.** The SDK already encodes this: an employee is `foundation: true` until `permissions.can_execute`. Today only **Research AI** is live; the other 11 render honest baselines. #008 keeps this gate and turns employees live **one at a time**, lowest-risk first, each behind its own flag and approval policy.

5. **Internal ↔ External.** External dependencies are explicit and few: Anthropic (primary LLM) → OpenAI (fallback) — both already wired in `research-llm.ts`; Stripe (inbound webhook → `billing_events`); an email provider (currently a *stub* outbox — `notification_email_queue` — that nothing drains). Each external edge is a trust boundary with its own credentials, rate limits, and failure handling.

**Explicit non-goals for #008** (named so scope cannot creep): no customer-facing changes; no new tenant tables; no multi-region/multi-cloud; no replacing Supabase/Vercel; no autonomous AI action without a human-approval path; no removal of the existing audit logs or pages.

---

## 4. Database changes

All changes are **additive, forward-only migrations** following the existing discipline (numbered timestamp files under `supabase/migrations/`, currently 88 of them). Every new HQ table is **RLS-enabled, zero-policy** (service-role-only). No tenant table is altered. Read-models are derived and rebuildable, so they carry no irreplaceable state.

### 4.1 The spine

```sql
-- The one event log. Append-only. Partitioned by month for retention/scale.
create table hq_events (
  id            bigint generated always as identity,
  ts            timestamptz not null default now(),
  -- who acted
  actor_type    text not null,        -- 'human' | 'ai_employee' | 'system' | 'tenant'
  actor_id      text,                 -- HqActor.id, ai_employees.slug, cron name, org id
  -- what they did
  verb          text not null,        -- 'org.trial_started', 'invoice.payment_failed',
                                       -- 'ai.task_planned', 'approval.granted' (see Appendix A)
  -- the primary object
  object_type   text not null,        -- 'organization' | 'customer' | 'ai_employee' | ...
  object_id     text not null,
  -- optional secondary target
  target_type   text,
  target_id     text,
  -- causality (trace the whole chain)
  correlation_id uuid not null,       -- the trace: one human/AI intent end-to-end
  causation_id   bigint,              -- the event that directly caused this one
  -- payload + visibility
  severity      text not null default 'info',  -- 'info'|'success'|'warn'|'critical'
  payload       jsonb not null default '{}',
  visibility    text not null default 'hq',    -- room to scope per-role later
  primary key (id, ts)
) partition by range (ts);
-- monthly partitions created ahead by a cron job; old partitions detached to cold storage.

create index on hq_events (object_type, object_id, ts desc);
create index on hq_events (actor_type, actor_id, ts desc);
create index on hq_events (correlation_id);
create index on hq_events (verb, ts desc);
```

The spine is written via a **transactional outbox**: a state mutation and its event are inserted in the *same* Postgres transaction, so an event can never be lost or invented relative to the state it describes. A `pg_notify('hq_events', …)` fires on insert for low-latency consumer wakeups; the Realtime publication (§6) carries it to the UI.

### 4.2 Consumers & queue

```sql
-- Durable consumer offsets so workers resume exactly where they left off.
create table hq_event_consumers (
  consumer      text primary key,     -- 'timeline_projection', 'metrics_rollup', ...
  last_event_id bigint not null default 0,
  updated_at    timestamptz not null default now()
);
```

For work that must be *retried* (AI tasks, email sends), we use a real queue. Phase 1 uses a Postgres-backed queue (extend the existing `ai_employee_tasks` into a proper state machine; adopt **`pgmq`** when throughput warrants — see §17 graduation triggers).

### 4.3 AI runtime tables

```sql
-- One row per execution attempt of a task (cost/latency/model accounting).
create table ai_employee_runs (
  id            uuid primary key default gen_random_uuid(),
  employee_slug text not null references ai_employees(slug),
  task_id       uuid references ai_employee_tasks(id),
  trigger       text not null,        -- 'schedule'|'event'|'manual'|'delegation'
  state         text not null,        -- FSM state (see §7)
  model         text, input_tokens int, output_tokens int,
  cost_usd      numeric(12,6),
  latency_ms    int,
  correlation_id uuid not null,
  started_at timestamptz, finished_at timestamptz,
  error         text
);

-- Every tool invocation, logged (the AI "syscall" record).
create table ai_employee_tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ai_employee_runs(id),
  tool   text not null,               -- 'email.draft', 'customer.read', ...
  args   jsonb, result_summary text,
  required_capability text,           -- checked at the gate
  approval_id uuid,                    -- set if it needed human approval
  ts timestamptz not null default now()
);

create table ai_employee_schedules (
  employee_slug text not null references ai_employees(slug),
  cron text not null, enabled boolean default true, ...
);
```

`ai_employee_tasks` and `ai_employee_memory` already exist; we extend tasks with an explicit `state` machine and budget fields rather than replacing them.

### 4.4 Control plane tables

```sql
-- Human approvals for AI side-effects.
create table hq_approvals (
  id uuid primary key default gen_random_uuid(),
  requested_by_employee text references ai_employees(slug),
  run_id        uuid references ai_employee_runs(id),
  capability    text not null,        -- the action requiring approval
  risk_tier     text not null,        -- 'low'|'medium'|'high'|'critical'
  payload       jsonb not null,       -- exactly what will execute, human-readable
  projected_effect text,              -- "Refund £240 to Acme Ltd"
  status        text not null default 'pending', -- pending|approved|rejected|expired
  decided_by    text,                 -- HqActor.id
  decided_at    timestamptz, reason text, expires_at timestamptz,
  created_at    timestamptz not null default now()
);

create table hq_approval_policies (
  id uuid primary key default gen_random_uuid(),
  employee_slug text, capability text, risk_tier text,
  decision text not null,             -- 'auto'|'require_human'|'dual_control'
  monetary_threshold numeric,         -- e.g. auto under £50, human above
  enabled boolean default true
);
```

### 4.5 Permissions / RBAC tables

```sql
create table hq_capabilities (        -- the fine-grained verbs (seeded catalogue)
  key text primary key,               -- 'billing.refund','org.suspend','email.send',...
  description text, danger boolean default false
);
create table hq_roles (               -- bundles of capabilities
  key text primary key, name text, description text
);
create table hq_role_capabilities ( role_key text, capability_key text, primary key (role_key, capability_key) );
create table hq_principal_roles (     -- grants to humans AND ai employees
  principal_type text not null,       -- 'human'|'ai_employee'
  principal_id   text not null,       -- HqActor.id or employee slug
  role_key text not null,
  granted_by text, granted_at timestamptz default now(), expires_at timestamptz
);
```

### 4.6 Read-models & memory

```sql
-- Cross-entity search index, maintained additively by triggers/outbox.
create table hq_search_index (
  entity_type text not null, entity_id text not null,
  title text not null, subtitle text, body text, url text,
  search_tsv tsvector,                -- weighted FTS (existing pattern)
  updated_at timestamptz not null default now(),
  primary key (entity_type, entity_id)
);
create index on hq_search_index using gin (search_tsv);
create index on hq_search_index using gin (title gin_trgm_ops);  -- needs pg_trgm

-- Time-series metric rollups (one source per metric — see §14).
create table hq_metrics (
  metric text not null, ts timestamptz not null,
  grain text not null,                -- 'minute'|'hour'|'day'
  value numeric not null, dims jsonb default '{}',
  primary key (metric, grain, ts, dims)
);

-- Memory graph: the engine + relationship tables already exist. Add the semantic layer.
create extension if not exists vector;          -- pgvector (greenfield)
create extension if not exists pg_trgm;         -- fuzzy search (greenfield)
alter table hq_memories add column embedding vector(1536);  -- replaces embedding_placeholder
create index on hq_memories using hnsw (embedding vector_cosine_ops);

create table hq_memory_edges (        -- formalised typed graph edges
  id uuid primary key default gen_random_uuid(),
  subject_memory uuid references hq_memories(id),
  predicate text not null,            -- 'relates_to'|'caused_by'|'about_entity'|...
  object_memory uuid references hq_memories(id),
  object_entity_type text, object_entity_id text,  -- edges can point at entities too
  weight real default 1.0, confidence real default 1.0,
  provenance jsonb                    -- which run/event asserted this
);
```

**Migration safety:** every change above is `create`/`add column` (additive); `embedding` backfills lazily; partitions are created ahead of time; read-models are rebuildable from source + the spine. There are **no destructive operations, no column drops, no data rewrites.**

---

## 5. Event bus

The event bus is the spine plus its delivery mechanics. The design goal: **guaranteed, ordered-per-aggregate, at-least-once delivery with idempotent consumers**, on infrastructure we already operate.

### Write path — transactional outbox

A producer never writes an event "best effort." It writes the state change and the event in the **same transaction**:

```
BEGIN;
  UPDATE organizations SET status='trialing' WHERE id=$1;
  INSERT INTO hq_events (verb, object_type, object_id, correlation_id, …)
    VALUES ('org.trial_started', 'organization', $1, $corr, …);
COMMIT;   -- both or neither
```

This is the single most important reliability property of the bus: **state and its narrative can never diverge.** The codebase already uses trigger-based fan-out (`_record_activity()`, `notify_*`) — we generalise that into the outbox so producers don't even have to remember: AFTER triggers on key tables emit canonical events.

### Delivery — three consumer styles

1. **Realtime UI** (latency-critical, lossy-tolerant): Supabase Realtime publication on `hq_events` → server-authorized broadcast to subscribed islands (§6). If a client misses a beat it re-snapshots; no correctness risk.
2. **Projection workers** (must be exact): read by `last_event_id` offset from `hq_event_consumers`, process in order, advance the offset transactionally. Idempotent (keyed by event id), so re-runs are safe. Driven by `pg_notify` wakeups with a cron drainer as the dead-worker safety net — *exactly the pattern Research AI already uses* (`research-drain`).
3. **Retryable work** (AI tasks, emails): a real queue with visibility timeout, retries, and a dead-letter table.

### Event taxonomy

A controlled vocabulary of `verb`s (Appendix A) keyed `domain.action` — `org.trial_started`, `invoice.payment_failed`, `ai.run_started`, `ai.tool_called`, `approval.requested`, `approval.granted`, `memory.asserted`. Producers may only emit registered verbs (a lint-style guard, in the spirit of 007's design-rule enforcement). One vocabulary, enforced, forever.

### Why Postgres-first, and when to graduate

At CrewFlow's current volume, Postgres *is* the right bus: it gives ACID outbox writes, ordering, durable offsets, and `LISTEN/NOTIFY` for free, with zero new infrastructure to operate or secure. We graduate **only on measured pressure** (§17): adopt **`pgmq`** when retryable-queue depth/throughput strains plain tables; consider Redis Streams / NATS / Kafka only if sustained event rate exceeds what a partitioned Postgres comfortably serves. We will not pay Kafka's operational tax before the numbers demand it.

---

## 6. Real-time infrastructure

Real-time UX is **entirely greenfield** — today every page is `force-dynamic` SSR with cosmetic motion (the Command Centre `LiveDot` is a CSS ping, `ExecCounter` a count-up; neither reflects a live feed). #008 makes the OS actually live.

### The hybrid model: RSC snapshot + realtime island

We keep what's excellent about the current architecture (fast server-rendered first paint from the service-role aggregator) and add liveness as a thin layer:

```
RSC page  ──renders──▶  initial snapshot (service-role, server-only)
   │
   └─ embeds ─▶  <LiveRegion>  ("use client" island)
                      │ subscribes on mount
                      ▼
                 server-authorized Realtime channel  ──deltas──▶  prepend/patch in place
```

The server renders the truth as-of-now; the island keeps it current. No more full reloads to feel alive; no loss of the SSR performance story.

### Security: broadcast from a trusted server, do **not** loosen RLS

This is the subtle part. HQ tables are service-role-only (no JWT policies) — by design, a customer's browser must never subscribe to `hq_events` directly. So we do **not** expose HQ tables to Realtime's `postgres_changes` (which would require JWT-readable RLS). Instead:

- A server process (the projection worker) consumes the spine with the service role, **authorizes** each event for the HQ audience, and **broadcasts** it on a Realtime *Broadcast* channel that only authenticated super-admins can join.
- Channel authorization reuses `requireHqPage()`/`isSuperAdminEmail()` — the same single gate that protects every HQ page.

This keeps the sensitive log server-side and ships only vetted, HQ-scoped deltas to vetted clients. Presence (which humans/AIs are active) rides the same Realtime presence primitive.

### Resilience

Islands reconnect with backoff; on reconnect they re-fetch a fresh snapshot then resume deltas (no gap). If Realtime is unavailable, islands fall back to a slow poll. Fan-out is bounded per channel; high-cardinality entity channels are created on demand and torn down on unsubscribe.

---

## 7. AI employee lifecycle

The framework SDK (`lib/ai-employees/framework`) already models an employee as **config, not code**: six dimensions (Identity, Configuration, Runtime, Memory, Performance, Audit), a `defineEmployee()` factory, a frozen registry of 11 definitions, and the `foundation: true` gate until `permissions.can_execute`. **Research AI is the one live executor** (`hq-research.ts` + `research-llm.ts`, Anthropic→OpenAI, queue + browser-kick + `research-drain` cron). #008 *generalises that proven executor into a uniform runtime* every employee can use.

### The lifecycle state machine

```
  Provisioned → Configured → Idle
                               │  trigger (schedule | event | manual | delegation)
                               ▼
                           Triggered → Planning ──(LLM)──▶ proposes actions
                               │                               │
                               │                       gate: authorize(capability)
                               │                               │
                               │                    ┌──────────┴───────────┐
                               │              auto-approved          requires human
                               │                    │                      │
                               │                    ▼                AwaitingApproval
                               │                Executing  ◀── approved ────┤
                               │                    │            rejected → Idle (recorded)
                               │                    ▼
                               │                Reflecting (write memory, emit events)
                               └────────────────────┴──▶ Idle
   (Suspended / Retired are terminal-ish administrative states)
```

### The execution loop (one run)

1. **Perceive** — load task context + relevant memory (graph query, §11) + recent events for the object.
2. **Plan** — call the model (tiered: cheap model for routine, stronger for hard — §17), producing a structured proposal of tool calls, not free text.
3. **Gate** — for each proposed tool, `authorize(employee, capability, resource)`; if the approval policy says `require_human`/`dual_control`, create an `hq_approvals` row and park in `AwaitingApproval`.
4. **Act** — execute approved tools through the typed **tool registry**; each call is logged (`ai_employee_tool_calls`) and emits events.
5. **Record** — write the `ai_employee_runs` row (model, tokens, cost, latency), emit `ai.run_*` events, stamp `admin_activity_log`.
6. **Reflect** — write episodic + semantic memory (what happened, what was learned), update KPIs.

### Tools as capabilities

A tool is a typed function with a declared `required_capability` and a side-effect classification. Read tools (`customer.read`) are low-risk; write tools (`email.send`, `billing.refund`, `org.suspend`) are gated. The registry is the AI's syscall table; `authorize()` is the protection ring. This is what makes an LLM safe to employ: it can *propose* anything but can only *do* what its capabilities and the approval policy permit.

### Cost, budget, safety

Every run accounts tokens and cost; each employee has a budget with a circuit breaker (auto-suspend on overrun). Runs are idempotent and retryable with dead-lettering. The `foundation` gate stays: an employee goes live only when (a) its `permissions.can_execute` is set, (b) an approval policy exists, and (c) its flag is enabled — turned on **one employee at a time**, lowest-risk first (extend Research AI's pattern to, say, Documentation AI, then Support AI drafts-only, etc.).

---

## 8. Command Centre architecture (Mission Control)

Mission Control is the OS desktop — the `/admin` landing surface, generalised from today's `hq-executive.ts` Command Centre. It must render fast, then come alive.

### Composition (zones)

- **Vitals header** — ARR/MRR, active orgs, trials, churn, conversion — live counters.
- **AI Workforce strip** — every employee as a live tile: status, current task, workload, today's cost, health (`deriveHealth()` already exists).
- **The Pulse** — the global event timeline (§10), live-prepending.
- **Approvals inbox** — pending `hq_approvals`, newest first, one-click decide.
- **Health & alerts** — unhealthy orgs, failing payments, system alerts (reuse `hq-alerts`/`hq-health`).
- **Command bar** — global search / ⌘K (§9).

### Data strategy: precomputed read-models, not request-time scans

The current Command Centre aggregates with a parallel batch of bounded/COUNT queries — excellent, but it scans on every load. At OS scale the homepage must be **O(1)**: it reads precomputed `hq_metrics` rollups (refreshed by cron + invalidated by events) and a small recent-events slice, then subscribes for deltas. The heavy aggregation moves off the request path into rollup jobs. First paint is a cheap snapshot; liveness is a subscription. The streaming-skeleton pattern already in `command-centre/page.tsx` carries over.

### The OS test

Mission Control passes the Golden Rule when an operator can sit on it all day: it *changes under you* as the company runs, it *asks you* for decisions (approvals), and every number is a doorway (click MRR → drill to the events that moved it). Not a dashboard you check — a control room you inhabit.

---

## 9. Global search architecture

Cross-entity search is **greenfield** (FTS exists only on `hq_memories` and `hq_sales_*`; there is no global search). The OS needs one box that finds an org, a customer, an invoice, an employee, a memory, or an event — instantly, fuzzily, ranked.

### Approach: a denormalized HQ search index

`hq_search_index` (§4.6) holds one row per searchable entity — `{entity_type, entity_id, title, subtitle, body, url, search_tsv}` — maintained **additively** by triggers/outbox from source tables, so we never touch tenant RLS or source schemas. We combine:

- **`tsvector`** weighted FTS (the proven `hq_memories` pattern) for ranked relevance, and
- **`pg_trgm`** trigram indexes for typo-tolerant fuzzy matching (greenfield extension).

A single `searchHq(query, scopes)` service ranks across types and returns typed results with deep links. The UI is a keyboard-first **command palette (⌘K)** — also an *action* launcher (search verbs: "suspend org…", "approve…"), so search becomes the OS's universal entry point, not just a finder.

### Semantic option & scale path

For "find related / find similar" we reuse the memory graph's pgvector embeddings (§11) — hybrid keyword+vector ranking. Postgres FTS+trigram serves us well into the hundreds of thousands of entities; if latency or relevance demands more we graduate to **Typesense/Meilisearch** behind the same `searchHq` abstraction (the service boundary makes the backend swappable). We will not stand up Elasticsearch on day one.

---

## 10. Event timeline architecture

The timeline is the spine made visible: **one global, append-only feed**, with every entity getting a filtered slice of the *same* log. No second source.

### Unify the existing logs — additively

Three audit/event stores exist today: `activity_log` (per-tenant, trigger-written, RLS-scoped), `admin_activity_log` (cross-tenant HQ, service-role), and `hq_memory_events` (per-memory). #008 **ingests** these into the spine via adapters + a one-time backfill — *without removing the originals* (they remain their domains' systems of record). The spine becomes the unifying read layer; the sources stay intact and authoritative. This is the same "one source for the *view*, sources stay put" discipline that lets us upgrade without risk.

### Reads

- **Global feed** — `hq_events ORDER BY ts DESC`, cursor-paginated, virtualized infinite scroll, live-prepend via Realtime.
- **Per-entity feed** — filter by `(object_type, object_id)` *or* `(target_type, target_id)` so an org's timeline includes both "things it did" and "things done to it."
- **Per-employee feed** — `actor_type='ai_employee' AND actor_id=slug`: the employee's complete activity history, which doubles as its episodic memory and its audit trail.

Filtering by `verb`/`severity`/`actor`, grouping by `correlation_id` (see a whole intent as one expandable thread), and month-partition retention all fall out of the schema. The timeline is where "operating system, not pages" becomes *felt*: one place where the entire company's activity streams by, and any noun you click pivots the same stream to its story.

---

## 11. Memory graph architecture

The Shared Memory engine is the most-built foundation we have: `hq_memories` with a generated weighted `search_tsv`, plus `hq_memory_types`, `_sources`, `_relationships`, `_employee_links`, `_access_grants`, `_events`, `_versions`, and a 26KB `hq-memory.ts` service (search, versioning, events, grants). Crucially, `embedding_placeholder jsonb` is reserved-but-empty — **the semantic layer is the named greenfield.**

### Three memory types, one graph

- **Episodic** — *what happened*: the event spine itself, sliced per entity/employee. Already covered by §10.
- **Semantic** — *what is known*: `hq_memories` facts, now with real **pgvector** embeddings (§4.6) for similarity, plus typed `hq_memory_edges` forming the graph (fact → predicate → fact/entity, with weight, confidence, provenance).
- **Procedural** — *how to act*: employee configuration + learned playbooks stored as memories linked to an employee.

### Capabilities this unlocks

- **Hybrid recall** — FTS + vector similarity to answer "what does the OS know about Acme Ltd?" by traversing edges (recursive CTEs) from the entity node out through related facts, scored by weight×confidence.
- **Provenance & trust** — every memory and edge records which run/event asserted it; confidence decays over time; conflicting facts are versioned (the `_versions` table exists), not silently overwritten.
- **Scoped access** — `hq_memory_access_grants` (exists) governs which employee/role may read each memory — least privilege for knowledge.

### Write path

The AI **Reflect** step (§7) and spine ingestion both write memory; a dedup/merge pass keeps the graph clean. This is how the company *accumulates intelligence*: every run leaves the OS knowing slightly more, with a citation for each thing it believes.

---

## 12. Approval workflow

Human-in-the-loop is the default execution mode (the SDK already ships `requires_approval=true`). The workflow turns that default into infrastructure.

### Flow

```
AI run proposes a side-effect tool
        │
   policy engine (hq_approval_policies): auto | require_human | dual_control
        │                                   │
     auto ─▶ execute                  create hq_approvals (risk, payload, projected_effect)
                                            │  emit approval.requested  ▶ Approvals Inbox + Realtime
                                            ▼
                                   human decides (approve/reject/edit)
                                            │  emit approval.granted|rejected
                                  approved ─▶ run resumes → Executing
                                  rejected ─▶ run ends, recorded, employee may re-plan
```

### Policy engine

`hq_approval_policies` decides by employee × capability × risk tier × monetary threshold: e.g. *Finance AI may auto-issue refunds under £50, requires a human £50–£500, requires dual-control above.* Defaults are conservative (everything consequential → `require_human`) and loosen only as trust is earned and measured.

### Guarantees

No high-risk AI action ever executes without a recorded human decision; the `hq_approvals` row captures *exactly* what will run (payload) and *what it means* (projected effect) so the human approves substance, not a black box; every decision is an event + an audit record; SLA timers and escalation prevent silent stalls. The Approvals Inbox is a primary Mission Control zone — oversight is front-and-centre, mobile-friendly, one-click.

---

## 13. Observability

Observability is not bolted on; it **falls out of the event model**. Every intent carries a `correlation_id`; every step links via `causation_id`. That *is* a distributed trace.

- **Tracing** — reconstruct any chain (human click → AI plan → tool calls → state changes → events) by `correlation_id`; render it as a trace/waterfall in an HQ observability page.
- **Structured logs** — generalise the existing `withCronTelemetry`/`cron_runs` and `automation_runs` into an `hq_runs`/`hq_spans` model covering AI runs, cron, webhooks, and projections uniformly.
- **Health** — per-employee health already computed via `deriveHealth()`; extend to per-subsystem health (bus lag, queue depth, projection freshness, error rates) with explicit SLOs.
- **External** — Vercel logs/analytics for the edge; **Sentry** for exceptions; optional OpenTelemetry export if/when we want an external APM. Pragmatic, not maximalist.
- **Dashboards** — an internal observability surface: LLM latency & spend, queue depth, event lag, error budgets — the system watching itself.

---

## 14. Metrics

One source per metric — the 007 ethos applied to numbers. Two classes:

- **Business metrics** — ARR, MRR, active orgs, trials, churn, conversion, pipeline. The definitions already live in `lib/hq/metrics.ts` + the snapshot services; we promote them into a **metric registry** (each metric = one canonical formula, documented, single-sourced) feeding `hq_metrics` rollups.
- **System metrics** — task throughput, approval latency, AI cost per employee/day, run error rate, queue depth, event lag.

### Real-time + accurate

Event-driven **counters** update tiles instantly (increment on `org.trial_started`); periodic **rollup jobs** (Vercel cron) recompute authoritative values and reconcile any counter drift. So Mission Control is both live *and* eventually exact. The registry prevents "the dashboard says X, the report says Y" — every surface that shows MRR reads the same definition, the same way 007 made every status pill read the same token.

---

## 15. Audit

Audit is a first-class subsystem, and the spine makes it nearly free.

- **Canonical store** — `admin_activity_log` stays the immutable HQ audit: append-only, service-role-only, actor-stamped via `HqActor = {id,email}` (already the established pattern). Every event also lands here in audit form.
- **Coverage** — every state mutation, every AI tool call, every approval decision, every permission grant, every impersonation (already audited via `impersonation_sessions`). If it changed the world, there is a row naming who, what, when, and why.
- **Tamper-evidence** — optional hash-chaining (each audit row stores a hash of the previous) gives append-only *and* verifiable-integrity for high-assurance review.
- **Retention & export** — month-partitioned with a documented retention policy (we already ship `docs/activity-log-retention.md`); compliance-ready export.

Audit + permissions + access control on this footing put CrewFlow on a credible **SOC2 trajectory** without a rewrite.

---

## 16. Permissions

Today: a single binary super-admin gate (`CREWFLOW_SUPERADMIN_EMAILS` → `isSuperAdminEmail()` → `requireHq()`/`requireHqPage()`). It's clean and load-bearing — and the foundation to build real RBAC on, for **both humans and AIs**.

### Capability model

- **`hq_capabilities`** — fine-grained verbs (`billing.refund`, `org.suspend`, `email.send`, `customer.read`, `ai.configure`), each flagged `danger` where dual-control applies.
- **`hq_roles`** — bundles (Owner, Operator, Auditor, Viewer for humans; per-employee scoped sets for AIs).
- **`hq_principal_roles`** — grants to humans *and* AI employees, with expiry.

The per-employee `permissions` jsonb on `ai_employees` (today: config metadata, *not enforced*) becomes **enforced** at the runtime gate.

### One chokepoint

A single `authorize(actor, capability, resource)` function in `server/auth` is the *only* place permission is decided — extending `requireHq()`. Both human server actions and the AI execution gate (§7 step 3) call it. One source for permission, forever. Backwards-compatible: super-admins implicitly hold all capabilities at first; we tighten toward least-privilege over time without ever locking ourselves out.

---

## 17. Scalability

Scale on evidence. The architecture is built to grow gracefully and to tell us *when* to graduate.

- **Data** — `hq_events`/timeline partitioned by month; hot partitions indexed, cold partitions detached to archival storage. Read-models (`hq_metrics`, `hq_search_index`, projections) mean reads never scan the raw log. Memory graph uses HNSW vector indexes.
- **Compute** — serverless workers scale horizontally; queue-based load-levelling smooths bursts; per-employee concurrency caps + global rate limits; backpressure via visibility timeouts.
- **LLM** — the dominant cost. Controls: token budgets per employee, **model tiering** (haiku for routine, sonnet/opus for hard reasoning), prompt/result caching, batching, and the existing Anthropic→OpenAI fallback. Cost is a first-class metric with circuit breakers.
- **Realtime** — server-broadcast (not per-client DB subscriptions) bounds fan-out; channels created on demand.

### Explicit graduation triggers (measured, not speculative)

| Symptom (measured) | Graduate to |
|---|---|
| Retryable-queue contention / throughput on plain tables | **`pgmq`** Postgres queue, then Redis Streams |
| Sustained event rate beyond partitioned-Postgres comfort | dedicated broker (NATS / Kafka) |
| Search latency/relevance ceiling at scale | Typesense / Meilisearch behind `searchHq()` |
| Rollup jobs straining the primary | read replica / dedicated analytics path |
| Vector recall latency | tune HNSW → dedicated vector store only if forced |

Each abstraction (bus, queue, search, vector) sits behind a service boundary so the backend swaps without touching call sites. **We pay for scale when the numbers ask, and not one sprint sooner.**

---

## 18. Security

Security is boundaries (§3) made concrete, plus AI-specific defenses.

- **Trust boundaries** — JWT clients are deny-all on every HQ table; the service-role key is server-only and never shipped to the browser; Realtime delivers via *server-authorized broadcast*, never by relaxing HQ RLS. Cross-tenant isolation is preserved absolutely — the OS reads tenant data only through the audited service-role aggregator.
- **Secrets** — env-based (`lib/env.ts`); LLM/provider keys server-only; per-tool credential scoping so a tool only holds what it needs.
- **AI-specific** — this is the new attack surface and we treat it seriously:
  - **Prompt-injection defense** — all tenant content, tool-fetched data, and external text is **untrusted data, never instructions** (the same rule this engineering team operates under). Employees act only on their configured objectives + capabilities, never on directives smuggled through data.
  - **Effect containment** — side-effects only via the typed tool registry, only after `authorize()` + approval; no free-form code execution; output validation/schema on model responses.
  - **No exfiltration** — capabilities gate what data an employee can read; egress (email/webhook) is itself a gated capability; budgets/rate-limits bound blast radius.
- **Data protection** — PII handling, impersonation fully audited (`impersonation_sessions`), least privilege throughout.
- **Supply chain** — pinned dependencies, review, dynamic import of the LLM SDK (already the pattern) keeps the dependency surface explicit.

Net: the OS *increases* security posture — more is audited, more is permissioned, more is contained — even as it does far more.

---

## 19. Rollout strategy

Eight gated phases. Each is **independently shippable, flag-gated (`hq_settings` flags already exist), preview-first, CEO-gated to merge, and reversible** — the exact discipline that made Directive 007 a clean release. No phase requires a big-bang cutover; each leaves the HQ better and fully working.

| Phase | Delivers | Why this order | Reversible by |
|---|---|---|---|
| **0** | This blueprint → CEO approval | Direction before code | n/a |
| **1 — Spine** | `hq_events`, outbox triggers, ingest existing audit logs (additive), timeline read-model | Everything else is a consumer of the spine; zero behavior change for users | flag off → events still written, just unread |
| **2 — Live HQ** | Realtime infra (server broadcast) + Mission Control read-models + the global timeline goes live | The first visible "it's alive" moment; proves the spine | flag off → pages revert to SSR snapshots |
| **3 — Find** | Global search index + ⌘K command palette | High-leverage, low-risk; makes the OS navigable | flag off → palette hidden |
| **4 — Control plane** | Permissions/RBAC (`authorize()` chokepoint) + approval workflow + inbox | **Must precede broader AI execution** — the safety rails go in before the cars | flag off → falls back to binary super-admin |
| **5 — Memory** | pgvector + memory edges; hybrid recall; reflection writes | Gives employees real recall before they do more | additive; embeddings ignorable |
| **6 — Workforce** | Generalise the Research AI runtime; turn employees live **one at a time**, lowest-risk first, behind approval gates | The payoff, made safe by phases 4–5 | per-employee `can_execute`/flag off |
| **7 — Harden** | Observability/metrics/audit dashboards; tamper-evident audit; scale graduations as measured | Operationalise what's now running | dashboards are read-only |

**Per-phase contract:** additive migrations only · behind a flag · preview deploy first · validation triplet green (tsc / lint / tests) · Vercel build green · a written backout · and the Golden-Rule check — *does this phase make CrewFlow feel more like an operating system than a collection of pages?* If a phase doesn't move that needle, it doesn't ship.

---

## Appendix A — Event taxonomy (illustrative)

`domain.action`, controlled vocabulary, enforced at the producer:

- **org**: `org.created`, `org.trial_started`, `org.trial_converted`, `org.churned`, `org.suspended`, `org.health_changed`
- **billing**: `invoice.created`, `invoice.payment_failed`, `invoice.paid`, `billing.refund_issued`
- **customer/job**: `customer.created`, `job.created`, `job.completed`
- **ai**: `ai.triggered`, `ai.run_started`, `ai.planned`, `ai.tool_called`, `ai.run_completed`, `ai.run_failed`, `ai.budget_exceeded`
- **approval**: `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired`
- **memory**: `memory.asserted`, `memory.superseded`, `memory.edge_added`
- **permission**: `permission.granted`, `permission.revoked`
- **system**: `system.cron_ran`, `system.alert_raised`, `system.webhook_received`

## Appendix B — New table catalogue (RLS posture)

All RLS-enabled, **zero-policy (service-role-only)**, matching the established HQ pattern:
`hq_events` (partitioned) · `hq_event_consumers` · `ai_employee_runs` · `ai_employee_tool_calls` · `ai_employee_schedules` · `hq_approvals` · `hq_approval_policies` · `hq_capabilities` · `hq_roles` · `hq_role_capabilities` · `hq_principal_roles` · `hq_search_index` · `hq_metrics` · `hq_memory_edges` (+ `hq_memories.embedding` column). Extensions: `vector`, `pg_trgm`. **No tenant table altered. No destructive change.**

## Appendix C — Existing assets reused (not rebuilt)

| OS component | Built on |
|---|---|
| AI runtime | `lib/ai-employees/framework` six-dimension SDK + Research AI executor (`hq-research.ts`) |
| Memory graph | `hq_memories` engine + relationship/version/grant tables (`hq-memory.ts`) |
| Data access | service-role aggregators (`server/services/*`, `lib/hq/*`) |
| Audit | `admin_activity_log` + `HqActor` stamping |
| Event fan-out | existing trigger pattern (`_record_activity`, `notify_*`) → outbox |
| Scheduling | Vercel Cron + `withCronTelemetry` + `cron_runs` + `research-drain` worker pattern |
| Metrics | `lib/hq/metrics.ts` + snapshot services |
| Auth gate | `server/auth/hq.ts` (`requireHq`/`requireHqPage`) → `authorize()` |
| Feature flags | `hq_settings` |
| Mission Control | generalise `hq-executive.ts` + the `command-centre` streaming-skeleton UI |

## Appendix D — Open questions for the CEO

1. **Execution appetite** — which employee goes live *first* in Phase 6 (recommend Documentation AI or Support-drafts, lowest blast radius)?
2. **Approval defaults** — how conservative initially (recommend: *every* side-effect human-approved until trust is measured)?
3. **Human roles** — do we want sub-super-admin roles (Auditor/Viewer) in Phase 4, or stay binary and only scope the *AIs* first?
4. **Audit assurance** — is hash-chained tamper-evidence wanted now (compliance signalling) or deferred?
5. **External APM** — adopt Sentry/OTel in Phase 7, or lean on Vercel + the internal observability page?

## Appendix E — Explicit non-goals for #008

No customer-facing changes · no new tenant tables · no multi-region · no replacing Supabase/Vercel · no autonomous AI action without a human-approval path · no removal of existing audit logs or pages · no speculative infrastructure ahead of measured need.

---

*This is architecture only. No implementation begins until the blueprint is approved. When approved, Phase 1 (the event spine) starts — additive, flag-gated, preview-first, CEO-gated — exactly as Directive 007 shipped.*
