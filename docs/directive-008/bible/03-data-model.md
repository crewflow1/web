# Chapter 03 — Data Model (Canon)

## Purpose

This chapter is the single source for the OS data model. Every other chapter that names a table points here; no chapter invents a table that is not catalogued here. If you change a table, you change it here first, with an ADR (Ch.20), then sweep dependents. This is the most load-bearing chapter in the Bible.

## Goals

- Catalogue **every new table** the OS introduces, with full illustrative DDL: columns, types, constraints, indexes, partitioning, RLS posture, retention, who writes it, who reads it, and the spine events it emits.
- Ground the new tables in the **existing schema** (88 migrations) so every change is provably additive (P2).
- Define the **conventions** (keys, timestamps, soft-delete, RLS notation) all tables obey.
- Provide the **migration ordering** and the data-lifecycle/retention policy.

**Non-goals:** the event *semantics* (Ch.04); per-system query patterns (each system's chapter); production migration SQL (produced and gated at implementation).

---

## Conventions

- **Primary keys.** `uuid` (`gen_random_uuid()`) for entities; `bigint generated always as identity` for high-volume append-only logs (the spine) where a monotonic id gives total ordering.
- **Timestamps.** `timestamptz`, UTC, `created_at`/`updated_at` defaults; append-only tables have only `ts`/`created_at`.
- **Soft delete.** HQ entities use `archived_at timestamptz` where reversibility matters; the spine and audit are **never** deleted, only partitioned out (retention).
- **JSON.** `jsonb` for open payloads; typed columns for anything queried or indexed. Policy: *no PII in event/audit payloads beyond identifiers* (Ch.16).
- **RLS notation** (from Ch.00):
  - **`RLS:hq`** — RLS enabled, **zero policies** → service-role only. **The default for every new table in this chapter.**
  - **`RLS:tenant`** — org-scoped policies via `current_org_ids()` (existing tenant tables; unchanged).
- **Naming.** New OS tables are `hq_*` or `ai_employee_*`. Verbs/capabilities are `domain.action`.
- **Extensions added:** `vector` (pgvector), `pg_trgm`. Both additive, both standard on Supabase.

---

## The existing schema (grounding — unchanged by the OS)

The OS is built *on top of* a mature schema. Two families exist today (♻️ all of it):

**Tenant family (`RLS:tenant`, org-scoped):** `organizations` (with `stripe_customer_id`), `users`, `memberships`; `customers`, `leads`, `properties`, `jobs`, `quotes`/`quote_line_items`, `invoices`/`invoice_payments`/`invoice_reminders`, `finances`, `expense_drafts`, `suppliers`, `service_catalog`; comms (`calls`, `conversations`, `messages`, `voice_notes`, `missed_call_textbacks`, `inbound_enquiries`); workforce (`staff_secrets`, `rota_entries`, `time_entries`, `leave_requests`, `payroll_runs`/`payroll_lines`, `compliance_documents`); docs (`job_documents`/`_versions`, `tenant_attachments`, `portal_uploads`, `signatures`); imports; plus shared `notifications`, `activity_log`, `review_requests`, `support_tickets`/`support_messages`, `ai_receptionist_setups`, `rate_limit_counters`.

**HQ family (`RLS:hq`, service-role only):** `admin_activity_log`, `admin_alert_state`, `health_score_events`, `internal_notes`, `impersonation_sessions`, `demo_requests`, `billing_invoices`/`billing_events`, `hq_settings`, `cron_runs`, `automation_runs`, `notification_email_queue`; the AI-employee tables `ai_employees`, `ai_employee_tasks`, `ai_employee_memory`; the Shared-Memory graph `hq_memories` (+ generated `search_tsv`, **reserved `embedding_placeholder`**), `hq_memory_types`/`_sources`/`_relationships`/`_employee_links`/`_access_grants`/`_events`/`_versions`; and the large mostly-inert Sales-AI model (`hq_sales_*`).

**The two truths the OS unifies as *views* (sources stay):** `activity_log` (per-tenant audit) and `admin_activity_log` (HQ audit). The OS ingests both into the spine for a unified *timeline*, without removing either (Ch.11).

**The one live executor today:** Research AI (`hq-research.ts`), which the OS generalises into the runtime (Ch.07).

---

## New tables

Every table below is **`RLS:hq`** (service-role only) unless noted. None alters a tenant table.

### 1. The spine

```sql
-- 03.1  hq_events — the one append-only event log. Partitioned monthly.
create table hq_events (
  id             bigint generated always as identity,
  ts             timestamptz not null default now(),
  actor_type     text   not null,          -- 'human'|'ai_employee'|'system'|'tenant'
  actor_id       text,                      -- HqActor.id | employee slug | cron name | org id
  verb           text   not null,           -- canonical verb (Ch.04 registry)
  object_type    text   not null,           -- 'organization'|'customer'|'ai_employee'|...
  object_id      text   not null,
  target_type    text,                       -- optional secondary
  target_id      text,
  correlation_id uuid   not null,            -- the trace (one intent end-to-end)
  causation_id   bigint,                     -- the event that caused this one
  severity       text   not null default 'info',  -- 'info'|'success'|'warn'|'critical'
  payload        jsonb  not null default '{}',
  visibility     text   not null default 'hq',
  primary key (id, ts)
) partition by range (ts);

create index hq_events_object_idx  on hq_events (object_type, object_id, ts desc);
create index hq_events_actor_idx   on hq_events (actor_type, actor_id, ts desc);
create index hq_events_corr_idx    on hq_events (correlation_id);
create index hq_events_verb_idx    on hq_events (verb, ts desc);
create index hq_events_severity_idx on hq_events (severity, ts desc) where severity in ('warn','critical');
```
- **Partitioning:** one partition per month, created ~2 months ahead by a cron job; partitions older than the retention window (Ch.15) are detached to cold storage, never dropped destructively.
- **Writes:** the outbox — producers + AFTER triggers (Ch.04). **Reads:** projection workers (by offset), the timeline (Ch.11), observability (Ch.15), the broadcaster (Ch.06).
- **Emits:** n/a (it *is* the event store).

```sql
-- 03.2  hq_event_consumers — durable offsets so workers resume exactly.
create table hq_event_consumers (
  consumer       text primary key,          -- 'timeline'|'metrics'|'search_index'|...
  last_event_id  bigint not null default 0,
  updated_at     timestamptz not null default now()
);
```

### 2. AI runtime (Ch.07–08)

```sql
-- 03.3  ai_employee_runs — one row per execution attempt (cost/latency/trace unit).
create table ai_employee_runs (
  id             uuid primary key default gen_random_uuid(),
  employee_slug  text not null references ai_employees(slug),
  task_id        uuid,                       -- references ai_employee_tasks(id)
  trigger        text not null,              -- 'schedule'|'event'|'manual'|'delegation'
  state          text not null default 'triggered', -- FSM (Ch.07)
  model          text, input_tokens int, output_tokens int,
  cost_usd       numeric(12,6) default 0,
  latency_ms     int,
  correlation_id uuid not null,
  started_at     timestamptz, finished_at timestamptz,
  error          text,
  created_at     timestamptz not null default now()
);
create index on ai_employee_runs (employee_slug, created_at desc);
create index on ai_employee_runs (state) where state not in ('idle','done','failed');
```
- **Emits:** `ai.run_started`, `ai.planned`, `ai.run_completed`, `ai.run_failed`, `ai.budget_exceeded`.

```sql
-- 03.4  ai_employee_tool_calls — every tool invocation (the AI "syscall" log).
create table ai_employee_tool_calls (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references ai_employee_runs(id),
  tool          text not null,              -- 'email.send'|'customer.read'|...
  args          jsonb, result_summary text,
  required_capability text not null,         -- checked at the gate (Ch.14)
  approval_id   uuid,                        -- set if it required human approval
  ok            boolean, ts timestamptz not null default now()
);
create index on ai_employee_tool_calls (run_id);
```
- **Emits:** `ai.tool_called`.

```sql
-- 03.5  ai_employee_schedules — recurring triggers per employee.
create table ai_employee_schedules (
  id            uuid primary key default gen_random_uuid(),
  employee_slug text not null references ai_employees(slug),
  cron          text not null, enabled boolean not null default true,
  last_run_at   timestamptz, next_run_at timestamptz
);

-- 03.6  EXTENSIONS to existing ai_employee_tasks (additive columns only):
-- add: state text (FSM), priority int, budget_usd numeric, deadline timestamptz,
--      correlation_id uuid, requested_by text.   (No column dropped.)
```

### 3. Control plane — approvals (Ch.13)

```sql
-- 03.7  hq_approvals — human approval for an AI side-effect.
create table hq_approvals (
  id            uuid primary key default gen_random_uuid(),
  requested_by_employee text references ai_employees(slug),
  run_id        uuid references ai_employee_runs(id),
  capability    text not null,              -- the action requiring approval
  risk_tier     text not null,              -- 'low'|'medium'|'high'|'critical'
  payload       jsonb not null,             -- EXACTLY what will execute
  projected_effect text not null,           -- human-readable ("Refund £240 to Acme")
  status        text not null default 'pending', -- pending|approved|rejected|expired
  decided_by    text, decided_at timestamptz, reason text,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index on hq_approvals (status, created_at) where status = 'pending';
```
- **Emits:** `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired`.

```sql
-- 03.8  hq_approval_policies — the rules that route auto vs human vs dual-control.
create table hq_approval_policies (
  id            uuid primary key default gen_random_uuid(),
  employee_slug text,                        -- null = applies to all
  capability    text, risk_tier text,
  decision      text not null,              -- 'auto'|'require_human'|'dual_control'
  monetary_threshold numeric,                -- e.g. auto under £50
  approver_role text,                        -- which human role decides (Ch.14)
  enabled       boolean not null default true
);
```

### 4. Control plane — permissions / RBAC (Ch.14)

```sql
-- 03.9  hq_capabilities — the fine-grained verb catalogue (seeded).
create table hq_capabilities (
  key         text primary key,             -- 'billing.refund'|'org.suspend'|'email.send'
  description text not null, domain text not null,
  danger      boolean not null default false -- dangerous → dual-control eligible
);

-- 03.10 hq_roles — bundles of capabilities (human + AI scoped sets).
create table hq_roles (
  key text primary key, name text not null, description text,
  kind text not null default 'human'        -- 'human'|'ai'
);

-- 03.11 hq_role_capabilities — role → capability (many-to-many).
create table hq_role_capabilities (
  role_key text references hq_roles(key),
  capability_key text references hq_capabilities(key),
  primary key (role_key, capability_key)
);

-- 03.12 hq_principal_roles — grants to humans AND ai employees.
create table hq_principal_roles (
  principal_type text not null,             -- 'human'|'ai_employee'
  principal_id   text not null,             -- HqActor.id | employee slug
  role_key       text not null references hq_roles(key),
  granted_by     text, granted_at timestamptz not null default now(),
  expires_at     timestamptz,
  primary key (principal_type, principal_id, role_key)
);
```
- **Emits:** `permission.granted`, `permission.revoked`.

### 5. Read-models (Ch.09/10/11/15)

```sql
-- 03.13 hq_search_index — denormalized cross-entity search (Ch.10).
create table hq_search_index (
  entity_type text not null, entity_id text not null,
  title text not null, subtitle text, body text, url text not null,
  search_tsv  tsvector,
  updated_at  timestamptz not null default now(),
  primary key (entity_type, entity_id)
);
create index on hq_search_index using gin (search_tsv);
create index on hq_search_index using gin (title gin_trgm_ops);   -- pg_trgm fuzzy
```
- **Writes:** maintained additively by AFTER triggers / the search-index consumer from source tables. **Reads:** `searchHq()` (Ch.10).

```sql
-- 03.14 hq_metric_definitions — the metric registry (one formula per metric).
create table hq_metric_definitions (
  metric text primary key,                  -- 'mrr'|'arr'|'active_orgs'|'churn_rate'|...
  description text not null, unit text, formula_ref text not null,  -- the canonical source fn
  grain text[] not null                      -- which grains it rolls to
);

-- 03.15 hq_metrics — time-series rollups (Ch.15).
create table hq_metrics (
  metric text not null references hq_metric_definitions(metric),
  ts     timestamptz not null,
  grain  text not null,                     -- 'minute'|'hour'|'day'
  value  numeric not null, dims jsonb not null default '{}',
  primary key (metric, grain, ts, dims)
);
create index on hq_metrics (metric, grain, ts desc);
```

### 6. Memory graph — semantic layer (Ch.12)

```sql
-- 03.16 extend hq_memories with a real embedding (replaces embedding_placeholder).
create extension if not exists vector;
alter table hq_memories add column embedding vector(1536);
create index on hq_memories using hnsw (embedding vector_cosine_ops);

-- 03.17 hq_memory_edges — typed graph edges (facts ↔ facts ↔ entities).
create table hq_memory_edges (
  id            uuid primary key default gen_random_uuid(),
  subject_memory uuid not null references hq_memories(id),
  predicate     text not null,              -- 'relates_to'|'caused_by'|'about_entity'|...
  object_memory uuid references hq_memories(id),
  object_entity_type text, object_entity_id text, -- edges may point at entities
  weight        real not null default 1.0,
  confidence    real not null default 1.0,
  provenance    jsonb,                      -- which run/event asserted this
  created_at    timestamptz not null default now()
);
create index on hq_memory_edges (subject_memory);
create index on hq_memory_edges (object_entity_type, object_entity_id);
```
- **Emits:** `memory.asserted`, `memory.superseded`, `memory.edge_added`. ♻️ `hq_memories` + relationship/version/grant tables already exist; this adds only the embedding column and the formal edge table.

### 7. Observability (Ch.15)

```sql
-- 03.18 hq_runs / hq_spans — unify cron + AI + webhook + projection execution traces.
-- (Generalises ♻️ cron_runs / automation_runs; those remain as domain stores.)
create table hq_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                       -- 'cron'|'ai_run'|'webhook'|'projection'
  correlation_id uuid not null, name text not null,
  status text not null, started_at timestamptz, finished_at timestamptz,
  error text, meta jsonb not null default '{}'
);
create table hq_spans (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references hq_runs(id),
  name text not null, started_at timestamptz, finished_at timestamptz,
  attrs jsonb not null default '{}'
);
create index on hq_runs (correlation_id);
create index on hq_spans (run_id);
```

### 8. Reused, not rebuilt (♻️)

The OS leans on these existing tables as-is: `admin_activity_log` (the canonical immutable audit, Ch.15), `hq_settings` (feature flags, P7), `cron_runs`/`automation_runs` (scheduling telemetry), `impersonation_sessions` (oversight audit), `notification_email_queue` (the outbound outbox to be drained, Ch.05), the whole `hq_memories` graph, and the `ai_employees`/`ai_employee_tasks`/`ai_employee_memory` triad.

---

## Entity-relationship overview (new + key existing)

```
ai_employees ──< ai_employee_tasks ──< ai_employee_runs ──< ai_employee_tool_calls
     │                                       │                      │
     │                                       └──< (correlation_id) ─┴─▶ hq_events (spine)
     │                                                                      ▲  ▲
     ├──< ai_employee_schedules                          (outbox writes) ───┘  │
     │                                                                          │
hq_principal_roles >── hq_roles ──< hq_role_capabilities >── hq_capabilities    │
     │ (also grants to humans)                                                  │
hq_approvals >── ai_employee_runs        hq_approval_policies                    │
     └──────────────────────────────────────────────────────────(emits)────────┤
hq_memories ──< hq_memory_edges        hq_memories.embedding                     │
     └──(memory.* emits)───────────────────────────────────────────────────────┤
hq_search_index   hq_metrics >── hq_metric_definitions   hq_runs ──< hq_spans    │
     └─ projections (consume the spine) ────────────────────────────────────────┘
```
The spine is the hub: AI runs *write* events; projections (`hq_search_index`, `hq_metrics`, timeline) *read* events; everything traces by `correlation_id`.

---

## Migration plan & ordering

Forward-only, additive, numbered-timestamp migrations (♻️ the existing discipline, now at migration #89+). Ordering mirrors the rollout (Ch.19):

1. **Spine first:** `hq_events` (+ partitions + the partition-creator cron) and `hq_event_consumers`. Plus the outbox triggers on key existing tables (Ch.04). *No behaviour change for users.*
2. **Backfill adapters:** ingest `activity_log` + `admin_activity_log` history into the spine (idempotent backfill, Ch.11). Originals untouched.
3. **Read-models:** `hq_metric_definitions` (seed) + `hq_metrics`; `hq_search_index` + its triggers; timeline projection (a view/consumer, no new base table).
4. **Control plane:** `hq_capabilities`/`hq_roles`/`hq_role_capabilities`/`hq_principal_roles` (seed the catalogue, grant all to existing super-admins for back-compat); `hq_approvals`/`hq_approval_policies`.
5. **Runtime:** `ai_employee_runs`/`ai_employee_tool_calls`/`ai_employee_schedules` + the additive columns on `ai_employee_tasks`.
6. **Memory:** `vector` extension + `hq_memories.embedding` + HNSW index + `hq_memory_edges`; lazy embedding backfill.
7. **Observability:** `hq_runs`/`hq_spans`.

Each migration is independently shippable behind a flag; each is reversible (a new table can be ignored/dropped on a preview without data loss because read-models are rebuildable and the spine is additive).

---

## Failure handling

- **Partition gaps:** the partition-creator cron runs ahead of need; a missing partition is caught by a monitor (Ch.15) and created before inserts reach it. A default partition catches stragglers safely.
- **Constraint violations** on outbox writes fail the *whole* transaction (state + event together) — by design, state never diverges from its narrative (P1).
- **Read-model drift:** projections are rebuildable from the spine; a suspected-bad rollup is recomputed, never hand-edited.
- **Embedding backfill failure:** `embedding` is nullable; recall degrades gracefully to FTS-only until backfilled (Ch.12).

## Edge cases

- **A verb with no schema yet** in `payload`: payloads are `jsonb`, so producers and consumers evolve independently; the event-contract tests (Ch.04) pin the shapes that matter.
- **Very large `payload`:** policy caps payloads to identifiers + small metadata; large artifacts live in their domain table and are referenced by id (no blobs in the spine).
- **Cross-type ids** (`object_id` is `text`): deliberate, so any entity can be an object without a polymorphic FK; integrity is enforced at the producer, not by FK.

## Performance

- **Hot path** (the homepage, Ch.09) reads a handful of `hq_metrics` rows + a small recent-events slice — both indexed, both O(1) in company count.
- **Spine writes** are a single indexed insert in an existing transaction — negligible overhead on the state change.
- **Timeline/search reads** hit covering indexes; partitioning keeps the hot month small.
- **At 1M companies:** the spine grows large, but reads are always *bounded* (recent partition + indexed lookups) and old partitions are cold-stored. Vector recall uses HNSW (sub-linear). This is the schema *because of* the Golden Rule.

## Security

Every new table is `RLS:hq` (service-role only) — JWT clients cannot read a single OS row (Ch.16). No tenant table is altered, so tenant isolation is provably unchanged. Payload policy forbids PII beyond identifiers. The audit table (`admin_activity_log`) is append-only and may be hash-chained (Ch.15).

## Testing

- **RLS tests:** assert every `hq_*`/`ai_employee_*` table is unreadable by an anon/JWT client and readable only by service-role (♻️ pattern exists).
- **Schema tests:** migrations apply cleanly forward; additive columns don't break existing queries; partitions create and route.
- **Projection tests:** rebuild a read-model from a fixture spine and assert it matches an oracle (♻️ the byte-identical-oracle style from 007's token tests).

## Future expansion

New domains add tables + verbs + a projection at the existing seams — never a change to the spine's shape. If a read-model outgrows Postgres (search, vectors), the table becomes a cache in front of an external engine behind the same service API (P6, Ch.17). The data model is designed so the next decade is *more tables at the edges*, not a reshaping of the core.
