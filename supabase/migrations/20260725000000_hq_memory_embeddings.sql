-- CrewFlow HQ — Shared Memory: embedding layer + background worker queue
-- (CEO Directive 009, Phase 1, Module 1 — Shared Memory, PR4).
--
-- Builds ON TOP of the cognitive-classes substrate (PR1,
-- 20260722000000_memory_classes_lifecycle.sql), which RESERVED PR4 for
-- "embeddings / pgvector (the vector column + ANN index)". This migration
-- lands that: pgvector, a real vector column + the embedding metadata every
-- embedded memory permanently carries, and the SQL primitives a dedicated
-- background worker uses to embed memories OUTSIDE any SQL transaction
-- (external AI calls never run inside Postgres — CEO architecture rule).
--
-- ADDITIVE & DARK. Every column is added with a default that preserves the
-- exact current meaning of existing rows; no column is dropped or retyped.
-- The worker ships behind a kill-switch (`memory_embedding.worker_enabled`,
-- default false) AND only runs when an embedding provider is configured, so
-- applying this migration changes NO behaviour. Existing rows simply become
-- "pending" (embedded_at IS NULL) — they get embedded in the background once
-- BOTH the switch is on and a provider key is set, and recall keeps working
-- (permission → lexical → structural → ranking → assembly) the entire time.
--
-- EMBEDDINGS ARE A PLUG-IN, NOT A DEPENDENCY. The provider abstraction lives
-- in lib/ai/embeddings/*; this migration is provider-AGNOSTIC. It stores
-- whatever provider/model/dimension/version the worker reports, so switching
-- vendors (OpenAI → Anthropic → Voyage → local) is configuration only and
-- needs NO change here. `embedding vector(1536)` sizes the column to
-- "Version 1" (text-embedding-3-small); a future dimension change is a new
-- additive migration, never a rewrite of this one.
--
-- EMBEDDING IS NOT A BUSINESS EVENT. Nothing here touches the Event Spine
-- (no hq_emit_event, no memory.* verb): generating a vector is mechanical
-- bookkeeping, not company history. The business event is `memory.asserted`
-- (PR2) — it flows on The Pulse; the embedding it triggers does not.
--
-- THE QUEUE is DERIVED from hq_memories columns (no separate enqueue table to
-- drift out of sync): a memory needs embedding iff `embedded_at IS NULL`. A
-- provider/model/quality upgrade re-queues via hq_embedding_enqueue_stale,
-- which sets embedded_at back to NULL in bounded batches while LEAVING the old
-- vector in place — so old vectors stay searchable until their atomic
-- replacement lands. Content edits re-queue automatically (drift trigger).
--
-- Every new table is RLS:hq (RLS enabled, ZERO policies → service-role only).
-- Every new function is SECURITY DEFINER with a pinned empty search_path,
-- EXECUTE revoked from public/anon/authenticated and granted only to
-- service_role — the L-4 hardening the spine + write/recall paths established.

-- ---------------------------------------------------------------------------
-- 0. pgvector. Enable the extension so `vector` types + ANN indexes exist.
--    Pinned to `public` — this repo's extension home (pg_trgm + citext live
--    there too; only Supabase-preinstalled extensions like pgcrypto sit in
--    `extensions`). The schema MATTERS: the recall + complete functions run
--    with `search_path = ''` (injection-proof), so they reference the type and
--    operators as `public.vector` / `OPERATOR(public.<=>)`. Pinning here makes
--    those qualifications correct deterministically rather than depending on
--    the migration session's search_path. Idempotent.
-- ---------------------------------------------------------------------------
create extension if not exists vector with schema public;

-- ---------------------------------------------------------------------------
-- 1. Embedding columns on hq_memories.
--
--    The vector itself + the 9 permanent metadata fields the directive names
--    (provider, model, dimension, version, checksum, embedded_at, latency,
--    cost, status) + the queue/lease/backoff bookkeeping the background worker
--    needs (attempts, last_error, claimed_at, claimed_by, next_attempt_at).
--
--    Embeddings are VERSIONED ASSETS: `embedding_version` is the single
--    canonical staleness key (provider:model:dDIM:vREV) — one comparison
--    detects a provider, model, dimension, or quality change. provider/model/
--    dimension are also stored individually for cost analysis + mixed-provider
--    filtering at recall time.
-- ---------------------------------------------------------------------------
alter table public.hq_memories
  -- "Version 1" is 1536-d (text-embedding-3-small). Nullable: NULL = no
  -- vector yet. A dimension change is a future additive migration.
  add column if not exists embedding vector(1536),

  -- The 9 permanent metadata fields (CEO: "every embedded memory permanently
  -- stores"). embedded_at IS NULL is THE queue trigger.
  add column if not exists embedding_provider   text,
  add column if not exists embedding_model      text,
  add column if not exists embedding_dimension  integer,
  add column if not exists embedding_version    text,
  add column if not exists embedding_checksum   text,
  add column if not exists embedded_at          timestamptz,
  add column if not exists embedding_latency_ms integer,
  add column if not exists embedding_cost       numeric,
  add column if not exists embedding_status     text not null default 'pending'
    check (embedding_status in ('pending', 'embedded', 'failed', 'stale')),

  -- Worker queue / lease / backoff bookkeeping.
  add column if not exists embedding_attempts        integer not null default 0,
  add column if not exists embedding_last_error      text,
  add column if not exists embedding_claimed_at      timestamptz,
  add column if not exists embedding_claimed_by      text,
  add column if not exists embedding_next_attempt_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Indexes — ANN for recall, a tiny partial queue index for the worker, and
--    helpers for re-embed scans + crash recovery. Built for millions of rows.
-- ---------------------------------------------------------------------------

-- ANN (HNSW, cosine). Partial: only embedded rows are in the index, so it
-- stays empty until the worker populates it and never indexes a NULL vector.
-- Recall (PR4d) probes this; query + candidate are filtered to one version so
-- vectors are always compared within a single model's space.
create index if not exists hq_memories_embedding_hnsw
  on public.hq_memories using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- The hot queue: rows awaiting embedding, ordered by their backoff gate. Tiny
-- in steady state (only un-embedded, non-dead rows), so the per-minute claim
-- is an index scan, never a seq scan — the decade-scale guarantee.
create index if not exists hq_memories_embed_queue_idx
  on public.hq_memories (embedding_next_attempt_at asc nulls first, created_at asc)
  where embedded_at is null and embedding_status <> 'failed';

-- Re-embed scans (hq_embedding_enqueue_stale walks embedded rows by version).
create index if not exists hq_memories_embed_version_idx
  on public.hq_memories (embedding_version)
  where embedded_at is not null;

-- Crash recovery: hq_embedding_reclaim_stale finds expired leases.
create index if not exists hq_memories_embed_claimed_idx
  on public.hq_memories (embedding_claimed_at)
  where embedding_claimed_at is not null;

-- ---------------------------------------------------------------------------
-- 3. Drift re-queue trigger. When a memory's embeddable content (title /
--    summary / body) changes, its stored vector is stale: clear embedded_at to
--    re-queue, but KEEP the old vector + version so it stays searchable until
--    the worker computes the replacement (atomic swap in hq_embedding_complete).
--    Embedding-only updates (claim/complete/fail/reinforce) leave content
--    untouched, so they never trip this — no requeue storms.
-- ---------------------------------------------------------------------------
create or replace function public._hq_memories_embed_requeue()
returns trigger language plpgsql as $$
begin
  if (new.title, new.summary, new.body)
       is distinct from (old.title, old.summary, old.body) then
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

drop trigger if exists hq_memories_embed_requeue on public.hq_memories;
create trigger hq_memories_embed_requeue
  before update on public.hq_memories
  for each row execute function public._hq_memories_embed_requeue();

-- ---------------------------------------------------------------------------
-- 4. hq_embedding_runs — the per-request cost ledger (append-only).
--    The CEO's cost-accounting contract: "every embedding request records"
--    Provider, Model, Dimension, Tokens, Cost, Latency, Retries (attempt),
--    Failure reason, Worker ID, Timestamp. One row per ATTEMPT (success OR
--    failure) so spend, throughput, and failure rates are all derivable. The
--    per-memory columns hold the latest outcome; this table is the full history.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_embedding_runs (
  id             bigint generated always as identity primary key,
  memory_id      uuid references public.hq_memories(id) on delete cascade,
  worker_id      text        not null,
  provider       text,
  model          text,
  dimension      integer,
  tokens         integer,
  cost           numeric,
  latency_ms     integer,
  attempt        integer     not null default 1,
  status         text        not null check (status in ('succeeded', 'failed')),
  failure_reason text,
  created_at     timestamptz not null default now()
);
alter table public.hq_embedding_runs enable row level security;
-- NO policies → service-role only.

create index if not exists hq_embedding_runs_created_idx
  on public.hq_embedding_runs (created_at desc);
create index if not exists hq_embedding_runs_memory_idx
  on public.hq_embedding_runs (memory_id);
create index if not exists hq_embedding_runs_status_idx
  on public.hq_embedding_runs (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Worker kill-switch — seed memory_embedding.worker_enabled = false.
--    Idempotent and non-clobbering (only writes when ABSENT). Stored under the
--    non-UI `memory_embedding` section of hq_settings — an infra switch, not a
--    feature flag — exactly as the spine seeded event_spine.consumer_enabled.
-- ---------------------------------------------------------------------------
update public.hq_settings
set data = coalesce(data, '{}'::jsonb)
           || jsonb_build_object('memory_embedding',
                coalesce(data -> 'memory_embedding', '{}'::jsonb)
                  || jsonb_build_object('worker_enabled', false))
where id = 'singleton'
  and (data #> '{memory_embedding,worker_enabled}') is null;

-- ---------------------------------------------------------------------------
-- 6. hq_memory_embed_enabled() — read the worker gate. STABLE, fail-dark
--    (defaults FALSE on a missing key), mirrors hq_spine_consumer_enabled().
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_embed_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (data #> '{memory_embedding,worker_enabled}')::boolean
       from public.hq_settings
      where id = 'singleton'),
    false
  );
$$;

revoke all on function public.hq_memory_embed_enabled() from public, anon, authenticated;
grant execute on function public.hq_memory_embed_enabled() to service_role;

-- ---------------------------------------------------------------------------
-- 7. hq_embedding_claim_batch — lease a batch of memories needing embedding.
--    Mirrors the spine drainer's concurrency control (FOR UPDATE SKIP LOCKED)
--    but PERSISTS the claim as a LEASE (claimed_at/claimed_by) because the work
--    — the external embedding call — happens in TS, OUTSIDE this transaction. A
--    crashed worker's lease expires (p_lease_seconds) and the row is re-claimed
--    (hq_embedding_reclaim_stale). Returns each row's id + the composed text to
--    embed (title/summary/body, capped to the model's input bound) so the
--    worker never has to know the composition. Fail-dark when the gate is off.
-- ---------------------------------------------------------------------------
create or replace function public.hq_embedding_claim_batch(
  p_worker_id     text,
  p_limit         integer default 32,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if not public.hq_memory_embed_enabled() then
    return jsonb_build_object('skipped', 'worker_disabled', 'claimed', '[]'::jsonb);
  end if;

  with claimable as (
    select id
      from public.hq_memories
     where embedded_at is null
       and embedding_status <> 'failed'
       and (embedding_claimed_at is null
            or embedding_claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 1)))
       and (embedding_next_attempt_at is null or embedding_next_attempt_at <= now())
     order by embedding_next_attempt_at asc nulls first, created_at asc
     limit greatest(p_limit, 1)
     for update skip locked
  ),
  claimed as (
    update public.hq_memories m
       set embedding_claimed_at = now(),
           embedding_claimed_by = p_worker_id
      from claimable c
     where m.id = c.id
     returning m.id,
               left(
                 coalesce(m.title, '') || E'\n\n' ||
                 coalesce(m.summary, '') || E'\n\n' ||
                 coalesce(m.body, ''),
                 32000
               ) as embed_input
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('id', id, 'embed_input', embed_input)),
           '[]'::jsonb
         )
    into v_rows
    from claimed;

  return jsonb_build_object('claimed', v_rows);
end;
$$;

revoke all on function public.hq_embedding_claim_batch(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hq_embedding_claim_batch(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 8. hq_embedding_complete — store a freshly-computed vector ATOMICALLY.
--    The atomic swap: the worker computed the new vector via the provider
--    FIRST (outside any txn); this single UPDATE replaces the vector + all
--    metadata + clears the lease in one statement, so a re-embed never leaves a
--    half-written row and old vectors stay searchable until this instant.
--    Idempotency / crash recovery: only the worker that still HOLDS the lease
--    may complete (claimed_by = p_worker_id). A late worker whose lease expired
--    and whose row was re-embedded by another finds 0 rows → no-op, never a
--    duplicate. Validates dimension defensively; returns {ok:false} (caller
--    routes to fail) rather than raising, so the ledger stays consistent.
-- ---------------------------------------------------------------------------
create or replace function public.hq_embedding_complete(
  p_memory_id  uuid,
  p_worker_id  text,
  p_embedding  float8[],
  p_provider   text,
  p_model      text,
  p_dimension  integer,
  p_version    text,
  p_checksum   text,
  p_tokens     integer default null,
  p_cost       numeric default null,
  p_latency_ms integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt integer;
  v_updated uuid;
begin
  -- Defensive dimension guard (the worker validates too; defence in depth).
  if coalesce(array_length(p_embedding, 1), 0) <> p_dimension then
    return jsonb_build_object('ok', false, 'reason', 'dimension_mismatch',
      'expected', p_dimension, 'actual', coalesce(array_length(p_embedding, 1), 0));
  end if;

  update public.hq_memories m
     -- `public.vector`, not `vector`: this function pins `search_path = ''`, so
     -- the type must be schema-qualified (pgvector lives in `public`, §0).
     set embedding             = p_embedding::real[]::public.vector,
         embedding_provider    = p_provider,
         embedding_model       = p_model,
         embedding_dimension   = p_dimension,
         embedding_version     = p_version,
         embedding_checksum    = p_checksum,
         embedded_at           = now(),
         embedding_latency_ms  = p_latency_ms,
         embedding_cost        = p_cost,
         embedding_status      = 'embedded',
         embedding_attempts    = 0,
         embedding_last_error  = null,
         embedding_claimed_at  = null,
         embedding_claimed_by  = null,
         embedding_next_attempt_at = null
   where m.id = p_memory_id
     and m.embedding_claimed_by = p_worker_id
  returning m.id, m.embedding_attempts into v_updated, v_attempt;

  if v_updated is null then
    -- Lease lost (reclaimed + re-embedded elsewhere) or already done: no-op.
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;

  insert into public.hq_embedding_runs
    (memory_id, worker_id, provider, model, dimension, tokens, cost, latency_ms, attempt, status)
  values
    (p_memory_id, p_worker_id, p_provider, p_model, p_dimension, p_tokens, p_cost, p_latency_ms,
     coalesce(v_attempt, 0) + 1, 'succeeded');

  return jsonb_build_object('ok', true, 'memory_id', p_memory_id);
end;
$$;

revoke all on function public.hq_embedding_complete(uuid, text, float8[], text, text, integer, text, text, integer, numeric, integer) from public, anon, authenticated;
grant execute on function public.hq_embedding_complete(uuid, text, float8[], text, text, integer, text, text, integer, numeric, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 9. hq_embedding_fail — record a failed attempt: retry with exponential
--    backoff, dead-letter after p_max_attempts. Increments attempts, stores the
--    reason, releases the lease, and sets embedding_next_attempt_at = now() +
--    min(2^attempts * 30s, 1h) so a transient provider error (rate-limit, blip)
--    is retried later without hammering. At the threshold the row is parked
--    (status = 'failed' → excluded from the queue) — the dead-letter; it stays
--    fully recallable via lexical/structural, only semantic is unavailable.
--    Lease-guarded (claimed_by) for the same idempotency reason as complete.
-- ---------------------------------------------------------------------------
create or replace function public.hq_embedding_fail(
  p_memory_id    uuid,
  p_worker_id    text,
  p_provider     text,
  p_model        text,
  p_error        text,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt integer;
  v_dead    boolean := false;
  v_updated uuid;
begin
  update public.hq_memories m
     set embedding_attempts   = m.embedding_attempts + 1,
         embedding_last_error = left(p_error, 2000),
         embedding_claimed_at = null,
         embedding_claimed_by = null,
         embedding_status     = case
           when m.embedding_attempts + 1 >= greatest(p_max_attempts, 1) then 'failed'
           else m.embedding_status
         end,
         embedding_next_attempt_at = case
           when m.embedding_attempts + 1 >= greatest(p_max_attempts, 1) then null
           else now() + make_interval(secs =>
             least(power(2, m.embedding_attempts + 1)::integer * 30, 3600))
         end
   where m.id = p_memory_id
     and m.embedding_claimed_by = p_worker_id
  returning m.id, m.embedding_attempts,
            (m.embedding_status = 'failed') into v_updated, v_attempt, v_dead;

  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;

  insert into public.hq_embedding_runs
    (memory_id, worker_id, provider, model, attempt, status, failure_reason)
  values
    (p_memory_id, p_worker_id, p_provider, p_model, v_attempt, 'failed', left(p_error, 2000));

  return jsonb_build_object('ok', true, 'memory_id', p_memory_id,
    'attempts', v_attempt, 'dead_lettered', v_dead);
end;
$$;

revoke all on function public.hq_embedding_fail(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.hq_embedding_fail(uuid, text, text, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 10. hq_embedding_reclaim_stale — crash / restart recovery. A worker that
--     died mid-batch left rows leased (claimed_at set) but never completed
--     (embedded_at still null). After the lease expires, clear the claim so the
--     rows are claimable again. Bounded; returns the count reclaimed. This is
--     "resume after restart" — no work is lost, none is double-done (the
--     lease + complete's claimed_by guard make a late finisher a no-op).
-- ---------------------------------------------------------------------------
create or replace function public.hq_embedding_reclaim_stale(
  p_lease_seconds integer default 300,
  p_limit         integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with stale as (
    select id
      from public.hq_memories
     where embedding_claimed_at is not null
       and embedded_at is null
       and embedding_claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 1))
     order by embedding_claimed_at asc
     limit greatest(p_limit, 1)
     for update skip locked
  ),
  reclaimed as (
    update public.hq_memories m
       set embedding_claimed_at = null,
           embedding_claimed_by = null
      from stale s
     where m.id = s.id
     returning m.id
  )
  select count(*) into v_count from reclaimed;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.hq_embedding_reclaim_stale(integer, integer) from public, anon, authenticated;
grant execute on function public.hq_embedding_reclaim_stale(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 11. hq_embedding_enqueue_stale — re-embed driver for provider/model/quality
--     upgrades + bulk/partial/background rebuilds. Finds EMBEDDED rows whose
--     version no longer matches the target and re-queues them (embedded_at =
--     null) in bounded batches — LEAVING the old vector + version untouched, so
--     they remain searchable until the worker computes + atomically swaps in
--     the replacement. Pass p_limit to pace a million-row migration over many
--     runs (background). Returns the count enqueued; 0 means fully migrated.
-- ---------------------------------------------------------------------------
create or replace function public.hq_embedding_enqueue_stale(
  p_target_version text,
  p_limit          integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with stale as (
    select id
      from public.hq_memories
     where embedded_at is not null
       and embedding_status <> 'failed'
       and embedding_version is distinct from p_target_version
     order by embedded_at asc
     limit greatest(p_limit, 1)
     for update skip locked
  ),
  requeued as (
    update public.hq_memories m
       set embedded_at = null,
           embedding_status = 'pending',
           embedding_attempts = 0,
           embedding_last_error = null,
           embedding_next_attempt_at = null,
           embedding_claimed_at = null,
           embedding_claimed_by = null
      from stale s
     where m.id = s.id
     returning m.id
  )
  select count(*) into v_count from requeued;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.hq_embedding_enqueue_stale(text, integer) from public, anon, authenticated;
grant execute on function public.hq_embedding_enqueue_stale(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 12. hq_embedding_reset_failed — bring dead-lettered rows back into the queue
--     once the root cause (bad key, provider outage) is fixed. Bounded; clears
--     the failure state so the worker retries them. The deliberate "drain the
--     DLQ" operator action.
-- ---------------------------------------------------------------------------
create or replace function public.hq_embedding_reset_failed(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with dead as (
    select id
      from public.hq_memories
     where embedding_status = 'failed'
     order by updated_at asc
     limit greatest(p_limit, 1)
     for update skip locked
  ),
  reset as (
    update public.hq_memories m
       set embedding_status = 'pending',
           embedding_attempts = 0,
           embedding_last_error = null,
           embedding_next_attempt_at = null,
           embedding_claimed_at = null,
           embedding_claimed_by = null
      from dead d
     where m.id = d.id
     returning m.id
  )
  select count(*) into v_count from reset;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.hq_embedding_reset_failed(integer) from public, anon, authenticated;
grant execute on function public.hq_embedding_reset_failed(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 13. hq_embedding_golden_signals — operational read (Ch.15 golden signals).
--     Queue depth, in-flight leases, dead-letter count, coverage, spend, and
--     throughput — everything an operator needs to watch the worker. Optional
--     p_target_version reports how many EMBEDDED rows are stale vs. the current
--     model (the re-embed backlog). Cheap bounded aggregates; no projection.
-- ---------------------------------------------------------------------------
create or replace function public.hq_embedding_golden_signals(
  p_target_version text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'worker_enabled', public.hq_memory_embed_enabled(),
    'memories', jsonb_build_object(
      'total',    (select count(*) from public.hq_memories),
      'embedded', (select count(*) from public.hq_memories where embedded_at is not null),
      'pending',  (select count(*) from public.hq_memories
                    where embedded_at is null and embedding_status <> 'failed'),
      'failed',   (select count(*) from public.hq_memories where embedding_status = 'failed'),
      'in_flight',(select count(*) from public.hq_memories where embedding_claimed_at is not null),
      'stale',    case when p_target_version is null then null else
                  (select count(*) from public.hq_memories
                    where embedded_at is not null
                      and embedding_version is distinct from p_target_version) end
    ),
    'spend', jsonb_build_object(
      'cost_1h',  (select coalesce(sum(cost), 0) from public.hq_embedding_runs
                    where status = 'succeeded' and created_at >= now() - interval '1 hour'),
      'cost_24h', (select coalesce(sum(cost), 0) from public.hq_embedding_runs
                    where status = 'succeeded' and created_at >= now() - interval '24 hours'),
      'tokens_24h',(select coalesce(sum(tokens), 0) from public.hq_embedding_runs
                    where status = 'succeeded' and created_at >= now() - interval '24 hours')
    ),
    'throughput', jsonb_build_object(
      'succeeded_1h', (select count(*) from public.hq_embedding_runs
                        where status = 'succeeded' and created_at >= now() - interval '1 hour'),
      'failed_1h',    (select count(*) from public.hq_embedding_runs
                        where status = 'failed' and created_at >= now() - interval '1 hour')
    )
  );
$$;

revoke all on function public.hq_embedding_golden_signals(text) from public, anon, authenticated;
grant execute on function public.hq_embedding_golden_signals(text) to service_role;
