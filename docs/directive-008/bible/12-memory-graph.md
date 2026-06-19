# Chapter 12 — Memory Graph

## Purpose

This chapter specifies the OS's **shared memory** — the kernel concept from Ch.01/02 made literal as a single, permission-aware, fully-audited graph of what the company knows. It is the surface that makes the thesis's third clause true: information is not just *observable* (Ch.11) but *actionable by AI*, because an appropriately-permissioned employee can recall it, reason over it, and cite its provenance.

Memory in CrewFlow is **one graph in three layers**, not three stores:

- **Episodic — *what happened*.** The event spine (`hq_events`, Ch.04) is the episodic memory, *as authored*. The timeline (Ch.11) slices it per entity and per employee. We do **not** copy events into a second table to "remember" them; an employee's episodic recall is a bounded, indexed read of the spine for an object or actor. The spine is the heartbeat; episodic memory is the spine read backwards.
- **Semantic — *what is known*.** Durable, distilled facts about the world: "Acme churned-then-returned in 2025", "the Stripe webhook for plan X is flaky", "this customer prefers email over SMS". These live in ♻️ `hq_memories` (the existing Directive-002 Shared Memory Engine) — now given a real `embedding` and formal typed `hq_memory_edges` so facts connect to each other and to entities.
- **Procedural — *how to act*.** An employee's playbooks, tone, escalation rules, and standing instructions: "Finance AI dunning sequence is three emails at 0/3/7 days; never auto-refund above £50". Procedural memory is *also* `hq_memories` rows (a `playbook`/`policy` memory type), **linked to the employee** via ♻️ `hq_memory_employee_links`, and read on every run as part of `perceive` (Ch.07).

One graph, three lenses. The episodic lens is the spine; the semantic and procedural lenses are the memory tables. This chapter owns the **semantic + procedural** layers and the **hybrid recall** that unifies all three at read time.

> **The named greenfield.** Be precise about the split. Almost everything here already exists and is ♻️ reused: the eight `hq_memory*` tables, the generated weighted `search_tsv` + GIN, FTS search, versioning, per-memory events, access grants, the read-only AI feed. **Only two things are new:** (1) the **semantic vector layer** — enable `vector`, populate `hq_memories.embedding` (replacing the reserved-but-empty `embedding_placeholder`), HNSW cosine index; and (2) the **formal typed edge** table `hq_memory_edges`. Hybrid recall and the AI write-path are *compositions* of the new primitives over the existing service.

---

## Goals

- Promote the existing **Shared Memory Engine** from a human-authored, AI-read-only knowledge base into a **living graph** that the workforce both reads from and (under gates) writes to.
- Add the **semantic layer**: real embeddings on `hq_memories`, an HNSW cosine index, and typed `hq_memory_edges` with `weight`, `confidence`, and `provenance`.
- Deliver **hybrid recall** — one call that fuses FTS (lexical) + vector (semantic) + **graph traversal** (relational) to answer "what does the OS know about org X?", scored by `weight × confidence`.
- Make the **write path** safe: the AI `Reflect` step (Ch.07) and spine ingestion assert facts; similar facts **dedup/merge**; conflicting facts are **versioned** via ♻️ `hq_memory_versions`, **never silently overwritten**; confidence **decays** with age; every memory and edge records **provenance** (the run/event that asserted it).
- Keep knowledge under **least privilege (P5)**: ♻️ `hq_memory_access_grants` + the `visibility` enum decide which employee/role may read each memory; `memory.access_granted/revoked` make grants observable.
- Give the operator a **memory-graph explorer**: entity → its facts → related entities, with provenance on every node.

**Non-goals:** the event envelope and the episodic layer's mechanics (Ch.04/11); a separate vector database (P1/P6 — embeddings live *with* the facts); fine-tuning or training any model on memory; tenant-visible memory (the graph is `RLS:hq`, super-admin only, Ch.16); the employee runtime loop itself (Ch.07).

---

## Architecture

### The three layers and where they live

