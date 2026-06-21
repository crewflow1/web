# The CrewFlow AI Substrate — Volumes IX–XIII

> **Status:** Architecture specification. Constitutional design work under the
> CEO Directive *"Bible Ratification & AI Substrate First"* (2026-06-21).
>
> **This is design, not a build order.** Per the directive: *do not implement
> code, do not modify production, do not create PRs.* Nothing in this directory
> is implemented until a future CEO Directive explicitly instructs it. These
> documents exist so that, when that directive lands, a new engineering team
> could implement the substrate **without ambiguity**.

---

## Why this exists

CrewFlow is building an **AI operating system for UK construction companies**.
The adoption analysis (`../adoption-analysis.md`) reached one decisive
conclusion, which the CEO ratified:

> Build the operating system **before** installing the applications. The AI
> substrate comes before any individual AI employee.

An "AI employee" — Sales AI, Research AI, a future Finance AI — is an
*application*. The substrate is the *kernel* every one of them runs on. Today
CrewFlow has two executing employees (Research AI, Lead Qualification AI) and a
roster of thirteen seeded ones, but each new employee re-implements its own
plumbing: how it is invoked, how it remembers, how it talks to peers, how it is
audited, how a human approves its risky actions. That does not scale to a
*workforce*. The substrate factors the plumbing out **once** so that, in the
CEO's words, *every future AI employee can reuse it.*

The substrate is five subsystems. Each is one volume:

| Vol | Subsystem | One-line role | Kernel analogy |
|-----|-----------|---------------|----------------|
| **IX** | **AI Communication Protocol** | How one AI employee addresses, asks, answers, and hands off to another | IPC / message passing |
| **X** | **Shared Memory Architecture** | What every employee knows, remembers, and recalls — permissioned | Virtual memory + filesystem |
| **XI** | **Event Bus** | The append-only nervous system every state change flows through | The scheduler's run-queue + interrupt bus |
| **XII** | **Task Engine** | The universal unit of AI work: lifecycle, dependencies, approval, recovery | Process scheduler |
| **XIII** | **AI SDK** | The single interface an employee uses to touch any of the above — the syscall layer | The system-call ABI + libc |

**Read them in dependency order, not numeric order.** The bus (XI) is the
backbone; communication (IX) and the task engine (XII) ride on it; memory (X) is
the store they pass context through; the SDK (XIII) binds all four into the one
interface an employee is allowed to use.

```
                   ┌─────────────────────────────────────────────┐
                   │            Volume XIII — AI SDK              │
                   │   the ONLY interface an AI employee may use  │
                   │  identity · permissions · tools · approval · │
                   │      cost · audit · capability registry      │
                   └───────┬───────────┬───────────┬─────────────┘
                           │           │           │
              ┌────────────▼──┐  ┌─────▼──────┐  ┌─▼───────────────┐
              │  IX  Comms     │  │  X  Memory │  │  XII  Tasks     │
              │  AI ⇄ AI msgs  │  │  recall/   │  │  the unit of    │
              │  threads,      │  │  remember, │  │  work: FSM,     │
              │  escalation    │  │  retrieval │  │  deps, approval │
              └────────┬───────┘  └─────┬──────┘  └────────┬────────┘
                       │                │                  │
                       └────────────────┼──────────────────┘
                                        │  everything emits/consumes
                              ┌─────────▼───────────┐
                              │  XI  Event Bus       │
                              │  hq_events (BUILT)   │
                              │  append-only spine,  │
                              │  drainer, DLQ, replay│
                              └─────────┬───────────┘
                                        │
                              ┌─────────▼───────────┐
                              │  Postgres (Supabase) │
                              │  RLS:hq, service-role│
                              └─────────────────────┘
```

---

## The prime directives this substrate obeys

Every design choice below is traceable to a standing rule:

