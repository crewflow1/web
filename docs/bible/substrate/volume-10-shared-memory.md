# Volume X — Shared Memory Architecture

> **Substrate Block, document 2 of 5.** Architecture only. Read `./README.md`
> first; this volume uses the shared primitives (P1–P7) and does not redefine
> them.
>
> *Provisional numbering "X" per the CEO directive; collides with the existing
> Marketing volume. Tracked in the canonical renumber.*

---

## 1. Purpose & scope

**The job, in one sentence:** be the single, permission-aware, living store of
*everything CrewFlow's AI workforce knows and remembers* — the company's shared
knowledge **and** each employee's private experience — and serve the *right
slice* of it into any employee's working context on demand.

CrewFlow already has the Shared Memory Engine (`hq_memories` + 7 child tables,
Directive 002): a permission-aware, versioned, full-text-searchable knowledge
store. But it is, today, **read-first**: humans author memories in the HQ UI; AI
employees only *read*; the `embedding_placeholder` column is reserved and never
populated; and nothing assembles memory into a bounded prompt context. It is a
beautiful filing cabinet that the AI cannot yet write to or reason over at scale.

This volume turns that filing cabinet into **virtual memory for the workforce**:
AI employees *write* (their experiences, their working notes, their learned
knowledge) and *recall* (a permissioned, ranked, budgeted retrieval) through the
SDK — with semantic search finally switched on. It is the system that lets a
Sales AI in six months remember an objection a different employee handled today.

**In scope:** the memory typology (semantic / episodic / working / long-term /
procedural; private vs. shared); ownership & the permission matrix; the
retrieval pipeline (the heart of this volume); context-window assembly under a
token budget; compression & consolidation; expiry, decay & eviction; embeddings
/ pgvector activation; the SQL + SDK interface.

