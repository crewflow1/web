-- CrewFlow HQ — The Capability Registry, LR1: Registry-Native Authoring
-- (CEO Directive #015 / D-05, Legacy Removal increment 1).
--
-- ADR: docs/bible/decisions/0010-capability-registry.md (Accepted).
-- Proposal: docs/bible/governance/... Legacy Removal Proposal (reviewed + approved).
-- Governing standards (Kernel Contract Map §2): the Single Source of Authority Rule
-- (13th), the Migration Parity Rule (14th), the Behaviour Preservation Rule (15th),
-- the Shadow Validation Rule (16th), the Rollback Readiness Rule (17th), and the
-- Evidence Before Deletion Rule (18th — removal is a LATER, separately-authorised
-- increment; LR1 removes NOTHING).
--
-- WHAT LR1 IS. R1–R4 stood the registry up and made it the AUTHORITATIVE runtime
-- source (legacy retained for rollback). But authority is still AUTHORED into the
-- legacy `ai_employees` columns and only mirrored INTO the registry by the R2
-- backfill. LR1 is the first legacy-removal increment: it gives the registry a
-- NATIVE write path so authority can be authored AT the registry, while the legacy
-- model keeps receiving a parity-faithful mirror (the dual write is not stopped).
--
-- What this migration creates:
--   public.hq_author_employee_capabilities(p_slug, p_tokens, p_actor_id,
--   p_actor_email) — a single SECURITY DEFINER, service-role-only RPC that performs
--   the WHOLE authoring act ATOMICALLY in one transaction (supabase-js has no
--   client-side multi-statement transaction — CEO decision D1 — so only an RPC can
--   make the registry write and the legacy mirror succeed or fail together, leaving
--   no divergence window). In order it:
--     1. normalises the requested token set to sorted-distinct;
--     2. defensively format-checks each token (clean envelope, not a raised
--        constraint, for the service-role caller to branch on);
--     3. resolves the subject by canonical slug (unknown → clean envelope, no write);
--     4. DEFINES any new token in the catalogue (`hq_capabilities`), leaving the kind
--        of pre-existing tokens untouched;
--     5. UPSERTS the employee-scoped grant — TOKENS ONLY;
--     6. MIRRORS a parity-faithful split back to the retained legacy columns.
--
-- The PARITY contract (the Migration Parity + Behaviour Preservation Rules). The
-- authored set is split by catalogue KIND: scopes → `permissions.scopes`, everything
-- else (tool permissions + forward-compat api scopes) → `tools_allowed`. The two
-- halves PARTITION the authored set, so their UNION — exactly what `legacyAuthorityOf`
-- resolves — equals the grant's token array. Posture (`can_execute`,
-- `requires_approval`) and `memory_scope` are PRESERVED on both sides, so all four
-- compared dimensions stay equal and continuous shadow verification keeps passing.
--
-- What LR1 DELIBERATELY does NOT do (the CEO's explicit do-not list for LR1):
--   * does NOT remove any legacy column — `ai_employees.tools_allowed` /
--     `permissions` / `memory_scope` remain and are still mirrored;
--   * does NOT stop parity verification — the shadow + parity gate are untouched;
--   * does NOT retire rollback — `CAPABILITY_AUTHORITY_SOURCE=legacy` still works;
--   * does NOT change runtime authority — the R4 resolver is untouched;
--   * does NOT delete migration tooling — the R2 backfill stays in place;
--   * does NOT change posture — `can_execute` stays exactly where the legacy model
--     has it (LR1 authors the token SET, never the execution lock — Directive 001).
--
-- Security posture — RLS:hq. The function is SECURITY DEFINER with a pinned empty
-- search_path; EXECUTE is revoked from public/anon/authenticated and granted only to
-- service_role, so it is reachable only through the service-role admin client behind
-- the superadmin-gated server action. No tenant table is touched.

-- ---------------------------------------------------------------------------
-- 1. The authoring entry point.
-- ---------------------------------------------------------------------------
create or replace function public.hq_author_employee_capabilities(
  p_slug        text,
  p_tokens      text[],
  p_actor_id    uuid default null,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tokens             text[];
  v_bad_token          text;
  v_emp_id             uuid;
  v_permissions        jsonb;
  v_memory_scope       text;
  v_can_execute        boolean;
  v_requires_approval  boolean;
  v_tool_tokens        text[];
  v_scope_tokens       text[];
  v_grant_id           uuid;
  v_action             text;
begin
  -- 1. Normalise the requested set to sorted-distinct, dropping NULL/blank tokens.
  --    This is the exact normal form the grant's validate trigger will store, so the
  --    value mirrored to the legacy model and returned is the value persisted.
  v_tokens := coalesce(
    (select array_agg(distinct t order by t)
       from unnest(p_tokens) as t
      where t is not null and char_length(t) > 0),
    '{}'::text[]
  );

  -- 2. Defensive token-format check. The catalogue's own constraint is the hard
  --    backstop; this returns a clean envelope instead of a raised constraint so the
  --    service-role caller can branch. Mirrors the hq_capabilities.token shape.
  select t into v_bad_token
  from unnest(v_tokens) as t
  where t !~ '^[a-z0-9]+([._-][a-z0-9]+)*$' or char_length(t) > 120
  limit 1;
  if v_bad_token is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_token', 'token', v_bad_token);
  end if;

  -- 3. Resolve the subject by canonical slug — the registry KEYS to identity, it
  --    never re-derives it. Unknown employee → a clean envelope and NO write.
  select id, permissions, memory_scope
    into v_emp_id, v_permissions, v_memory_scope
  from public.ai_employees
  where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_employee', 'slug', p_slug);
  end if;

  -- 4. DEFINE every requested token in the catalogue if it is not already there.
  --    New tokens authored through the tools surface are tool permissions; tokens
  --    that already exist keep their kind (ON CONFLICT DO NOTHING), so a known scope
  --    like 'read' stays a scope and mirrors back to permissions.scopes.
  insert into public.hq_capabilities (token, kind, created_by_id, created_by_email)
  select t, 'tool_permission', p_actor_id, p_actor_email
  from unnest(v_tokens) as t
  on conflict (token) do nothing;

  -- 5. Split the authored set by catalogue kind for the parity-faithful legacy
  --    mirror: scopes → permissions.scopes; everything else (tool permissions and
  --    forward-compat api scopes) → tools_allowed. The two halves PARTITION v_tokens,
  --    so their UNION — exactly what legacyAuthorityOf() resolves — equals the grant's
  --    token array (the Migration Parity Rule).
  select
    coalesce(array_agg(c.token order by c.token) filter (where c.kind <> 'scope'), '{}'::text[]),
    coalesce(array_agg(c.token order by c.token) filter (where c.kind =  'scope'), '{}'::text[])
    into v_tool_tokens, v_scope_tokens
  from public.hq_capabilities c
  where c.token = any(v_tokens);

  -- 6. UPSERT the employee-scoped grant — TOKENS ONLY. An existing grant (the R2
  --    backfill created one per employee) keeps its posture, memory_scope, budget,
  --    registration and immutable audit trail untouched. A grant created here for an
  --    employee the backfill never saw seeds posture + memory_scope from the retained
  --    legacy model (same formula as the backfill), so a fresh grant is born already
  --    in parity. Either way the execution lock is PRESERVED — LR1 never unlocks it.
  update public.hq_capability_grants
     set tokens = v_tokens
   where scope_level = 'employee' and scope_key = p_slug
  returning id into v_grant_id;

  if found then
    v_action := 'updated';
  else
    v_can_execute       := coalesce((v_permissions -> 'can_execute') = 'true'::jsonb, false);
    v_requires_approval := ((v_permissions -> 'requires_approval') is distinct from 'false'::jsonb);
    begin
      insert into public.hq_capability_grants
        (scope_level, scope_key, tokens, can_execute, requires_approval,
         memory_scope, created_by_id, created_by_email)
      values
        ('employee', p_slug, v_tokens, v_can_execute, v_requires_approval,
         coalesce(v_memory_scope, 'isolated'), p_actor_id, p_actor_email)
      returning id into v_grant_id;
      v_action := 'created';
    exception when unique_violation then
      -- A concurrent author won the insert race; apply our tokens to its row.
      update public.hq_capability_grants
         set tokens = v_tokens
       where scope_level = 'employee' and scope_key = p_slug
      returning id into v_grant_id;
      v_action := 'updated';
    end;
  end if;

  -- 7. MIRROR to the RETAINED legacy model in the SAME transaction (continued legacy
  --    mirroring — LR1 does not stop the dual write). Replaces only the token halves;
  --    preserves can_execute / requires_approval (posture) and memory_scope. The
  --    ai_employees touch trigger stamps updated_at.
  update public.ai_employees
     set tools_allowed = v_tool_tokens,
         permissions   = coalesce(permissions, '{}'::jsonb)
                         || jsonb_build_object('scopes', to_jsonb(v_scope_tokens))
   where id = v_emp_id;

  -- 8. Success envelope — the house style of the reference engines (a "no row" is
  --    never a composite of all-null columns over PostgREST).
  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'slug', p_slug,
    'grant_id', v_grant_id,
    'tokens', to_jsonb(v_tokens),
    'tools_allowed', to_jsonb(v_tool_tokens),
    'scopes', to_jsonb(v_scope_tokens)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Lock down EXECUTE — service-role only (the registry's entry-point posture).
-- ---------------------------------------------------------------------------
revoke all on function public.hq_author_employee_capabilities(text, text[], uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_author_employee_capabilities(text, text[], uuid, text)
  to service_role;

-- Documentation only follows: nothing below this line changes schema or behaviour.
comment on function public.hq_author_employee_capabilities(text, text[], uuid, text) is
  'CrewFlow HQ Capability Registry LR1 (Directive #015 / D-05): registry-native capability authoring. The atomic, service-role-only write path that defines requested tokens in the catalogue, upserts the employee-scoped grant (tokens only — posture and memory_scope preserved), and mirrors the parity-faithful split (scopes vs tools) to the retained legacy ai_employees model, all in one transaction. Removes nothing; audited via admin_activity_log at the call site.';