```
                            ┌──────────────────────────────────────────┐
   WHAT HAPPENED  ─────────▶│  EPISODIC   = hq_events (the spine, Ch.04)│
   (the spine, as authored) │  recall = bounded indexed read per entity │
                            │  projected per entity/employee → Ch.11    │
                            └───────────────┬──────────────────────────┘
                                            │ Reflect distils episodes → facts (Ch.07)
                            ┌───────────────▼──────────────────────────┐
   WHAT IS KNOWN  ─────────▶│  SEMANTIC   = hq_memories (facts)         │
   (distilled facts)        │   + embedding vector(1536)  [NEW]         │
                            │   + hq_memory_edges (typed) [NEW]         │
                            │   ♻️ search_tsv (FTS) · versions · grants  │
                            └───────────────┬──────────────────────────┘
                                            │ linked to an employee (hq_memory_employee_links)
                            ┌───────────────▼──────────────────────────┐
   HOW TO ACT     ─────────▶│  PROCEDURAL = hq_memories (playbook/policy│
   (playbooks/config)       │   memory_type) linked to an ai_employee   │
                            │   read on every run's `perceive` (Ch.07)  │
                            └──────────────────────────────────────────┘
```

The graph is the Data plane's "shared memory" box from the kernel table (Ch.02): `hq_memories + hq_memory_edges + embeddings`, co-located in the one Postgres so a single SQL statement can join lexical, vector, and relational evidence.

### Components

| Component | Responsibility | Reuse / new |
|---|---|---|
| `hq_memories` | The fact record — title/summary/body, type, importance, **confidence (0–100)**, status, version, visibility, the generated `search_tsv`, and now the `embedding`. The single source of truth for a fact. | ♻️ exists; **add `embedding`** |
| `hq_memory_edges` | Typed relationships: `subject_memory → predicate → (object_memory \| object_entity)` with `weight`, `confidence`, `provenance`. Formalises the graph the prose `hq_memory_relationships` table only gestured at. | **NEW** |
| `hq_memory_relationships` | The existing *polymorphic, free-text* link table (memory → feature/PR/customer/…). Retained as the **human-authored annotation** layer; `hq_memory_edges` is the **machine-typed, scored** layer used for recall. (See §Edge cases for why both coexist.) | ♻️ exists |
| `hq_memory_versions` | Immutable per-version snapshots — the mechanism by which a conflicting fact is *superseded*, never overwritten. | ♻️ exists |
| `hq_memory_employee_links` | memory ↔ employee (`relevant`/`pinned`/`owner`/`contributor`) — the procedural link, and the relevance signal for the AI feed. | ♻️ exists |
| `hq_memory_access_grants` + `visibility` | The permission substrate (P5): who may read each memory. | ♻️ exists |
| `hq_memory_events` | The per-memory timeline (created/updated/superseded/accessed) — too high-volume for `admin_activity_log`. | ♻️ exists |
| **Embedder** | Server-only adapter that turns text → `vector(1536)`; lazy backfill + on-write. ♻️ provider plumbing from `research-llm.ts`. | **NEW (thin)** |
| **Recall service** | `recallMemory()` — fuses FTS + vector + traversal, applies access filtering, returns ranked, provenance-stamped results. | **NEW** |
| **Reflector** | The `Reflect` step's memory writer (Ch.07): assert / dedup-merge / supersede / edge. | **NEW** |
| **Decay job** | A cron that ages `confidence` on stale, unre-confirmed facts. | **NEW** |
| **Explorer UI** | The operator's graph view: entity → facts → entities, with provenance. | **NEW** |

### Read and write paths in one picture

```
WRITE                                            READ (hybrid recall)
─────                                            ────────────────────
spine event  ─┐                                  question "about org X"
AI Reflect   ─┤→ Reflector                              │
              │   • embed(text)                   ┌─────┴───────────────────────┐
              │   • dedup: vector NN within type  │ 1. FTS  (search_tsv @@ q)    │  lexical
              │   • merge OR supersede (versions) │ 2. VEC  (embedding <=> q)    │  semantic
              │   • assert edges (+provenance)    │ 3. GRAPH (recursive CTE from │  relational
              ▼                                   │    the entity node, bounded) │
        hq_memories (+embedding)                  └─────┬───────────────────────┘
        hq_memory_edges                                 │  fuse: score = Σ wᵢ·signalᵢ,
        hq_memory_versions                              │  edge contribution = weight×confidence
        emits memory.* (Ch.04) ───────────────▶  filter by access (visibility+grants)
                                                        ▼
                                                  ranked facts + provenance → employee / explorer
```

---

## Database design