**Out of scope (owned elsewhere):** the *transport* of memory references between
employees (IX, by reference); *who* an employee is and what it may read (XIII
identity/permissions, which this volume's matrix is consumed by); the *events*
that become episodic memories (XI); the *tasks* whose lifecycles open and close
working memory (XII).

---

## 2. Where it sits

```
   Comms (IX) ──context_refs──▶ resolveContext() ─┐
   Tasks (XII) ──working notes──▶ remember() ─────┤
   Events (XI) ──episodic source──▶ (consolidation)│
                                                   ▼
                                        ┌──────────────────────┐
                                        │   Shared Memory (X)   │
   SDK (XIII) ──recall(query,ctx)──────▶│  hq_memories (+class, │──ranked,
                                        │  owner, embedding),   │  budgeted,
   SDK (XIII) ──remember(memory)───────▶│  retrieval pipeline,  │  permissioned
                                        │  pgvector, consolidate│  context out
                                        └──────────────────────┘
```

- **Depends on:** SDK (XIII) for the calling employee's identity & permission
  scopes; Event Bus (XI) as the source stream for episodic memory and for
  emitting `memory.*` audit events; Task Engine (XII) for the lifecycle that
  bounds working memory and drives consolidation as a task.
- **Depended on by:** every employee (recall is in almost every task);
  Communication Protocol (IX) context-by-reference; the Approval Framework and
  output `evidence[]` (XIII/P3), which cite memory ids.

---

## 3. Built vs. to-build

| Capability | State | Note |
|------------|-------|------|
| Permission-aware, versioned knowledge record | **Built** | `hq_memories` + `hq_memory_versions`/`_events`/`_relationships`/`_employee_links`/`_access_grants`. |
| Visibility model (public_hq/department/private/restricted/system) + grants | **Built** | enforced in the service layer today; this volume makes it the SDK permission matrix. |
| Full-text search (weighted generated tsvector + GIN) | **Built** | `hq_memories.search_tsv`, `hq_memories_search_idx`. |
| Per-memory timeline incl. `ai_accessed` | **Built** | `hq_memory_events` already models AI reads. |
| Reserved semantic-search column | **Built** · activated D009 M1 PR4 | the original `embedding_placeholder jsonb` (Directive 002) stays *never populated*; PR4 adds a real `embedding vector(1536)` column beside it, so the live ANN is decoupled from the placeholder. |
| Memory **classes** (episodic/working/long-term/procedural) | **Built** · D009 M1 PR1 | additive `memory_class` + lifecycle columns (`owner_employee_id`, `expires_at`, `consolidated_into`, `salience`, `bound_task_id`, `last_reinforced_at`); migration `20260722000000`. The `hq_memory_types` lookup stays data-driven. |
| AI **write** path (employees author memory) | **Built (owned)** · D009 M1 PR2 | `hq_memory_write` commits owned episodic/working/private autonomously; shared-knowledge writes return the NULL sentinel pending the Module 4 approval checkpoint (§6). Migration `20260723000000`; the human write path is untouched. |
| The **retrieval pipeline** (hybrid rank + budget + assembly) | **Built** · D009 M1 PR3 | SQL `hq_memory_recall` does the permissioned stage-1/2 read and returns RAW candidate signals; the pure `rankAndAssemble` (`lib/memory/retrieval.ts`) composes score→diversify→assemble (stages 3–5); `hq_memory_reinforce` reinforces the assembled set + writes the `ai_accessed` audit. Migration `20260724000000`. The semantic ANN channel is switched on in PR4 (§7, §11). |
| **Consolidation / compression / expiry** engines | **Built** · D009 M1 PR5 | the three §9 reduction engines (summarise / consolidate / dedupe→supersede) + the §10 TTL/decay sweep + eviction primitive, driven by a dark background worker (`server/services/memory-lifecycle.ts`, cron `*/15`). Migration `20260727000000`. LLM summarisation is a plug-in (`lib/ai/text/*`), never a dependency. |
| pgvector + the embedding worker | **Built** · D009 M1 PR4 | `vector` extension (pinned to `public`); real `embedding vector(1536)` + the 9 permanent metadata fields; partial HNSW cosine index; a *derived* queue (`embedded_at IS NULL`) drained by a dark background worker. Migrations `20260725000000` (layer) + `20260726000000` (ANN recall). |
| The AI **SDK memory facet** (`ctx.memory`) | **Built** · D009 M1 PR6 | `server/sdk/memory.ts` binds the §12.2 `interface Memory` (recall/remember/resolve/forget/search) to ONE employee — identity stamped on every call (no `actor_id` to spoof), working memory auto-bound to the running task, recalled ids accumulated as the output `evidence[]`. `forget()` is backed by the new `hq_memory_forget` primitive (ownership-checked, versioned, audited, never a hard delete, nothing on The Pulse). Migration `20260728000000`. The rest of the `ctx` ABI (comms/events/tasks/tools/api) is Volume XIII. |

**Net:** the *record, versioning, permission model, FTS and audit are shipped.*
This volume **activates** semantic search, **opens** an AI write path, **adds**
the memory typology, and **builds** the retrieval pipeline that turns storage
into cognition. No existing table is rewritten — every change is additive.

> **As-built — CEO Directive 009 · Module 1 (Shared Memory).** *PR1* added the
> cognitive classes + lifecycle columns and the pure `lib/memory` scorer/budget/
> decay foundation. *PR2* opened the **AI write path** (`hq_memory_write`): an
> employee's owned experience commits autonomously and atomically — row + version
> + per-memory event + a `memory.asserted` Pulse event in **one** transaction;
> shared-knowledge writes are **withheld** (NULL sentinel + `approvalRequired`)
> until the Module 4 Task Engine can host the approval checkpoint. Embeddings
> stay a **plug-in, not a dependency**: the write is byte-identical with or without
> a vector (pgvector was still dormant at PR2 — PR4 activates it, below). *PR3*
> builds the **recall pipeline**
> (`hq_memory_recall` + `hq_memory_reinforce`, migration `20260724000000`): the SQL
> enforces the §6 permission filter as a stage-1 `WHERE` (forbidden rows are never
> scored), does the lexical + structural candidate read, and returns RAW signals
> (`ts_rank`, `structural_match`, token *estimates* — never the body); the pure
> `rankAndAssemble` then scores, diversifies and budget-packs them (stages 3–5)
> with no DB. Recall emits **nothing** on The Pulse — there is no recall verb in the
> registry; an AI read is audited per-memory (`hq_memory_events.ai_accessed`) by
> `hq_memory_reinforce`, which also reinforces decay on the assembled set.
>
> *PR4* lights up the **embedding layer** and the **semantic channel** (migrations
> `20260725000000` + `20260726000000`). pgvector is enabled (pinned to `public`); a
> real `embedding vector(1536)` column + nine permanent metadata fields land on
> `hq_memories`; a *partial* HNSW cosine index backs the probe. Vectors are produced
> by a **dedicated background worker** (`server/services/memory-embedder.ts`, cron
> `*/2`) — never inside a SQL transaction, never on The Pulse — that claims a leased
> batch, embeds it through the configured provider, and stores it atomically; the
> queue is *derived* (`embedded_at IS NULL`), not a side table. `hq_memory_recall`
> gains one trailing `p_query_version` argument and turns its dormant semantic stage
> on: the §6 permission predicate runs in **both** channels, version + dimension
> isolate the comparison to one model's space, and `cos_sim` joins the raw signals.
> Embeddings stay a **plug-in, not a dependency** end to end — with no provider
> configured the worker no-ops and recall is byte-identical to PR3, and the
> application cannot tell semantic is off.
>
> *PR5* builds the **reduction + lifecycle engines** (§9–§10; migration
> `20260727000000`, worker `server/services/memory-lifecycle.ts`, cron `*/15`) —
> the recurring work that keeps the company brain dense, coherent and bounded
> forever. Three reduction engines: **summarisation** (`hq_memory_summary_candidates`
> detects a long under-summarised body and returns it; `hq_memory_set_summary`
> persists + versions + audits it), **consolidation** (`hq_memory_consolidate`
> rolls ≥3 of an employee's themed episodes into ONE private `long_term` lesson),
> and **deduplication** (`hq_memory_dedupe_pairs` finds near-duplicate vectors;
> `hq_memory_supersede` merges the loser away — reversibly). Two lifecycle passes:
> hard-**TTL expiry** + **decay archival** of consolidated episodes below the floor
> (`hq_memory_expire_sweep`), plus a class-guarded **eviction** primitive
> (`hq_memory_archive`). The **event model** is assessed, not assumed: consolidation
> WRITES knowledge → it emits the canonical `memory.asserted`; supersession is a
> business fact → it emits `memory.superseded` (the verb the registry RESERVED at
> the spine's birth, emitted for the first time here); expiry / decay / eviction /
> summarisation are MECHANICAL maintenance → they emit **nothing** on The Pulse,
> audited only per-memory (the widened `hq_memory_events` vocabulary). **DARK by
> default** (`memory_lifecycle.worker_enabled = false`) and a graceful no-op with no
> text provider / no embeddings: consolidation's body is a DETERMINISTIC SQL digest
> (LLM refinement is a later plug-in), and dedupe returns `[]` with no vectors — the
> LLM text seam (`lib/ai/text/*`, PR5c) mirrors the embeddings seam exactly
> (`getTextProvider()` → `null` when unconfigured). The worker drives only the
> mechanical-safe reducers autonomously each tick (expire-sweep → dedupe → summarise);
> **consolidation is exposed** (`consolidateTheme()`) but **not yet auto-driven** —
> there is no theme-discovery / clustering signal yet, so per the standing rule
> (Detect → Design → Expose stable interface → Complete later) the primitive ships
> ready and a future signal turns it on with **no application change**.
>
> *PR6* closes Module 1 by binding everything above into the **`ctx.memory` SDK
> facet** (`server/sdk/memory.ts`, migration `20260728000000`) — the single memory
> surface an AI employee ever touches (§12.2 `interface Memory`). It does not
> re-implement anything: it WRAPS the built service layer (`recallMemory` /
> `rememberMemory` / `forgetMemory`) and stamps the **calling employee's identity
> onto every verb** — there is no parameter anywhere to act as another employee
> (the spoofing class is designed out, XIII §8). Three behaviours the loose
> service functions could not give: working/episodic `remember()` **auto-binds**
> the running task (`bound_task_id`, so the lifecycle worker can expire the
> scratchpad when the task ends); `recall()` + `resolve()` **accumulate** the ids
> they surface so a future RunContext drains them into the output `evidence[]`
> (XIII §10) with zero handler code; and `search()` is the raw escape hatch (ranked,
> no assembly drop, **no** reinforcement — a dedupe probe leaves no audit trail).
> The one missing primitive was **`forget()`**: `hq_memory_archive` (PR5) is
> mechanical eviction (class-guarded, owner-blind, unversioned), so PR6 adds
> `hq_memory_forget` — an employee may forget ONLY memory it OWNS (permission
> re-asserted in SQL, P5), which **archives + versions** it (never a hard delete —
> memory stays an audit subject, §14) and audits an `archived` row stamped with the
> acting employee, emitting **nothing** on The Pulse (there is no forget verb).
> Ownership is the whole guard: an employee only ever owns private/episodic/working
> memory, so this can never touch the owner-less company brain — retracting shared
> knowledge stays a Module 4 approval. This is a **standalone facet, not a whole
> `ctx`**: the full RunContext (identity·memory·comms·events·tasks·tools·api) is
> Volume XIII, a separate module; PR6 builds the memory dimension to its stable
> contract so a future `createContext()` exposes it AS `ctx.memory` with no change
> here ("expose a stable interface, complete later").

---

## 4. The memory typology

Human memory is not one thing, and neither is an AI employee's. The CEO named
four kinds; CrewFlow's existing store is implicitly a fifth. We model them as a
single `memory_class` discriminator on one record (so search, permissions,
versioning and audit are uniform across all of them), with class-specific
columns and lifecycle.

| Class | What it holds | Lifetime | Example | Maps to today |
|-------|---------------|----------|---------|---------------|
| **semantic** | Durable *facts & knowledge* — true regardless of who learned them | Long; versioned | "CrewFlow's construction ICP is 10–250 staff, £2–50m turnover." | **This is what `hq_memories` is today.** |
| **episodic** | A time-stamped *experience an employee had* — "I did X and observed Y at time T" | Medium; decays/consolidates | "On 2026-06-21 I researched Acme Builders and found they use Sage + a manual WhatsApp rota." | new (sourced from `hq_events`) |
| **working** | Short-lived *scratchpad* for an in-flight task; the context-assembly buffer | Ephemeral; **expires with the task** | "Mid-qualification: fit 72, waiting on turnover confirmation." | new |
| **long_term** | *Consolidated, important, durable* knowledge promoted from many episodes | Long; versioned | "Construction firms on legacy accounting + manual scheduling convert ~2× — pattern across 40 leads." | new (promoted) |
| **procedural** | Learned *how-to* — playbooks, skills, repeatable methods | Long; versioned | "Objection-handling playbook for 'we already use a spreadsheet'." | new (a `memory_type`) |

Two orthogonal axes cut across every class:

- **Scope / visibility** (already modelled): `public_hq` (any employee/operator),
  `department`, `private` (owner + grants), `restricted` (grants only), `system`
  (engine-internal). **AI private memory** = `private` + `owner_employee_id` set.
- **Shared company knowledge vs. private experience.** Semantic/long_term/
  procedural with `public_hq`/`department` visibility = the company brain.
  Episodic/working that are `private` to an employee = that employee's lived
  experience. The bridge between them is **consolidation** (§7.2): private
  episodes earn their way into shared knowledge.

> `memory_class` is *additive* to the existing `memory_type` lookup. `memory_type`
> stays the fine-grained, **data-driven** kind (decision, objection, win,
> playbook…); `memory_class` is the coarse cognitive category that drives
> *lifecycle* (expiry, consolidation, retrieval weighting). New types are still
> rows; the five classes are a fixed enum because they drive engine behaviour.

---

## 5. Data model (additive to `hq_memories`)

```sql
alter table public.hq_memories
  -- The cognitive class (§4). Defaults 'semantic' so every existing row keeps
  -- its current meaning with zero backfill.
  add column if not exists memory_class text not null default 'semantic'
    check (memory_class in ('semantic','episodic','working','long_term','procedural')),

  -- Ownership: which AI employee this memory belongs to (private experience).
  -- Null = company-owned (the classic shared memory). FK keeps it honest.
  add column if not exists owner_employee_id uuid
    references public.ai_employees(id) on delete set null,

  -- Working/expiring memory TTL. Null = never expires (semantic/long_term).
  add column if not exists expires_at timestamptz,

  -- Consolidation lineage: when an episodic memory is rolled up into a
  -- long_term one, point at the target so the episode can decay without loss.
  add column if not exists consolidated_into uuid
    references public.hq_memories(id) on delete set null,

  -- Salience: retention/eviction priority (0..100). High-salience working
  -- memory survives pressure; low-salience episodes decay first. Distinct from
  -- `importance` (editorial) and `confidence` (epistemic) already present.
  add column if not exists salience integer not null default 50
    check (salience between 0 and 100),

  -- The bound task for working memory (auto-expire when the task finishes, XII).
  add column if not exists bound_task_id uuid,

  -- Decay bookkeeping for episodic ranking (recency × salience).
  add column if not exists last_reinforced_at timestamptz;

-- pgvector (PR4): activate semantic search. The reserved `embedding_placeholder
-- jsonb` (Directive 002) stays for back-compat; the live vector + its metadata
-- live in their own columns, so the ANN is decoupled from the placeholder. The
-- extension is pinned to `public` because the recall/worker functions run under
-- `search_path = ''` and must schema-qualify the type + operator (`public.vector`,
-- `OPERATOR(public.<=>)`); the pin makes those qualifications correct regardless
-- of the migration session's search_path.
create extension if not exists vector with schema public;
alter table public.hq_memories
  add column if not exists embedding vector(1536),       -- "Version 1" dim; null = not embedded
  -- The 9 PERMANENT metadata fields every embedded memory carries.
  add column if not exists embedding_provider   text,    -- vendor (cost analysis, mixed-provider filtering)
  add column if not exists embedding_model      text,    -- model    (cost analysis)
  add column if not exists embedding_dimension  integer, -- cosine compares only WITHIN a dimension
  add column if not exists embedding_version    text,    -- provider:model:dDIM:vREV — the staleness key
  add column if not exists embedding_checksum   text,    -- SHA-256 of embedded text (idempotency + drift)
  add column if not exists embedded_at          timestamptz,  -- null = THE work queue
  add column if not exists embedding_latency_ms integer,
  add column if not exists embedding_cost       numeric,
  add column if not exists embedding_status     text not null default 'pending'
    check (embedding_status in ('pending','embedded','failed','stale')),
  -- Worker lease / backoff bookkeeping (claim → embed → complete/fail).
  add column if not exists embedding_attempts        integer not null default 0,
  add column if not exists embedding_last_error      text,
  add column if not exists embedding_claimed_at      timestamptz,
  add column if not exists embedding_claimed_by      text,
  add column if not exists embedding_next_attempt_at timestamptz;

-- Lifecycle retrieval indexes (PR1).
create index if not exists hq_memories_class_idx        on public.hq_memories (memory_class);
create index if not exists hq_memories_owner_idx        on public.hq_memories (owner_employee_id)
  where owner_employee_id is not null;
create index if not exists hq_memories_expiry_idx       on public.hq_memories (expires_at)
  where expires_at is not null;
create index if not exists hq_memories_bound_task_idx   on public.hq_memories (bound_task_id)
  where bound_task_id is not null;
-- ANN index (PR4): HNSW cosine, PARTIAL — only embedded rows, so it stays empty
-- until the worker populates it and never indexes a null vector.
create index if not exists hq_memories_embedding_hnsw
  on public.hq_memories using hnsw (embedding vector_cosine_ops)
  where embedding is not null;
-- The derived work queue + re-embed / crash-recovery scans (PR4, all partial so
-- they stay tiny in steady state — index scans at the millions-of-rows scale).
create index if not exists hq_memories_embed_queue_idx
  on public.hq_memories (embedding_next_attempt_at asc nulls first, created_at asc)
  where embedded_at is null and embedding_status <> 'failed';
create index if not exists hq_memories_embed_version_idx
  on public.hq_memories (embedding_version) where embedded_at is not null;
create index if not exists hq_memories_embed_claimed_idx
  on public.hq_memories (embedding_claimed_at) where embedding_claimed_at is not null;
```

No existing column is dropped or retyped; `memory_class` defaults make the whole
change a no-op for current rows (they remain `semantic`, company-owned, never
expiring) — protecting production (directive). The embedding columns are likewise
all-nullable / defaulted, so existing rows become simply "pending" (an empty ANN
index) until the worker embeds them — no backfill, no behaviour change on apply.

> **As-built (D009 M1 PR4).** The embedding columns above ship in migration
> `20260725000000`. Two companions live in the same migration but off this table:
> a `before update` drift trigger (`_hq_memories_embed_requeue`) that clears
> `embedded_at` when `title`/`summary`/`body` change — re-queueing the row while
> KEEPING the old vector searchable until its replacement lands — and
> `hq_embedding_runs`, an append-only per-attempt **cost ledger** (provider, model,
> dimension, tokens, cost, latency, attempt, status, failure reason, worker id).
> Both are RLS:hq (service-role only). Every embedding write goes through the SQL
> primitives in §12.1, never raw DML.

---

## 6. Ownership & the permission matrix

Memory is the most sensitive substrate — it is the company's brain. The
permission matrix is enforced **at every read and write through the SDK** (X is
never touched by employee code directly; P5). It composes the existing
`visibility` + `hq_memory_access_grants` with the new `owner_employee_id`.

**Read.** An employee *E* may read a memory *M* iff any holds:
- `M.visibility = 'public_hq'`; or
- `M.visibility = 'department'` and `E.department = M.department`; or
- `M.visibility ∈ ('private','restricted')` and (`M.owner_employee_id = E` or a
  grant in `hq_memory_access_grants` matches *E* or *E*'s department); or
- *E* is an HQ operator context (human super-admin) — full read.
- `system` visibility is **never** surfaced to an AI (engine-internal only).

**Write.** An employee *E* may:
- **create** `episodic`/`working`/`private` memory it **owns** — autonomously
  (reversible, bounded → passes P4);
- **create or update** `semantic`/`long_term`/`procedural` *shared* knowledge
  only as a **proposal** — this changes the company brain, so it is **not**
  trivially reversible/low-blast-radius and therefore hits an **approval
  checkpoint** (P4 → a `waiting_approval` task, XII) *unless* the employee holds
  an explicit `memory.write.shared` capability scope (XIII) for that
  department/type;
- **never** edit another employee's private memory, or `system` memory.

> **As-built (D009 M1 PR2).** The autonomous branch is live in `hq_memory_write`.
> The shared-knowledge approval checkpoint has no host until the Module 4 Task
> Engine (XII) exists, so a shared write *without* the capability does **not**
> touch the company brain: the function returns the NULL sentinel and the SDK
> surfaces `approvalRequired`. Wiring the `waiting_approval` task later changes no
> caller code — the `{ id, approvalRequired }` contract (§12.2) is already the
> surface. The pure mirror of this rule is `lib/memory/model.ts decideMemoryWrite`
> (unit-tested); the SQL function is the atomic gate, and an integration test pins
> the two in agreement across the §6 matrix.

Every read by an AI writes an `ai_accessed` row to `hq_memory_events` (already
modelled) and increments `access_count`/`last_accessed_at` — a **per-memory**
audit trail and a retrieval signal (popular memories rank up). Reads do **not**
broadcast on The Pulse: there is deliberately **no** `memory.read`/`memory.recalled`
verb in the registry, so recall — the most-called operation — never floods the
event bus. Every *write*, by contrast, emits the **registered** `memory.asserted`
verb on the Event Bus and snapshots a `hq_memory_versions` row. *(The frozen verb
registry in `lib/events/registry.ts` is the source of truth; an earlier draft of
this volume wrongly mirrored reads as a `memory.read` bus event and named the
write `memory.written` — both corrected here as-built, D009 M1 PR2/PR3.)*

---

## 7. The retrieval pipeline (the heart)

`recall(query, employee, taskContext, budget)` is the single most-called
substrate operation. It must return *the right knowledge, that this employee is
allowed to see, ranked by usefulness, compressed to fit a token budget, with
provenance* — fast, at millions of rows. Six stages:

```
 query + employee + task context + token budget
        │
        ▼
 ┌────────────────────────────────────────────────────────────────────┐
 │ 1. PERMISSION FILTER  — reduce the corpus to what `employee` may read │
 │    (§6). A SQL predicate, applied FIRST so nothing forbidden is ever  │
 │    scored or returned. Non-negotiable, not a post-filter.            │
 ├────────────────────────────────────────────────────────────────────┤
 │ 2. CANDIDATE RETRIEVAL  — hybrid recall over the permitted corpus:    │
 │    a. lexical  : FTS over search_tsv (ts_rank)        — exact terms    │
 │    b. semantic : ANN over embedding (cosine)          — meaning        │
 │    c. structural: relationships/links to the task's subject (graph)   │
 │    Union the top-K of each (K≈50) into a candidate set.              │
 ├────────────────────────────────────────────────────────────────────┤
 │ 3. SCORE & RANK  — one blended score per candidate:                  │
 │    score = w_sem·cos_sim + w_lex·ts_rank + w_rec·recency             │
 │          + w_sal·(salience/100) + w_imp·importance + w_pop·log(access)│
 │          + w_pin·pinned + w_rel·structural_match                     │
 │    weights are per-class & tunable; pinned/critical floor-boost.     │
 ├────────────────────────────────────────────────────────────────────┤
 │ 4. DIVERSIFY & DEDUPE  — drop near-duplicates (cosine > 0.95),        │
 │    prefer the latest version, spread across memory_types so the       │
 │    context isn't 10 paraphrases of one fact (MMR-style).             │
 ├────────────────────────────────────────────────────────────────────┤
 │ 5. CONTEXT-WINDOW ASSEMBLY  — greedily pack highest-score memories    │
 │    into the token budget (§8); summarise overflow (§9) rather than    │
 │    truncate; always include pinned + the task's own working memory.  │
 ├────────────────────────────────────────────────────────────────────┤
 │ 6. RETURN WITH PROVENANCE  — each item carries {id, type, class,      │
 │    score, version}; the SDK records the recall as evidence refs (P3)  │
 │    and writes ai_accessed audit. Reinforce returned memories          │
 │    (last_reinforced_at = now) so used knowledge decays slower.       │
 └────────────────────────────────────────────────────────────────────┘
```

Design rules:
- **Permission before scoring (stage 1 first).** A forbidden memory is never
  embedded in a ranking it could leak through. This is the security spine of
  retrieval (P5).
- **Hybrid, not vector-only.** Construction-domain queries mix exact tokens
  (a company name, "CIS", "Sage") with meaning ("firms that struggle to schedule
  crews"). Lexical FTS (already built) + semantic ANN (new) + the relationship
  graph (already built) each catch what the others miss.
- **Recall is itself evidence.** Returned ids flow into the output envelope's
  `evidence[]` (P3), so every AI conclusion is traceable to the exact memories it
  rested on — closing the loop between memory and auditability.
- **Reinforcement.** Memories that get recalled are *used*; bumping
  `last_reinforced_at` makes the decay model (§10) keep useful knowledge and let
  unused episodes fade — a usage-weighted brain.

> **As-built (D009 M1 PR3).** Stages 1–2 live in SQL (`hq_memory_recall`): the
> permission predicate is the stage-1 `WHERE` (so `system` and any non-permitted
> row is never even scored), then a lexical (`ts_rank` over `search_tsv`) +
> structural (relationship / own-working) candidate read returns up to `p_limit`
> rows as RAW signals — crucially a `body_tokens` *estimate*, never the body, so
> the knapsack packs without shipping the corpus. Stages 3–5 are the pure
> `rankAndAssemble` (`lib/memory/retrieval.ts`): `scoreCandidate` → `diversify` →
> `assembleContext`, fully DB-free and deterministic. Stage 6's reinforcement +
> `ai_accessed` audit is `hq_memory_reinforce`, applied to the *assembled* set
> only. The semantic ANN channel (2b) and the `cos_sim` term were a dormant seam
> in PR3 — the scorer treats a missing embedding as 0, so ranking is identical with
> or without it; PR4 lights them up (see the next note). **Supersession is resolved
> by presence, not score order:** an episode whose `consolidated_into` target is in
> the candidate set is dropped even when the fresh episode out-scores the durable
> consolidation that rolls it up —
> "prefer the latest version" (stage 4) is a hard lineage fact, not a ranking
> tie-break, and it collapses version chains correctly.

> **As-built (D009 M1 PR4).** Stage 2b is now live (migration `20260726000000`).
> `hq_memory_recall` gains a trailing `p_query_version`; when the service passes a
> query vector AND its version it adds a top-k cosine probe (`OPERATOR(public.<=>)`
> over the partial HNSW index) as a SECOND candidate source — UNIONed with the
> lexical/structural set, purely ADDITIVE (it never narrows or replaces it). Stage 1
> is re-applied as an inline base-table `WHERE` INSIDE the ANN set so the index
> backs `ORDER BY … LIMIT` (routing the probe through a CTE/join would materialise
> the permitted set and defeat HNSW — fatal at scale); the two permission predicates
> are kept textually identical and the security gate asserts both exist, so a vector
> inherits its memory's permissions and semantic can never surface a row the
> employee couldn't already read. `cos_sim` is computed only for a candidate whose
> `embedding_version` + `embedding_dimension` match the probe (a CASE short-circuit,
> so `<=>` never runs on a mismatched row) — cosine therefore only ever compares one
> model's space; a row not yet re-embedded to the current version contributes no
> semantic signal (a graceful coverage ramp, never an outage). With no probe — no
> provider, or a blank query — the function is byte-identical to PR3. The query
> VECTOR and its VERSION are generated INTERNALLY by `recallMemory` from the active
> provider (§11/§12.2); the SDK contract (`query`, not a raw vector) is unchanged.

---

## 8. Context windows

The retrieval budget is a **token budget**, not a row count, because what an
employee can reason over is bounded by the model's context window minus its
prompt, tools, and the task payload. Assembly (stage 5) is a bounded knapsack:

- **Budget** = `model_context − system_prompt − task_payload − response_reserve`.
  The SDK supplies it from the employee's model config (XIII).
- **Priority tiers** packed in order until the budget is spent:
  1. **Always-in**: the task's own `working` memory + any `pinned` memory in
     scope (these are not negotiable context).
  2. **Top-ranked semantic/long_term/procedural** for the query.
  3. **Recent episodic** for this employee + subject.
  4. **Structurally linked** memories (relationships to the subject).
- **Overflow → summarise, don't truncate (§9).** A high-scoring 4 KB memory that
  doesn't fit whole is replaced by its stored/last-generated summary (the record
  already has a `summary` field), preserving the signal at a fraction of the cost.
- **Token accounting** uses the model's tokenizer; the SDK returns the assembled
  context *and* a manifest (what was included, what was summarised, what was
  dropped) for observability and for the evidence trail.

---

## 9. Compression & consolidation

Three reduction engines keep the brain dense and affordable. Each is a recurring
**Task** (XII), not a poller (C3), and each is idempotent.

1. **Summarisation (per memory).** When a memory's `body` exceeds a length
   threshold, generate/refresh its `summary` (a `summarise.memory` task). The
   summary is what context-assembly uses under pressure (§8). Versioned, so the
   original is never lost.
2. **Consolidation (episodic → long_term).** Periodically cluster an employee's
   (or a department's) episodic memories about a theme and roll them into one
   `long_term` memory that generalises the pattern, linking the sources via
   `consolidated_into`. The episodes can then decay (§10) without losing the
   lesson. *This is the bridge from private experience to shared knowledge* —
   the consolidated `long_term` memory is proposed as `public_hq`/`department`
   (which, per §6, crosses an approval checkpoint before it becomes company
   canon). Example: forty "they balked at price then converted after the ROI
   demo" episodes consolidate into one procedural objection-handling playbook.
3. **Deduplication.** Detect near-duplicate memories (cosine > 0.95 within a
   type/scope), merge them (keep the highest-confidence/latest, relink
   references, archive the rest as `superseded`), so the corpus doesn't bloat
   with paraphrases. Conservative: merges are versioned and reversible.

> **As-built (D009 M1 PR5).** All three engines exist, idempotent, each split into
> a READ-ONLY detector + an atomic APPLY primitive so the external LLM call can live
> in TS, OUTSIDE any SQL transaction (the spine's no-IO-in-txn rule). The policy
> numbers live in ONE pure place (`lib/memory/lifecycle.ts`) and the SQL uses those
> EXACT literals, pinned equal by the security gate.
>
> - **Summarisation.** `hq_memory_summary_candidates(limit)` returns each long
>   under-summarised memory WITH its body (bounded to the leading 24 000 chars, plus
>   the true `body_chars`) — everything the worker needs in ONE read, no second
>   round-trip. "Under-summarised" == `needsSummary`: `body ≥ SUMMARY_MIN_BODY_CHARS`
>   (1200) AND the summary is empty OR still ≥ `SUMMARY_MAX_RATIO` (0.6) of the body
>   (so it saves nothing). `hq_memory_set_summary(id, text)` persists it, bumps the
>   version + snapshots, audits `summarised`, and — because changing the summary trips
>   the PR4 drift trigger — the row is automatically re-embedded from the better text.
>   The worker computes the text via the PR5c provider when configured and SKIPS the
>   write if the result is empty or not actually shorter (the ratio guard again, now
>   on the candidate's true `body_chars`).
> - **Consolidation.** `hq_memory_consolidate(employee, theme)` gathers the employee's
>   OWN active, unconsolidated episodic memories whose `search_tsv` matches the theme;
>   below `MIN_CONSOLIDATION_SOURCES` (3) it is noise → NULL no-op. Otherwise it writes
>   ONE **private, owner-scoped** `long_term` lesson (autonomous per §6) with a
>   DETERMINISTIC SQL digest body, points every source's `consolidated_into` at it (the
>   sources are NOT archived — they keep decaying and §10 archives them later, lesson
>   preserved), snapshots version 1, audits `created` + one `consolidated` per source,
>   and emits `memory.asserted`. Naturally idempotent: consolidated sources drop out of
>   the candidate set, so a re-run on the theme finds < 3 fresh and no-ops. The lesson
>   is private; **promoting it to shared** (`public_hq`/`department`) is the §6 approval
>   checkpoint owned by the Module 4 Task Engine — deferred, no caller change when it
>   lands. The worker exposes this as `consolidateTheme()` but does NOT call it on the
>   autonomous tick (no theme-discovery signal yet — see the §3 PR5 note).
> - **Deduplication.** `hq_memory_dedupe_pairs(limit, threshold)` is read-only: for a
>   bounded batch of embedded active rows it probes the HNSW index for each row's single
>   nearest CO-SCOPED neighbour (same type / visibility / department / owner AND same
>   embedding version + dimension — vectors compared only within one model's space),
>   keeps pairs above `DEDUPE_COSINE_THRESHOLD` (0.95), labels the survivor with the
>   EXACT `chooseDedupeKeeper` rule (highest confidence, then most recent, then smaller
>   id), and collapses unordered dupes. With no embeddings there are no vectors → `[]`,
>   a graceful no-op (embeddings are a plug-in). `hq_memory_supersede(keep, drop, reason)`
>   is the atomic, REVERSIBLE apply: relinks inbound memory-edges drop→keep, repoints any
>   `consolidated_into` the drop → keep, records a `superseded_by` lineage breadcrumb,
>   bumps the drop's version + snapshots it `status='superseded'`, audits `superseded`,
>   and emits `memory.superseded`. Idempotent via the `status='active'` guard on the drop.
>
> **The text/LLM seam is a plug-in, not a dependency** — `lib/ai/text/*` (PR5c) mirrors
> the embeddings seam: `getTextProvider()` is the ONE place that knows the vendor and
> returns a `TextProvider` (`{ info, generate(prompt, opts) }`) or `null`. Selection is
> configuration only — `MEMORY_TEXT_PROVIDER` (default `auto`: Anthropic key, else OpenAI
> key, else `null`); an unknown name or missing key degrades to `null`, never a crash.
> `null` IS the contract: provider present → summaries are LLM-written; provider null →
> the engines still run (deterministic digest, no summary) and nothing outside can tell.

---

## 10. Expiry, decay & eviction

Memory that never forgets is memory that can't think (and can't afford its
storage/embedding bill). Retention is **by class**:

| Class | Retention policy |
|-------|------------------|
| **working** | Hard TTL via `expires_at` **and** auto-expire when `bound_task_id` completes/fails (XII emits `task.finished` → a consumer expires the working memory). Never consolidated. |
| **episodic** | Soft **decay**: `effective_score = base × e^(−age/τ) × (salience/100) × reinforcement`. Once it falls below a floor *and* is `consolidated_into` something (its lesson is preserved), it is archived (`status='archived'`), not deleted. Unconsolidated high-salience episodes persist. |
| **semantic / long_term / procedural** | **Never auto-expire.** They are the company brain. Superseded by versioning or explicit human archival only. |
| **system** | Engine-internal retention (e.g. embedding job bookkeeping), not surfaced. |

**Eviction under pressure** (storage/cost budgets) drops lowest *effective_score*
working/episodic first, never touches shared knowledge, and is fully audited
(`memory.expired`/`memory.archived` events). The expiry sweep is a recurring task
reading `hq_memories_expiry_idx` — idempotent (re-expiring an expired memory is a
no-op).

> **As-built (D009 M1 PR5).** `hq_memory_expire_sweep(now, limit)` is the autonomous
> driver the cron calls each tick — fail-dark on `memory_lifecycle.worker_enabled`
> (returns `{skipped:'worker_disabled', ttl_expired:0, decayed_archived:0}` while off).
> It runs two bounded, idempotent passes as SEPARATE statements (a row matching both is
> archived once — the second pass sees the first's status change and skips it), each
> guarded by `status='active'` so a re-run never re-archives:
>
> - **(a) TTL expiry** — `working`/`episodic` past `expires_at` → `status='archived'`,
>   audited `expired`. A class guard is belt-and-suspenders: a durable memory can never
>   be archived by the clock even if a bug set its `expires_at`.
> - **(b) Decay archival** — `episodic` that is ALREADY `consolidated_into` something
>   (its lesson is preserved) AND whose retention score has fallen below `DECAY_FLOOR`
>   (0.05) → `archived`, audited `archived`. The score is
>   `e^(−age/τ) · salience/100` with τ = 30 days, age clamped ≥ 0 — byte-for-byte the
>   pure `shouldArchiveEpisodic`. An UNCONSOLIDATED episode is NEVER decay-archived,
>   however old (dropping it would lose its lesson); durable classes are never touched.
>
> **Eviction** is `hq_memory_archive(id, reason)` — a deliberate single-row primitive
> (the worker computes WHICH rows with the pure `evictionPlan`, lowest-score ephemeral
> first, and calls this per id). Durable company-brain classes are STRUCTURALLY
> un-evictable: the `memory_class IN ('working','episodic')` guard means a
> semantic/long_term/procedural id can never be archived by this path, however it is
> called. Active storage-pressure detection is a future signal; the stable primitive is
> ready for it (Detect → Design → Expose → Complete). **Event-model correction:** the
> design's `memory.expired`/`memory.archived` are realised as per-memory
> `hq_memory_events` rows (`expired`/`archived`), NOT Pulse verbs — expiry, decay and
> eviction are mechanical maintenance and broadcast nothing (only supersession +
> consolidation are business facts on the bus). Every transition stays reversible +
> traceable without flooding the spine.

---

## 11. Embeddings / pgvector

Built in PR4 (migrations `20260725000000` + `20260726000000`; `lib/ai/embeddings/*`
+ `server/services/memory-embedder.ts`). The governing rule is the directive's:
**embeddings are a plug-in, not a dependency.** Every interface above works with
no embeddings at all; configuring a provider makes semantic search appear with no
application-code change, and nothing can tell from the outside whether it is on.

**The provider seam.** `getEmbeddingProvider()` (`lib/ai/embeddings/index.ts`) is
the ONE place that knows the vendor. It returns an `EmbeddingProvider` — `{ info:
{ provider, model, dimension, version }, embed(texts, { signal }) }` — or `null`.
Selection is **configuration only**: `MEMORY_EMBEDDING_PROVIDER` names the vendor
(default `openai`) and the vendor's own key gates it; an unknown name or a missing
key degrades to `null`, never a crash. Adding Anthropic / Voyage / Azure / a local
model is a `case` here plus a sibling file — the Memory Engine never changes. That
`null` IS the degradation contract: provider present → semantic recall + the worker
switch on; provider null → semantic is simply unavailable and permission / lexical
/ structural / ranking / assembly all keep working.

**pgvector pin + schema qualification.** The extension is created `with schema
public` (§5). The recall and worker functions pin `search_path = ''` for injection
safety, so they reference the type and operator schema-qualified — `public.vector`,
`OPERATOR(public.<=>)` (cosine distance). The float8 array crosses the boundary as
`p_query_embedding::real[]::public.vector`. An unqualified `vector` / `<=>` would
not resolve at runtime — the pin is what makes the qualifications deterministic.

**Embeddings are VERSIONED ASSETS.** Every embedded row permanently stores the
nine metadata fields (§5). The canonical staleness key is the composite
`embedding_version` = `provider:model:dDIM:vREV` (`embeddingVersion()`), so a
SINGLE comparison detects a provider, model, dimension, OR quality change
(`EMBEDDING_SCHEMA_REVISION` is the manual lever for a quality bump with no model
swap). A SHA-256 `embedding_checksum` of the exact embedded text gives idempotency
("text unchanged ⇒ vector already correct, skip") and content-drift detection.

**Embedding is NOT a business event, and the queue is DERIVED.** Generating a
vector is mechanical bookkeeping, not company history: nothing in the embedding
path touches the Event Spine — no `hq_emit_event`, no `memory.*` verb, nothing on
The Pulse. (The business event is `memory.asserted`, emitted by the *write*, PR2;
the embedding it eventually triggers is invisible to the bus.) There is **no
enqueue table** to drift out of sync: a memory needs embedding iff `embedded_at IS
NULL`, driven by a tiny partial index. New rows start pending; the §5 drift trigger
re-queues a row whose `title`/`summary`/`body` changes (clearing `embedded_at`
while leaving the old vector in place).

**The worker** (`runEmbeddingWorker`, cron `GET /api/cron/memory-embed`, schedule
`*/2 * * * *`, `maxDuration 60`). An external provider call must never run inside a
Postgres transaction (spine D1), so the loop is the seam between SQL and TS:

```
reclaim crashed leases (SQL)
  → for each batch, up to maxBatches:
       claim a lease  (hq_embedding_claim_batch, FOR UPDATE SKIP LOCKED)   — SQL
       embed it       (provider.embed(inputs, { signal }))   — TS, OUTSIDE any txn
       store / retire (hq_embedding_complete | hq_embedding_fail)          — SQL
```

It is **dark by default and degrades**: gate off (`memory_embedding.worker_enabled
= false`, seeded in `hq_settings`) → one cheap RPC, no work; no provider → no work,
recall keeps serving lexical/structural. It **never throws** — a provider hiccup is
recorded per-memory and reported in the run summary, never raised into the cron.
Every resilience property the directive named is present: **batching** (default 32);
**retry + exponential backoff** (`min(2^attempts·30s, 1h)`) and **dead-letter**
after `maxAttempts` (default 5; status `'failed'` drops out of the queue — the row
stays fully recallable via lexical/structural, only semantic is unavailable);
**idempotency + crash recovery** via a persisted **lease** (`embedding_claimed_at`/
`_by`) with a `claimed_by` guard on complete/fail (a late finisher whose lease was
reclaimed is a no-op, never a duplicate) and `hq_embedding_reclaim_stale` for
resume-after-restart; **concurrency** via `SKIP LOCKED` + a per-run worker id;
**cost limiting** (`maxCostUsd`, default 5) and a **wall-clock deadline**
(`maxRunMs`, default 50 000, under the 60 s ceiling); **cancellation** (an
`AbortSignal` per provider call); and a defensive dimension/finite-value guard so a
corrupt vector dead-letters instead of poisoning the ANN index.

**Re-embedding is designed in, not bolted on.** A model/quality upgrade is a
**config change + a re-embed**, never a redesign: bump the provider config (or
`EMBEDDING_SCHEMA_REVISION`), then `hq_embedding_enqueue_stale(target_version,
limit)` walks embedded rows whose version differs and clears `embedded_at` in
bounded batches — **leaving the old vector + version in place**, so old vectors stay
searchable until the worker computes the replacement and `hq_embedding_complete`
swaps it in atomically (one UPDATE: vector + all metadata + lease cleared). A
million-row migration is paced over many background runs; coverage ramps, recall
never goes dark. `hq_embedding_reset_failed` drains the dead-letter once a root
cause (bad key, outage) is fixed.

**Cost accounting.** `hq_embedding_runs` records one row per attempt (success or
failure) with provider, model, dimension, tokens, cost, latency, attempt, status,
failure reason, worker id — the full history; the per-memory columns hold the
latest outcome. Token attribution splits the provider's authoritative batch usage
across inputs by an estimate; pricing (`embeddingCostUsd`) is provider METADATA, and
an unpriced model still embeds (cost recorded as unknown — cost is observability,
never a correctness gate).

**Recall integration.** `recallMemory` (`server/services/hq-memory.ts`) asks
`getEmbeddingProvider()` for a probe ITSELF, embeds the trimmed query under a short
abort timeout, and forwards `(vector, version)` to `hq_memory_recall`. Any failure —
no provider, blank query, provider throw/timeout, wrong-shape vector — yields a null
probe and lexical/structural recall, so the caller's request always succeeds. There
is no query-embedding parameter on the SDK; the stable contract is `query`.

---

## 12. Interfaces

### 12.1 SQL entry points (P5: `SECURITY DEFINER`, `search_path=''`, service-role-only)

```
hq_memory_recall(p_employee_id uuid, p_query text, p_query_embedding float8[],
                 p_subject_kind text, p_subject_id text, p_class_filter text[],
                 p_limit int, p_query_version text) returns jsonb
    -- BUILT — D009 M1 PR3, semantic channel switched on PR4d. Stages 1–2 of the
    -- pipeline (§7): the §6 permission filter is the stage-1 WHERE (forbidden/
    -- system rows are never scored), then lexical (ts_rank) + structural candidates
    -- UNIONed with the optional semantic ANN set. Returns up to p_limit RAW
    -- candidates as jsonb (signals only — ts_rank, structural_match, cos_sim, a
    -- body_tokens estimate, never the body); the pure rankAndAssemble scores/
    -- diversifies/budgets them (stages 3–5), so there is NO p_token_budget here.
    -- The trailing p_query_version (added PR4d; PR3 calls still resolve via the
    -- default) ARMS semantic only WITH a vector: a top-k OPERATOR(public.<=>) probe
    -- over the partial HNSW index, permission re-applied inline, filtered to the
    -- query's exact embedding_version + dimension (one model's space). Null probe ⇒
    -- byte-identical to PR3. The version is derived internally from the active
    -- provider, never supplied by the caller — the SDK surface is unchanged.

hq_memory_write(p_employee_id uuid, p_class text, p_type text, p_title text,
                p_summary text, p_body text, p_visibility text, p_owner uuid,
                p_salience int, p_expires_at timestamptz, p_bound_task_id uuid,
                p_correlation_id uuid, p_context jsonb) returns uuid
    -- AI write path (BUILT — D009 M1 PR2). Enforces §6 write rules: autonomous
    -- for owned private/episodic/working. A shared semantic/long_term/procedural
    -- write *without* the `memory.write.shared` scope returns the NULL sentinel
    -- (a proposal withheld); the `waiting_approval` task is opened by the Module 4
    -- Task Engine (XII) when it exists — no caller change then. Snapshots a
    -- version, writes the per-memory event, and emits the registered
    -- `memory.asserted` on The Pulse in the SAME transaction. Embeddings are a
    -- plug-in: this function writes NO embedding column and emits NO embed event —
    -- the new row is simply pending (embedded_at IS NULL), and the PR4 background
    -- worker (§11) picks it off the DERIVED queue out-of-band. Embedding is not a
    -- business event, so it never rides this (or any) transaction.

hq_memory_reinforce(p_employee_id uuid, p_memory_ids uuid[]) returns void
    -- BUILT — D009 M1 PR3. Applied to the ASSEMBLED set: bumps last_reinforced_at
    -- (slows decay, §10), increments access_count, and writes one per-memory
    -- ai_accessed row to hq_memory_events attributed to p_employee_id — the audit
    -- home for AI reads (NOT a Pulse verb; recall never broadcasts).

-- The embedding worker primitives (BUILT — D009 M1 PR4, §11). The external
-- provider call lives in TS (server/services/memory-embedder.ts); these are the
-- atomic SQL halves of claim → embed → complete/fail. All SECURITY DEFINER,
-- search_path='', service-role-only. None touches the Event Spine.
hq_memory_embed_enabled() returns boolean
    -- The worker kill-switch read (memory_embedding.worker_enabled). Fail-dark.
hq_embedding_claim_batch(p_worker_id text, p_limit int, p_lease_seconds int) returns jsonb
    -- Lease a batch off the DERIVED queue (FOR UPDATE SKIP LOCKED); returns each
    -- id + the composed embed_input. No-op jsonb when the gate is off.
hq_embedding_complete(p_memory_id uuid, p_worker_id text, p_embedding float8[],
                      p_provider text, p_model text, p_dimension int, p_version text,
                      p_checksum text, p_tokens int, p_cost numeric, p_latency_ms int) returns jsonb
    -- The ATOMIC swap: one UPDATE writes the vector (::real[]::public.vector) + all
    -- metadata + clears the lease. Lease-guarded (claimed_by) ⇒ a late finisher is
    -- a no-op, never a duplicate. Appends a 'succeeded' hq_embedding_runs row.
hq_embedding_fail(p_memory_id uuid, p_worker_id text, p_provider text, p_model text,
                  p_error text, p_max_attempts int) returns jsonb
    -- Record a failed attempt: exponential backoff (next_attempt_at) or dead-letter
    -- (status='failed') at the threshold. Lease-guarded. Appends a 'failed' run.
hq_embedding_reclaim_stale(p_lease_seconds int, p_limit int) returns int
    -- Crash recovery: free expired leases so their rows are claimable again.
hq_embedding_enqueue_stale(p_target_version text, p_limit int) returns int
    -- Re-embed driver: re-queue embedded rows whose version != target, in bounded
    -- batches, LEAVING the old vector searchable until atomic replacement (§11).
hq_embedding_reset_failed(p_limit int) returns int
    -- Drain the dead-letter once a root cause is fixed (bounded).
hq_embedding_golden_signals(p_target_version text) returns jsonb -- §13

-- The lifecycle + reduction primitives (BUILT — D009 M1 PR5, §9–§10). The external
-- LLM call lives in TS (server/services/memory-lifecycle.ts); these are the atomic
-- SQL halves. All SECURITY DEFINER, search_path='', service-role-only. Only
-- consolidate + supersede touch the Event Spine (memory.asserted / memory.superseded).
hq_memory_lifecycle_enabled() returns boolean
    -- The worker kill-switch read (memory_lifecycle.worker_enabled). STABLE, fail-dark.
    -- The ONLY gate protecting the ungated apply primitives below — the TS worker checks
    -- it FIRST each tick, and the autonomous sweep/consolidate also self-gate (defence
    -- in depth). Mirrors hq_memory_embed_enabled().
hq_memory_expire_sweep(p_now timestamptz, p_limit int) returns jsonb
    -- §10. The autonomous TTL + decay driver, fail-dark on the gate. Two bounded,
    -- idempotent passes as SEPARATE statements: (a) working/episodic past expires_at →
    -- 'archived'/audit 'expired'; (b) consolidated episodic whose e^(−age/τ)·salience/100
    -- (τ=30d, floor 0.05) < DECAY_FLOOR → 'archived'/audit 'archived'. Unconsolidated
    -- + durable classes spared. Returns {ttl_expired, decayed_archived, …}. No Pulse.
hq_memory_consolidate(p_employee_id uuid, p_theme text) returns uuid
    -- §9.2. AUTONOMOUS company-brain write, fail-dark (NULL when disabled). Clusters the
    -- employee's OWN active unconsolidated episodic by theme (search_tsv); < 3
    -- (MIN_CONSOLIDATION_SOURCES) ⇒ NULL no-op. Else writes ONE private long_term lesson
    -- (deterministic SQL digest body — LLM refinement is a later plug-in), links sources
    -- via consolidated_into (NOT archived), v1 snapshot, audits created + consolidated,
    -- emits memory.asserted. Idempotent. Exposed as consolidateTheme(); not on the tick.
hq_memory_dedupe_pairs(p_limit int, p_threshold float8) returns jsonb
    -- §9.3 detection (READ-ONLY, no gate). For a bounded batch of embedded active rows,
    -- probes the HNSW index for each row's nearest CO-SCOPED neighbour (same type/
    -- visibility/department/owner + same embedding version+dimension) and returns the
    -- pairs above p_threshold (default 0.95) with the chooseDedupeKeeper survivor labelled
    -- ({keep_id, drop_id, cos_sim}). No embeddings ⇒ [] (graceful no-op).
hq_memory_supersede(p_keep_id uuid, p_drop_id uuid, p_reason text) returns jsonb
    -- §9.3 apply (atomic, REVERSIBLE, not gated — the worker self-gates). Relinks inbound
    -- edges drop→keep, repoints consolidated_into drop→keep, records a superseded_by
    -- lineage edge, bumps the drop's version + snapshots it status='superseded', audits
    -- 'superseded', emits memory.superseded (the long-reserved verb). Idempotent via the
    -- drop's active-status guard; a non-active keeper is refused.
hq_memory_summary_candidates(p_limit int) returns jsonb
    -- §9.1 detection (READ-ONLY, no gate), the SQL twin of needsSummary. Returns
    -- [{id, title, body, body_chars, summary_chars}] — body bounded to its leading 24000
    -- chars so the worker summarises in ONE read (body_chars still the true length for the
    -- ratio guard). Detects body ≥ 1200 with an empty OR ≥ 0.6×body summary.
hq_memory_set_summary(p_memory_id uuid, p_summary text) returns jsonb
    -- §9.1 apply (not gated). Persists the summary, bumps version + snapshots, audits
    -- 'summarised'. The PR4 drift trigger re-embeds the row from the improved text. No
    -- Pulse (mechanical). Idempotent-safe via the active-status guard; empty text refused.
hq_memory_archive(p_memory_id uuid, p_reason text) returns jsonb
    -- §10 eviction primitive (not gated). Class-guarded: only working/episodic can be
    -- archived by this path — durable company-brain classes are structurally un-evictable.
    -- Audits 'archived', no Pulse. Idempotent via the active-status guard.
hq_memory_golden_signals() returns jsonb                -- §13
```

### 12.2 TypeScript SDK surface (XIII)

```ts
interface Memory {
  // Recall: the pipeline. The SDK supplies the calling employee's identity,
  // permission scopes, and token budget automatically (P2/P5).
  recall(opts: {
    query: string;
    subject?: Ref;                  // bias toward the task's subject
    classes?: MemoryClass[];        // default: all the employee may read
    limit?: number;
  }): Promise<{ context: AssembledContext; items: RecalledMemory[]; manifest: ContextManifest }>;

  // Write owned/private experience (autonomous) or propose shared knowledge
  // (auto-routes to an approval checkpoint per §6/P4).
  remember(opts: {
    class: MemoryClass; type: string; title: string; summary?: string;
    body: string; visibility?: Visibility; salience?: number;
    expiresAt?: Date; boundTask?: TaskId;
  }): Promise<{ id: MemoryId; approvalRequired: boolean }>;

  // Resolve a context reference handed over a message (IX) — permission-checked.
  resolve(ref: Ref): Promise<ResolvedContext>;

  forget(id: MemoryId, reason: string): Promise<void>;   // archive, audited (never hard-delete)
  search(query: string, opts?: SearchOpts): Promise<RecalledMemory[]>;  // raw search, no assembly
}
```

`pure lib/*` holds the scoring function, the budget knapsack, the decay model and
the permission predicate builder — unit-testable without a DB; the SQL holds only
the atomic, permissioned reads/writes.

> **As-built (D009 M1 PR4).** `recall()` takes `query`, NOT a vector — and that did
> not change when semantic switched on. The implementation (`recallMemory`) asks the
> provider seam (§11) for the query embedding ITSELF and forwards `(vector, version)`
> to the SQL; with no provider, a blank query, or a provider failure it forwards a
> null probe and recall degrades to lexical/structural. A caller-supplied raw vector
> would be unversioned (uncomparable) and would leak whether semantic is on, so the
> seam is deliberately internal. There is correspondingly NO embedding RPC on the SDK
> surface — the worker primitives in §12.1 are infrastructure, called only by the cron.

> **As-built (D009 M1 PR6).** `interface Memory` is now real: `createMemory(identity)`
> (`server/sdk/memory.ts`) returns the bound facet, with the five verbs delegating to
> the service layer. The contract is honoured verb-for-verb — `recall()` returns
> `{ context, items, manifest }` (the `context` rendered prompt-ready from the
> assembled set); `remember()` returns `{ id, approvalRequired }` and `id` is `null`
> exactly when a shared-knowledge write is withheld; `resolve(ref)` is structural
> recall fully biased to an entity; `search()` is the raw, unreinforced lookup; and
> `forget(id, reason)` archives via `hq_memory_forget`. Identity is supplied by the
> SDK, never by a verb argument (§14, P2/P5): every call runs as the bound employee,
> the permission filter stays server-side (the SDK can only narrow ergonomics, never
> widen scope), and recalled ids accumulate as `evidence()`. The five verbs **throw**
> on failure (the handler ABI is throw-based); the underlying `{ ok:false }` results
> are converted to thrown errors at this seam. The facet is deliberately standalone —
> a future `ctx` (XIII) exposes it AS `ctx.memory` unchanged.

---

## 13. Observability

`hq_memory_golden_signals()`: corpus size by class; embedding backlog
(`embedded_at IS NULL` count — should trend to 0); recall latency p50/p95; recall
permission-denials (a spike may mean a mis-scoped employee); consolidation &
expiry throughput; storage/embedding cost rollup; "stale brain" canary
(semantic memories never reinforced in N months). Surfaced on The Pulse (XI).

> **As-built (D009 M1 PR4).** The embedding-worker signals are their own read,
> `hq_embedding_golden_signals(p_target_version)`: `worker_enabled`; queue depth
> (total / embedded / pending / failed / in-flight); spend (`cost_1h`, `cost_24h`,
> `tokens_24h` from `hq_embedding_runs`); throughput (`succeeded_1h` / `failed_1h`);
> and — when a target version is passed — the **re-embed backlog** (embedded rows
> whose `embedding_version` no longer matches, the coverage gauge for a migration).
> Cheap bounded aggregates, no projection.

> **As-built (D009 M1 PR5).** The lifecycle read is `hq_memory_golden_signals()`:
> `worker_enabled`; the status distribution (total / active / archived / superseded /
> draft); the active corpus `by_class`; the **backlog** each engine faces
> (`ttl_expired_due`, `decay_archivable`, `summary_candidates`,
> `unconsolidated_episodic` — computed with the SAME policy literals as the engines, so
> the dashboard can never disagree with them); and a 24h count of each transition
> (`expired` / `archived` / `consolidated` / `superseded` / `summarised`). STABLE +
> ungated, so state is observable even while the worker is dark. Surfaced through the
> worker summary (`getMemoryGoldenSignals()`) and mirrors `hq_embedding_golden_signals`.

---

## 14. Security & permissions (P5 applied)

- **Permission-first retrieval** (§7 stage 1): the forbidden corpus is excluded
  before scoring — no ranking-channel leak.
- **AI writes are bounded** (§6): private/owned is autonomous; shared/company
  knowledge crosses an approval checkpoint (P4) — the company brain can't be
  silently rewritten by an AI.
- **No hard deletes.** `forget()` archives + versions; memory is an audit subject.
  *As-built (PR6):* `hq_memory_forget` re-asserts ownership in SQL (an employee may
  forget ONLY memory it owns — never another's, never the owner-less company brain),
  flips `active → archived`, bumps + snapshots the version, and audits an `archived`
  row stamped with the acting employee — no `DELETE`, no Pulse verb. A second forget
  is an idempotent `already_inactive` no-op.
- **All AI access audited**: an AI *read* writes a per-memory
  `hq_memory_events.ai_accessed` row (via `hq_memory_reinforce`, PR3) and emits
  **nothing** on the bus — there is deliberately no `memory.read` verb, so recall
  (the hottest path) can't flood The Pulse. Only *writes* emit a registered bus
  event (`memory.asserted`, PR2). C5's "one audit truth" is the registry, which
  has no recall verb.
- **RLS:hq** throughout; no customer/staff JWT can ever touch memory (P5). The
  customer-facing product is untouched.

---

## 15. Testing (the six gates)

| Gate | What it proves |
|------|----------------|
| 1 typecheck | `Memory` SDK surface, class/visibility unions, vector typing. |
| 2 lint | conventions, British spelling. |
| 3 unit | the scoring function, the budget knapsack, the decay formula, the diversify/dedupe step, the permission predicate builder — pure `lib/*`. |
| 4 integration (real Postgres) | permission-filtered recall (employee A cannot retrieve B's private memory through *any* channel — lexical, semantic, or structural), embed-on-write, consolidation lineage, working-memory auto-expire on task finish, hybrid ranking correctness, versioning on update — proved on real pgvector. |
| 5 security | RLS:hq on `hq_memories` (anon/authenticated denied); entry-point `EXECUTE` revoked from JWT roles; the read predicate denies cross-owner/cross-department leakage; `system` visibility never returned to AI — pinned in source. |
| 6 e2e | the HQ memory surface behind the auth wall (anonymous → 307 → /login, never paints). |

> **As-built (D009 M1 PR4).** Every embedding failure mode is proven
> deterministically across the tiers. *Unit*: the provider seam + versioning/cost
> helpers, and `recallMemory`'s graceful degradation (no provider, blank query,
> provider throw/timeout, wrong-shape vector ⇒ null probe; happy path forwards
> vector + version and cos_sim drives the rank); the worker's retry/backoff/DLQ/
> idempotency/crash-recovery/cost-cap/deadline (mocked RPC + provider). *Security*:
> the recall ANN invariants (permission predicate present in BOTH channels;
> schema-qualified `public.vector`/`OPERATOR(public.<=>)`, no bare cast; version +
> dimension isolation; no body/tsv/embedding leaked; no Pulse verb; service-role-
> only grants) pinned in source. *Integration* (real pgvector): the `::public.vector`
> cast + cosine operator execute; semantic is additive to lexical; permission,
> version, and dimension isolation hold; the channel is gated by its args. Large-
> dataset latency/stress is deferred to the Module 1 finalize gate.

> **As-built (D009 M1 PR5).** Every lifecycle failure mode is proven deterministically
> across the tiers. *Unit*: the pure §9/§10 policy (`retentionScore` /
> `shouldArchiveEpisodic` / `needsSummary` / `chooseDedupeKeeper` / `evictionPlan` and
> the decay math), the text-provider seam + cost helper (null when unconfigured;
> Anthropic-preferred auto-select; blank-prompt no-network; vendor-throw surfaces), and
> the worker's orchestration with a mocked RPC + provider (gate-dark short-circuit; the
> mechanical-safe tick; per-engine caps `maxSupersedes`/`maxSummaries`; the cost cap and
> wall-clock deadline; a failed supersede / a generation throw / an empty or too-long
> summary each isolated, never persisted; never-throws). *Security*: the lifecycle
> invariants pinned in source — SQL ↔ TS policy literals AGREE (0.05 / 30 days / 1200 /
> 0.6 / 0.95 / 3); every primitive is `SECURITY DEFINER`, `search_path=''`, EXECUTE
> revoked from JWT roles + granted only to `service_role`; the event model (consolidation
> emits `memory.asserted`, supersession emits `memory.superseded`, expiry/decay/eviction/
> summarisation emit NOTHING on the bus); the class guards on decay + eviction; the
> dedup probe schema-qualified `public.vector`/`OPERATOR(public.<=>)`. *Integration*
> (real Postgres): the kill-switch truly gates the autonomous engines (disabled ⇒
> expire_sweep no-ops + consolidate withholds, nothing changes); TTL + decay archival in
> one bounded idempotent pass with unconsolidated + durable spared; consolidation rolls
> ≥3 themed episodes into one private long_term lesson, links (not archives) the sources,
> emits `memory.asserted`, and is idempotent; dedupe finds the pair by vector + applies
> the keeper rule, supersede is atomic/audited/reversible/idempotent, a no-embedding row
> is never paired; summarise detect → apply → drop-out; golden signals; service-role-only.
> Large-dataset latency/stress is deferred to the Module 1 finalize gate.

> **As-built (D009 M1 PR6).** The `ctx.memory` facet is proven across the tiers.
> *Unit* (`memory-sdk.test.ts`, RPC mocked so the real SDK + service + pure ranker
> run): identity is stamped on EVERY verb (no parameter can act as another employee);
> `recall()` maps subject/classes/limit and renders a prompt-ready `context`;
> `recall()`/`resolve()` accumulate `evidence()` while `search()` deliberately does
> not; working/episodic `remember()` auto-binds the running task (durable does not;
> an explicit `boundTask` overrides); `expiresAt` serialises and an approval-withheld
> write surfaces `id:null`; `search()` does not reinforce; the bound identity is
> frozen; and every verb throws on a service failure. *Security*
> (`memory-forget-invariants.test.ts`, pinned in source): `hq_memory_forget`
> re-asserts ownership BOTH in the pre-check AND the `UPDATE` (TOCTOU-safe), never
> `DELETE`s/`TRUNCATE`s, bumps + snapshots the version, audits an `ai_employee_id`-
> stamped `archived` row with `action:'forget'`, emits nothing on the bus / never
> widens the event CHECK, is `SECURITY DEFINER` + `search_path=''`, and is EXECUTE-
> revoked from JWT roles + granted only to `service_role`. *Integration* (real
> Postgres, `forget-path.test.ts`): an owned active memory is archived + versioned +
> audited with nothing on The Pulse; another employee's memory and the owner-less
> company brain are both refused `not_owner` and left unchanged; a second forget is
> an idempotent `already_inactive` no-op (no second version); an unknown id is
> `not_found`; anon is refused outright.

---

## 16. Conflicts resolved & open questions

**Resolves:**
- **C6 (memory is a table+UI, not a live substrate)** — directly and fully:
  AI-writable, typed, semantically searchable, with retrieval/consolidation/
  expiry engines. The filing cabinet becomes cognition. *D009 M1 PR5* ships the
  last of these: the §9 reduction engines (summarise / consolidate / dedupe→supersede)
  and the §10 TTL/decay/eviction lifecycle, a dark background worker that prunes and
  compresses the brain with no application change once switched on.
- Contributes to **C5** — memory access/writes emit bus events (one audit truth).
- Contributes to **C2/P4** — shared-knowledge writes route through the autonomy
  test's approval path; private experience does not.
- **OQ1 (embedding model & dimension) — RESOLVED (D009 M1 PR4).** The model is
  decided: OpenAI `text-embedding-3-small`, 1536-d — "Version 1". Because the
  canonical staleness key is the composite `provider:model:dDIM:vREV` (not a bare
  model name), a vendor/model/dimension swap OR a quality bump is a **config-only
  re-embed**: `hq_embedding_enqueue_stale` walks the corpus in bounded batches
  while old vectors stay searchable until atomic replacement (§11) — never a
  redesign, never an outage. The dimension presumption is now a deliberate,
  documented, reversible choice rather than an open question.

**Open questions for a future directive:**
1. **Cross-department knowledge sharing policy.** Today `department` visibility
   silos knowledge. Do we want an explicit "publish to company" promotion flow
   (an approval-gated `department → public_hq` transition) as the default path
   for consolidated long_term memories? *Recommendation: yes — it's the engine of
   the shared brain.* **As-built note (PR5):** `hq_memory_consolidate` already
   produces the candidate — a `long_term` lesson — but writes it `private` +
   owner-scoped (autonomous per §6). The `private → public_hq/department` promotion is
   exactly the approval-gated transition this question asks for; it is owned by the
   Module 4 Task Engine and lands with **no change** to the consolidation engine.
2. **Forgetting vs. compliance.** A future data-retention/GDPR requirement may
   demand *hard* deletion of certain customer-derived memories. The "never hard-
   delete" rule needs a documented, audited exception path then — flagged, not
   built. **As-built note (PR6):** the *soft* forget is now built — `forget()` /
   `hq_memory_forget` archives + versions an owned memory (the deliberate
   counterpart to the lifecycle worker's mechanical eviction). It is explicitly
   NOT a hard delete; the compliance hard-delete exception above remains open and
   would be a separate, audited, approval-gated primitive — never the autonomous
   `forget()` path.

---

## 17. Module 1 final validation (D009 M1 finalize gate)

This section closes the two "deferred to the Module 1 finalize gate" notes left in
§15 (PR4 semantic recall, PR5 lifecycle) and records the gate's findings as-built.
The mandate was absolute and is now permanent doctrine: **production is never a
test environment.** The entire validation ran against a *local* Docker Supabase
(PostgreSQL 17.6, pgvector 0.8.0) — the same migration set, byte-for-byte — seeded
with a realistic corpus and driven by the **deterministic offline embedding
provider** (§4, `MEMORY_EMBEDDING_PROVIDER=deterministic`), so the full
queue → embed → store → ANN → recall loop runs with zero network and zero API key.
That provider is the living proof of the plug-in rule: a vendor is a configuration
swap, not a Memory-Engine change. It is mechanically faithful (idempotency,
versioning, cost ledger, ANN index population, lease/crash recovery) and never
semantically meaningful — it must never be selected in production.

### 17.1 Two production bugs the gate caught (the reason the rule exists)

Both bugs were invisible to the unit tier (which mocks the Supabase client) AND to
the primitive-level integration tier (which calls the SQL functions directly). Only
driving the **service layer against real Postgres** surfaced them — exactly the gap
the finalize gate exists to close.

1. **Recall system-memory leak.** The §6 permission predicate scoped owned and
   shared visibility correctly but did not exclude `system` visibility from the
   owner clause in one channel, so an employee's recall could, under a specific
   ownership shape, surface engine-internal `system` memory that §5/§6 promise is
   *never* returned to an AI. Fixed by tightening the ownership clause in the PR3
   write/recall and PR4 ANN-recall migrations; the source-pinned recall-invariant
   tests were strengthened so the contract ("`system` is never recalled") fails
   loudly if the clause regresses.

2. **`callRpc` this-binding.** The service helper `callRpc` *detached* the Supabase
   `rpc` method (`const run = admin.rpc; run(...)`), dropping its `this`. supabase-js's
   `rpc()` delegates to `this.rest`, so **every** service RPC (`remember` / `recall` /
   `reinforce` / `forget`) threw `Cannot read properties of undefined (reading 'rest')`
   the instant it ran against a real client. The unit tier's mock ignored `this`; the
   integration tier called `.rpc()` as a method (preserving `this`), so neither saw
   it. Fixed with `admin.rpc.bind(admin)` — the idiom `event-spine.ts` already used —
   and pinned by a new real-client regression suite (`service-rpc-binding.test.ts`)
   that drives the three RPC-bearing wrappers end-to-end and fails loudly if the bind
   is ever dropped again.

The lesson is doctrine now: **a mock proves orchestration, never the wire.** Any
service path that reaches Postgres needs at least one real-client test, or a
this-binding / cast / predicate bug hides until production.

### 17.2 Performance benchmarks

Measured on the local single-node stack (Apple Silicon, Colima VM; Postgres 17.6 /
pgvector 0.8.0 HNSW m=16 ef_construction=64), deterministic provider, via
`scripts/memory-bench.ts`. Each recall figure is the service function
`recallMemory()` end-to-end (permission filter → lexical+semantic candidate gather →
score → diversify → assemble), `candidateLimit=60`, warm cache, n=50 iterations per
cell. The query path uses the synthetic probe `benchmark corpus alpha`, which by
construction matches *every* seeded body — the deliberate worst case for the recall
analysis below.

| corpus | seed (rows/s) | embed (mem/s) | recall p50 / p95 — query | recall p50 / p95 — recency |
| -----: | ------------: | ------------: | ------------------------: | -------------------------: |
|    100 | 9,482         | 80            | 21.0 / 24.9 ms            | 11.3 / 13.8 ms             |
|  1,000 | 23,015        | 98            | 26.8 / 30.4 ms            | 13.8 / 16.7 ms             |
| 10,000 | 26,304        | 78            | 94.8 / 108.2 ms           | 30.4 / 32.1 ms             |
|100,000 | 18,474        | 60            | 597.9 / 646.7 ms          | 87.8 / 96.2 ms             |

**What the numbers say.**
- **Recency recall stays cheap and near-flat.** The no-query / no-vector path (pure
  permission-filtered recency over the GIN + btree indexes) holds at **87.8 ms p50
  over 100,000 memories** — a ~7.8× latency rise for a 1,000× corpus, strongly
  sub-linear. This is the common "what was I just doing" path and it never degrades.
- **Query recall is interactive to ~10k, then grows with the *matching set* — and
  the 100k cell is a deliberate worst case.** Because the synthetic query matches
  every seeded body, at 100k the `lexical` CTE returns the entire permitted set —
  **75,004 rows** for the probe employee (public_hq + owned + same-department) — and
  `enriched` then computes an exact cosine (`embedding <=> probe`, 1536-dim) for
  *every one* of them. That per-candidate exact recompute, not any index, is the
  ~600 ms: the `lexical` CTE is intentionally **unbounded** (it must not drop a
  lexically-relevant row before scoring), so a query matching a large fraction of an
  employee's accessible corpus costs roughly **linearly in that match-set size**. A
  *typical* real query matches a small subset and stays in the tens of milliseconds;
  the 100k figure is the pathological "matches everything" ceiling, recorded
  honestly. See §17.3 for the limitation and its scoped fast-follow.
- **The HNSW semantic channel itself is correctly bounded and fast.** In isolation
  the ANN probe (`Index Scan using hq_memories_embedding_hnsw`,
  `ORDER BY embedding <=> v_qvec LIMIT 60`) returns in ~51 ms at 100k; the GIN
  lexical scan (`hq_memories_search_idx`) in ~17.8 ms. The wall-clock above is *not*
  the indexes — it is the exact re-scoring of the unbounded lexical candidate set, a
  service-layer choice, not an index limit.
- **Embedding throughput degrades with corpus size, by design of HNSW.** 80 mem/s
  at 100 falls to 60 mem/s at 100k because each vector write pays graph-maintenance
  cost that grows with the number of indexed neighbours. This is expected, bounded,
  and irrelevant to *recall* latency (which the same index keeps fast); it only sets
  the wall-clock of a bulk (re-)embed, which is a paced background drain (§11), never
  on the request path. The full 100,000-row drain ran in **391 bounded batches,
  1,660.4 s (≈27.7 min) wall, 0 failures, $0 ledger** (deterministic).
- **Worker memory stays flat.** Peak RSS of the embedding worker held at **≈150 MiB**
  across the 100k drain — it claims and embeds in bounded batches (no full-corpus
  load), so memory is a function of batch size, not corpus size.
- **DB plan.** `EXPLAIN ANALYZE` on `hq_memory_recall` over the 100k corpus confirms
  the intended access paths: a GIN `hq_memories_search_idx` scan for the lexical
  channel and an `Index Scan using hq_memories_embedding_hnsw` (`LIMIT 60`) for the
  semantic channel; the dominant node is the per-candidate cosine recompute in
  `enriched` over the 75,004-row permitted lexical set, exactly as the latency above
  predicts — index-bound nowhere, enrichment-bound on a corpus-wide query.

### 17.3 Known limitations

- **The deterministic provider is mechanics-only.** It proves the *pipeline*, never
  *retrieval quality*; two paraphrases are not close in its space. Production
  retrieval quality is a property of the real provider (OpenAI `text-embedding-3-
  small`, §4 / OQ1) and is out of scope for an offline gate.
- **Unbounded lexical candidate set on broad queries.** The recall function's
  `lexical` CTE returns *all* permitted rows matching the query (it deliberately
  drops nothing before scoring), and `enriched` then computes an exact cosine for
  every candidate whenever a semantic probe is present. For a selective query this is
  a handful of rows and stays in the tens of milliseconds; for a query that matches a
  large fraction of an employee's accessible corpus it is the whole set (75,004 rows
  → ~600 ms at 100k). The recall *contract* — permission-first, frozen order, no
  body/embedding/system leak — is wholly unaffected; this is purely latency. The
  scoped fast-follow, deliberately **not** taken inside this finalize gate (the rule
  is *never rewrite a working system mid-validation*), is to cap the lexical
  candidate set with a bounded `ts_rank`-ordered pre-limit before the exact-cosine
  enrichment, mirroring the already-bounded `LIMIT 60` semantic channel. Flagged for
  CEO disposition as a Module 1 fast-follow, **not** a merge blocker.
- **Single-node, local scale.** These figures are a faithful *shape* (sub-linear
  recency, match-set-linear query, HNSW-bounded embed), not a production capacity
  statement; managed-Postgres IOPS, connection pooling, and concurrent tenant load
  will move the absolute numbers. The benchmark harness (`scripts/memory-bench.ts`)
  is committed precisely so the ladder can be re-run on any environment.
- **Bulk re-embed is paced, not instant.** A provider/model/dimension swap re-embeds
  the corpus via `hq_embedding_enqueue_stale` in bounded batches while old vectors
  stay searchable (§11) — correct and outage-free, but a 100k+ migration is measured
  in worker-minutes, to be scheduled, not awaited synchronously.
- **Lifecycle dedupe is the most corpus-sensitive primitive.** `hq_memory_dedupe`'s
  pairwise vector comparison is the one lifecycle op whose cost grows fastest with
  corpus size; the worker paces it with `scanLimit` / `maxRunMs` / a per-run cost cap
  so it never ranges unbounded. (Observed during the gate: a dedupe pass left to
  range over a stale 10k embedded corpus hit the statement timeout — a test-isolation
  artefact, not a product fault, fixed by cleaning the bench corpus first; it is
  nonetheless the canary for "the lifecycle worker must stay paced".)

### 17.4 Operational procedures

- **Two kill-switches, both fail-dark.** `hq_settings.data->memory_embedding->
  worker_enabled` and `->memory_lifecycle->worker_enabled` gate the two background
  workers; `hq_memory_embed_enabled()` / `hq_memory_lifecycle_enabled()` read them
  and treat *any* error as OFF. Default is dark: a fresh deploy embeds and prunes
  nothing until an operator switches it on. Recall, lexical and structural, works
  regardless.
- **Draining the embed queue.** The worker is driven by an authenticated cron
  (`CRON_SECRET`); a single run claims a lease, embeds a bounded batch, completes
  atomically, and reports `claimed/embedded/failed/batches/costUsd/stopped`. To pace
  a large backfill, raise the cron cadence rather than the batch bound.
- **Switching providers.** Set `MEMORY_EMBEDDING_PROVIDER` (and the vendor key);
  `getEmbeddingProvider()` resolves it at runtime and returns `null` when unusable —
  semantic search simply goes dark, every other recall channel keeps working, and no
  application code changes. After a swap, enqueue a re-embed (below).

### 17.5 Disaster recovery

- **Worker crash / restart.** A worker that dies mid-batch leaves rows leased
  (`embedding_claimed_at` set, `embedded_at` null). `hq_embedding_reclaim_stale`
  clears expired leases so the rows are claimable again; the `claimed_by` guard on
  `complete`/`fail` makes a late finisher a no-op, so no work is lost and none is
  double-done. Proven against real Postgres in `embed-recovery.test.ts`.
- **Provider outage / transient failure.** A failed batch routes through
  `hq_embedding_fail`: it records the error, releases the lease, and sets
  `embedding_next_attempt_at = now() + backoff`, so a backed-off row is *not*
  re-claimed until due — retry pacing, never a retry storm. Repeated failure
  dead-letters the row (`embedding_status='failed'`) rather than blocking the queue.
- **Corrupt vector.** `assertValidEmbedding` rejects a wrong-dimension or non-finite
  vector at the worker boundary; the row is dead-lettered, never indexed.
- **Re-embed after model change.** `hq_embedding_enqueue_stale` re-queues rows whose
  composite version `provider:model:dDIM:vREV` no longer matches the target, in
  bounded batches, leaving the old vector searchable until atomic replacement (§11).

### 17.6 Maintenance procedures

- **Re-validate on any change** with the committed harness:
  `memory-bench.ts clean → seed N → embed → recall K → lifecycle → report`, sourced
  against a local Supabase with `MEMORY_EMBEDDING_PROVIDER=deterministic`. Every row
  it creates is tagged (`BENCH·` title / `bench-` slug) so `clean` removes exactly
  its own footprint.
- **Watch the golden signals.** `getEmbeddingGoldenSignals()` exposes queue depth,
  failure/dead-letter counts, and oldest-pending age; an alert on rising dead-letters
  or pending-age is the earliest sign of a provider or quota problem.
- **Cost.** The embedding worker writes a per-run cost ledger (`hq_embedding_runs`);
  the deterministic provider records $0 (no pricing row), a real provider records the
  metered spend. The lifecycle worker is similarly cost-capped per run.

> **Resolved.** The §15 PR4 and PR5 deferrals ("large-dataset latency/stress is
> deferred to the Module 1 finalize gate") are closed by §17.2–§17.5: latency is
> measured to 100k (recency sub-linear; query interactive to 10k and match-set-linear
> on a corpus-wide probe, §17.3), stress (crash/lease-reclaim, backoff, dead-letter)
> is proven against real Postgres, and the security surface (SQL/prompt injection,
> malformed and unknown employee identity) is probed end-to-end through the service
> layer. One latency fast-follow (bound the lexical candidate set, §17.3) is flagged
> for CEO disposition — not a merge blocker.

---

*Volume X of the AI Substrate. The architecture (§1–§16) is design-only — no
production change; §17 records the Module 1 finalize gate as-built, run entirely
against a local Docker Supabase (production was never touched). Continues into
Volume XI (Event Bus), the backbone both this volume's episodic source and its
audit emissions depend on.*
