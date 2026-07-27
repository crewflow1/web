-- CrewFlow HQ — The Capability Registry, LR2: Registry-Native Memory Scope
-- (CEO Directive #015 / D-05, Legacy Removal increment 2).
--
-- ADR: docs/bible/decisions/0010-capability-registry.md (Accepted).
-- Governing standards (Kernel Contract Map §2): the Single Source of Authority Rule
-- (13th), the Migration Parity Rule (14th), the Behaviour Preservation Rule (15th),
-- the Shadow Validation Rule (16th), the Rollback Readiness Rule (17th), the Evidence
-- Before Deletion Rule (18th), and — the headline rule for this increment — the
-- Mirror Integrity Rule (19th, set on the LR1 review): "Whenever data is mirrored
-- between an authoritative model and a compatibility model, the mirror must be treated
-- as a derived representation. The derived representation must never be edited directly.
-- Only the authoritative model may accept user-initiated writes. Mirror updates must be
-- deterministic, atomic, and reproducible."
--
-- WHAT LR2 IS. LR1 gave the registry a native write path for the token SET and routed
-- the admin tokens editor through it, while continuing to mirror to the retained legacy
-- columns. But one administrative authority write was still going DIRECT to the legacy
-- model: updateAiEmployeeConfig wrote ai_employees.memory_scope straight to the
-- compatibility column and NEVER re-synced the registry grant. That is exactly the
-- breach the Mirror Integrity Rule names — a user-initiated write editing the derived
-- representation — and it is a latent parity drift: hq_capability_registry_parity()
-- compares grant.memory_scope to ai_employees.memory_scope, so a direct legacy edit
-- silently diverges the grant the R2 backfill seeded. LR2 closes that last direct path:
-- memory_scope is now authored AT the registry, deterministically and atomically
-- mirrored to the retained legacy column, exactly as LR1 did for tokens.
--
-- What this migration creates:
--   public.hq_author_employee_memory_scope(p_slug, p_memory_scope, p_actor_id,
--   p_actor_email) — a single SECURITY DEFINER, service-role-only RPC that performs the
--   WHOLE memory-scope authoring act ATOMICALLY in one transaction (supabase-js has no
--   client-side multi-statement transaction — CEO decision D1 — so only an RPC can make
--   the registry write and the legacy mirror succeed or fail together, leaving no
--   divergence window — the Mirror Integrity Rule's "deterministic, atomic"). In order it:
--     1. validates the requested scope against the fixed memory-scope vocabulary (a clean
--        envelope, not a raised constraint, for the service-role caller to branch on);
--     2. resolves the subject by canonical slug (unknown → clean envelope, no write);
--     3. UPSERTS the employee-scoped grant — MEMORY_SCOPE ONLY;
--     4. MIRRORS the new memory_scope back to the retained legacy column.
--
-- The PARITY contract (the Migration Parity + Behaviour Preservation + Mirror Integrity
-- Rules). memory_scope is one of the four dimensions hq_capability_registry_parity()
-- compares. By writing the grant and the legacy column to the SAME value in one
-- transaction, the two sides stay equal, so the parity oracle keeps reporting parity_ok
-- — and LR2 actually REPAIRS the drift the old direct-write path could open. Tokens and
-- posture (can_execute / requires_approval) are PRESERVED on both sides, so all four
-- compared dimensions stay equal and continuous shadow verification keeps passing.
--
-- A grant created here for an employee the R2 backfill never saw (a backfill gap) is
-- born already in parity: its tokens are seeded from the retained legacy union and its
-- posture from the retained legacy permissions — with the EXACT normalisation the R2
-- backfill and the parity oracle use — and it takes the authored memory_scope, which is
-- mirrored to the legacy column in the same transaction. To keep that fresh grant valid
-- against the R1 validate trigger (tokens ⊆ hq_capabilities), the seeded legacy tokens
-- are first defined in the catalogue, idempotently and with the SAME classification the
-- R2 backfill uses — recording tokens the employee ALREADY HOLDS in the legacy model,
-- never granting new authority.
--
-- What LR2 DELIBERATELY does NOT do (the CEO's explicit do-not list for LR2):
--   * does NOT remove any legacy column — ai_employees.memory_scope (and tools_allowed /
--     permissions) remain and are still mirrored;
--   * does NOT remove rollback — CAPABILITY_AUTHORITY_SOURCE=legacy still works;
--   * does NOT remove parity tooling — the R2 parity function + the runtime shadow remain;
--   * does NOT remove migration monitoring — the R2 backfill stays in place;
--   * does NOT change runtime authority resolution — the R4 resolver is untouched
--     (memory_scope is still SERVED from the legacy model; LR2 changes only the WRITE
--     path, so "preserve runtime behaviour" and "do not change runtime authority
--     resolution" both hold);
--   * does NOT change posture — can_execute stays exactly where the legacy model has it
--     (LR2 authors memory_scope, never the execution lock — Directive 001).
--
-- Security posture — RLS:hq. The function is SECURITY DEFINER with a pinned empty
-- search_path; EXECUTE is revoked from public/anon/authenticated and granted only to
-- service_role, so it is reachable only through the service-role admin client behind the
-- superadmin-gated server action. No tenant table is touched.

-- ---------------------------------------------------------------------------
-- 1. The memory-scope authoring entry point.
-- ---------------------------------------------------------------------------
create or replace function public.hq_author_employee_memory_scope(
  p_slug         text,
  p_memory_scope text,
  p_actor_id     uuid default null,
  p_actor_email  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emp_id             uuid;
  v_permissions        jsonb;
  v_tokens             text[];
  v_can_execute        boolean;
  v_requires_approval  boolean;
  v_grant_id           uuid;
  v_action             text;
begin
  -- 1. Validate the requested scope against the fixed memory-scope vocabulary. The
  --    grant + legacy CHECK constraints are the hard backstop; this returns a clean
  --    envelope (not a raised constraint) so the service-role caller can branch. Mirrors
  --    the MEMORY_SCOPES vocabulary (lib/ai-employees/model.ts).
  if p_memory_scope is null
     or p_memory_scope not in ('isolated', 'department', 'organization', 'global') then
    return jsonb_build_object(
      'ok', false, 'reason', 'invalid_memory_scope', 'memory_scope', p_memory_scope
    );
  end if;

  -- 2. Resolve the subject by canonical slug — the registry KEYS to identity, it never
  --    re-derives it — and read the legacy authority a FRESH grant must be seeded from so
  --    a grant born here is born in parity: the token union and the posture, computed with
  --    the EXACT normalisation the R2 backfill and the parity oracle use. Unknown employee
  --    → a clean envelope and NO write.
  select
    e.id,
    e.permissions,
    coalesce(
      (select array_agg(distinct tok order by tok)
       from (
         select unnest(e.tools_allowed) as tok
         union
         select jsonb_array_elements_text(e.permissions -> 'scopes')
       ) s
       where tok is not null and length(tok) > 0),
      '{}'::text[]
    )
    into v_emp_id, v_permissions, v_tokens
  from public.ai_employees e
  where e.slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_employee', 'slug', p_slug);
  end if;

  -- 3. UPSERT the employee-scoped grant — MEMORY_SCOPE ONLY. An existing grant (the R2
  --    backfill created one per employee) keeps its tokens, posture, budget, registration
  --    and immutable audit trail untouched; only memory_scope moves. A grant created here
  --    for an employee the backfill never saw seeds tokens + posture from the retained
  --    legacy model (same formula as the backfill) and takes the authored memory_scope,
  --    so a fresh grant is born already in parity. Either way the execution lock is
  --    PRESERVED — LR2 authors memory_scope, never posture (Directive 001).
  update public.hq_capability_grants
     set memory_scope = p_memory_scope
   where scope_level = 'employee' and scope_key = p_slug
  returning id into v_grant_id;

  if found then
    v_action := 'updated';
  else
    -- Define the seeded legacy tokens in the catalogue first (idempotently), so the
    -- fresh grant satisfies the R1 validate trigger (tokens ⊆ hq_capabilities). Classify
    -- exactly as the R2 backfill does — a token is a tool_permission if it appears in any
    -- tools_allowed, else a scope — so a later LR1 re-author mirrors it back faithfully.
    -- These tokens are ALREADY HELD by the employee in the legacy model; this records
    -- them, it does not grant new authority.
    insert into public.hq_capabilities (token, kind, created_by_id, created_by_email)
    select
      s.tok,
      case when bool_or(s.is_tool) then 'tool_permission' else 'scope' end,
      p_actor_id, p_actor_email
    from (
      select unnest(e.tools_allowed) as tok, true as is_tool
      from public.ai_employees e where e.id = v_emp_id
      union all
      select jsonb_array_elements_text(e.permissions -> 'scopes') as tok, false as is_tool
      from public.ai_employees e where e.id = v_emp_id
    ) s
    where s.tok is not null and length(s.tok) > 0
    group by s.tok
    on conflict (token) do nothing;

    v_can_execute       := coalesce((v_permissions -> 'can_execute') = 'true'::jsonb, false);
    v_requires_approval := ((v_permissions -> 'requires_approval') is distinct from 'false'::jsonb);
    begin
      insert into public.hq_capability_grants
        (scope_level, scope_key, tokens, can_execute, requires_approval,
         memory_scope, created_by_id, created_by_email)
      values
        ('employee', p_slug, v_tokens, v_can_execute, v_requires_approval,
         p_memory_scope, p_actor_id, p_actor_email)
      returning id into v_grant_id;
      v_action := 'created';
    exception when unique_violation then
      -- A concurrent author won the insert race; apply our memory_scope to its row.
      update public.hq_capability_grants
         set memory_scope = p_memory_scope
       where scope_level = 'employee' and scope_key = p_slug
      returning id into v_grant_id;
      v_action := 'updated';
    end;
  end if;

  -- 4. MIRROR to the RETAINED legacy model in the SAME transaction (the Mirror Integrity
  --    Rule's deterministic, atomic, reproducible mirror — continued legacy mirroring,
  --    LR2 does not stop the dual write). Replaces only memory_scope; tokens
  --    (tools_allowed / permissions) and posture are untouched. The ai_employees touch
  --    trigger stamps updated_at.
  update public.ai_employees
     set memory_scope = p_memory_scope
   where id = v_emp_id;

  -- 5. Success envelope — the house style of the reference engines (a "no row" is never a
  --    composite of all-null columns over PostgREST).
  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'slug', p_slug,
    'grant_id', v_grant_id,
    'memory_scope', p_memory_scope
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Lock down EXECUTE — service-role only (the registry's entry-point posture).
-- ---------------------------------------------------------------------------
revoke all on function public.hq_author_employee_memory_scope(text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_author_employee_memory_scope(text, text, uuid, text)
  to service_role;

-- Documentation only follows: nothing below this line changes schema or behaviour.
comment on function public.hq_author_employee_memory_scope(text, text, uuid, text) is
  'CrewFlow HQ Capability Registry LR2 (Directive #015 / D-05): registry-native memory-scope authoring. The atomic, service-role-only write path that upserts the employee-scoped grant (memory_scope only — tokens and posture preserved) and deterministically mirrors the new memory_scope to the retained legacy ai_employees column, all in one transaction (the Mirror Integrity Rule). Closes the last direct legacy authoring path (updateAiEmployeeConfig). Removes nothing; audited via admin_activity_log at the call site.';
