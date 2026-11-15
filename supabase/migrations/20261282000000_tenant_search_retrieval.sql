-- CrewFlow — Tenant Semantic Search: the permissioned retrieval RPC.
--
-- The ONE authenticated read path into tenant_search_documents (which is RLS
-- zero-policy → service-role only). SECURITY DEFINER so it can read the corpus,
-- but it re-imposes the FULL tenant boundary IN-BODY, fail-closed, before any
-- candidate is considered — exactly as hq_memory_recall does for HQ memory, and
-- exactly the posture required of every secdef RPC in this repo (the control is
-- the in-body current_org_ids() membership check, never the GRANT).
--
-- THE BOUNDARY, enforced as a WHERE clause on the base table in BOTH the
-- semantic and lexical candidate channels (a non-permitted row is never even a
-- candidate — it cannot be widened by ranking):
--   1. TENANT:   org_id = p_org_id AND p_org_id = any(current_org_ids()).
--                A caller who is not a member of p_org_id gets '[]' — fail-closed.
--   2. STAFF:    a non-admin (NOT is_org_admin(p_org_id)) sees ONLY rows whose
--                visibility is staff-reachable ('member'|'staff') AND whose job
--                is NULL or in my_assigned_job_ids(). 'management' (Sales/Money/
--                Operations admin surfaces) and 'private' (admin-only job docs)
--                are NEVER returned to staff. Unknown visibilities fail closed
--                (the allowlist is positive). An admin sees the whole org.
--   3. The embedding column is NEVER projected — only a content SNIPPET, the
--      gating columns, and the raw ranker signals (cos_sim, ts_rank).
--
-- RETRIEVED TEXT IS DATA, NOT INSTRUCTIONS. The caller renders the snippet as a
-- search result label; it is never fed back to a model as a prompt here.
--
-- DARK-SAFE. The semantic channel ARMS only when the caller passes BOTH a query
-- embedding AND its version (single-model-space comparison). With neither — no
-- provider, or embeddings dark — recall degrades to the lexical channel
-- (websearch over content_tsv). The caller (app/api/search/route.ts) degrades
-- further still: if this RPC is unavailable it falls back to its own keyword
-- search over the source tables, unchanged.

create or replace function public.tenant_search_semantic(
  p_org_id          uuid,
  p_query           text       default null,
  p_query_embedding float8[]   default null,
  p_query_version   text       default null,
  p_source_tables   text[]     default null,
  p_limit           integer    default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_member boolean;
  v_is_admin  boolean;
  v_query     tsquery;
  v_limit     integer;
  v_qvec      public.vector;
  v_qdim      integer;
  v_semantic  boolean;
  v_result    jsonb;
begin
  -- ===== 1. TENANT membership gate — fail closed on a non-member. =====
  v_is_member := p_org_id = any (select public.current_org_ids());
  if not coalesce(v_is_member, false) then
    return '[]'::jsonb;
  end if;
  v_is_admin := public.is_org_admin(p_org_id);

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100);

  -- Lexical query — websearch grammar over the generated content_tsv. A blank
  -- query means "no lexical channel"; semantic (if armed) answers alone.
  v_query := case
    when p_query is null or btrim(p_query) = '' then null
    else websearch_to_tsquery('english', p_query)
  end;

  -- Arm the semantic channel ONLY with a query embedding AND its version.
  v_qdim := array_length(p_query_embedding, 1);
  v_semantic := p_query_embedding is not null
            and v_qdim is not null
            and p_query_version is not null
            and btrim(p_query_version) <> '';
  if v_semantic then
    v_qvec := p_query_embedding::real[]::public.vector;
  end if;

  with
  -- =================================================================
  -- SEMANTIC channel — top-k nearest PERMITTED vectors of the query's exact
  -- version + dimension. Selects from the base table with an inline copy of the
  -- SAME boundary so the HNSW index backs the ORDER BY ... LIMIT. Empty unless
  -- v_semantic. (The boundary predicate is kept textually identical to the
  -- lexical channel below; the security invariants assert both copies exist.)
  -- =================================================================
  semantic as (
    select d.id
    from public.tenant_search_documents d
    where v_semantic
      and d.org_id = p_org_id
      and (p_source_tables is null or d.source_table = any(p_source_tables))
      -- ===== STAFF + VISIBILITY gate (admin sees all; staff by allowlist) =====
      and (
        v_is_admin
        or (
          d.visibility in ('member', 'staff')
          and (d.job_id is null or d.job_id in (select public.my_assigned_job_ids()))
        )
      )
      -- ===== version isolation: same model space, same dimension =====
      and d.embedding is not null
      and d.embedding_version = p_query_version
      and d.embedding_dimension = v_qdim
    order by d.embedding OPERATOR(public.<=>) v_qvec
    limit v_limit
  ),
  -- =================================================================
  -- LEXICAL channel — websearch over content_tsv, same boundary. This is the
  -- graceful fallback when the semantic channel is dark.
  -- =================================================================
  lexical as (
    select d.id
    from public.tenant_search_documents d
    where v_query is not null
      and d.org_id = p_org_id
      and (p_source_tables is null or d.source_table = any(p_source_tables))
      and (
        v_is_admin
        or (
          d.visibility in ('member', 'staff')
          and (d.job_id is null or d.job_id in (select public.my_assigned_job_ids()))
        )
      )
      and d.content_tsv @@ v_query
    limit v_limit
  ),
  candidate_ids as (
    select id from semantic
    union
    select id from lexical
  ),
  enriched as (
    select
      d.id, d.source_table, d.source_id, d.job_id, d.visibility,
      left(coalesce(d.content, ''), 200) as snippet,
      case when v_query is null then 0::real
           else ts_rank(d.content_tsv, v_query) end as ts_rank,
      case when v_semantic
                and d.embedding is not null
                and d.embedding_version = p_query_version
                and d.embedding_dimension = v_qdim
           then (1 - (d.embedding OPERATOR(public.<=>) v_qvec))::real
           else null end as cos_sim
    from public.tenant_search_documents d
    join candidate_ids c on c.id = d.id
  ),
  ranked as (
    select *
    from enriched
    order by
      greatest(coalesce(cos_sim, 0::real), coalesce(ts_rank, 0::real)) desc
    limit v_limit
  )
  -- Ship ONLY the safe projection. Explicit jsonb_build_object (never to_jsonb
  -- of the row) guarantees the embedding column is NEVER returned.
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_table', source_table,
    'source_id',    source_id,
    'job_id',       job_id,
    'visibility',   visibility,
    'snippet',      snippet,
    'cos_sim',      cos_sim,
    'ts_rank',      ts_rank
  )), '[]'::jsonb)
  into v_result
  from ranked;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilege model. Unlike the service-role-only queue, THIS function is the
-- authenticated read path, so it is granted to `authenticated`. The control is
-- the in-body current_org_ids() membership gate (fail-closed), NOT the grant —
-- anon is revoked (no auth.uid() → no membership → '[]' anyway, defence in
-- depth), and the default anon/authenticated EXECUTE that Supabase grants on a
-- new public function is revoked and re-granted deliberately.
-- ---------------------------------------------------------------------------
revoke all on function public.tenant_search_semantic(uuid, text, float8[], text, text[], integer)
  from public, anon, authenticated;
grant execute on function public.tenant_search_semantic(uuid, text, float8[], text, text[], integer)
  to authenticated;
