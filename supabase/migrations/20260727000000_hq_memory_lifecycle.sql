-- CrewFlow HQ — Shared Memory: consolidation + memory lifecycle engines
-- (CEO Directive 009, Phase 1, Module 1 — Shared Memory, PR5).
--
-- Builds ON TOP of the cognitive-classes substrate (PR1,
-- 20260722000000_memory_classes_lifecycle.sql — memory_class, owner_employee_id,
-- expires_at, consolidated_into, salience, last_reinforced_at), the AI write
-- path (PR2), the recall pipeline (PR3), and the embedding layer (PR4). It lands
-- the recurring REDUCTION + LIFECYCLE engines the CrewFlow Bible, Volume X §9–§10
-- describes — the work that keeps the company brain coherent and bounded forever:
--
--   §9.1 summarisation  — long bodies get a compact summary
--                         (hq_memory_summary_candidates / hq_memory_set_summary)
--   §9.2 consolidation  — a cluster of related episodes rolls up into ONE
--                         long_term lesson            (hq_memory_consolidate)
--   §9.3 deduplication  — near-duplicate pairs collapse to the strongest survivor
--                         (hq_memory_dedupe_pairs / hq_memory_supersede)
--   §10  TTL + decay    — working memory expires by clock; consolidated episodes
--                         archive once decayed below the floor (hq_memory_expire_sweep)
--   §10  eviction       — under pressure, the lowest-value ephemeral memory is
--                         archived; durable company-brain memory never is
--                         (hq_memory_archive)
--   §15  golden signals — one operational read over all of the above
--                         (hq_memory_golden_signals)
--
-- POLICY LIVES IN ONE PLACE, MIRRORED HERE. The pure, database-free policy is
-- lib/memory/lifecycle.ts (PR5a): DECAY_FLOOR (0.05), the episodic τ (30 days),
-- MIN_CONSOLIDATION_SOURCES (3), SUMMARY_MIN_BODY_CHARS (1200) + SUMMARY_MAX_RATIO
-- (0.6), DEDUPE_COSINE_THRESHOLD (0.95), and the decay math
-- (effectiveScore = e^(-age/τ) · salience/100). The SQL below uses those EXACT
-- numbers; the security gate (memory-lifecycle-invariants) pins SQL ↔ TS
-- agreement so the two can never drift. "Build it once, build it properly."
--
-- ADDITIVE & DARK. This migration adds functions + WIDENS one CHECK constraint
-- (the per-memory audit event vocabulary) — it drops/retypes no table, column,
-- function or index, and touches no tenant data. The autonomous writers ship
-- behind a kill-switch (`memory_lifecycle.worker_enabled`, default false) AND
-- have no production caller until the lifecycle worker + cron land (PR5d), so
-- applying this changes NO behaviour. Recall keeps working unchanged the entire
-- time (permission → lexical → structural → semantic → ranking → assembly).
--
-- EMBEDDINGS / LLM ARE A PLUG-IN, NOT A DEPENDENCY (Directive 009 standing rule).
-- Consolidation builds its rolled-up body as a DETERMINISTIC SQL digest, so it
-- works with NO model provider configured. A future text provider (PR5c) only
-- REFINES that body when present — the engine never depends on it. Deduplication
-- needs vectors to find near-duplicates; with no embeddings, hq_memory_dedupe_pairs
-- simply returns an empty set (graceful no-op), exactly like semantic recall
-- degrading to lexical. No lifecycle function performs an external AI call —
-- those happen in TS, OUTSIDE any SQL transaction (CEO architecture rule).
--
-- THE EVENT MODEL (assessed for PR5, consistent with PR2/PR3/PR4):
--   * consolidation WRITES company knowledge → it emits the canonical write verb
--     `memory.asserted` on The Pulse (the same seam PR2 established; a future
--     embed-consumer vectors the new long_term memory with no app change).
--   * supersession is a first-class business fact → it emits `memory.superseded`,
--     the verb the registry RESERVED at the spine's birth and that nothing has
--     emitted until now.
--   * expiry / decay-archival / eviction / summarisation are MECHANICAL
--     maintenance, not company history — like embedding (PR4) and recall (PR3)
--     they emit NOTHING on The Pulse. They are fully audited per-memory in
--     hq_memory_events (the new `expired` / `archived` / `summarised` /
--     `consolidated` / `superseded` event kinds widened below), so every
--     lifecycle transition is reversible + traceable without flooding the spine.
--
-- Every new function is SECURITY DEFINER with a pinned empty search_path,
-- EXECUTE revoked from public/anon/authenticated and granted only to
-- service_role — the L-4 hardening every HQ engine primitive carries. pgvector
-- lives in `public` (PR4 §0 pins it there), so the dedup probe qualifies the
-- type + operator as `public.vector` / `OPERATOR(public.<=>)`.