1. **Postgres-first. Reuse over invention.** (Directive 003: *"Maximum reuse.
   Minimum complexity. One architecture. One source of truth."*) The Event Spine
   already exists (`hq_events`, five migrations, a drainer, a DLQ, replay, golden
   signals). The Shared Memory engine already exists (`hq_memories` + 7 tables).
   The AI task queue already exists (`hq_sales_ai_tasks`). The roster already
   exists (`ai_employees`). **The substrate is mostly a *generalisation and
   wiring* of systems already in the repo, not a greenfield rewrite.** Each
   volume has an explicit **Built vs. To-build** ledger so no one rebuilds what
   is already shipped.

2. **Do not rewrite working systems. Protect production stability.** (This
   directive.) The sales-scoped systems (`hq_sales_ai_tasks`, the Sales AI
   timeline) keep running. The substrate introduces *general* tables alongside
   them (`hq_ai_tasks`, …) and a migration path, never an in-place mutation of a
   live table that a runner depends on.

3. **The three-question gate.** (This directive's *Future Rule*.) No feature in
   any volume is admitted unless it answers **yes** to all three:
   - *Does it align with the CrewFlow Bible?*
   - *Does it fit naturally into the AI substrate?*
   - *Can every future AI employee reuse it?*

4. **Document before you build.** (Directive 004.) These volumes *are* that
   documentation. When implementation is later authorised, each major decision
   lands as an ADR in `../decisions/NNNN-*.md` in the same PR as its code.

5. **The six-gate bar.** (Directive 004.) Every volume closes with a testing
   section that maps its behaviour onto the six gates (typecheck, lint, unit,
   integration on real Postgres, security/trust-boundary, e2e). Determinism over
   mocks: the spine's invariants are proved against a *real* database, and the
   substrate inherits that discipline.

---

## Shared primitives — defined ONCE here, referenced everywhere

The five volumes share a small set of primitives. To prevent drift, they are
canonised **here** and only **referenced** (never redefined) in the volumes. If
one of these needs to change, it changes here, and the volumes inherit it.

### P1 · The canonical event envelope

Every meaningful thing that happens in the substrate is recorded as an **event**
in the shape the Event Spine already ships (`public.hq_events`). This is the
substrate's universal "something happened" record. Volume XI owns it in full;
the other volumes only *emit* and *consume* it. Its fields:

| Field | Type | Meaning |
|-------|------|---------|
| `id` | `bigint` identity | **The total order.** Globally monotonic. Consumers order by `id`, never by `ts`. |
| `ts` | `timestamptz` | Wall-clock time (partition key; *not* the ordering key). |
| `actor_type` | `text` | `human` \| `ai_employee` \| `system` \| `tenant` — who acted. |
| `actor_id` | `text` | The actor's stable id (an employee **slug**, a user id, a system component name). |
| `verb` | `text` | Past-tense fact: `task.completed`, `ai.message.sent`, `memory.written`. |
| `object_type` / `object_id` | `text` | The thing the verb is about. |
| `target_type` / `target_id` | `text` | Optional second party (e.g. message recipient). |
| `correlation_id` | `uuid` **not null** | **The saga id.** See P2. |
| `causation_id` | `bigint` | The `id` of the event that directly caused this one. See P2. |
| `severity` | `text` | `info` \| `success` \| `warn` \| `critical`. |
| `payload` | `jsonb` | Verb-specific body. Carries `schema_version`. |
| `visibility` | `text` | `hq` by default — the audience. |

**Rule:** an event is *append-only* (the spine blocks `UPDATE`/`DELETE` even
under service-role) and is emitted **in the same database transaction** as the
state change it records (the *transactional outbox* rule). No subsystem invents
its own log; they all write here. This is the backbone that resolves the
"three parallel audit logs" conflict (see C5 below): `hq_events` is the **system
of record**; `activity_log` and the various `*_timeline_events` tables become
**projections** of it, not independent truths.

### P2 · The correlation model (one trace across the whole substrate)

A single piece of work — "qualify this lead" — fans out across events, messages,
tasks and memory writes spanning several employees. We stitch it into one trace
with two ids that already exist on `hq_events` and are mandated on every
substrate row that can be traced:

- **`correlation_id` (uuid) — the saga.** Generated *once* at the origin of a
  causal chain (a human action, a cron tick, an inbound webhook). Then
  **propagated unchanged** onto every event, message, task and memory write that
  descends from it. "Show me everything that happened because of request X" is
  `WHERE correlation_id = X`.
- **`causation_id` — the immediate parent.** *What directly caused this?* For an
  event it is the parent event's `bigint id`. For a task or message it is the
  triggering event's id (or a parent task/message id, by the same logic). The
  chain of `causation_id`s is the **causal DAG**; the shared `correlation_id` is
  the **tree it lives in**.

> **Invariant (propagation):** any SDK call that creates a new event/message/
> task/memory write **inherits** the ambient `correlation_id` of the work that
> triggered it. The SDK stamps it automatically (Volume XIII); employees never
> set it by hand. A genuinely new top-level conversation mints a fresh
> `correlation_id`; everything downstream borrows it.

### P3 · The standard AI output envelope

Every AI employee, for every unit of reasoning it produces, returns the **same
shape**. This is the contract the Task Engine stores in `result`, the
Communication Protocol carries in a message body, and the Approval Framework
inspects. It makes *every* AI output explainable, auditable, and uniformly
gateable — independent of which employee produced it.

```jsonc
{
  "summary":      "string — one human-readable sentence: what I concluded/did",
  "reasoning":    "string — why; the chain of thought, in prose",
  "confidence":   0.0,        // 0..1, the employee's calibrated self-estimate
  "evidence":     [           // what the conclusion rests on — by REFERENCE
    { "kind": "memory", "id": "uuid", "note": "research report" },
    { "kind": "event",  "id": 12345 },
    { "kind": "task",   "id": "uuid" }
  ],
  "alternatives": [           // paths considered and rejected, with why
    { "option": "string", "rejectedBecause": "string" }
  ],
  "approvalRequired": false,  // set true if the autonomy test (P4) fails
  "actions": [                // PROPOSED side effects — NOT yet applied
    {
      "tool": "string",       // a registered tool/capability slug
      "args": { },            // typed per the tool's schema
      "reversible": true,     // feeds the autonomy test
      "blastRadius": "low",   // low | medium | high
      "estCostMicros": 0      // metered against the employee's budget
    }
  ]
}
```

Two design rules ride on this shape:

- **Reason before acting.** An employee first emits this envelope (a *proposal*).
  Its `actions` are *not* executed by the act of producing them — they are
  candidate side effects. Whether each one auto-executes or waits for a human is
  decided by P4.
- **Confidence and alternatives are not optional.** Low confidence or weighty
  rejected alternatives are signals the Approval Framework (XIII) and the Task
  Engine's verification step (XII) use to decide escalation.

### P4 · The autonomy test (the one rule that decides "act vs ask")

The Bible says, in one place, *"humans always decide"* and, in another, ships an
**autonomous** lead-qualification employee. Both are right at different stakes.
The substrate reconciles them (conflict **C2**) with a single, mechanical test
applied to **every proposed action** (each entry in `actions[]`):

> An action may execute **autonomously** if and only if **all** hold:
> 1. **Reversible** — it can be undone (or it writes only to HQ-internal,
>    append-or-correctable state), and
> 2. **Low blast radius** — it affects a bounded, known set of subjects, and
> 3. **Type-bounded target** — it acts on a typed, validated target, not an
>    open-ended one, and
> 4. **Within capability scope** — the acting employee holds the capability for
>    this action in the registry (XIII), and
> 5. **Within cost budget** — its metered cost fits the employee's/task's
>    remaining budget (XIII).
>
> If **any** condition fails, the action does **not** execute. Instead the SDK
> raises an **approval checkpoint**: a `waiting_approval` task (XII) carrying the
> proposal, surfaced to a human in HQ, who approves or rejects. Only on approval
> does the action apply.

Anything that sends an email/SMS, spends money, writes to a *customer-facing*
surface, or deletes data is by definition **not** reversible/low-blast-radius
and therefore **always** crosses a human checkpoint. Internal research, scoring,
memory writes, and HQ-only timeline entries are reversible and bounded, so they
may run autonomously — which is exactly why Lead Qualification AI is allowed to
ship autonomous today. The test is the contract that makes that principled
rather than ad hoc.

### P5 · The service-role guardrail doctrine (how "AI never bypasses security" is *true*)

The sharpest conflict in the Bible (C4): it insists *"AI never bypasses
security,"* yet the runners execute under the Supabase **service-role**, which
has `BYPASSRLS`. The substrate's resolution is **structural, not aspirational**:

- Every substrate table is **RLS:hq** — RLS enabled, **zero policies** — so no
  JWT client (anon or authenticated) can ever read or write it; only the
  service-role can. The page wall is the network boundary.
- The service-role is **never** wielded as raw table access by employee code.
  Every write goes through a **`SECURITY DEFINER` SQL function** with a pinned
  empty `search_path`, with `EXECUTE` **revoked from `public`, `anon`,
  `authenticated`** and granted **only to `service_role`** — the exact L-4
  hardening the Event Spine already uses (`hq_emit_event`, `hq_drain_consumer`,
  …). These functions are the **validated entry points**: they enforce shape,
  capability, and audit *inside the database*.
- An **AI employee has no direct database handle at all.** It can only call the
  **SDK** (XIII); the SDK calls these audited entry points. So the "bypass" of
  RLS is a deliberate, narrow, *audited* seam owned by the platform — not a
  capability handed to the AI. The AI is sandboxed *above* the service-role, not
  given it.

> Restated as a one-liner the whole company can hold: **the AI never holds the
> keys; it makes requests to a doorman (the SDK) who checks the rules, opens
> exactly one door, and writes down that it did.**

### P6 · Naming, RLS, and migration conventions

- **Substrate tables are prefixed `hq_ai_*`** (e.g. `hq_ai_messages`,
  `hq_ai_tasks`, `hq_ai_capabilities`). They are HQ-internal: **RLS:hq**
  (enabled, no policies). Partitions, where used, enable RLS in their own right
  (the spine's defence-in-depth rule).
- **Every traceable row carries** `correlation_id uuid` and, where it has a
  parent, `causation_id`. AI-authorable rows carry the traceability triad the
  repo already standardised: `generated_by` (`ai`\|`human`), `model`,
  `ai_employee_id`.
- **Migrations are additive and idempotent** (`create table if not exists`, `add
  column if not exists`, `on conflict do nothing`). A live table a runner
  depends on is never edited in place; new capability arrives as new columns or
  new tables. Lookups (types, verbs, capabilities) are **data, not code** — a new
  kind is an `INSERT`, never a deploy.
- **Entry-point functions** are `SECURITY DEFINER`, `set search_path = ''`,
  `revoke … from public, anon, authenticated`, `grant execute … to
  service_role` — no exceptions.

### P7 · The reuse ledger (what already exists)

So no volume proposes building what is already in the tree:

| Substrate need | Already in the repo | Migration / file |
|----------------|---------------------|------------------|
| Append-only event log + write primitive | `hq_events`, `hq_emit_event` | `20260720000000_hq_event_spine_core.sql` |
| Consumer offsets, drainer, retries, DLQ, replay, golden signals | `hq_event_consumers`, `hq_drain_consumer`, `hq_consumer_retries`, `dead_events`, `hq_replay_consumer`, `hq_spine_golden_signals` | `20260720020000_*`, `..core.sql` |
| Event producers (dual-write triggers) | spine producers | `20260720010000_*` |
| Timeline projection (The Pulse) | `timeline` consumer | `20260720030000_*` / PR5 |
| AI roster + per-employee config/permissions/memory-scope | `ai_employees`, `ai_employee_tasks`, `ai_employee_memory` | `20260712000000_ai_employees.sql` |
| Shared, permission-aware, versioned knowledge store | `hq_memories` + 7 child tables (relationships, employee-links, grants, events, versions) | `20260713000000_hq_shared_memory.sql` |
| Reserved embedding column for semantic search | `hq_memories.embedding_placeholder` | same |
| AI task queue (claim/priority/retry/dedupe/payload/result) | `hq_sales_ai_tasks`, `hq_sales_task_types` | `20260714000001_hq_sales_ai_scale.sql` |
| Per-employee task metrics | `ai_employee_task_metrics` | `20260715000000_*` |
| Two reference employees that already claim & run tasks | Research AI, Lead Qualification AI | `20260718*`, `20260721*` |

The substrate's job is to **generalise** these (sales-scoped → employee-generic),
**wire** them to each other (today they are islands), and **fill the gaps**
(AI-to-AI messaging, live AI-writable memory, capability routing, cost metering,
the unified SDK). Each volume is explicit about which of the three it is doing.

---

## Conflicts this substrate resolves

The adoption analysis catalogued nine contradictions (C1–C9). The substrate is
where the architectural ones are *designed out*. This is the map; each volume
carries the detailed resolution in its own "Conflicts resolved" section.

| # | Conflict | Resolved by | Mechanism |
|---|----------|-------------|-----------|
| **C1** | AI workforce specified 3× with conflicting rosters (13 vs ~30) + numbering collision | XIII | Roster is **data** in `ai_employees`; capabilities are **data** in `hq_ai_capabilities`. Adding/changing employees never contradicts code — both rosters are just different row-sets of one registry. |
| **C2** | "Humans always decide" vs shipped autonomous qualification | P4 + XII + XIII | The **autonomy test**: reversible∧bounded∧in-scope∧in-budget acts autonomously; everything else hits an approval checkpoint task. Principled, mechanical, per-action. |
| **C3** | "Nothing polls" vs 13 cron pollers + unwired Inngest | XI + XII | The **bus** is the event-driven backbone; pollers become **consumers** of `hq_events`; the cron drainer is an implementation detail (a tick that drives push-like delivery), not the architecture. Migration is incremental — pollers are reclassified, not ripped out. |
| **C4** | "AI never bypasses security" vs service-role runners with `BYPASSRLS` | P5 + XIII | The AI holds **no DB handle**; it calls the SDK, which calls **audited `SECURITY DEFINER` entry points**. The bypass is a narrow platform seam, not an AI capability. |
| **C5** | Three parallel audit logs (`activity_log`, `*_timeline_events`, `hq_events`) | P1 + XI + XIII | `hq_events` is the **system of record**; the others become **projections** built by consumers. One truth, many read-models. |
| **C6** | Shared memory is a table+UI, not a live substrate | X | Memory becomes **AI-writable** through the SDK, with typed classes (semantic/episodic/working/long-term/procedural), a retrieval pipeline, and pgvector — a living store, not a CRUD screen. |
| **C7** | "30% Rule" vs a 15-phase roadmap | (governance, not code) | Out of scope for the substrate; flagged for the roadmap reconciliation (analysis §10). Noted so no volume silently assumes one or the other. |
| **C8** | Directives 004/005 already issued | (numbering) | New substrate work is sequenced from **#006+** per the analysis §9; this design block is the content behind the recommended **#007 AI Employee SDK** and **#008 Event Bus** directives. |
| **C9** | Vol VI "Part 2" has no Part 1 | (renumbering) | Folded into the canonical renumber (analysis Appendix A); see the numbering note below. |

---

## A note on volume numbering (the IX–XIII collision)

The CEO named these five volumes **IX–XIII**. The *provided* canon already uses
IX (Engineering Standards), X (Marketing), XI (Sales), and XII (Master Roadmap),
and has two "Volume VII" and two "Volume VIII" collisions besides. So the new
numbers **collide** with existing ones.

**Resolution (provisional, pending the canonical renumber):**

- These five are designed and referenced as a coherent, self-consistent
  **Substrate Block**. Within this directory they are unambiguous: "Volume IX"
  here always means **AI Communication Protocol**, etc.
- The collision is **tracked, not silently overwritten.** The canonical renumber
  proposed in `../adoption-analysis.md` Appendix A is the single place the whole
  Bible's numbering is reconciled. When that renumber is ratified by directive,
  the Substrate Block takes its final numbers there, and the file front-matter
  here is updated to match. Until then, the *titles* are authoritative and the
  *numbers* are provisional — exactly as the CEO used them.
- This honours the standing instruction to *"continue reviewing the Bible for
  contradictions/duplications/renumbering while preserving the vision."* The
  numbering is an open item; the architecture is not blocked on it.

---

## How to read a substrate volume

Each of the five volume documents follows the same skeleton, so a reader can
jump to the same section in any of them:

1. **Purpose & scope** — what this subsystem is, and its one-sentence job.
2. **Where it sits** — its place in the kernel diagram; what it depends on and
   what depends on it.
3. **Built vs. to-build** — the honest ledger against the current repo (P7).
4. **Data model** — tables, columns, constraints, indexes (DDL sketches).
5. **State machines / lifecycle** — the FSMs, with every transition and guard.
6. **Interfaces** — the SQL entry points (P5/P6) and the TypeScript SDK surface.
7. **Flows** — worked sequences (request/response, escalation, retrieval, …).
8. **Failure & recovery** — retries, timeouts, DLQ, crash recovery, escalation.
9. **Security & permissions** — how P5 applies here specifically.
10. **Observability** — golden signals and how they're read.
11. **Testing** — how the six gates prove this subsystem.
12. **Conflicts resolved** — the C-items this volume closes, in detail.
13. **Open questions** — what a future directive must still decide.

---

*Design work under the CEO Directive "Bible Ratification & AI Substrate First"
(2026-06-21). No implementation proceeds from these documents until an explicit
future CEO Directive instructs it. Architecture only — no code, no production
change, no PR.*
