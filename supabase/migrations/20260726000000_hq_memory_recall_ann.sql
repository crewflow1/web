-- CrewFlow HQ — Shared Memory: the SEMANTIC (ANN) recall channel
-- (CEO Directive 009, Phase 1, Module 1 — Shared Memory, PR4d).
--
-- PR3 (20260724000000_hq_memory_recall.sql) shipped `hq_memory_recall` with the
-- frozen pipeline order Permission → Lexical → Structural → (Semantic) → Rank,
-- and DELIBERATELY left the semantic stage dormant: it already accepted
-- `p_query_embedding float8[]` and IGNORED it, because pgvector was not enabled
-- and the model was undecided (Volume X §16). PR4b lit pgvector up (the real
-- `embedding vector(1536)` column, the HNSW cosine index, the versioned-asset
-- metadata, and the embedding worker). THIS migration connects the two: it
-- turns on the semantic channel inside `hq_memory_recall` WITHOUT moving the
-- permission boundary and WITHOUT changing how the service/SDK call it.
--
-- EMBEDDINGS ARE A PLUG-IN, NOT A DEPENDENCY (Directive 009 standing rule).
-- The semantic channel ARMS only when the caller passes BOTH a query embedding
-- AND its version (see below). With neither — no provider configured, or a
-- blank query — recall is BYTE-IDENTICAL to PR3: permission filter, lexical
-- (websearch over the generated tsvector), structural (relationship graph),
-- pinned, and the employee's own working/episodic experience. Semantic search
-- is purely ADDITIVE; it never gates, narrows, or replaces the other channels.
--
-- VERSION ISOLATION IS MANDATORY (Directive 009: "vectors are always compared
-- within a single model's space"). The query embedding produced by the active
-- provider carries a version string (provider:model:dDIM:vREV). Candidates are
-- filtered to `embedding_version = p_query_version` AND
-- `embedding_dimension = array_length(query)`, so the cosine operator only ever
-- compares equal-dimension vectors from the SAME model. During a re-embedding
-- migration (PR4b's `hq_embedding_enqueue_stale`), rows not yet re-embedded to
-- the new version simply don't contribute a semantic signal — recall degrades
-- to lexical+structural for them until their vector is replaced (a graceful
-- coverage ramp, never an outage). This is why the query VERSION must travel
-- with the query VECTOR.
--
-- SIGNATURE EVOLUTION — one backward-compatible trailing parameter.
-- `hq_memory_recall` gains `p_query_version text default null` at the END of
-- its parameter list. Postgres treats a changed argument list as a NEW, DISTINCT
-- function (CREATE OR REPLACE cannot add a parameter in place), and leaving the
-- old 7-arg overload alongside the new 8-arg one would make a 7-named-arg call
-- AMBIGUOUS ("function is not unique"). So we DROP the PR3 function and CREATE
-- the new one. This is a deliberate, NON-destructive signature evolution, not a
-- rewrite: the new body is a strict SUPERSET of the old (semantic off when
-- p_query_version is null ⇒ identical candidates and order to PR3), and PR3's
-- own header anticipated exactly this ("PR4 ... adds an ANN channel"). Every
-- PR3-era call shape still resolves (the new parameter defaults to null), and
-- the TS surface the SDK binds to — recallMemory(input, employee) / RecallInput
-- — is UNCHANGED: the version is derived internally from the active provider,
-- never supplied by the caller. So "the SDK never changes" still holds.
--
-- PERMISSION IS STILL FIRST, AND IN SQL. Both candidate sources — the lexical/
-- structural set AND the semantic ANN set — apply the §6 permission predicate
-- (mirroring lib/memory/model.ts canEmployeeAccess) as a WHERE clause on the
-- base table, so a non-permitted row is never a candidate in EITHER channel. A
-- vector therefore inherits the permissions of its memory; semantic search can
-- never surface a memory the employee could not already read. The two copies of
-- the predicate are kept textually in sync; the security gate
-- (memory-recall-ann-invariants) asserts BOTH are present.
--
-- WHY THE SEMANTIC SET SELECTS FROM THE BASE TABLE. pgvector's HNSW index only
-- accelerates `ORDER BY embedding <=> q LIMIT k` evaluated directly against the
-- table scan. Routing the ANN probe through a CTE/join would materialise the
-- permitted set and defeat the index (a full distance scan — fatal at the
-- "millions of memories" scale the directive targets). So the ANN candidate
-- query carries its own inline permission WHERE and orders by distance on the
-- base table; the duplicated predicate is the price of an index-backed probe.
--
-- pgvector lives in `public` (PR4b §0 pins it there). This function pins
-- `search_path = ''` for injection-safety, so the type and operator are
-- SCHEMA-QUALIFIED: `public.vector` and `OPERATOR(public.<=>)` (cosine
-- distance). An unqualified `vector` / `<=>` would not resolve at runtime.
--
-- READS STILL DO NOT BROADCAST. Like PR3, recall emits nothing on The Pulse and
-- makes no external call; the assembled set is audited per-memory + reinforced
-- by the separate `hq_memory_reinforce` (untouched here).

-- ---------------------------------------------------------------------
-- Drop the PR3 7-arg function so the new 8-arg function is unambiguous.
-- ---------------------------------------------------------------------
drop function if exists public.hq_memory_recall(
  uuid, text, float8[], text, text, text[], integer
);

-- ---------------------------------------------------------------------
-- hq_memory_recall(...) — permissioned candidate retrieval with the SEMANTIC
-- ANN channel switched on (Volume X §7, stage 1–2 + the optional semantic
-- stage). Returns the SAME jsonb projection as PR3 plus `cos_sim`, the raw
-- semantic signal the pure ranker (lib/memory/retrieval.ts) blends. Never
-- returns the body, search_tsv, or the embedding — only a token estimate.
-- ---------------------------------------------------------------------
create or replace function public.hq_memory_recall(
  p_employee_id     uuid,
  p_query           text       default null,
  p_query_embedding float8[]   default null,
  p_subject_kind    text       default null,
  p_subject_id      text       default null,
  p_class_filter    text[]     default null,
  p_limit           integer    default 48,
  p_query_version   text       default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dept     text;
  v_query    tsquery;
  v_limit    integer;
  v_qvec     public.vector;
  v_qdim     integer;
  v_semantic boolean;
  v_sem_k    integer;
  v_result   jsonb;
begin
  -- Resolve the recalling employee. The department drives the §6 read
  -- predicate; an unknown id fails closed (no candidates leak on a typo).
  select e.department into v_dept
  from public.ai_employees e
  where e.id = p_employee_id;

  if v_dept is null then
    raise exception 'hq_memory_recall: unknown employee %', p_employee_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Bound the candidate set (the pure layer diversifies + budgets it down).
  v_limit := least(greatest(coalesce(p_limit, 48), 1), 200);

  -- Lexical query — websearch grammar over the weighted, generated tsvector.
  -- A null/blank query means "no lexical channel": recall then ranks on
  -- recency / salience / structure / pinned, so "what was I just doing?"
  -- recall works with no search terms at all.
  v_query := case
    when p_query is null or btrim(p_query) = '' then null
    else websearch_to_tsquery('english', p_query)
  end;

  -- Arm the semantic channel ONLY with a query embedding AND its version. The
  -- version is mandatory (single-model-space comparison); without it the vector
  -- cannot be safely compared, so semantic stays off and recall degrades to
  -- lexical + structural — the plug-in contract.
  v_qdim := array_length(p_query_embedding, 1);
  v_semantic := p_query_embedding is not null
            and v_qdim is not null
            and p_query_version is not null
            and btrim(p_query_version) <> '';
  if v_semantic then
    -- float8[] → real[] → public.vector. Schema-qualified: search_path is ''.
    v_qvec := p_query_embedding::real[]::public.vector;
  end if;
  v_sem_k := v_limit;

  with
  -- =================================================================
  -- STAGE 2a — lexical / structural / pinned / own-experience candidates
  -- (PR3, unchanged). STAGE 1 (the §6 permission filter) is the WHERE: a
  -- non-permitted row is never even a candidate.
  -- =================================================================
  lexical as (
    select m.id
    from public.hq_memories m
    where m.status = 'active'
      -- ===== STAGE 1: §6 permission filter (mirrors canEmployeeAccess) =====
      and (
        m.visibility = 'public_hq'
        or (m.visibility in ('department', 'private', 'restricted')
              and m.owner_employee_id is not null and m.owner_employee_id = p_employee_id)
        or (m.visibility = 'department'
              and m.department is not null and m.department = v_dept)
        or (m.visibility in ('department', 'private', 'restricted')
              and exists (
                select 1 from public.hq_memory_access_grants g
                where g.memory_id = m.id
                  and ((g.grantee_type = 'employee' and g.grantee_value = p_employee_id::text)
                    or (g.grantee_type = 'department' and g.grantee_value = v_dept))
              ))
      )
      and (p_class_filter is null or m.memory_class = any(p_class_filter))
      -- ===== STAGE 2: lexical / structural / pinned / own relevance =====
      and (
        v_query is null
        or m.search_tsv @@ v_query
        or m.pinned
        or (p_subject_kind is not null and p_subject_id is not null and exists (
              select 1 from public.hq_memory_relationships r
              where r.memory_id = m.id
                and r.entity_type = p_subject_kind
                and r.entity_id = p_subject_id))
        or (m.memory_class in ('working', 'episodic')
              and m.owner_employee_id is not null
              and m.owner_employee_id = p_employee_id)
      )
  ),
  -- =================================================================
  -- STAGE 2b — the SEMANTIC ANN channel (PR4). Top-k nearest PERMITTED
  -- vectors of the query's exact version + dimension. Selects from the base
  -- table (not a CTE) with an inline copy of the SAME §6 permission predicate,
  -- so the HNSW index backs the ORDER BY ... LIMIT. Empty unless v_semantic.
  -- (The permission predicate below is kept textually identical to `lexical`
  -- above — the security gate asserts both copies exist.)
  -- =================================================================
  semantic as (
    select m.id
    from public.hq_memories m
    where v_semantic
      and m.status = 'active'
      -- ===== STAGE 1: §6 permission filter (mirrors canEmployeeAccess) =====
      and (
        m.visibility = 'public_hq'
        or (m.visibility in ('department', 'private', 'restricted')
              and m.owner_employee_id is not null and m.owner_employee_id = p_employee_id)
        or (m.visibility = 'department'
              and m.department is not null and m.department = v_dept)
        or (m.visibility in ('department', 'private', 'restricted')
              and exists (
                select 1 from public.hq_memory_access_grants g
                where g.memory_id = m.id
                  and ((g.grantee_type = 'employee' and g.grantee_value = p_employee_id::text)
                    or (g.grantee_type = 'department' and g.grantee_value = v_dept))
              ))
      )
      and (p_class_filter is null or m.memory_class = any(p_class_filter))
      -- ===== version isolation: same model space, same dimension =====
      and m.embedding is not null
      and m.embedding_version = p_query_version
      and m.embedding_dimension = v_qdim
    order by m.embedding OPERATOR(public.<=>) v_qvec
    limit v_sem_k
  ),
  -- The union of both channels' ids. Permission was enforced upstream in BOTH,
  -- so nothing here can widen what is readable.
  candidate_ids as (
    select id from lexical
    union
    select id from semantic
  ),
  -- Enrich the union with the raw ranker signals. cos_sim is computed for any
  -- candidate carrying a same-version, same-dimension vector (the CASE
  -- short-circuits, so the <=> operator never runs on a mismatched row). It is
  -- 1 - cosine_distance ∈ [-1, 1]; the pure ranker clamps to [0, 1].
  enriched as (
    select
      m.id, m.memory_class, m.memory_type, m.title, m.summary, m.body,
      m.visibility, m.department, m.owner_employee_id, m.importance,
      m.salience, m.pinned, m.access_count, m.consolidated_into, m.version,
      m.created_at, m.last_reinforced_at,
      case when v_query is null then 0::real
           else ts_rank(m.search_tsv, v_query) end as l_rank,
      case when p_subject_kind is not null and p_subject_id is not null
             and exists (
               select 1 from public.hq_memory_relationships r
               where r.memory_id = m.id
                 and r.entity_type = p_subject_kind
                 and r.entity_id = p_subject_id
             )
           then 1 else 0 end as s_match,
      case when v_semantic
                and m.embedding is not null
                and m.embedding_version = p_query_version
                and m.embedding_dimension = v_qdim
           then (1 - (m.embedding OPERATOR(public.<=>) v_qvec))::real
           else null end as cos_sim
    from public.hq_memories m
    join candidate_ids c on c.id = m.id
  ),
  ranked as (
    -- A COARSE pre-rank, purely to choose the top v_limit candidates. Strength
    -- in EITHER channel (semantic OR lexical) keeps a row in. The authoritative
    -- blended score (Volume X §7.3) is computed in the pure ranker over the
    -- signals below — SQL never decides the final order.
    select *
    from enriched
    order by
      greatest(coalesce(cos_sim, 0::real), coalesce(l_rank, 0::real)) desc,
      pinned desc,
      salience desc,
      coalesce(last_reinforced_at, created_at) desc
    limit v_limit
  )
  -- Ship ONLY the projection the ranker needs. Explicit jsonb_build_object
  -- (never to_jsonb of the row) guarantees the body, the search_tsv and the
  -- embedding column are NEVER returned — only a token estimate of the body.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                id,
    'memory_class',      memory_class,
    'memory_type',       memory_type,
    'title',             title,
    'summary',           summary,
    'visibility',        visibility,
    'department',        department,
    'owner_employee_id', owner_employee_id,
    'importance',        importance,
    'salience',          salience,
    'pinned',            pinned,
    'access_count',      access_count,
    'consolidated_into', consolidated_into,
    'version',           version,
    'created_at',        created_at,
    'last_reinforced_at', last_reinforced_at,
    'ts_rank',           l_rank,
    'structural_match',  s_match,
    'cos_sim',           cos_sim,
    'body_tokens',       ceil(char_length(coalesce(body, '')) / 4.0)::int,
    'summary_tokens',    ceil(char_length(coalesce(summary, '')) / 4.0)::int
  )), '[]'::jsonb)
  into v_result
  from ranked;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- Privilege model — service_role-only, like every HQ engine primitive.
-- Re-issued for the NEW 8-arg signature (Supabase grants EXECUTE on new public
-- functions to anon/authenticated by default, so revoking from PUBLIC alone is
-- not enough): revoke from all JWT roles, grant only to service_role.
-- ---------------------------------------------------------------------
revoke all on function public.hq_memory_recall(
  uuid, text, float8[], text, text, text[], integer, text
) from public, anon, authenticated;

grant execute on function public.hq_memory_recall(
  uuid, text, float8[], text, text, text[], integer, text
) to service_role;
