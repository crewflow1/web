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
| Reserved semantic-search column | **Built (dormant)** | `hq_memories.embedding_placeholder jsonb` — *never populated*; this volume activates it via pgvector. |
| Memory **classes** (episodic/working/long-term/procedural) | **Built** · D009 M1 PR1 | additive `memory_class` + lifecycle columns (`owner_employee_id`, `expires_at`, `consolidated_into`, `salience`, `bound_task_id`, `last_reinforced_at`); migration `20260722000000`. The `hq_memory_types` lookup stays data-driven. |
| AI **write** path (employees author memory) | **Built (owned)** · D009 M1 PR2 | `hq_memory_write` commits owned episodic/working/private autonomously; shared-knowledge writes return the NULL sentinel pending the Module 4 approval checkpoint (§6). Migration `20260723000000`; the human write path is untouched. |
| The **retrieval pipeline** (hybrid rank + budget + assembly) | **Built** · D009 M1 PR3 | SQL `hq_memory_recall` does the permissioned stage-1/2 read and returns RAW candidate signals; the pure `rankAndAssemble` (`lib/memory/retrieval.ts`) composes score→diversify→assemble (stages 3–5); `hq_memory_reinforce` reinforces the assembled set + writes the `ai_accessed` audit. Migration `20260724000000`. Semantic ANN stays dormant (PR4 seam). |
| **Consolidation / compression / expiry** engines | **To build** | recurring tasks (XII). |
| pgvector + embedding-on-write | **To build** | enable extension; backfill; embed task. |

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
> stay a **plug-in, not a dependency**: pgvector remains dormant (PR4) and the
> write is byte-identical with or without it. *PR3* builds the **recall pipeline**
> (`hq_memory_recall` + `hq_memory_reinforce`, migration `20260724000000`): the SQL
> enforces the §6 permission filter as a stage-1 `WHERE` (forbidden rows are never
> scored), does the lexical + structural candidate read, and returns RAW signals
> (`ts_rank`, `structural_match`, token *estimates* — never the body); the pure
> `rankAndAssemble` then scores, diversifies and budget-packs them (stages 3–5)
> with no DB. Recall emits **nothing** on The Pulse — there is no recall verb in the
> registry; an AI read is audited per-memory (`hq_memory_events.ai_accessed`) by
> `hq_memory_reinforce`, which also reinforces decay on the assembled set. The
> query-embedding parameter ships as a stable `float8[]` seam PR4 fills — no caller
> changes when semantic search switches on.

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

-- pgvector: activate the reserved semantic-search slot. embedding_placeholder
-- (jsonb) stays for back-compat; the live vector lives in its own column so we
-- are not coupled to enabling the extension everywhere at once.
create extension if not exists vector;
alter table public.hq_memories
  add column if not exists embedding vector(1536),     -- model-dependent dim
  add column if not exists embedding_model text,       -- which model produced it
  add column if not exists embedded_at timestamptz;    -- null = not yet embedded

-- Retrieval indexes.
create index if not exists hq_memories_class_idx       on public.hq_memories (memory_class);
create index if not exists hq_memories_owner_idx        on public.hq_memories (owner_employee_id)
  where owner_employee_id is not null;
create index if not exists hq_memories_expiry_idx       on public.hq_memories (expires_at)
  where expires_at is not null;
create index if not exists hq_memories_bound_task_idx   on public.hq_memories (bound_task_id)
  where bound_task_id is not null;
-- ANN index for vector recall (ivfflat/hnsw chosen at build time; hnsw preferred
-- for recall quality at our scale). Built CONCURRENTLY in a follow-up step.
create index if not exists hq_memories_embedding_idx
  on public.hq_memories using hnsw (embedding vector_cosine_ops);
