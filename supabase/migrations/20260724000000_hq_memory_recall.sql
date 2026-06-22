-- CrewFlow HQ — Shared Memory: the AI recall pipeline (`hq_memory_recall`)
-- (CEO Directive 009, Phase 1, Module 1 — Shared Memory, PR3).
--
-- Builds ON TOP of the Shared Memory Engine (Directive 002), the lifecycle
-- columns from PR1 (20260722000000_memory_classes_lifecycle.sql) and the AI
-- write path from PR2 (20260723000000_hq_memory_write.sql). This is the
-- substrate the CrewFlow Bible, Volume X §7 describes: the engine gains a
-- SINGLE, permissioned, indexed entry point through which an AI employee
-- recalls a ranked, budgeted slice of memory.
--
-- ADDITIVE & DARK. This migration adds TWO functions and NOTHING else; it
-- drops/retypes nothing and changes NO existing behaviour. The functions
-- have NO callers in production — the SDK that invokes them ships later
-- (PR6), behind the boardroom/employee gates — so the *absence of a caller*
-- is the dark boundary; no feature flag is needed. The existing human read
-- path (server/services/hq-memory.ts searchMemories / getEmployeeMemoryFeed)
-- is untouched: ONE engine, two callers (Directive 009 "one of each").
--
-- THE SPLIT (Volume X §12.2). The SQL holds ONLY the atomic, permissioned
-- reads: stage 1 the §6 permission filter (mirroring lib/memory/model.ts
-- `canEmployeeAccess` the same way `hq_memory_write` mirrors `decideMemoryWrite`)
-- and stage 2 the indexed candidate retrieval (lexical over the generated
-- search_tsv, structural over the relationship graph). The pure
-- lib/memory/retrieval.ts `rankAndAssemble` performs the blended scoring
-- (§7.3), diversify (§7.4) and the token-budget knapsack (§8) over the
-- candidates this returns. Permission is therefore enforced BEFORE scoring,
-- in SQL, and can never be widened by the ranking layer.
--
-- READS DO NOT BROADCAST. Recall emits NOTHING on The Pulse: the frozen
-- event registry (lib/events/registry.ts) has no `memory.read`/recall verb,
-- and the spine is the business-event heartbeat, not the read trail. AI
-- reads are audited per-memory instead (the `ai_accessed` timeline event +
-- reinforcement bookkeeping), written by `hq_memory_reinforce` over the
-- ASSEMBLED set — so the company-wide audit stays signal, not noise.
--
-- EMBEDDINGS ARE A PLUG-IN, NOT A DEPENDENCY (Directive 009 standing rule).
-- `hq_memory_recall` already takes `p_query_embedding`; pgvector stays
-- dormant until the Volume X §16 model decision, so the parameter is typed
-- `float8[]` (a plain array — no extension needed) and is ACCEPTED AND
-- IGNORED here. Recall degrades gracefully to lexical + structural search.
-- When PR4 enables pgvector it casts this parameter to `vector` and adds an
-- ANN channel WITHOUT changing this signature — so the SDK never changes,
-- and semantic search lights up automatically with no application code edit.
--
-- hq_memories / its child tables already have RLS ENABLED with NO policies
-- (service-role only); these SECURITY DEFINER functions are granted to
-- service_role alone, like every other HQ engine primitive.

-- ---------------------------------------------------------------------
-- 1. hq_memory_recall(...) — permissioned candidate retrieval (Volume X §7,
--    stage 1–2). Returns a jsonb array of candidate rows carrying the RAW
--    signals the pure ranker consumes (never the body, search_tsv or the
--    reserved embedding column — only a token estimate of the body, so the
--    §8 knapsack can pack without shipping megabytes of text). Raises on an
--    unknown employee; returns '[]' when nothing is permitted/relevant.
-- ---------------------------------------------------------------------

