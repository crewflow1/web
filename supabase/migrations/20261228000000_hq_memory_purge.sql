-- ---------------------------------------------------------------------------
-- CrewFlow HQ — Shared Memory: REAL PURGE semantics (`hq_memory_purge`) (E2).
--
-- WHY. `hq_memory_forget` (20260728) is the deliberate, reversible, §14
-- "memory is an audit subject" primitive: it archives + versions and retains
-- the content and the vector forever. That is the CORRECT default operator
-- action — but it means a "forgotten" memory is never actually erased. This
-- migration adds the missing, EXPLICIT erasure primitive: `hq_memory_purge`
-- irreversibly scrubs a memory IN PLACE into a TOMBSTONE — content gone,
-- vector gone, search disappearance guaranteed — while the audit evidence
-- (the row id, timestamps, event timeline, purge attribution) survives.
--
-- PURGE IS A TOMBSTONE, NOT A ROW DELETE. hq_memory_versions,
-- hq_memory_events, hq_memory_relationships, hq_memory_employee_links and
-- hq_memory_access_grants all FK the memory id (mostly ON DELETE CASCADE), and
-- hq_events / admin_activity_log reference memory ids as text. A hard DELETE
-- would cascade away the audit trail — the exact evidence a purge must keep.
-- So purge scrubs every content-bearing field and keeps the skeleton:
--
--   SCRUBBED on hq_memories ......... title -> '[purged]', summary -> '',
--     body -> '' (search_tsv is a GENERATED column over these three, so the
--     lexical index empties automatically), tags/keywords -> '{}',
--     organisation_name -> null, embedding_placeholder -> null, pinned -> false,
--     embedding -> NULL, embedding_provider/model/dimension/version/checksum
--     -> NULL, embedding cost/latency/error/lease/backoff bookkeeping cleared.
--   SCRUBBED on hq_memory_versions .. every snapshot of this memory (the
--     versions table is where the body would otherwise survive a scrub):
--     title -> '[purged]', summary/body -> '', tags -> '{}'.
--   SCRUBBED on hq_memory_relationships .. entity_label of INBOUND edges
--     (entity_type='memory' pointing at this id) — labels routinely embed the
--     target's title ("Superseded by <title>").
--   KEPT ............................ the row id, status ('purged'),
--     memory_type/class/department/visibility/importance/confidence (facts
--     ABOUT the record, not its content), created/updated timestamps, the
--     version counter, the full hq_memory_events timeline, and the new
--     purged_at / purged_by / purge_reason attribution columns.
--
-- RESURRECTION-PROOFING (the subtle part). Three background paths could
-- otherwise revive a purged memory into the PAID embedding queue:
--   1. The drift-requeue trigger (`_hq_memories_embed_requeue`, 20260725 §3)
--      clears embedded_at on any title/summary/body change — INCLUDING the
--      scrub itself, which would enqueue the tombstone for an embed of
--      '[purged]'. The trigger is re-created below to SKIP rows whose NEW
--      status is 'purged', so the purge UPDATE's terminal embedding state
--      survives the trigger.
--   2. `hq_embedding_claim_batch`'s predicate (embedded_at is null AND
--      embedding_status <> 'failed') WOULD select the tombstone. It is
--      re-created below with embedding_status excluded for 'purged' too.
--   3. `hq_embedding_enqueue_stale` (version-migration requeue) and
--      `hq_embedding_reset_failed` (DLQ drain) are re-created to SKIP purged
--      rows explicitly.
-- Belt-and-braces, a new BEFORE UPDATE guard trigger makes the tombstone
-- IMMUTABLE: once status='purged', any attempt to change status away from
-- 'purged', restore title/summary/body, or write an embedding/embedded_at
-- RAISES. Purge is a one-way door at the SQL layer, not just in the app.
-- (`hq_embedding_reclaim_stale` needs no guard: purge clears the lease, so
-- claimed_at is null and the reclaim scan can never see a tombstone; a worker
-- holding a pre-purge lease finds claimed_by no longer matches in
-- hq_embedding_complete and no-ops as 'lease_lost'.)
--
-- RECALL / SEARCH DISAPPEARANCE. `hq_memory_recall` (20260726) filters every
-- channel — lexical, structural, pinned, own-experience AND the semantic ANN
-- probe — on m.status = 'active', so 'purged' can never surface; the vector is
-- additionally NULL (out of the partial HNSW index) and the generated
-- search_tsv recomputes to the empty content. The /admin lexical listing
-- (searchMemories textSearch over search_tsv) likewise can no longer match the
-- erased content. The integration tier proves all of this on real Postgres.
--
-- DSAR / EXPORT POSTURE. hq_memories is CrewFlow-CONTROLLER data (no org_id;
-- HQ-internal, service-role-only), so the tenant GDPR export/erasure census
-- (lib/gdpr/*, strictly org-scoped tables) does not — and must not — reach it.
-- The deliverable for a data-subject request made TO CREWFLOW is the
-- CAPABILITY: /admin/memory/search (lexical locate) + this purge primitive
-- (genuine erase, evidence kept) = locate-and-erase. See
-- docs/hq-memory-privacy.md.
--
-- ADDITIVE. New columns, widened CHECK constraints (the repo's established
-- drop-and-re-add-named-constraint widening idiom, cf. 20260727 §1), one new
-- function, one new trigger, and create-or-replace re-creations of four
-- existing functions with guards ADDED (same signatures — no drops). No table,
-- column or index is dropped or retyped; RLS is untouched (these tables are
-- already service-role-only). Every function is SECURITY DEFINER with a pinned
-- empty search_path, EXECUTE revoked from JWT roles, granted to service_role.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Status vocabulary — widen hq_memories.status with the terminal 'purged'
--    state, and hq_memories.embedding_status with its terminal 'purged' state
--    (never claimable, never resettable). Both CHECKs were declared inline, so
--    Postgres auto-named them <table>_<column>_check; drop + re-add WIDENS the
--    set (every existing row remains legal).
-- ---------------------------------------------------------------------------
alter table public.hq_memories
  drop constraint if exists hq_memories_status_check;
alter table public.hq_memories
  add constraint hq_memories_status_check
  check (status in ('draft', 'active', 'archived', 'superseded', 'purged'));

alter table public.hq_memories
  drop constraint if exists hq_memories_embedding_status_check;
alter table public.hq_memories
  add constraint hq_memories_embedding_status_check
  check (embedding_status in ('pending', 'embedded', 'failed', 'stale', 'purged'));

-- ---------------------------------------------------------------------------
-- 2. Purge attribution — the durable, content-free evidence on the tombstone.
-- ---------------------------------------------------------------------------
alter table public.hq_memories
  add column if not exists purged_at    timestamp with time zone,
  add column if not exists purged_by    text,
  add column if not exists purge_reason text;

-- ---------------------------------------------------------------------------
-- 3. Per-memory audit vocabulary — add the 'purged' event kind (the same
--    widening idiom as 20260727 §1). TS mirror: lib/memory/model.ts EVENT_TYPES.
-- ---------------------------------------------------------------------------
alter table public.hq_memory_events
  drop constraint if exists hq_memory_events_event_type_check;
alter table public.hq_memory_events
  add constraint hq_memory_events_event_type_check
  check (event_type in (
    'created', 'updated', 'viewed', 'ai_accessed',
    'status_changed', 'pinned', 'unpinned', 'linked',
    'unlinked', 'version_restored',
    'summarised', 'consolidated', 'superseded', 'archived', 'expired',
    'purged'
  ));

-- ---------------------------------------------------------------------------
-- 4. Drift-requeue trigger — SKIP purged rows. Without this, the scrub UPDATE
--    itself (title/summary/body change) would clear embedded_at and set
--    embedding_status='pending' AFTER the purge statement assigned its terminal
--    values (a BEFORE trigger's assignments to NEW win over the UPDATE's SET
--    list), re-enqueueing the tombstone for a PAID embed of '[purged]'.
--    Checking NEW.status covers both the purge statement itself (which sets
--    status='purged' in the same UPDATE) and any later update of a tombstone.
--    Non-purged rows behave byte-identically to 20260725 §3.
-- ---------------------------------------------------------------------------
create or replace function public._hq_memories_embed_requeue()
returns trigger language plpgsql as $$
begin
  if new.status = 'purged' then
    return new;
  end if;
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

-- (The trigger itself — hq_memories_embed_requeue, BEFORE UPDATE — already
-- points at this function; create-or-replace swaps the body in place.)

-- ---------------------------------------------------------------------------
-- 5. Tombstone immutability guard. Once purged, a memory can never be
--    un-purged, re-titled, re-bodied, re-tagged, re-pinned, or re-embedded —
--    by ANY caller, App or SQL. Bookkeeping columns (access_count,
--    recalled_at, updated_at) stay writable so a stray reinforce sweep cannot
--    blow up a whole batch, but every content/resurrection vector raises.
--    Purge itself passes (OLD.status <> 'purged').
-- ---------------------------------------------------------------------------
create or replace function public._hq_memories_purge_guard()
returns trigger language plpgsql as $$
begin
  if old.status = 'purged' then
    if new.status is distinct from 'purged' then
      raise exception 'hq_memories: a purged memory cannot leave the purged state (id %)', old.id
        using errcode = 'check_violation';
    end if;
    if (new.title, new.summary, new.body,
        new.tags, new.keywords, new.organisation_name,
        new.embedding_placeholder, new.pinned)
         is distinct from
       (old.title, old.summary, old.body,
        old.tags, old.keywords, old.organisation_name,
        old.embedding_placeholder, old.pinned) then
      -- Review P2-4: the FULL scrub set is immutable — not only the original
      -- content but every content-carrying column and `pinned`, so no new
      -- content can be attached to a tombstone and it can never be re-pinned
      -- into recall's pinned channel. Bookkeeping (access_count, recalled_at,
      -- updated_at) stays writable so a stray reinforce cannot blow up.
      raise exception 'hq_memories: purged memory content is immutable (id %)', old.id
        using errcode = 'check_violation';
    end if;
    if new.embedding is not null or new.embedded_at is not null then
      raise exception 'hq_memories: a purged memory cannot carry an embedding (id %)', old.id
        using errcode = 'check_violation';
    end if;
    if new.embedding_status is distinct from 'purged' then
      raise exception 'hq_memories: purged embedding state is terminal (id %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists hq_memories_purge_guard on public.hq_memories;
create trigger hq_memories_purge_guard
  before update on public.hq_memories
  for each row execute function public._hq_memories_purge_guard();

-- ---------------------------------------------------------------------------
-- 6. hq_embedding_claim_batch — re-created with the tombstone excluded. The
--    only change vs 20260725 §7 is the embedding_status predicate: a purged
--    row (embedded_at null, embedding_status 'purged') must NEVER be claimable.
--    The claim predicate still implies the partial queue index's predicate
--    (embedded_at is null and embedding_status <> 'failed'), so the index
--    keeps backing the scan.
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
       and embedding_status not in ('failed', 'purged')
       and status <> 'purged'
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
-- 7. hq_embedding_enqueue_stale — re-created to SKIP purged rows. A tombstone
--    has embedded_at null so the existing predicate already excludes it, but
--    the explicit guard makes the exclusion structural (and keeps a future
--    predicate edit from silently re-including tombstones). Without the skip,
--    a requeue UPDATE touching a tombstone would also raise via the guard
--    trigger and abort a whole legitimate backfill batch.
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
       and status <> 'purged'
       and embedding_status <> 'purged'
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
-- 8. hq_embedding_reset_failed — re-created to SKIP purged rows. A purge
--    rewrites embedding_status to 'purged' (never 'failed') so the DLQ scan
--    cannot match a tombstone today; the explicit guard makes that structural.
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
       and status <> 'purged'
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
-- 9. hq_memory_purge — the erasure primitive. Operator-deliberate (the
--    /admin/memory surface calls it via the service layer after a super-admin
--    typed an explicit confirmation), service_role-only, idempotent.
--
--    p_actor is the acting operator's email — attribution only, snapshot-style
--    (mirrors created_by_email). NO content ever enters the event detail or
--    the return payload: only the reason, whether a vector existed, and how
--    many version snapshots were scrubbed.
--
--    NO version bump / snapshot: a purge deliberately does NOT write a
--    hq_memory_versions row (a snapshot exists to make a state restorable —
--    a purge is the one transition that must never be). The 'purged' event +
--    purged_* columns are the durable record instead.
--
--    NO Pulse event: the frozen event registry has no memory.purged verb
--    (exactly as forget/expiry/eviction emit nothing); the per-memory event +
--    the caller's admin_activity_log row are the audit truth.
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_purge(
  p_memory_id uuid,
  p_actor     text,
  p_reason    text default 'purged'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status           text;
  v_had_embedding    boolean;
  v_versions         integer := 0;
  v_purged_id        uuid;
  v_reason           text;
begin
  v_reason := coalesce(nullif(btrim(p_reason), ''), 'purged');

  select m.status, (m.embedding is not null)
    into v_status, v_had_embedding
  from public.hq_memories m
  where m.id = p_memory_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_status = 'purged' then
    -- Idempotent: a re-purge is a no-op, never a second event.
    return jsonb_build_object('ok', false, 'reason', 'already_purged');
  end if;

  -- (a) Scrub every version snapshot FIRST — this is where the body would
  --     otherwise survive. Snapshot skeletons (version numbers, editor,
  --     timestamps) remain as evidence.
  with scrubbed as (
    update public.hq_memory_versions v
       set title   = '[purged]',
           summary = '',
           body    = '',
           tags    = '{}'
     where v.memory_id = p_memory_id
    returning v.id
  )
  select count(*) into v_versions from scrubbed;

  -- (b) Scrub inbound relationship labels that may quote this memory's title
  --     (e.g. the supersede lineage breadcrumb 'Superseded by <title>').
  update public.hq_memory_relationships r
     set entity_label = '[purged]'
   where r.entity_type = 'memory'
     and r.entity_id = p_memory_id::text;

  -- (c) The tombstone scrub itself. search_tsv is GENERATED from
  --     title/summary/body, so the lexical index empties in the same write.
  --     The re-created requeue trigger sees NEW.status='purged' and leaves the
  --     terminal embedding state alone; the guard trigger allows this UPDATE
  --     because OLD.status is not yet 'purged'. Status-guarded so a concurrent
  --     purge race resolves to exactly one winner.
  update public.hq_memories m
     set title                     = '[purged]',
         summary                   = '',
         body                      = '',
         tags                      = '{}',
         keywords                  = '{}',
         organisation_name         = null,
         embedding_placeholder     = null,
         pinned                    = false,
         embedding                 = null,
         embedding_provider        = null,
         embedding_model           = null,
         embedding_dimension       = null,
         embedding_version         = null,
         embedding_checksum        = null,
         embedded_at               = null,
         embedding_latency_ms      = null,
         embedding_cost            = null,
         embedding_status          = 'purged',
         embedding_attempts        = 0,
         embedding_last_error      = null,
         embedding_claimed_at      = null,
         embedding_claimed_by      = null,
         embedding_next_attempt_at = null,
         status                    = 'purged',
         purged_at                 = now(),
         purged_by                 = p_actor,
         purge_reason              = v_reason
   where m.id = p_memory_id
     and m.status <> 'purged'
  returning m.id into v_purged_id;

  if v_purged_id is null then
    -- Lost a race with a concurrent purge; treat as already purged.
    return jsonb_build_object('ok', false, 'reason', 'already_purged');
  end if;

  -- (d) The content-free audit event. p_actor lands in actor_email (a human
  --     operator drove this); detail carries NO memory content.
  insert into public.hq_memory_events (memory_id, event_type, actor_email, detail)
  values (
    p_memory_id, 'purged', p_actor,
    jsonb_build_object(
      'reason', v_reason,
      'from_status', v_status,
      'had_embedding', coalesce(v_had_embedding, false),
      'versions_scrubbed', v_versions
    )
  );

  return jsonb_build_object(
    'ok', true,
    'memory_id', p_memory_id,
    'had_embedding', coalesce(v_had_embedding, false),
    'versions_scrubbed', v_versions
  );
end;
$$;

revoke all on function public.hq_memory_purge(uuid, text, text) from public, anon, authenticated;
grant execute on function public.hq_memory_purge(uuid, text, text) to service_role;
