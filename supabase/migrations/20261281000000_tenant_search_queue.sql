-- CrewFlow — Tenant Semantic Search: the background embedding worker queue.
--
-- The atomic claim→embed→complete lease mechanics, mirroring the HQ memory
-- embedding primitives (20260725000000) EXACTLY — same FOR UPDATE SKIP LOCKED
-- concurrency, same lease/backoff/dead-letter, same crash recovery — because
-- the constraint is identical: the external embedding call must run in TS,
-- OUTSIDE any Postgres transaction, so the queue state lives in SQL and the
-- worker is the seam.
--
-- THE ONE DIFFERENCE FROM THE HQ QUEUE: every row carries its OWN org_id
-- (tenant), so the claim projects it and the worker bills THAT org's budget
-- through the governed door — never CrewFlow's internal org. A single claimed
-- batch may span orgs; the worker groups by org_id, one governed call per org.
--
-- Every function: SECURITY DEFINER, search_path = '', EXECUTE revoked from
-- public/anon/authenticated, granted only to service_role.

-- ---------------------------------------------------------------------------
-- 1. tenant_search_claim_batch — lease a batch of documents needing embedding.
--    Returns each row's id, org_id (the budget owner) and content to embed.
--    Fail-dark when the gate is off.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_search_claim_batch(
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
  if not public.tenant_search_embed_enabled() then
    return jsonb_build_object('skipped', 'worker_disabled', 'claimed', '[]'::jsonb);
  end if;

  with claimable as (
    select id
      from public.tenant_search_documents
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
    update public.tenant_search_documents m
       set embedding_claimed_at = now(),
           embedding_claimed_by = p_worker_id
      from claimable c
     where m.id = c.id
     returning m.id, m.org_id, left(coalesce(m.content, ''), 32000) as embed_input
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('id', id, 'org_id', org_id, 'embed_input', embed_input)),
           '[]'::jsonb
         )
    into v_rows
    from claimed;

  return jsonb_build_object('claimed', v_rows);
end;
$$;

revoke all on function public.tenant_search_claim_batch(text, integer, integer) from public, anon, authenticated;
grant execute on function public.tenant_search_claim_batch(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. tenant_search_complete — store a freshly-computed vector ATOMICALLY.
--    Lease-guarded (claimed_by): a late worker whose lease expired finds 0 rows
--    → no-op, never a duplicate. Validates dimension defensively.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_search_complete(
  p_document_id uuid,
  p_worker_id   text,
  p_embedding   float8[],
  p_provider    text,
  p_model       text,
  p_dimension   integer,
  p_version     text,
  p_checksum    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated uuid;
begin
  if coalesce(array_length(p_embedding, 1), 0) <> p_dimension then
    return jsonb_build_object('ok', false, 'reason', 'dimension_mismatch',
      'expected', p_dimension, 'actual', coalesce(array_length(p_embedding, 1), 0));
  end if;

  update public.tenant_search_documents m
     set embedding             = p_embedding::real[]::public.vector,
         embedding_provider    = p_provider,
         embedding_model       = p_model,
         embedding_dimension   = p_dimension,
         embedding_version     = p_version,
         content_checksum      = p_checksum,
         embedded_at           = now(),
         embedding_status      = 'embedded',
         embedding_attempts    = 0,
         embedding_last_error  = null,
         embedding_claimed_at  = null,
         embedding_claimed_by  = null,
         embedding_next_attempt_at = null
   where m.id = p_document_id
     and m.embedding_claimed_by = p_worker_id
  returning m.id into v_updated;

  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;

  return jsonb_build_object('ok', true, 'document_id', p_document_id);
end;
$$;

revoke all on function public.tenant_search_complete(uuid, text, float8[], text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.tenant_search_complete(uuid, text, float8[], text, text, integer, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. tenant_search_fail — record a failed attempt: retry with exponential
--    backoff, dead-letter after p_max_attempts. A dead-lettered row stays fully
--    recallable via the lexical channel; only semantic is unavailable for it.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_search_fail(
  p_document_id  uuid,
  p_worker_id    text,
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
  update public.tenant_search_documents m
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
   where m.id = p_document_id
     and m.embedding_claimed_by = p_worker_id
  returning m.id, m.embedding_attempts, (m.embedding_status = 'failed')
       into v_updated, v_attempt, v_dead;

  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;

  return jsonb_build_object('ok', true, 'document_id', p_document_id,
    'attempts', v_attempt, 'dead_lettered', v_dead);
end;
$$;

revoke all on function public.tenant_search_fail(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.tenant_search_fail(uuid, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. tenant_search_reclaim_stale — crash / restart recovery. Frees leases left
--    by a worker that died mid-batch, after the lease expires. Bounded.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_search_reclaim_stale(
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
      from public.tenant_search_documents
     where embedding_claimed_at is not null
       and embedded_at is null
       and embedding_claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 1))
     order by embedding_claimed_at asc
     limit greatest(p_limit, 1)
     for update skip locked
  ),
  reclaimed as (
    update public.tenant_search_documents m
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

revoke all on function public.tenant_search_reclaim_stale(integer, integer) from public, anon, authenticated;
grant execute on function public.tenant_search_reclaim_stale(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. tenant_search_enqueue_stale — re-embed driver for provider/model/quality
--    upgrades. Re-queues embedded rows whose version != target in bounded
--    batches, LEAVING the old vector searchable until the swap. Returns count.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_search_enqueue_stale(
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
      from public.tenant_search_documents
     where embedded_at is not null
       and embedding_status <> 'failed'
       and embedding_version is distinct from p_target_version
     order by embedded_at asc
     limit greatest(p_limit, 1)
     for update skip locked
  ),
  requeued as (
    update public.tenant_search_documents m
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

revoke all on function public.tenant_search_enqueue_stale(text, integer) from public, anon, authenticated;
grant execute on function public.tenant_search_enqueue_stale(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. tenant_search_golden_signals — operational read: queue depth, in-flight,
--    dead-letter, coverage. Cheap bounded aggregates.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_search_golden_signals()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'worker_enabled', public.tenant_search_embed_enabled(),
    'documents', jsonb_build_object(
      'total',    (select count(*) from public.tenant_search_documents),
      'embedded', (select count(*) from public.tenant_search_documents where embedded_at is not null),
      'pending',  (select count(*) from public.tenant_search_documents
                    where embedded_at is null and embedding_status <> 'failed'),
      'failed',   (select count(*) from public.tenant_search_documents where embedding_status = 'failed'),
      'in_flight',(select count(*) from public.tenant_search_documents where embedding_claimed_at is not null)
    )
  );
$$;

revoke all on function public.tenant_search_golden_signals() from public, anon, authenticated;
grant execute on function public.tenant_search_golden_signals() to service_role;