create or replace function public.hq_memory_recall(
  p_employee_id     uuid,
  p_query           text       default null,
  p_query_embedding float8[]   default null,
  p_subject_kind    text       default null,
  p_subject_id      text       default null,
  p_class_filter    text[]     default null,
  p_limit           integer    default 48
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dept   text;
  v_query  tsquery;
  v_limit  integer;
  v_result jsonb;
begin
  -- Resolve the recalling employee. The department drives the §6 read
  -- predicate (department-visible memory is readable by same-department
  -- employees); an unknown id fails closed (no candidates leak on a typo).
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

  -- p_query_embedding is the PR4 semantic seam. pgvector is dormant
  -- (Volume X §16): there is no vector column to compare against yet, so the
  -- parameter is accepted and IGNORED here. PR4 casts it to `vector` and adds
  -- an ANN channel WITHOUT changing this signature — recall is byte-identical
  -- with or without embeddings, so the SDK caller never changes.

  with permitted as (
    select
      m.id, m.memory_class, m.memory_type, m.title, m.summary, m.body,
      m.visibility, m.department, m.owner_employee_id, m.importance,
      m.salience, m.pinned, m.access_count, m.consolidated_into, m.version,
      m.created_at, m.last_reinforced_at,
      -- Lexical rank (ts_rank); 0 when there is no query. Computed once here.
      case when v_query is null then 0::real
           else ts_rank(m.search_tsv, v_query) end as l_rank,
      -- Structural match to the task subject (graph relationship) → 1 else 0.
      case when p_subject_kind is not null and p_subject_id is not null
             and exists (
               select 1 from public.hq_memory_relationships r
               where r.memory_id = m.id
                 and r.entity_type = p_subject_kind
                 and r.entity_id = p_subject_id
             )
           then 1 else 0 end as s_match
    from public.hq_memories m
    where m.status = 'active'
      -- ============================================================
      -- STAGE 1 — the §6 permission filter, IN SQL (mirrors
      -- lib/memory/model.ts canEmployeeAccess). This is a WHERE clause,
      -- not a post-filter: a non-permitted row is never even a candidate.
      --   public_hq            → everyone
      --   owned (any class)    → the owning employee
      --   department           → same department, an owner, or a grant
      --   private / restricted → an owner or a grant
      --   system / unknown     → never (no branch matches → fail closed)
      -- ============================================================
      and (
        m.visibility = 'public_hq'
        or (m.owner_employee_id is not null and m.owner_employee_id = p_employee_id)
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
      -- Optional cognitive-class filter (e.g. recall only procedural memory).
      and (p_class_filter is null or m.memory_class = any(p_class_filter))
      -- ============================================================
      -- STAGE 2 — the relevance candidate set. With a query: lexical OR
      -- structural OR pinned OR the employee's own recent experience. With
      -- no query: every permitted row (ranked by recency/salience/pinned).
      -- ============================================================
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
  ranked as (
    -- A COARSE pre-rank, purely to choose the top v_limit candidates. The
    -- authoritative blended score (Volume X §7.3) is computed in the pure
    -- lib/memory/retrieval.ts rankAndAssemble over the signals below — SQL
    -- never ranks the final order.
    select *
    from permitted
    order by
      l_rank desc,
      pinned desc,
      salience desc,
      coalesce(last_reinforced_at, created_at) desc
    limit v_limit
  )
  -- Ship ONLY the projection the ranker needs. Explicit jsonb_build_object
  -- (never to_jsonb of the row) guarantees the body, the search_tsv and the
  -- reserved embedding column are NEVER returned — only a token estimate of
  -- the body, so the §8 knapsack packs without shipping the text.
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
    'body_tokens',       ceil(char_length(coalesce(body, '')) / 4.0)::int,
    'summary_tokens',    ceil(char_length(coalesce(summary, '')) / 4.0)::int
  )), '[]'::jsonb)
  into v_result
  from ranked;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. hq_memory_reinforce(...) — reinforcement + the AI read audit, applied
--    to the ASSEMBLED set after the pure ranker has chosen it (Volume X
--    §7 reinforcement / §10 decay). Recalled knowledge decays slower
--    (last_reinforced_at), gains popularity (access_count), and records WHO
--    read it via a per-memory `ai_accessed` timeline event. Idempotent on an
--    empty/NULL array. NO Pulse event — reads are audited per-memory only.
-- ---------------------------------------------------------------------

create or replace function public.hq_memory_reinforce(
  p_employee_id uuid,
  p_memory_ids  uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_memory_ids is null or array_length(p_memory_ids, 1) is null then
    return;
  end if;

  -- Reinforcement bookkeeping: used knowledge decays slower (§10) and gains
  -- popularity (§7.3). Mirrors the human recordMemoryAccess bump for AI reads.
  update public.hq_memories
     set last_reinforced_at = now(),
         last_accessed_at   = now(),
         access_count       = access_count + 1
   where id = any(p_memory_ids);

  -- Per-memory AI read audit (the ai_accessed timeline event the memory-detail
  -- view already renders). Selecting from hq_memories first means a stale id
  -- can never violate the events FK. ai_employee_id records authorship of the read.
  insert into public.hq_memory_events (memory_id, event_type, actor_email, ai_employee_id, detail)
  select m.id, 'ai_accessed', null, p_employee_id, jsonb_build_object('via', 'ai_recall')
  from public.hq_memories m
  where m.id = any(p_memory_ids);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Privilege model — service_role-only, like every HQ engine primitive.
--    Supabase's default privileges grant EXECUTE on new public functions
--    directly to anon/authenticated, so revoking from PUBLIC alone is not
--    enough (L-4): revoke from all JWT roles, grant only to service_role.
-- ---------------------------------------------------------------------

revoke all on function public.hq_memory_recall(
  uuid, text, float8[], text, text, text[], integer
) from public, anon, authenticated;

grant execute on function public.hq_memory_recall(
  uuid, text, float8[], text, text, text[], integer
) to service_role;

revoke all on function public.hq_memory_reinforce(
  uuid, uuid[]
) from public, anon, authenticated;

grant execute on function public.hq_memory_reinforce(
  uuid, uuid[]
) to service_role;
