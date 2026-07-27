-- CrewFlow HQ — Shared Memory: cognitive classes + lifecycle
-- (CEO Directive 009, Phase 1, Module 1 — Shared Memory, PR1).
--
-- Builds ON TOP of the Shared Memory Engine (CEO Directive 002,
-- 20260713000000_hq_shared_memory.sql). This is the substrate evolution
-- the CrewFlow Bible, Volume X (Shared Memory Architecture) §4–§5
-- describes: from a "read-first filing cabinet" (humans author, AI only
-- reads) into "virtual memory for the AI workforce" (AI writes lived
-- experience and recalls a ranked, budgeted, permissioned slice).
--
-- ADDITIVE & DARK. Every column added below carries a default that
-- preserves the EXACT current meaning of every existing row
-- (memory_class = 'semantic', company-owned, never expiring), so this
-- migration is a NO-OP for production data and changes NO behaviour on
-- its own. The engine that gives these columns meaning lands in later,
-- separately-reviewed migrations:
--   PR2  the AI write path        (hq_memory_write)
--   PR3  the retrieval pipeline   (hq_memory_recall)
--   PR4  embeddings / pgvector    (the vector column + ANN index)
--   PR5  consolidation / expiry   (recurring tasks)
-- pgvector is deliberately NOT enabled here — semantic search stays
-- dormant until the embedding-model decision (Volume X §16 Q1) is taken,
-- and recall degrades gracefully to the existing full-text + graph search.
--
-- No existing column is dropped or retyped (production-safe, per directive).
-- hq_memories already has RLS ENABLED with NO policies (service-role only);
-- the new columns inherit that — no customer/staff JWT can ever see them.

-- ---------------------------------------------------------------------
-- Cognitive class + lifecycle columns (Volume X §4–§5).
-- ---------------------------------------------------------------------

alter table public.hq_memories
  -- The cognitive class. The COARSE category that drives lifecycle
  -- (expiry, consolidation, retrieval weighting) — distinct from, and
  -- additive to, the fine-grained data-driven `memory_type` lookup, which
  -- is unchanged. Five classes are a fixed enum because they drive engine
  -- behaviour; new `memory_type`s remain data rows. Defaults 'semantic'
  -- so every existing row keeps its current meaning with zero backfill.
  add column if not exists memory_class text not null default 'semantic'
    check (memory_class in ('semantic', 'episodic', 'working', 'long_term', 'procedural')),

  -- Ownership: which AI employee this memory belongs to (private lived
  -- experience). Null = company-owned (the classic shared memory). FK keeps
  -- it honest; on employee deletion the memory survives as company-owned.
  add column if not exists owner_employee_id uuid
    references public.ai_employees(id) on delete set null,

  -- Working / expiring-memory TTL. Null = never expires (the durable
  -- company brain: semantic / long_term / procedural).
  add column if not exists expires_at timestamp with time zone,

  -- Consolidation lineage: when an episodic memory is rolled up into a
  -- long_term one (Volume X §9.2), point at the target so the episode can
  -- decay (§10) without losing its lesson.
  add column if not exists consolidated_into uuid
    references public.hq_memories(id) on delete set null,

  -- Salience: retention / eviction priority (0..100). High-salience working
  -- memory survives pressure; low-salience episodes decay first. Distinct
  -- from `importance` (editorial) and `confidence` (epistemic) already present.
  add column if not exists salience integer not null default 50
    check (salience between 0 and 100),

  -- The bound task for working memory — auto-expire when the task finishes
  -- (Task Engine, Volume XII, Module 4). Intentionally NOT FK-constrained
  -- yet: the task table does not exist until Module 4. The FK is added then.
  add column if not exists bound_task_id uuid,

  -- Decay bookkeeping: last time this memory was recalled / used, so used
  -- knowledge decays slower (Volume X §7 reinforcement, §10 decay).
  add column if not exists last_reinforced_at timestamp with time zone;

-- ---------------------------------------------------------------------
-- Retrieval / lifecycle indexes (non-vector). The ANN (HNSW) index ships
-- in PR4 alongside pgvector. Partial indexes where the column is sparse,
-- so they stay tiny until the AI write path populates them.
-- ---------------------------------------------------------------------

create index if not exists hq_memories_class_idx
  on public.hq_memories (memory_class);

create index if not exists hq_memories_owner_idx
  on public.hq_memories (owner_employee_id)
  where owner_employee_id is not null;

create index if not exists hq_memories_expiry_idx
  on public.hq_memories (expires_at)
  where expires_at is not null;

create index if not exists hq_memories_bound_task_idx
  on public.hq_memories (bound_task_id)
  where bound_task_id is not null;

create index if not exists hq_memories_consolidated_idx
  on public.hq_memories (consolidated_into)
  where consolidated_into is not null;

-- Episodic / working decay ranking reads recency × salience.
create index if not exists hq_memories_reinforced_idx
  on public.hq_memories (last_reinforced_at desc nulls last)
  where memory_class in ('episodic', 'working');