All tables are **`RLS:hq`** (service-role only; Ch.03 convention) — no JWT client reads a single memory row. This section references Ch.03 §03.16–03.17 for the canonical DDL; nothing here forks it.

### Reused, unchanged (♻️ Directive-002, migration `20260713000000_hq_shared_memory.sql`)

`hq_memories` already carries every column recall needs except the vector: `confidence integer (0–100)`, `status ∈ {draft,active,archived,superseded}`, `version`, `visibility ∈ {public_hq,department,private,restricted,system}`, `pinned`, `access_count`/`last_accessed_at`, and the **generated** weighted FTS column:

```sql
-- ♻️ EXISTING — do not redefine; quoted for grounding.
search_tsv tsvector generated always as (
  setweight(to_tsvector('english', coalesce(title,   '')), 'A') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(body,    '')), 'C')
) stored;                                  -- GIN: hq_memories_search_idx
```

The seven satellite tables (`_types`, `_sources`, `_relationships`, `_employee_links`, `_access_grants`, `_events`, `_versions`) and their indexes are reused as-is. The `embedding_placeholder jsonb` column is the documented seam: "reserved for future semantic search … never populated or read in Phase 2 … a later phase can migrate this to a vector." **This chapter is that phase.**

### New — the semantic layer (Ch.03 §03.16)

```sql
-- 03.16  Replace the reserved placeholder with a real vector.
create extension if not exists vector;            -- pgvector; additive, standard on Supabase
alter table hq_memories add column embedding vector(1536);   -- nullable: recall degrades to FTS until backfilled
create index on hq_memories using hnsw (embedding vector_cosine_ops);  -- sub-linear ANN
-- embedding_placeholder is dropped only after the backfill verifies parity (additive-then-cutover, P2).
```

- **Dimensionality** is `1536` to match the canon (Ch.03). The chosen embedding model is pinned in `hq_settings` and recorded per row (see `provenance`), so a model change is detectable and re-embeddable. 🔬 **Open question (Ch.20):** which embedding model/provider, and whether to standardise on `1536` or a smaller dimension to halve index size — deferred to the implementation ADR.
- **`embedding` is nullable.** A fact with no embedding yet still participates in FTS and graph recall; the vector arm simply skips it. This is why backfill can be lazy and failure is graceful (Ch.03 §Failure handling).

### New — formal typed edges (Ch.03 §03.17)

```sql
-- 03.17  hq_memory_edges — the machine-typed, scored graph.
create table hq_memory_edges (
  id                 uuid primary key default gen_random_uuid(),
  subject_memory     uuid not null references hq_memories(id),
  predicate          text not null,        -- 'relates_to'|'caused_by'|'about_entity'|'supersedes'|'derived_from'|...
  object_memory      uuid references hq_memories(id),
  object_entity_type text, object_entity_id text,   -- edges may point at an ENTITY, not a fact
  weight             real not null default 1.0,      -- strength of the relation (0..1, traversal-decayed)
  confidence         real not null default 1.0,      -- belief this edge is true (0..1)
  provenance         jsonb,                           -- { run_id, event_id, asserted_by, model, asserted_at }
  created_at         timestamptz not null default now()
);
create index on hq_memory_edges (subject_memory);
create index on hq_memory_edges (object_entity_type, object_entity_id);
```

- **The predicate registry.** `predicate` is a small, curated vocabulary (mirroring the verb registry discipline of Ch.04): `about_entity` (fact → org/customer/job), `relates_to`, `caused_by`, `supersedes`, `contradicts`, `derived_from`, `refines`. A new predicate is a data addition with an ADR (Ch.20) — not free text, so traversal logic stays total.
- **Entities are first-class graph nodes** without a table of their own: an `object_entity_type/id` edge (`about_entity`, `organization`, `org-123`) makes "the Acme node" the set of memories whose edges point at `('organization','org-123')`. This reuses Ch.04's `object_type`/`object_id` text convention — any entity qualifies, no polymorphic FK.
- **`provenance` is mandatory in practice** (jsonb so producers evolve): every machine-asserted edge records the `run_id` and/or `event_id` that asserted it, the asserting actor, and the embedding model. This is how the explorer answers "*why* does the OS believe this?".

### What each table is written by / read by

