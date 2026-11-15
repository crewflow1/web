-- CrewFlow — Tenant Semantic Search: the per-tenant embeddings corpus + worker queue.
--
-- Gives the global command-palette search (app/api/search/route.ts) a SECOND,
-- OPTIONAL retrieval channel: dense-vector semantic recall over an org's own
-- business records, so "boiler leak" can surface a job whose notes say "water
-- escaping from the hot-water cylinder" even with no shared keyword. The
-- existing keyword (ILIKE / tsvector) search is UNTOUCHED and remains the
-- substrate; semantic recall is purely additive and dark by default.
--
-- REUSES, NEVER FORKS, the embedding stack (CEO Directive 009 standing rule):
--   - pgvector + the vector(1536) column shape from the HQ memory corpus
--     (20260725000000_hq_memory_embeddings.sql);
--   - the SAME provider abstraction (lib/ai/embeddings/*), the SAME governed
--     door (lib/ai/embeddings/governed.ts → invokeWithGovernor), the SAME
--     claim→embed→complete lease mechanics. This is a SECOND corpus table with
--     its own queue primitives, NOT a parallel embedding system.
--
-- THE SECURITY POSTURE (non-negotiable, enforced across this file + the queue +
-- the retrieval migrations):
--   - tenant_search_documents has RLS ENABLED with ZERO policies → service-role
--     only. No authenticated/anon client can read a row directly; the ONLY read
--     path is the SECURITY DEFINER retrieval RPC (20261282), which enforces
--     tenant (current_org_ids) + staff assignment (my_assigned_job_ids) +
--     visibility INLINE and NEVER returns the embedding column.
--   - the corpus NEVER stores money or secrets: the TS source mappers
--     (lib/search/semantic/mappers.ts) compose `content` from a strict column
--     ALLOWLIST, and management-only / money registers are excluded or marked
--     visibility='management' so staff can never reach them semantically.
--   - every function here is SECURITY DEFINER, search_path = '' (injection-
--     proof), EXECUTE revoked from public/anon/authenticated, granted only to
--     service_role — the embedding queue is operator/worker machinery, never
--     client-reachable.
--
-- ADDITIVE & DARK. Applying this changes NO behaviour: nothing writes to the
-- table until the backfill runs, nothing embeds until BOTH the worker gate
-- (tenant_search.worker_enabled, seeded false) is on AND an embedding provider
-- is configured, and nothing reads it until the route lights up the semantic
-- channel — which itself degrades to keyword the instant embeddings are dark.

-- ---------------------------------------------------------------------------
-- 0. pgvector. Already enabled by the HQ memory corpus; idempotent + pinned to
--    `public` (this repo's extension home) so the search_path='' functions can
--    schema-qualify the type + operators as public.vector / OPERATOR(public.<=>).
-- ---------------------------------------------------------------------------
create extension if not exists vector with schema public;

-- ---------------------------------------------------------------------------
-- 1. tenant_search_documents — one row per embeddable SOURCE record.
--
--    Identity: (org_id, source_table, source_id) is unique — a job, a customer,
--    a site report each own exactly one corpus row, re-synced in place.
--
--    GATING COLUMNS the retrieval RPC enforces (never trusted to the client):
--      - org_id     → tenant isolation (current_org_ids()).
--      - job_id     → staff assignment gate (my_assigned_job_ids()); NULL for
--                     org-level records that carry no job.
--      - visibility → the staff-reachability allowlist. 'member'/'staff' are
--                     staff-reachable; 'management' (Sales/Money/Operations
--                     admin surfaces) and 'private' (admin-only job docs) are
--                     admin-only. Any other/unknown value fails closed.
--
--    content is the embeddable + lexically-indexed text (column-allowlisted,
--    NO money/secrets). content_tsv backs the keyword channel INSIDE the RPC so
--    semantic-off recall still returns lexical corpus hits (graceful fallback).
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_search_documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  source_table  text not null check (length(trim(source_table)) between 1 and 120),
  source_id     uuid not null,
  job_id        uuid,
  visibility    text not null default 'member'
    check (visibility in ('member', 'staff', 'management', 'private')),

  -- The embeddable / searchable text. Allowlisted + money-free by construction
  -- (the TS mappers decide what goes here). Capped defensively.
  content          text not null,
  content_checksum text,
  -- Lexical index over the corpus — the keyword channel the RPC falls back to
  -- when the semantic channel is dark. 2-arg to_tsvector (IMMUTABLE) so the
  -- generated column is legal.
  content_tsv      tsvector generated always as
                     (to_tsvector('english'::regconfig, coalesce(content, ''))) stored,

  -- The vector + the versioned-asset metadata (same shape as hq_memories).
  embedding            public.vector(1536),
  embedding_provider   text,
  embedding_model      text,
  embedding_dimension  integer,
  embedding_version    text,
  embedded_at          timestamptz,
  embedding_status     text not null default 'pending'
    check (embedding_status in ('pending', 'embedded', 'failed', 'stale')),

  -- Worker queue / lease / backoff bookkeeping (mirrors hq_memories).
  embedding_attempts        integer not null default 0,
  embedding_last_error      text,
  embedding_claimed_at      timestamptz,
  embedding_claimed_by      text,
  embedding_next_attempt_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_search_documents_unique_source
    unique (org_id, source_table, source_id)
);

alter table public.tenant_search_documents enable row level security;
-- NO policies → service-role only. The retrieval RPC (SECURITY DEFINER) is the
-- sole authenticated read path and enforces tenant/staff/visibility in-body.

-- ---------------------------------------------------------------------------
-- 2. Indexes — ANN recall, lexical fallback, the hot queue, re-embed + recovery.
-- ---------------------------------------------------------------------------

-- ANN (HNSW, cosine). Partial: only embedded rows, so it stays empty until the
-- worker populates it and never indexes a NULL vector.
create index if not exists tenant_search_documents_embedding_hnsw
  on public.tenant_search_documents using hnsw (embedding public.vector_cosine_ops)
  where embedding is not null;

-- Lexical fallback channel.
create index if not exists tenant_search_documents_tsv_idx
  on public.tenant_search_documents using gin (content_tsv);

-- The per-org gate the RPC drives from (org_id first, then the staff/job gate).
create index if not exists tenant_search_documents_org_idx
  on public.tenant_search_documents (org_id);
create index if not exists tenant_search_documents_job_idx
  on public.tenant_search_documents (org_id, job_id)
  where job_id is not null;

-- The hot queue: rows awaiting embedding, ordered by their backoff gate.
create index if not exists tenant_search_documents_queue_idx
  on public.tenant_search_documents (embedding_next_attempt_at asc nulls first, created_at asc)
  where embedded_at is null and embedding_status <> 'failed';

-- Re-embed scans (enqueue_stale walks embedded rows by version).
create index if not exists tenant_search_documents_version_idx
  on public.tenant_search_documents (embedding_version)
  where embedded_at is not null;

-- Crash recovery: reclaim_stale finds expired leases.
create index if not exists tenant_search_documents_claimed_idx
  on public.tenant_search_documents (embedding_claimed_at)
  where embedding_claimed_at is not null;

-- ---------------------------------------------------------------------------
-- 3. Drift re-queue trigger. When content changes, the stored vector is stale:
--    clear embedded_at to re-queue, KEEPING the old vector + version so it stays
--    searchable until the worker computes the replacement (atomic swap in
--    tenant_search_complete). Also maintains updated_at. Embedding-only updates
--    (claim/complete/fail) leave content untouched, so they never trip this.
-- ---------------------------------------------------------------------------
create or replace function public._tenant_search_documents_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.content is distinct from old.content then
    new.embedded_at := null;
    new.embedding_status := 'pending';
    new.embedding_attempts := 0;
    new.embedding_last_error := null;
    new.embedding_next_attempt_at := null;
    new.embedding_claimed_at := null;
    new.embedding_claimed_by := null;
  end if;
  return new;
end $$;

drop trigger if exists tenant_search_documents_touch on public.tenant_search_documents;
create trigger tenant_search_documents_touch
  before update on public.tenant_search_documents
  for each row execute function public._tenant_search_documents_touch();

-- ---------------------------------------------------------------------------
-- 4. Worker kill-switch — seed tenant_search.worker_enabled = false.
--    Idempotent + non-clobbering, under the non-UI `tenant_search` section of
--    hq_settings — an infra switch, exactly like memory_embedding.worker_enabled.
-- ---------------------------------------------------------------------------
update public.hq_settings
set data = coalesce(data, '{}'::jsonb)
           || jsonb_build_object('tenant_search',
                coalesce(data -> 'tenant_search', '{}'::jsonb)
                  || jsonb_build_object('worker_enabled', false))
where id = 'singleton'
  and (data #> '{tenant_search,worker_enabled}') is null;

-- ---------------------------------------------------------------------------
-- 5. tenant_search_embed_enabled() — read the worker gate. STABLE, fail-dark
--    (defaults FALSE on a missing key), mirrors hq_memory_embed_enabled().
-- ---------------------------------------------------------------------------
create or replace function public.tenant_search_embed_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (data #> '{tenant_search,worker_enabled}')::boolean
       from public.hq_settings
      where id = 'singleton'),
    false
  );
$$;

revoke all on function public.tenant_search_embed_enabled() from public, anon, authenticated;
grant execute on function public.tenant_search_embed_enabled() to service_role;