```

No existing column is dropped or retyped; `memory_class` defaults make the whole
change a no-op for current rows (they remain `semantic`, company-owned, never
expiring) — protecting production (directive).

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
> only. The semantic ANN channel (2b) and the `cos_sim` term are dormant until
> PR4 — the scorer treats a missing embedding as 0, so ranking is identical with
> or without it. **Supersession is resolved by presence, not score order:** an
> episode whose `consolidated_into` target is in the candidate set is dropped even
> when the fresh episode out-scores the durable consolidation that rolls it up —
> "prefer the latest version" (stage 4) is a hard lineage fact, not a ranking
> tie-break, and it collapses version chains correctly.

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

---

## 11. Embeddings / pgvector

- **Activation.** `create extension vector`; add the `embedding vector(1536)`
  column (§5). The dormant `embedding_placeholder jsonb` (Directive 002's
  reserved slot) stays for back-compat; the live ANN runs on the real vector
  column so we are decoupled from when the extension is enabled everywhere.
- **Embed-on-write.** When a memory is created/`body`-updated, enqueue an
  `embed.memory` task (XII). The runner calls the embedding model through the SDK
  API gateway (XIII — metered, audited), writes `embedding`, `embedding_model`,
  `embedded_at`. `embedded_at IS NULL` is the work queue; a partial index drives
  the backfill of the existing corpus.
- **Index.** HNSW (`vector_cosine_ops`) preferred for recall quality at our
  scale; built `CONCURRENTLY`. ivfflat is the fallback if build cost matters.
- **Model versioning.** `embedding_model` is stored per row so a model upgrade is
  a **re-embed migration** (enqueue `embed.memory` for the old-model rows), never
  a silent mismatch — cross-model cosine is meaningless, so retrieval filters to
  one model generation at a time.
- **Cost.** Embedding spend is metered per the SDK cost model (XIII); a backfill
  is budgeted and rate-limited like any other AI cost.

---

## 12. Interfaces

### 12.1 SQL entry points (P5: `SECURITY DEFINER`, `search_path=''`, service-role-only)

```
hq_memory_recall(p_employee_id uuid, p_query text, p_query_embedding float8[],
                 p_subject_kind text, p_subject_id text, p_class_filter text[],
                 p_limit int) returns jsonb
    -- BUILT — D009 M1 PR3. Stages 1–2 of the pipeline (§7): the §6 permission
    -- filter is the stage-1 WHERE (forbidden/system rows are never scored), then a
    -- lexical (ts_rank) + structural candidate read. Returns up to p_limit RAW
    -- candidates as jsonb (signals only — a body_tokens estimate, never the body);
    -- the pure rankAndAssemble scores/diversifies/budgets them (stages 3–5), so
    -- there is NO p_token_budget here. p_query_embedding is the dormant float8[]
    -- seam PR4 fills — accepted and ignored today (no pgvector, no ::vector cast).

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
    -- plug-in: a future PR4 consumer subscribes to `memory.asserted` to backfill
    -- the vector — no `embed.memory` enqueue and no embedding column written here.

hq_memory_reinforce(p_employee_id uuid, p_memory_ids uuid[]) returns void
    -- BUILT — D009 M1 PR3. Applied to the ASSEMBLED set: bumps last_reinforced_at
    -- (slows decay, §10), increments access_count, and writes one per-memory
    -- ai_accessed row to hq_memory_events attributed to p_employee_id — the audit
    -- home for AI reads (NOT a Pulse verb; recall never broadcasts).
hq_memory_consolidate(p_employee_id uuid, p_theme text) returns uuid -- §9.2
hq_memory_expire_sweep(p_now timestamptz, p_limit int) returns jsonb -- §10
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

---

## 13. Observability

`hq_memory_golden_signals()`: corpus size by class; embedding backlog
(`embedded_at IS NULL` count — should trend to 0); recall latency p50/p95; recall
permission-denials (a spike may mean a mis-scoped employee); consolidation &
expiry throughput; storage/embedding cost rollup; "stale brain" canary
(semantic memories never reinforced in N months). Surfaced on The Pulse (XI).

---

## 14. Security & permissions (P5 applied)

- **Permission-first retrieval** (§7 stage 1): the forbidden corpus is excluded
  before scoring — no ranking-channel leak.
- **AI writes are bounded** (§6): private/owned is autonomous; shared/company
  knowledge crosses an approval checkpoint (P4) — the company brain can't be
  silently rewritten by an AI.
- **No hard deletes.** `forget()` archives + versions; memory is an audit subject.
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

---

## 16. Conflicts resolved & open questions

**Resolves:**
- **C6 (memory is a table+UI, not a live substrate)** — directly and fully:
  AI-writable, typed, semantically searchable, with retrieval/consolidation/
  expiry engines. The filing cabinet becomes cognition.
- Contributes to **C5** — memory access/writes emit bus events (one audit truth).
- Contributes to **C2/P4** — shared-knowledge writes route through the autonomy
  test's approval path; private experience does not.

**Open questions for a future directive:**
1. **Embedding model & dimension.** Locking `vector(1536)` presumes a specific
   model family. The dimension must be chosen with the model (a future decision);
   the `embedding_model` column makes a later switch a re-embed, not a redesign.
2. **Cross-department knowledge sharing policy.** Today `department` visibility
   silos knowledge. Do we want an explicit "publish to company" promotion flow
   (an approval-gated `department → public_hq` transition) as the default path
   for consolidated long_term memories? *Recommendation: yes — it's the engine of
   the shared brain.*
3. **Forgetting vs. compliance.** A future data-retention/GDPR requirement may
   demand *hard* deletion of certain customer-derived memories. The "never hard-
   delete" rule needs a documented, audited exception path then — flagged, not
   built.

---

*Volume X of the AI Substrate. Architecture only — no code, no production change,
no PR. Continues into Volume XI (Event Bus), the backbone both this volume's
episodic source and its audit emissions depend on.*