-- ---------------------------------------------------------------------------
-- 1. Widen the per-memory audit vocabulary (hq_memory_events.event_type).
--    PR1's hq_shared_memory migration declared the CHECK inline, so Postgres
--    auto-named it `<table>_<column>_check`. Drop + re-add the named constraint
--    with the five lifecycle kinds ADDED — every pre-existing kind remains
--    legal, so this only WIDENS the allowed set (no existing row can violate it).
--    This is the repo's established CHECK-widening idiom (cf.
--    20260617000000_widen_import_rows_entity_check.sql). The TS mirror
--    (lib/memory/model.ts EVENT_TYPES) is widened in lock-step.
-- ---------------------------------------------------------------------------
alter table public.hq_memory_events
  drop constraint if exists hq_memory_events_event_type_check;

alter table public.hq_memory_events
  add constraint hq_memory_events_event_type_check
  check (event_type in (
    -- existing kinds (PR1) — unchanged, still legal
    'created', 'updated', 'viewed', 'ai_accessed',
    'status_changed', 'pinned', 'unpinned', 'linked',
    'unlinked', 'version_restored',
    -- PR5 lifecycle kinds (Volume X §9–§10)
    'summarised',    -- §9.1 a fresh summary was written
    'consolidated',  -- §9.2 a source episode was rolled into a long_term lesson
    'superseded',    -- §9.3 a near-duplicate was merged into its keeper
    'archived',      -- §10  decay/eviction archival (status -> 'archived')
    'expired'        -- §10  hard-TTL expiry (status -> 'archived')
  ));

-- ---------------------------------------------------------------------------
-- 2. Worker kill-switch — seed memory_lifecycle.worker_enabled = false.
--    Idempotent + non-clobbering (writes only when ABSENT). Stored under the
--    non-UI `memory_lifecycle` section of hq_settings (an infra switch, not a
--    feature flag), exactly as PR4 seeded memory_embedding.worker_enabled.
-- ---------------------------------------------------------------------------
update public.hq_settings
set data = coalesce(data, '{}'::jsonb)
           || jsonb_build_object('memory_lifecycle',
                coalesce(data -> 'memory_lifecycle', '{}'::jsonb)
                  || jsonb_build_object('worker_enabled', false))
where id = 'singleton'
  and (data #> '{memory_lifecycle,worker_enabled}') is null;

-- ---------------------------------------------------------------------------
-- 3. hq_memory_lifecycle_enabled() — read the worker gate. STABLE, fail-dark
--    (defaults FALSE on a missing key), mirrors hq_memory_embed_enabled().
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_lifecycle_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (data #> '{memory_lifecycle,worker_enabled}')::boolean
       from public.hq_settings
      where id = 'singleton'),
    false
  );
$$;

revoke all on function public.hq_memory_lifecycle_enabled() from public, anon, authenticated;
grant execute on function public.hq_memory_lifecycle_enabled() to service_role;

