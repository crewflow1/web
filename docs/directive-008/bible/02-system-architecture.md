# Chapter 02 — System Architecture

## Purpose

This chapter is the map of the whole machine: the planes, the components in each, how data flows between them, and why each technology was chosen. It is the chapter an engineer reads to understand *where their work fits*. Everything specified in later chapters is a component named here.

## Goals

- Define the four planes + the spine, and assign every component to exactly one of them.
- Make the kernel metaphor literal — name the real component behind each OS concept.
- Trace one real business event end-to-end through every component, so the data flow is concrete, not abstract.
- Justify every technology choice against the Golden Rule, with the alternatives we rejected and why.
- Define the deployment topology and environments.

**Non-goals:** the per-system internals (those are each system's chapter); the database schema (Ch.03); the event taxonomy (Ch.04).

---

## Architecture

### The four planes over one spine

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION PLANE                                                            │
│  Next.js App Router (RSC) — server-rendered snapshot + "use client" live       │
│  islands.  Surfaces: Mission Control · Workforce · Timeline · Approvals Inbox · │
│  Global Search (⌘K) · Memory Graph · Observability · the 24 existing pages.     │
└───────▲───────────────────────────────────────────────────────────▲───────────┘
        │ initial snapshot (service-role, server-only)               │ live deltas
        │                                                            │ (server broadcast)
┌───────┴────────────────────────────┐          ┌────────────────────┴───────────┐
│  CONTROL PLANE                      │          │  REAL-TIME INFRASTRUCTURE        │
│  • authorize(actor,cap,resource)    │          │  • Supabase Realtime             │
│  • Approval policy engine + inbox   │          │  • Server-authorized broadcast   │
│  • Human oversight / impersonation  │          │  • Presence (who's active)       │
│  • Feature flags (hq_settings)      │          │  • Reconnect / snapshot-resync   │
└───────▲─────────────────────────────┘          └────────────────────▲───────────┘
        │ gate every side-effect                                       │ publish vetted deltas
┌───────┴──────────────────────────────────────────────────────────────┴─────────┐
│  EXECUTION PLANE                                                                 │
│  AI Employee Runtime:  perceive → plan → gate → act → record → reflect           │
│  • Tool registry (typed, capability-tagged)   • Cost/budget + circuit breakers   │
│  • Workers: queue-driven, idempotent, retryable, dead-lettered                   │
│  ♻️ generalised from the proven Research AI executor (hq-research.ts)            │
└──────────────────────────────────────────▲──────────────────────────────────────┘
        │ append (transactional outbox — state + event in one txn)                  
┌───────┴──────────────────────────────────────────────────────────────────────────┐
│  THE SPINE                                                                        │
│  hq_events — append-only, month-partitioned, correlation/causation chained        │
│  + pg_notify wakeups   + Realtime publication   + durable consumer offsets         │
└──────────────────────────────────────────▲────────────────────────────────────────┘
        │ projections / read-models (derived, rebuildable)                          
┌───────┴────────────────────────────────────────────────────────────────────────────┐
│  DATA PLANE                                                                         │
│  System of record: Supabase Postgres — existing tenant tables + HQ tables           │
│  Read-models: hq_metrics · hq_search_index · timeline projections                   │
│  Memory graph: hq_memories + hq_memory_edges + pgvector embeddings                   │
│  Access: service-role aggregator layer (server/services/* + lib/hq/*)  ♻️           │
│  Integrations: Stripe (inbound webhook) · Anthropic→OpenAI · email provider          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Plane responsibilities — one sentence each:**

- **Data plane** owns *truth*: the system of record, the derived read-models, the memory graph, and the only code allowed to touch the service-role client.
- **The spine** owns *narrative*: every state change becomes an ordered, durable event that all other planes consume.
- **Execution plane** owns *work*: it runs AI employees as processes that turn triggers into gated, accounted, recorded actions.
- **Control plane** owns *authority*: it decides who may do what (permissions) and what requires a human (approvals), and holds the feature flags.
- **Real-time infrastructure** owns *delivery*: it carries vetted deltas from the spine to the right authenticated operators, live.
- **Presentation plane** owns *experience*: fast server-rendered snapshots that come alive through subscribed islands.

### The kernel model, made literal

This is the table from Ch.01 with the *actual component* named — proof the metaphor is the architecture:

| OS concept | Literal CrewFlow component | Plane |
|---|---|---|
| Kernel log | `hq_events` + the outbox triggers that write it | Spine |
| Process | An `AIEmployee` instance + its `ai_employee_runs` | Execution |
| Scheduler | `ai_employee_schedules` + Vercel Cron drainers + event subscriptions | Execution |
| Syscall table | The typed tool registry | Execution |
| Protection ring | `authorize()` + the approval policy engine | Control |
| Shared memory | `hq_memories` + `hq_memory_edges` + embeddings | Data |
| Filesystem | Supabase Postgres (system of record) | Data |
| IPC / bus | Spine consumers + the queue (`ai_employee_tasks`, later `pgmq`) | Spine/Execution |
| System monitor | Tracing/metrics/audit derived from events | Control/Data |
| Shell / desktop | Mission Control | Presentation |
| Device drivers | Stripe / Anthropic / OpenAI / email adapters | Data |

### System context (who and what touches the OS)

```
        ┌─────────────┐         ┌──────────────────┐        ┌──────────────┐
        │ Super-admin │  HTTPS  │  CrewFlow OS      │  API   │  Anthropic   │
        │ operator    │◀───────▶│  (Vercel + Supa)  │◀──────▶│  (→ OpenAI   │
        └─────────────┘         │                   │        │   fallback)  │
                                │                   │        └──────────────┘
        ┌─────────────┐  webhook│                   │  SMTP/API ┌─────────────┐
        │   Stripe    │────────▶│                   │─────────▶│   Email     │
        └─────────────┘         │                   │          │  provider   │
                                └─────────┬─────────┘          └─────────────┘
                                          │ reads (service-role, audited)
                                          ▼
                                ┌───────────────────┐
                                │  Tenant product   │  (customers, jobs, invoices…)
                                │  data (org-scoped) │  — never exposed to JWT clients via HQ
                                └───────────────────┘
```

External actors are deliberately few: one human role today (super-admin; sub-roles arrive in Ch.14), the LLM providers, Stripe inbound, and an email provider outbound. Each is a trust boundary (Ch.16).

---

## Data flow — one event, traced end to end

The architecture is only real if you can follow a single business event through every component. Here is the canonical worked example: **a tenant's subscription payment fails, and Finance AI runs a dunning sequence.** Every arrow corresponds to a component above.

1. **Ingress (Data plane).** Stripe sends `invoice.payment_failed` to `app/api/webhooks/stripe`. The handler (♻️ `stripe-webhook-handler.ts`) writes the `billing_events`/`billing_invoices` rows **and**, in the *same transaction* (outbox, Ch.04), appends a spine event `invoice.payment_failed` with `object_type=organization`, a fresh `correlation_id`, and the failure detail in `payload`.

2. **Fan-out (Spine).** The insert fires `pg_notify('hq_events', …)`. Three consumers wake:
   - the **timeline projection** worker advances its offset and the org's feed gains the event (Ch.11);
   - the **metrics** worker increments the `failed_payments` counter (Ch.15);
   - the **real-time broadcaster** authorizes the event for the HQ audience and pushes it to subscribed Mission Control islands (Ch.06).
   Simultaneously, the **employee dispatcher** sees a verb that `Finance AI` subscribes to.

3. **Trigger (Execution plane).** The dispatcher enqueues a task for `finance-ai` and starts a **run** (`ai_employee_runs`, state `Triggered`). A worker (Vercel function, kicked now; durable queue at scale) picks it up.

4. **Perceive.** The run loads context: the org, its payment history, prior dunning attempts, and relevant **memory** (Ch.12) — e.g. "this org churned-then-returned last year; handle gently."

5. **Plan.** The runtime calls the model (cheap tier first, Ch.17) and gets a *structured proposal*: `[email.send(dunning_template_1, to=org_billing_contact)]` — not free text. Run state → `Planning`.

6. **Gate (Control plane).** For the `email.send` tool the runtime calls `authorize(finance-ai, email.send, org)` and consults the **approval policy**: "Finance AI outbound email to a customer → require_human under the conservative default." It creates an `hq_approvals` row capturing the *exact* payload and a human-readable projected effect ("Send dunning email #1 to Acme Ltd billing contact"). Run state → `AwaitingApproval`; a spine event `approval.requested` fans out — the **Approvals Inbox** in Mission Control lights up live.

7. **Human decision (Control plane / Presentation).** The operator sees the approval on Mission Control without navigating anywhere, reviews substance, clicks **Approve**. A spine event `approval.granted` is appended; the run resumes.

8. **Act (Execution plane).** The runtime invokes the `email.send` tool → the email provider adapter (Data plane) → the email is queued/sent. The tool call is logged (`ai_employee_tool_calls`) and a spine event `email.sent` is appended. Run state → `Executing`.

9. **Record (Control/Data).** The run row is finalised with model, tokens, cost, latency; `admin_activity_log` gets an immutable audit entry stamped with the human approver and the AI actor (Ch.15).

10. **Reflect (Data plane).** The runtime writes memory: an episodic record (the spine already holds it) and a semantic note ("dunning #1 sent to Acme on 2026-06-19; awaiting response") linked to the org node in the graph (Ch.12). Run state → `Idle`.

11. **Observability falls out for free (Control plane).** Because every step shares one `correlation_id`, the entire chain — webhook → event → trigger → plan → approval → send → memory — is a single trace, viewable in the observability surface (Ch.15). No step was instrumented specially; the event model *is* the trace.

That one walk-through exercises all six planes, the approval gate, the cost accounting, the memory write, and the live UI — and it is the template every other workflow follows.

---

## Technology choices (each justified against the Golden Rule)

| Decision | Choice | Why it survives 1M companies | Alternatives rejected |
|---|---|---|---|
| **App framework** | Next.js 15 App Router, RSC + client islands | Server-render the truth (fast first paint, no data on the client it shouldn't have); hydrate only the live bits. Scales by being mostly static/streamed. ♻️ already the stack. | SPA (ships service-role-adjacent data + slow first paint); separate API + frontend (two deploys, more surface). |
| **System of record** | Supabase Postgres | ACID, RLS, FTS, `LISTEN/NOTIFY`, triggers, partitioning, `pgvector` — one engine does record, queue, search, and vectors until scale splits them. ♻️ 88 migrations of proven discipline. | A polyglot store on day one (operational tax before evidence — violates P6). |
| **Event bus** | Postgres outbox + `pg_notify` + durable offsets; `pgmq` for retryable work | Transactional outbox makes state and event inseparable (P1). Postgres comfortably serves our event rate; Ch.17 names the exact point to graduate to a broker. | Kafka/NATS day one (operate/secure/pay before need — violates P6). |
| **Real-time** | Supabase Realtime via **server-authorized broadcast** | Keeps the sensitive HQ log server-side; ships only vetted, HQ-scoped deltas to authenticated super-admins. No loosening of RLS. | Direct `postgres_changes` on HQ tables (would require JWT-readable RLS on the most sensitive tables — unacceptable, Ch.06/16). |
| **Search** | Postgres FTS (`tsvector`) + `pg_trgm`, behind a `searchHq()` abstraction | One index serves ranked + fuzzy cross-entity search into the hundreds of thousands of entities; the abstraction lets us swap to Typesense/Meilisearch when measured (Ch.17). | Elasticsearch cluster up front (heavy ops before need). |
| **Vector / memory** | `pgvector` with HNSW, in the same DB as the memory rows | Co-locating embeddings with the facts and edges makes hybrid (keyword+vector+graph) recall a single query; ♻️ the `embedding_placeholder` was reserved for exactly this. | A separate vector DB (a second source of truth for memory — violates P1). |
| **Scheduling / workers** | Vercel Cron + `withCronTelemetry` + event-kicked workers | ♻️ already proven by the Research AI `research-drain` pattern; serverless scales horizontally; cron is the dead-worker safety net. | A standing worker fleet (more to run before the load justifies it). |
| **LLM** | Anthropic primary, OpenAI fallback, model tiering | ♻️ already wired in `research-llm.ts`; tiering (haiku→sonnet/opus) and fallback give cost control + resilience (P9, Ch.17). | Single-provider lock-in (resilience + pricing risk). |
| **Auth** | Allowlist super-admin gate today → capability RBAC | ♻️ `server/auth/hq.ts` is the single gate to extend into `authorize()` (P5, Ch.14). | A bolt-on RBAC parallel to the existing gate (two auth paths — violates P1). |

The through-line: **we already run a capable, disciplined Postgres+Vercel stack; the OS is built by extending it, and we graduate individual subsystems only when measurement demands (P6).**

---

## Deployment topology & environments

- **Hosting:** Vercel (Next.js, serverless functions, cron). **Data:** Supabase (Postgres, Auth, Storage, Realtime). **Single production project** — there is no separate staging; preview deployments are the pre-prod surface (matching current ops). 
- **Environments:** *Preview* (per-branch Vercel deploys; the QA surface — where the RC lives now) and *Production* (`crewflow.uk`). Every OS phase ships to preview behind a flag first, exactly as 007 did.
- **Regions:** single-region to start; the architecture is region-portable (stateless functions + one Postgres) and Ch.17 notes the read-replica/region path when latency data demands it.
- **Secrets:** environment variables via `lib/env.ts` (Zod-validated; the empty-`.env.local` constraint means full builds verify only in CI/Vercel — a known operational fact carried from 007).

---

## Failure handling (system level)

- **A plane degrades, the OS stays up.** If real-time fails, islands fall back to polling and pages still render their server snapshot. If the execution plane stalls, the spine and read-models are unaffected and the cron drainers catch up. If an integration (Stripe/LLM/email) is down, its events queue and retry; nothing is lost because state and events are written together.
- **The spine is the recovery anchor.** Read-models are rebuildable by replaying the spine; a corrupted projection is dropped and rebuilt, not hand-patched.
- **No single point of irreversible failure.** Every side-effect is idempotent (P8) and flag-killable (P7).

## Edge cases

- **Event without a consumer yet** (a new verb before its projection ships): harmless — the event is stored, read later. Additive by design (P2).
- **Out-of-order delivery:** consumers order by `(object, sequence)`; the spine's identity column gives a total order for tie-breaks (Ch.04).
- **Clock skew across serverless invocations:** events are ordered by the DB-assigned id, not wall-clock `ts`; `ts` is for display.
- **A run spanning an approval that never comes:** approvals expire (Ch.13); the run transitions to a terminal recorded state, never hangs.

## Performance

- **First paint** is a cheap server-rendered snapshot reading precomputed read-models (Ch.09), not a live scan — O(1) regardless of company count.
- **Liveness** is a subscription, not a poll — cost scales with *active operators*, not with data volume.
- **The heavy aggregation** moves off the request path into rollup jobs (Ch.15).
- **At 1M companies:** the homepage still reads a handful of rollup rows and subscribes to a bounded delta stream; the expensive work is amortised in background jobs and partitioned storage. This is the architecture *because* of the Golden Rule, not despite it.

## Security

Trust boundaries are the spine of Ch.16; at the system level: JWT clients are deny-all on every HQ table; the service-role key is server-only and never shipped to a browser; real-time delivers via authorized broadcast, never relaxed RLS; tenant isolation is absolute — the OS reads tenant data only through the audited service-role aggregator. AI side-effects are contained behind the tool registry + `authorize()` + approvals.

## Testing

- **Architecture-level tests:** the end-to-end traced flow above becomes an integration test (webhook → event → run → approval → side-effect → audit) with the LLM stubbed deterministically (♻️ Research AI already has a deterministic fallback path to model on).
- **Contract tests** on the event envelope and tool registry (Ch.04/07) keep planes decoupled but compatible.
- **RLS tests** assert no HQ table is JWT-readable (Ch.03/16).
- CI gates: the validation triplet (tsc / lint / tests) + Vercel build, exactly as 007.

## Monitoring

Golden signals per plane: spine lag & throughput; queue depth & run error rate (execution); approval latency (control); broadcast fan-out & reconnect rate (real-time); TTFB & hydration (presentation); query p95 & partition health (data). All derived from events and surfaced in the observability chapter (Ch.15).

## Future expansion

The plane boundaries are the seams for growth: a new product domain adds tables + verbs + a projection without touching other planes; a new AI capability adds a tool + a capability + a policy; graduating a subsystem (broker, search engine, vector store) swaps an implementation behind an existing abstraction (P6). The architecture is designed so that *the next decade of features are additions at these seams, not rewrites.*