| Table | Written by | Read by |
|---|---|---|
| `hq_memories.embedding` | Embedder (on-write + backfill) | Recall (vector arm) |
| `hq_memory_edges` | Reflector (Ch.07); operator (explorer) | Recall (graph arm); explorer |
| `hq_memory_versions` | Reflector on supersede; ♻️ operator edits | Explorer (history); audit |
| `hq_memory_access_grants` | Operator; Reflector (inherit subject's grants) | Recall (access filter); feed |

**Emits** (Ch.04 `memory.*`): `memory.asserted`, `memory.superseded`, `memory.edge_added`, `memory.access_granted`, `memory.access_revoked` — so every change to knowledge is itself an episode on the spine, observable in the timeline (Ch.11) and traceable by `correlation_id`.

---

## APIs

Service-layer functions, server-only, behind the existing `isSuperAdminEmail` gate (♻️ `server/auth/hq.ts`) and — for AI callers — the capability gate (Ch.14). Signatures are illustrative (Ch.00).

### Recall — the one read primitive

```ts
// server/services/hq-memory-recall.ts (NEW) — fuses FTS + vector + graph.
type RecallQuery = {
  text?: string;                       // natural-language question
  aboutEntity?: { type: string; id: string };  // anchor the graph traversal
  forEmployee?: { id: string; department: string };  // applies access filtering (P5)
  predicates?: Predicate[];            // restrict traversal edge types
  maxDepth?: number;                   // bounded; default 2, hard cap 4
  limit?: number;                      // default 20
};
type RecalledMemory = MemoryListItem & {
  score: number;                       // fused rank
  arms: { fts?: number; vector?: number; graph?: number };  // explainability
  path?: EdgePath;                     // how graph recall reached it (provenance)
};
async function recallMemory(q: RecallQuery): Promise<RecalledMemory[]>;
```

- **`forEmployee` is the privacy boundary.** When set, results are filtered by ♻️ `canEmployeeAccess` (visibility + grants), exactly as `getEmployeeMemoryFeed` does today — an AI never recalls a memory it cannot read. When the caller is a human operator, the full graph is visible (super-admin).
- **`arms` and `path` are returned for explainability** — the UI and evals can see *why* a fact ranked, and an operator can audit the traversal that surfaced it.

### Hybrid recall — the fusion (illustrative SQL shape)

The three arms run as CTEs and fuse on `id`. The **graph arm is a recursive CTE** rooted at the anchor entity, walking `hq_memory_edges`, decaying `weight × confidence` per hop, bounded by `maxDepth`:

```sql
with
-- (1) LEXICAL: existing GIN FTS — ranked by ts_rank over the weighted tsv.
fts as (
  select id, ts_rank(search_tsv, websearch_to_tsquery('english', :q)) as s
  from hq_memories
  where search_tsv @@ websearch_to_tsquery('english', :q)
    and status = 'active'
  order by s desc limit 50
),
-- (2) SEMANTIC: HNSW cosine ANN — 1 - cosine_distance as similarity.
vec as (
  select id, 1 - (embedding <=> :q_embedding) as s
  from hq_memories
  where embedding is not null and status = 'active'
  order by embedding <=> :q_embedding limit 50      -- sub-linear via HNSW
),
-- (3) RELATIONAL: bounded recursive traversal from the anchor entity node.
graph as (
  -- depth 0: facts whose edge points AT the entity (about_entity)
  select e.subject_memory as id,
         (e.weight * e.confidence)::real as s, 1 as depth
  from hq_memory_edges e
  where e.object_entity_type = :etype and e.object_entity_id = :eid
  union all
  -- depth n+1: facts related to facts already reached, weight-decayed
  select e.object_memory as id,
         (g.s * e.weight * e.confidence * 0.6)::real as s, g.depth + 1
  from graph g
  join hq_memory_edges e on e.subject_memory = g.id
  where e.object_memory is not null
    and g.depth < :max_depth                          -- HARD BOUND (Golden Rule)
)
select m.id,
       coalesce(max(fts.s),0)  * :w_fts
     + coalesce(max(vec.s),0)  * :w_vec
     + coalesce(max(graph.s),0)* :w_graph as score
from hq_memories m
left join fts   on fts.id   = m.id
left join vec   on vec.id   = m.id
left join graph on graph.id = m.id
where (fts.id is not null or vec.id is not null or graph.id is not null)
  and m.status = 'active'
group by m.id
order by score desc
limit :limit;
-- Access filtering (visibility + grants) is applied in the service layer
-- after fetch, reusing canEmployeeAccess (P5) — never trust the SQL alone.
```

The fusion weights (`w_fts`, `w_vec`, `w_graph`) and the per-hop decay (`0.6`) live in `hq_settings` (flag-tunable, P7), so recall quality is tuned without a deploy. 🔬 **Open question (Ch.20):** initial weights and whether to learn them from operator click-through — start with hand-set values, instrument, revisit.

### Write — the Reflector

```ts
// Called from the Reflect step (Ch.07) and from spine-ingestion adapters.
type Assertion = {
  fact: { title: string; summary: string; body: string;
          memoryType: 'playbook'|'fact'|'preference'|'decision'|string;
          department?: string; importance?: string; confidence: number };
  about?: { type: string; id: string };       // creates an about_entity edge
  edges?: Array<{ predicate: Predicate; objectMemory?: string; weight?: number }>;
  provenance: { runId?: string; eventId?: number; correlationId: string; model: string };
};
async function assertMemory(a: Assertion, actor: AiActor): Promise<WriteResult>;
```

`assertMemory` runs the **dedup → merge-or-supersede → edge** algorithm (see Write path below), reusing the existing `createMemory`/`updateMemory`/`hq_memory_versions` machinery (♻️) rather than reimplementing versioning. Procedural writes (a new playbook) are the same call with `memoryType:'playbook'` and an `employeeIds` link.

### Versioning of contracts

`recallMemory` and `assertMemory` are **v1** service contracts. The fusion SQL is an implementation detail behind them; swapping the graph arm to a materialised closure table, or the vector arm to an external store (Ch.17), never changes these signatures (P6).

---

## UI behaviour

The **Memory Graph Explorer** is a new HQ surface (Presentation plane, Ch.02), additive to the existing Directive-002 memory pages. It answers, for an operator: *what does the OS know, how sure is it, and why?*

- **Entity-anchored view.** Land on any entity (org/customer/employee) — from its page, the timeline, or search (Ch.10) — and see its **knowledge panel**: the facts whose edges point at it, grouped by predicate, each with a **confidence bar** and an **importance** badge. This is the visual form of the graph arm's depth-0 result.
- **Expand the graph.** Click a fact to reveal its outbound edges → related facts → their related entities, one bounded hop at a time (never an unbounded auto-expand — the depth cap is a UI affordance, not just a query bound). Edges render as labelled, weighted links (`caused_by`, `supersedes`, …).
- **Provenance on every node.** Each fact shows its **source** (♻️ `hq_memory_sources`: manual/system/integration), its asserting **run/event** (deep-link to the trace, Ch.15), the **model** that embedded/asserted it, and its **version history** (♻️ `hq_memory_versions`) — so "why does the OS believe this?" is one click. Superseded versions are visible but visually demoted.
- **Search-to-recall.** A query box drives `recallMemory({text})` and shows results with their **arm breakdown** (lexical/semantic/graph) — the operator sees *why* each hit surfaced, which doubles as a debugging tool for recall quality.
- **States.** *Loading:* skeleton of the knowledge panel. *Empty:* "The OS holds no facts about Acme yet" (honest, not a spinner). *Error:* the vector arm failing degrades to "showing keyword + graph results" with a banner — recall never hard-fails because one arm is down. *Live:* `memory.asserted`/`memory.edge_added` events (via the broadcaster, Ch.06) prepend new facts to an open entity panel without a refresh — knowledge appears as it is learned.
- **Keyboard/accessibility.** ⌘K opens recall search (shared palette, Ch.10); arrow-keys walk the graph; every node is a focusable, labelled control with an accessible name (`"fact: Acme prefers email — confidence 78% — asserted by Finance AI run …"`). Confidence is never colour-only; the bar carries a numeric label.

---

## Permissions

Memory is governed by **least privilege for knowledge (P5)** and the single `authorize()` chokepoint (Ch.14).

- **Who reads what.** Read access is decided by the memory's `visibility` + ♻️ `hq_memory_access_grants`, evaluated by ♻️ `canEmployeeAccess` in the service layer. `public_hq` → any employee/operator; `department` → same-department employees; `private`/`restricted` → explicit grants only; `system` → engine-internal, never surfaced to an AI. **An AI's recall is always access-filtered; the operator (super-admin) sees all.**
- **Capabilities (Ch.14).** New verbs: `memory.read` (held by every employee, scoped further by grants), `memory.assert` (held by employees permitted to *write* knowledge — most are; some read-only employees are not), `memory.edge` (assert typed edges), `memory.grant`/`memory.revoke` (manage access — operator-only by default). Procedural memory carries a higher bar: editing an employee's own playbook needs `memory.assert`, but editing *another* employee's playbook needs an operator (dual-control eligible, P5).
- **Default policy.** A *human operator* may read and write any memory. An *AI employee* may **read** within its grants and **assert** new facts within its department by default; superseding a `high`/`critical` fact, or writing a `system`-visibility memory, routes through approval (Ch.13). No AI may grant or revoke access to a memory (that is an authority change — operator-only).
- **Observability of authority.** `memory.access_granted`/`memory.access_revoked` are spine verbs (Ch.04): every change to who-can-read-what is an event, visible in the timeline and the audit (Ch.15).

---

## Failure handling

- **Embedder down / slow.** Writes still succeed — `embedding` is nullable; the row is queued for lazy backfill and participates in FTS + graph immediately. Recall's vector arm simply returns nothing for un-embedded rows; the lexical and graph arms carry it. **Recall degrades, never fails.**
- **pgvector / HNSW unavailable** (extension hiccup, index rebuild): the recall service detects the vector-arm error, drops that CTE, and serves FTS + graph with a `degraded:true` flag the UI surfaces. The Golden-Rule guarantee — *bounded* reads — is unaffected because FTS (GIN) and traversal (bounded depth) do not depend on pgvector.
- **Runaway traversal.** The recursive CTE has a **hard `maxDepth` bound** and a per-query `limit`; there is no path to an unbounded walk. A cycle (`A relates_to B relates_to A`) terminates at the depth bound and is de-duplicated by the `group by id` fusion — cycles are harmless, not fatal (cf. Ch.04's causation-cycle guarantee).
- **Reflector write fails mid-assertion** (fact written, edge insert errors): the assertion runs in one transaction (state + `memory.*` event together, P1) — a failure rolls back the whole assertion, so a fact never exists without its provenance, and an edge never references a missing subject.
- **Backfill failure** (Ch.03 §Failure handling): idempotent, keyed by memory id; a failed batch retries; partial progress is safe because each row's embedding is independent.
- **Dedup false-merge** (two genuinely different facts merged): recoverable — the merge is *itself* a versioned supersede with provenance, so the operator can split it back via the version history. No knowledge is destroyed; merges are reversible (P2).

## Edge cases

- **Two tables for relationships — why both?** ♻️ `hq_memory_relationships` is **human, free-text, unscored** (a curator's annotation: "related to PR #412"). `hq_memory_edges` is **machine, typed, scored** (recall-bearing). They coexist deliberately: the explorer *shows* both, but only `hq_memory_edges` feeds the graph arm of recall. A human annotation can be *promoted* to a typed edge by the Reflector when it recurs with evidence. 🔬 **Open question (Ch.20):** whether to eventually unify them — deferred; keeping the human layer unscored avoids polluting recall with unverified links.
- **Conflicting facts.** "Acme prefers email" vs "Acme prefers SMS". The Reflector never overwrites: it writes a new version (♻️ `hq_memory_versions`), marks the prior `superseded` (status), and adds a `supersedes`/`contradicts` edge with provenance. Recall returns the *current* version; the explorer shows the lineage. **Truth changes are recorded, not lost (P1).**
- **Confidence drift.** A fact asserted at `confidence=90` that nothing re-confirms for months should not outrank a freshly-confirmed `confidence=70` fact. The **decay job** ages confidence on stale rows (see Performance); a re-assertion *refreshes* it. Decay is logged as a `memory.asserted` (re-confirmation) or an internal touch, never as silent mutation.
- **Embedding the wrong text.** Only the distilled `title+summary+body` is embedded — never raw PII-laden payloads (Ch.16). If a memory is edited, its `search_tsv` regenerates automatically (generated column) and its `embedding` is re-queued; the two never drift because both derive from the same fields.
- **Entity with thousands of facts** (a large, long-lived org): the graph arm is `limit`-bounded and the knowledge panel paginates by predicate and importance — the operator sees the *most-weighted* facts first, not an unbounded dump.
- **Memory about a now-deleted entity.** Edges use text `object_entity_id` (no FK), so a fact survives its subject's deletion as orphaned knowledge; a sweep flags edges whose entity no longer resolves for operator review (never auto-deleted — additive, P2).
- **Procedural vs semantic ambiguity.** "Never refund above £50" could be a fact *or* a playbook rule. Convention: if it governs an *employee's behaviour*, it is `playbook`/`policy` and linked to that employee; if it describes the *world*, it is a `fact`. The `memory_type` lookup (♻️ data, not code) makes adding a category trivial.

## Performance

This section answers the Golden Rule explicitly: **would we build it this way at one million companies?** Yes — because every arm of recall is bounded or sub-linear.

- **The lexical arm** is the existing GIN index on `search_tsv` — O(matching rows), already proven "instant at scale" in Directive-002, returning a hard-capped 50 candidates.
- **The semantic arm is sub-linear.** HNSW is an approximate-nearest-neighbour index: vector recall does **not** scan the table — it walks a navigable small-world graph in ~O(log N). A 1M-company corpus of, say, tens of millions of facts is queried in single-digit milliseconds at a tunable recall/latency trade-off (`ef_search`). This is the *reason* embeddings live in Postgres-with-pgvector rather than a bolt-on store (Ch.02 tech table; P6).
- **The graph arm is depth-bounded.** The recursive CTE has a **hard `maxDepth` (default 2, cap 4)** and a per-query `limit`; on the indexed `hq_memory_edges (subject_memory)` and `(object_entity_type, object_entity_id)`, each hop is an index lookup over a small fan-out. Traversal cost is bounded by `depth × fan-out × limit`, **independent of total company count** — the only thing that grows with scale is the *number* of entity nodes, and each query touches exactly one neighbourhood.
- **The 1M analysis.** At a million companies the memory graph is large in *total*, but **every recall is local**: a bounded candidate set from each arm, fused and access-filtered in memory. There is no full-graph computation on the request path. The expensive, global work — embedding backfill and confidence decay — is **amortised off the request path** in cron jobs (the ♻️ `withCronTelemetry` pattern), exactly as metrics rollups are (Ch.15). Hot reads (the explorer's knowledge panel) are a single bounded query on covering indexes.
- **Budgets.** Recall p95 < 120 ms (FTS + HNSW + a depth-2 traversal); explorer first paint is a server-rendered snapshot (Ch.09 budget). Embedding a fact on write adds one provider round-trip, kept *off* the synchronous path — the write commits, the embedding lands asynchronously.
- **Index footprint.** HNSW on `vector(1536)` is the largest new index; it is the named cost we accept for sub-linear recall, monitored (index size, build time) and revisited if a smaller dimension suffices (the 🔬 dimension question).

## Security

Trust boundaries per Ch.16; memory is among the most sensitive subsystems because it *concentrates* knowledge.

- **`RLS:hq`, service-role only.** Every `hq_memory*` table — including `embedding` and `hq_memory_edges` — has RLS enabled with zero policies. No JWT/anon client can read one byte of memory. Delivery to the explorer is server-rendered or via the authorized broadcaster (Ch.06), never a client subscription to the tables.
- **No PII beyond identifiers in edges/provenance.** Edge `provenance` holds ids (run/event/correlation) and the model name — not customer detail. Facts may contain business knowledge but follow the same payload discipline as the spine (Ch.04/16): sensitive specifics live in the domain table and are referenced, not copied into broadly-readable memories.
- **Prompt-injection containment.** Memory is read *into* an AI's context, so a poisoned fact is an injection vector. Defences: (1) the Reflector tags machine-asserted facts with `source='system'` and provenance, so their trust level is known; (2) low-confidence/unverified facts are *recallable but flagged*, and high-confidence claims require re-confirmation to earn their weight; (3) an AI cannot grant itself access (operator-only `memory.grant`) — it cannot widen its own knowledge boundary. A fact that *changes behaviour* (procedural) crossing into `high` importance routes through approval (Ch.13).
- **Least privilege (P5).** An AI recalls only what its grants allow; the access filter is applied in the service layer (never trusting the fusion SQL alone), mirroring the defence-in-depth posture of the rest of the OS.
- **Auditability.** Every assert/supersede/grant is a `memory.*` spine event with a `correlation_id`, landing in the immutable audit (Ch.15). "Who taught the OS this, and when?" is always answerable.

## Testing

- **Recall-quality evals.** A fixture corpus of facts + edges + a labelled question set; assert the fused ranking surfaces the right facts (precision@k, recall@k) and that each arm contributes as designed. The byte-identical-oracle discipline (007) applies to the *deterministic* parts (FTS, graph); the vector arm is evaluated against tolerances, with a stubbed deterministic embedder for CI (♻️ Research AI's deterministic fallback pattern).
- **Dedup/supersede tests.** Assert a near-duplicate fact → expect a *merge* (version bump), not a second row; assert a contradicting fact → expect a *supersede* with a `supersedes`/`contradicts` edge and the prior marked `superseded`. Never a silent overwrite.
- **Traversal-bound tests.** A graph with a cycle and a deep chain → assert termination at `maxDepth`, no duplicates, bounded row count. The Golden-Rule guarantee is a test, not a hope.
- **Access tests (RLS + service).** Assert each `hq_memory*` table is unreadable by anon/JWT (♻️ existing RLS-test pattern), and that `recallMemory({forEmployee})` never returns a memory the employee's visibility/grants forbid (the `canEmployeeAccess` contract).
- **Event-contract tests (Ch.04).** Each `memory.*` verb's payload shape is pinned; a Reflector that drifts the shape fails CI.
- **Degradation tests.** Kill the vector arm → recall still returns FTS + graph results with `degraded:true`. Kill the embedder → writes still commit.

## Monitoring

Golden signals (Ch.15), all derived from the `memory.*` events and service metrics:

- **Knowledge growth:** facts asserted/superseded per day; edges added; per-employee contribution (who is teaching the OS).
- **Recall health:** recall p95 and per-arm latency (FTS / HNSW / traversal); **degraded-recall rate** (how often an arm is dropped) — a rising rate is the canary for a pgvector/embedder problem.
- **Embedding backlog:** count of `active` memories with `embedding is null` — the lazy-backfill lag; alerts if it stops draining.
- **Confidence distribution:** histogram of `confidence`; a drift toward low confidence flags stale knowledge the decay job is aging faster than re-confirmation refreshes it.
- **Access changes:** `memory.access_granted`/`revoked` rate — a spike is a security-relevant signal worth surfacing.
- **Index health:** HNSW index size and build time (the named cost from Performance); query plans periodically checked to confirm the index is used (no silent fallback to a seq-scan).

SLOs: recall availability is the *FTS + graph* path (must not depend on pgvector); the vector arm is a *quality* enhancement with its own, looser SLO. Embedding backlog must drain within the cron window.

## Future expansion

The seams left deliberately, each an addition at an existing boundary (P6):

- **Graduate the vector store.** If HNSW-in-Postgres outgrows comfort (index size, build time, recall latency at the measured threshold, Ch.17), the vector arm moves *behind `recallMemory`* to a dedicated store (e.g. a managed ANN service); `assertMemory`/`recallMemory` signatures are unchanged — only the vector CTE's implementation swaps. The facts and edges stay in Postgres (one source of truth, P1).
- **Materialised graph closure.** If deep traversals become hot, precompute a bounded transitive closure (a read-model rebuildable from `hq_memory_edges`, Ch.04 replay) — a cache in front of the recursive CTE, never a second source.
- **Cross-tenant pattern memory.** Today memory is HQ-global. A future phase could let the OS learn *patterns across tenants* ("orgs on plan X churn after event Y") as a distinct memory type with its own privacy review — a new `memory_type` (data, not code) plus an ADR.
- **Learned fusion weights.** Replace hand-set `w_fts/w_vec/w_graph` with weights tuned from operator click-through (the 🔬 open question) — a bounded, reversible change behind the existing flag.
- **Procedural memory as living config.** Extend playbook memories into versioned, approval-gated *operational policy* an employee executes directly — the seam between Ch.12 (what it knows how to do) and Ch.13 (what it may do without a human).

The graph's shape is meant to be stable for the decade: **more memory types, more predicates, more entities at the edges — never a reshaping of the core three-layer model.**