-- ---------------------------------------------------------------------------
-- 4. §10 — hq_memory_expire_sweep — the recurring TTL + decay archival driver.
--    The AUTONOMOUS sweep the cron worker calls each tick, so it is fail-dark
--    on the kill-switch (the direct analog of PR4's hq_embedding_claim_batch).
--    Two bounded, idempotent passes, each guarded by status='active' so a
--    re-run never re-archives:
--      (a) TTL EXPIRY  — working/episodic past expires_at  -> 'archived'/'expired'
--      (b) DECAY ARCHIVAL — episodic that is ALREADY consolidated (its lesson is
--          preserved) AND whose effective retention score has fallen below
--          DECAY_FLOOR -> 'archived'/'archived'. The score is
--          e^(-age/τ) · salience/100 with τ = 30 days and floor = 0.05, byte-for-
--          byte the lib/memory/lifecycle.ts shouldArchiveEpisodic decision.
--    An UNCONSOLIDATED episode is NEVER archived by decay, however old — dropping
--    it would lose its lesson (Volume X §10). Durable company-brain classes
--    (semantic/long_term/procedural) are never touched by either pass.
--    The two passes run as SEPARATE statements so a row matching both is archived
--    once (the second pass sees the first's status change and skips it).
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_expire_sweep(
  p_now   timestamp with time zone default now(),
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit       integer;
  v_ttl_count   integer := 0;
  v_decay_count integer := 0;
begin
  -- Fail-dark: no autonomous archival while the worker is disabled.
  if not public.hq_memory_lifecycle_enabled() then
    return jsonb_build_object('skipped', 'worker_disabled',
      'ttl_expired', 0, 'decayed_archived', 0);
  end if;

  v_limit := greatest(coalesce(p_limit, 500), 1);

  -- (a) Hard-TTL expiry. Only ephemeral classes ever carry expires_at; the
  --     class filter is belt-and-suspenders so a durable memory can never be
  --     archived by the clock even if some bug set its expires_at.
  with ttl_targets as (
    select id
      from public.hq_memories
     where status = 'active'
       and memory_class in ('working', 'episodic')
       and expires_at is not null
       and expires_at <= p_now
     order by expires_at asc
     limit v_limit
     for update skip locked
  ),
  ttl_archived as (
    update public.hq_memories m
       set status = 'archived'
      from ttl_targets t
     where m.id = t.id
     returning m.id
  ),
  ttl_events as (
    insert into public.hq_memory_events (memory_id, event_type, detail)
    select id, 'expired',
           jsonb_build_object('reason', 'ttl_expiry', 'swept_at', now())
      from ttl_archived
    returning 1
  )
  select count(*) into v_ttl_count from ttl_archived;

  -- (b) Decay archival of consolidated episodes below the retention floor.
  --     τ = 30 days (EPISODIC_DECAY_TAU_MS), floor = 0.05 (DECAY_FLOOR), age is
  --     clamped at 0 (clock-skew safe, matching memoryAgeMs). This expression is
  --     the SQL twin of effectiveScore + shouldArchiveEpisodic (PR5a).
  with decay_targets as (
    select id
      from public.hq_memories
     where status = 'active'
       and memory_class = 'episodic'
       and consolidated_into is not null
       and exp(
             - greatest(0, extract(epoch from (p_now - coalesce(last_reinforced_at, created_at))))
             / extract(epoch from interval '30 days')
           ) * (salience / 100.0) < 0.05
     order by coalesce(last_reinforced_at, created_at) asc
     limit v_limit
     for update skip locked
  ),
  decay_archived as (
    update public.hq_memories m
       set status = 'archived'
      from decay_targets t
     where m.id = t.id
     returning m.id
  ),
  decay_events as (
    insert into public.hq_memory_events (memory_id, event_type, detail)
    select id, 'archived',
           jsonb_build_object('reason', 'decay_floor', 'swept_at', now())
      from decay_archived
    returning 1
  )
  select count(*) into v_decay_count from decay_archived;

  return jsonb_build_object(
    'ran_at', now(),
    'ttl_expired', coalesce(v_ttl_count, 0),
    'decayed_archived', coalesce(v_decay_count, 0),
    'limit', v_limit
  );
end;
$$;

revoke all on function public.hq_memory_expire_sweep(timestamp with time zone, integer) from public, anon, authenticated;
grant execute on function public.hq_memory_expire_sweep(timestamp with time zone, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. §9.2 — hq_memory_consolidate — roll a themed cluster of an employee's own
--    episodes up into ONE long_term lesson. AUTONOMOUS company-brain WRITE, so
--    fail-dark on the kill-switch (returns the NULL sentinel when disabled).
--
--    Selects the employee's OWN active, UNCONSOLIDATED episodic memories whose
--    full-text vector matches the theme. If fewer than MIN_CONSOLIDATION_SOURCES
--    (3) match, it is noise, not a pattern -> return NULL (a no-op). Otherwise it
--    creates one PRIVATE, owner-scoped long_term memory (autonomous per §6; a
--    SHARED promotion is an approval checkpoint owned by the Module 4 approval
--    engine — deferred, no app change when it lands), writes a DETERMINISTIC
--    digest body (LLM refinement is a later plug-in, never a dependency), points
--    every source's consolidated_into at the new lesson (the sources are NOT
--    archived — they keep decaying and expire_sweep archives them later, now
--    that their lesson is preserved), snapshots version 1, audits 'created' +
--    one 'consolidated' per source, and emits `memory.asserted`.
--
--    Naturally IDEMPOTENT: once consolidated, the sources carry consolidated_into
--    and drop out of the candidate set, so a re-run on the same theme finds < 3
--    fresh sources and returns NULL.
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_consolidate(
  p_employee_id uuid,
  p_theme       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dept       text;
  v_query      tsquery;
  v_source_ids uuid[];
  v_count      integer;
  v_type       text;
  v_salience   integer;
  v_digest     text;
  v_body       text;
  v_new_id     uuid;
begin
  -- Fail-dark: no autonomous company-brain write while the worker is disabled.
  if not public.hq_memory_lifecycle_enabled() then
    return null;
  end if;

  -- Resolve the employee (department is recorded on the lesson's provenance).
  select e.department into v_dept
  from public.ai_employees e
  where e.id = p_employee_id;

  if v_dept is null then
    raise exception 'hq_memory_consolidate: unknown employee %', p_employee_id
      using errcode = 'foreign_key_violation';
  end if;

  -- A blank theme matches nothing — nothing to consolidate.
  v_query := case
    when p_theme is null or btrim(p_theme) = '' then null
    else websearch_to_tsquery('english', p_theme)
  end;
  if v_query is null then
    return null;
  end if;

  -- Gather the candidate sources (bounded so the digest stays bounded), most
  -- salient + most recent first, and derive the lesson's facets in one pass.
  select array_agg(id order by salience desc, created_at desc),
         count(*)::integer,
         mode() within group (order by memory_type),
         least(100, greatest(1, round(avg(salience))::integer)),
         string_agg(
           '- ' || left(coalesce(title, ''), 200)
                || coalesce(' — ' || nullif(left(coalesce(summary, ''), 400), ''), ''),
           E'\n' order by salience desc, created_at desc
         )
    into v_source_ids, v_count, v_type, v_salience, v_digest
  from (
    select id, title, summary, memory_type, salience, created_at
      from public.hq_memories
     where status = 'active'
       and memory_class = 'episodic'
       and owner_employee_id = p_employee_id
       and consolidated_into is null
       and search_tsv @@ v_query
     order by salience desc, created_at desc
     limit 100
  ) s;

  -- Below the floor for "a pattern worth keeping" -> no-op.
  if coalesce(v_count, 0) < 3 then
    return null;
  end if;

  v_body := left(
    'Consolidated lesson from ' || v_count
      || ' related episodes (theme: ' || p_theme || ').' || E'\n\n'
      || coalesce(v_digest, ''),
    32000
  );

  -- The single rolled-up long_term lesson — private + owner-scoped (autonomous).
  insert into public.hq_memories (
    title, summary, body, memory_type, source, visibility,
    memory_class, owner_employee_id, salience, last_reinforced_at
  )
  values (
    left('Consolidated: ' || p_theme, 300),
    left('Consolidated lesson from ' || v_count || ' episodes on: ' || p_theme, 1000),
    v_body,
    v_type,
    'ai_employee',
    'private',
    'long_term',
    p_employee_id,
    v_salience,
    now()
  )
  returning id into v_new_id;

  -- Version-1 snapshot (parity with the write path).
  insert into public.hq_memory_versions (
    memory_id, version, title, summary, body, memory_type, department,
    importance, tags, status, edited_by_email
  )
  select id, version, title, summary, body, memory_type, department,
         importance, tags, status, null
  from public.hq_memories
  where id = v_new_id;

  -- Link every source to the lesson (NOT archived — they decay then expire).
  -- A pure pointer update: title/summary/body are untouched, so the PR4 embed
  -- re-queue trigger does not fire.
  update public.hq_memories
     set consolidated_into = v_new_id
   where id = any(v_source_ids);

  -- Audit: authorship of the lesson + each source's consolidation.
  insert into public.hq_memory_events (memory_id, event_type, ai_employee_id, detail)
  values (
    v_new_id, 'created', p_employee_id,
    jsonb_build_object('via', 'consolidation', 'source_count', v_count, 'theme', p_theme)
  );

  insert into public.hq_memory_events (memory_id, event_type, ai_employee_id, detail)
  select sid, 'consolidated', p_employee_id,
         jsonb_build_object('consolidated_into', v_new_id, 'theme', p_theme)
  from unnest(v_source_ids) as sid;

  -- Canonical write verb on The Pulse — the new lesson is asserted knowledge.
  -- A future embed-consumer vectors it from here with no application change.
  perform public.hq_emit_event(
    p_actor_type     => 'ai_employee',
    p_actor_id       => p_employee_id::text,
    p_verb           => 'memory.asserted',
    p_object_type    => 'memory',
    p_object_id      => v_new_id::text,
    p_correlation_id => gen_random_uuid(),
    p_severity       => 'info',
    p_payload        => jsonb_build_object(
                          'memory_class', 'long_term',
                          'visibility',   'private',
                          'memory_type',  v_type,
                          'via',          'consolidation',
                          'source_count', v_count,
                          'owner_employee_id', p_employee_id
                        ),
    p_visibility     => 'hq'
  );

  return v_new_id;
end;
$$;

revoke all on function public.hq_memory_consolidate(uuid, text) from public, anon, authenticated;
grant execute on function public.hq_memory_consolidate(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. §9.3 — hq_memory_dedupe_pairs — find near-duplicate pairs to merge.
--    READ-ONLY detection (no mutation, no gate). For a bounded batch of embedded,
--    active memories it probes the HNSW index for each row's single nearest
--    co-scoped neighbour (same memory_type, visibility, department, owner, AND
--    same embedding version + dimension — vectors are only ever compared within
--    one model's space). A pair qualifies when cosine similarity exceeds
--    p_threshold (default 0.95 = DEDUPE_COSINE_THRESHOLD). For each pair it
--    labels the survivor with the EXACT chooseDedupeKeeper rule (PR5a): highest
--    confidence, then most recently created, then lexicographically-smaller id.
--    Unordered pairs (a~b / b~a) are collapsed. Returns [{keep_id, drop_id,
--    cos_sim}]; the worker passes each to hq_memory_supersede. With no embeddings
--    configured there are no vectors, so this returns [] — a graceful no-op.
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_dedupe_pairs(
  p_limit     integer default 100,
  p_threshold double precision default 0.95
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with scanned as (
    select m.id, m.embedding, m.embedding_version, m.embedding_dimension,
           m.memory_type, m.visibility, m.department, m.owner_employee_id,
           m.confidence, m.created_at
      from public.hq_memories m
     where m.status = 'active'
       and m.embedding is not null
     order by m.created_at desc
     limit greatest(coalesce(p_limit, 100), 1)
  ),
  nearest as (
    select s.id as a_id, s.confidence as a_conf, s.created_at as a_created,
           n.id as b_id, n.confidence as b_conf, n.created_at as b_created,
           (1 - (s.embedding OPERATOR(public.<=>) n.embedding))::double precision as cos_sim
      from scanned s
      cross join lateral (
        select m2.id, m2.embedding, m2.confidence, m2.created_at
          from public.hq_memories m2
         where m2.status = 'active'
           and m2.embedding is not null
           and m2.id <> s.id
           and m2.memory_type = s.memory_type
           and m2.visibility = s.visibility
           and m2.department is not distinct from s.department
           and m2.owner_employee_id is not distinct from s.owner_employee_id
           and m2.embedding_version = s.embedding_version
           and m2.embedding_dimension = s.embedding_dimension
         order by s.embedding OPERATOR(public.<=>) m2.embedding
         limit 1
      ) n
  ),
  pairs as (
    select
      -- keeper rule == lib/memory/lifecycle.ts chooseDedupeKeeper, EXACTLY.
      case
        when a_conf <> b_conf then (case when a_conf > b_conf then a_id else b_id end)
        when a_created <> b_created then (case when a_created > b_created then a_id else b_id end)
        else (least(a_id::text, b_id::text))::uuid
      end as keep_id,
      case
        when a_conf <> b_conf then (case when a_conf > b_conf then b_id else a_id end)
        when a_created <> b_created then (case when a_created > b_created then b_id else a_id end)
        else (greatest(a_id::text, b_id::text))::uuid
      end as drop_id,
      cos_sim
    from nearest
    where cos_sim > coalesce(p_threshold, 0.95)
  ),
  deduped as (
    -- collapse each unordered pair to one row, keeping the strongest signal.
    select distinct on (least(keep_id::text, drop_id::text), greatest(keep_id::text, drop_id::text))
           keep_id, drop_id, cos_sim
      from pairs
     order by least(keep_id::text, drop_id::text),
              greatest(keep_id::text, drop_id::text),
              cos_sim desc
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'keep_id', keep_id, 'drop_id', drop_id, 'cos_sim', cos_sim)),
           '[]'::jsonb)
    from deduped;
$$;

revoke all on function public.hq_memory_dedupe_pairs(integer, double precision) from public, anon, authenticated;
grant execute on function public.hq_memory_dedupe_pairs(integer, double precision) to service_role;

-- ---------------------------------------------------------------------------
-- 7. §9.3 — hq_memory_supersede — merge a near-duplicate into its keeper.
--    The atomic APPLY step (a deliberate primitive the worker calls per pair —
--    NOT gated, like PR4's complete/fail; the worker self-gates per tick).
--    REVERSIBLE + fully audited:
--      * relinks inbound memory-edges that pointed at the drop -> the keeper,
--      * repoints any memory consolidated_into the drop -> the keeper,
--      * records a `superseded_by` lineage edge on the drop (the breadcrumb that
--        makes the merge reversible),
--      * bumps the drop's version + snapshots it as status='superseded'
--        (a clean, restorable history entry),
--      * audits a 'superseded' event, and
--      * emits `memory.superseded` on The Pulse (the long-reserved verb).
--    IDEMPOTENT via the status='active' guard on the drop: a second call finds
--    nothing active and is a no-op. The keeper is left untouched (it only gains
--    inbound references); a non-active keeper is refused.
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_supersede(
  p_keep_id uuid,
  p_drop_id uuid,
  p_reason  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_version integer;
  v_keep_title  text;
begin
  if p_keep_id is null or p_drop_id is null or p_keep_id = p_drop_id then
    return jsonb_build_object('ok', false, 'reason', 'invalid_pair');
  end if;

  -- The keeper must be a live memory to absorb references into.
  select title into v_keep_title
  from public.hq_memories
  where id = p_keep_id and status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'keeper_not_active');
  end if;

  -- Archive (supersede) the drop — the idempotency guard is the active status.
  update public.hq_memories m
     set status = 'superseded',
         version = m.version + 1
   where m.id = p_drop_id
     and m.status = 'active'
  returning m.version into v_new_version;

  if v_new_version is null then
    return jsonb_build_object('ok', false, 'reason', 'drop_not_active');
  end if;

  -- Relink inbound references so nothing dangles pointing at a superseded row.
  update public.hq_memory_relationships
     set entity_id = p_keep_id::text
   where entity_type = 'memory'
     and entity_id = p_drop_id::text;

  update public.hq_memories
     set consolidated_into = p_keep_id
   where consolidated_into = p_drop_id
     and id <> p_keep_id;

  -- Lineage breadcrumb on the drop (reversibility + provenance).
  insert into public.hq_memory_relationships (
    memory_id, entity_type, entity_id, entity_label, relation, created_by_email
  )
  values (
    p_drop_id, 'memory', p_keep_id::text,
    left('Superseded by ' || coalesce(v_keep_title, 'keeper'), 300),
    'superseded_by', null
  );

  -- Snapshot the drop's superseded state (the bumped version makes it unique).
  insert into public.hq_memory_versions (
    memory_id, version, title, summary, body, memory_type, department,
    importance, tags, status, edited_by_email
  )
  select id, version, title, summary, body, memory_type, department,
         importance, tags, status, null
  from public.hq_memories
  where id = p_drop_id;

  insert into public.hq_memory_events (memory_id, event_type, detail)
  values (
    p_drop_id, 'superseded',
    jsonb_build_object('superseded_by', p_keep_id, 'reason', coalesce(p_reason, 'dedupe'))
  );

  -- The business fact on The Pulse: this memory was merged away. System actor
  -- (the lifecycle worker), object = the drop, target = the surviving keeper.
  perform public.hq_emit_event(
    p_actor_type     => 'system',
    p_actor_id       => 'memory-lifecycle',
    p_verb           => 'memory.superseded',
    p_object_type    => 'memory',
    p_object_id      => p_drop_id::text,
    p_target_type    => 'memory',
    p_target_id      => p_keep_id::text,
    p_correlation_id => gen_random_uuid(),
    p_severity       => 'info',
    p_payload        => jsonb_build_object(
                          'keep_id', p_keep_id,
                          'drop_id', p_drop_id,
                          'reason',  coalesce(p_reason, 'dedupe')
                        ),
    p_visibility     => 'hq'
  );

  return jsonb_build_object('ok', true, 'keep_id', p_keep_id, 'drop_id', p_drop_id);
end;
$$;

revoke all on function public.hq_memory_supersede(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hq_memory_supersede(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. §9.1 — hq_memory_summary_candidates — memories whose summary needs work.
--    READ-ONLY detection (no gate), the SQL twin of lib/memory/lifecycle.ts
--    needsSummary: a body at/above SUMMARY_MIN_BODY_CHARS (1200) whose summary is
--    either empty OR still >= SUMMARY_MAX_RATIO (0.6) of the body length (so it
--    saves nothing under budget). Returns [{id, title, body, body_chars,
--    summary_chars}] so the worker has everything it needs to summarise in ONE
--    read — no second round-trip, no client-side table access. `body` is bounded
--    to its leading 24000 chars (~6000 tokens): ample to summarise from, and a
--    hard cap on the JSON payload + downstream token cost for a pathologically
--    long body (its head is summarised, which `body_chars` still reports in full
--    so the worker's ratio guard uses the true length). With no text provider the
--    worker is a graceful no-op and these simply stay candidates (harmless).
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_summary_candidates(
  p_limit integer default 100
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'id', id,
             'title', title,
             'body', body_head,
             'body_chars', body_chars,
             'summary_chars', summary_chars)),
           '[]'::jsonb)
  from (
    select m.id,
           left(coalesce(m.title, ''), 300) as title,
           left(coalesce(m.body, ''), 24000) as body_head,
           char_length(coalesce(m.body, '')) as body_chars,
           char_length(coalesce(m.summary, '')) as summary_chars
      from public.hq_memories m
     where m.status = 'active'
       and char_length(coalesce(m.body, '')) >= 1200
       and (
         char_length(coalesce(m.summary, '')) = 0
         or char_length(coalesce(m.summary, '')) >= char_length(coalesce(m.body, '')) * 0.6
       )
     order by char_length(coalesce(m.body, '')) desc
     limit greatest(coalesce(p_limit, 100), 1)
  ) s;
$$;

revoke all on function public.hq_memory_summary_candidates(integer) from public, anon, authenticated;
grant execute on function public.hq_memory_summary_candidates(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 9. §9.1 — hq_memory_set_summary — write a fresh summary for a memory.
--    The APPLY step (deliberate primitive, not gated). The worker computes the
--    summary text (deterministically, or via the PR5c text provider when
--    configured — a plug-in, never a dependency) and persists it here. Bumps the
--    version + snapshots, audits 'summarised'. Changing the summary legitimately
--    re-queues the embedding (the PR4 drift trigger fires on summary change), so
--    the vector is recomputed from the improved text — automatically, no special
--    handling. No Pulse event: summarisation is mechanical maintenance.
--    IDEMPOTENT-safe via the status='active' guard.
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_set_summary(
  p_memory_id uuid,
  p_summary   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_version integer;
begin
  if p_summary is null or btrim(p_summary) = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty_summary');
  end if;

  update public.hq_memories m
     set summary = p_summary,
         version = m.version + 1
   where m.id = p_memory_id
     and m.status = 'active'
  returning m.version into v_new_version;

  if v_new_version is null then
    return jsonb_build_object('ok', false, 'reason', 'not_active');
  end if;

  insert into public.hq_memory_versions (
    memory_id, version, title, summary, body, memory_type, department,
    importance, tags, status, edited_by_email
  )
  select id, version, title, summary, body, memory_type, department,
         importance, tags, status, null
  from public.hq_memories
  where id = p_memory_id;

  insert into public.hq_memory_events (memory_id, event_type, detail)
  values (
    p_memory_id, 'summarised',
    jsonb_build_object('summary_chars', char_length(p_summary), 'version', v_new_version)
  );

  return jsonb_build_object('ok', true, 'memory_id', p_memory_id, 'version', v_new_version);
end;
$$;

revoke all on function public.hq_memory_set_summary(uuid, text) from public, anon, authenticated;
grant execute on function public.hq_memory_set_summary(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. §10 — hq_memory_archive — the eviction primitive (under storage pressure).
--     A deliberate single-row primitive (not gated). The worker computes WHICH
--     memories to evict with the pure evictionPlan/evictionOrder (PR5a — lowest
--     effective-score ephemeral first) and calls this per id. Durable company-
--     brain classes are STRUCTURALLY un-evictable here: the class guard means a
--     semantic/long_term/procedural id can never be archived by this path,
--     however it is called ("durable company-brain classes are NEVER evicted",
--     Volume X §10). IDEMPOTENT via the status='active' guard. Mechanical
--     maintenance -> audited as 'archived', no Pulse event. (Active pressure
--     detection is a future signal; this stable primitive is ready for it —
--     Detect -> Design -> Expose -> Complete.)
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_archive(
  p_memory_id uuid,
  p_reason    text default 'evicted'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.hq_memories m
     set status = 'archived'
   where m.id = p_memory_id
     and m.status = 'active'
     and m.memory_class in ('working', 'episodic')
  returning m.id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_evictable');
  end if;

  insert into public.hq_memory_events (memory_id, event_type, detail)
  values (
    p_memory_id, 'archived',
    jsonb_build_object('reason', coalesce(p_reason, 'evicted'))
  );

  return jsonb_build_object('ok', true, 'memory_id', p_memory_id);
end;
$$;

revoke all on function public.hq_memory_archive(uuid, text) from public, anon, authenticated;
grant execute on function public.hq_memory_archive(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 11. §15 — hq_memory_golden_signals — one operational read over the lifecycle.
--     Status + class distribution, the live backlog each engine faces (TTL due,
--     decay-archivable, summary candidates, still-unconsolidated episodes), and
--     a 24h count of each lifecycle transition. Cheap bounded aggregates; the
--     backlog thresholds reuse the SAME policy literals (0.05 / 30 days / 1200 /
--     0.6) so the dashboard agrees with the engines. STABLE + ungated so it can
--     be read to observe state even while the worker is disabled (it reports
--     worker_enabled). Mirrors hq_embedding_golden_signals (PR4).
-- ---------------------------------------------------------------------------
create or replace function public.hq_memory_golden_signals()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'worker_enabled', public.hq_memory_lifecycle_enabled(),
    'memories', jsonb_build_object(
      'total',      (select count(*) from public.hq_memories),
      'active',     (select count(*) from public.hq_memories where status = 'active'),
      'archived',   (select count(*) from public.hq_memories where status = 'archived'),
      'superseded', (select count(*) from public.hq_memories where status = 'superseded'),
      'draft',      (select count(*) from public.hq_memories where status = 'draft')
    ),
    'by_class', (
      select coalesce(jsonb_object_agg(memory_class, c), '{}'::jsonb)
      from (
        select memory_class, count(*) as c
          from public.hq_memories
         where status = 'active'
         group by memory_class
      ) g
    ),
    'lifecycle_backlog', jsonb_build_object(
      'ttl_expired_due', (
        select count(*) from public.hq_memories
         where status = 'active'
           and memory_class in ('working', 'episodic')
           and expires_at is not null and expires_at <= now()
      ),
      'decay_archivable', (
        select count(*) from public.hq_memories
         where status = 'active' and memory_class = 'episodic'
           and consolidated_into is not null
           and exp(
                 - greatest(0, extract(epoch from (now() - coalesce(last_reinforced_at, created_at))))
                 / extract(epoch from interval '30 days')
               ) * (salience / 100.0) < 0.05
      ),
      'summary_candidates', (
        select count(*) from public.hq_memories
         where status = 'active'
           and char_length(coalesce(body, '')) >= 1200
           and (
             char_length(coalesce(summary, '')) = 0
             or char_length(coalesce(summary, '')) >= char_length(coalesce(body, '')) * 0.6
           )
      ),
      'unconsolidated_episodic', (
        select count(*) from public.hq_memories
         where status = 'active' and memory_class = 'episodic'
           and consolidated_into is null
      )
    ),
    'transitions_24h', jsonb_build_object(
      'expired',      (select count(*) from public.hq_memory_events where event_type = 'expired'      and created_at >= now() - interval '24 hours'),
      'archived',     (select count(*) from public.hq_memory_events where event_type = 'archived'     and created_at >= now() - interval '24 hours'),
      'consolidated', (select count(*) from public.hq_memory_events where event_type = 'consolidated' and created_at >= now() - interval '24 hours'),
      'superseded',   (select count(*) from public.hq_memory_events where event_type = 'superseded'   and created_at >= now() - interval '24 hours'),
      'summarised',   (select count(*) from public.hq_memory_events where event_type = 'summarised'   and created_at >= now() - interval '24 hours')
    )
  );
$$;

revoke all on function public.hq_memory_golden_signals() from public, anon, authenticated;
grant execute on function public.hq_memory_golden_signals() to service_role;
