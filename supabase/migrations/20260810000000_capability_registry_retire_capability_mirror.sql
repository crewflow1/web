-- CrewFlow HQ — The Capability Registry, LR5.1: Retire the Capability Mirror
-- (CEO Directive #015 / D-05, Legacy Removal increment 5.1).
--
-- ADR: docs/bible/decisions/0010-capability-registry.md (Accepted).
-- Proposal: docs/bible/governance/directive-015-lr5-legacy-removal-sequence-proposal.md
-- (reviewed + approved). Governing standards (Kernel Contract Map §2): the Single
-- Source of Authority Rule (13th), the Behaviour Preservation Rule (15th), the
-- Rollback Readiness Rule (17th), the Evidence Before Deletion Rule (18th), the
-- Retirement Readiness Rule (22nd — this increment runs only after the readiness gate
-- was met and independently reviewed), and — first and foremost — the **Removal
-- Sequencing Rule (23rd): "First remove writes."** LR5.1 is that first step.
--
-- WHAT LR5.1 IS. R1–R4 stood the registry up and made it the AUTHORITATIVE runtime
-- source; LR1–LR3 made it the AUTHORITATIVE writer (the authoring RPC, with the legacy
-- columns kept only as a derived mirror) and moved every served dimension onto the
-- registry; LR4 banked the production-confidence evidence. The legacy
-- `ai_employees.tools_allowed` / `permissions` columns now survive ONLY as a derived
-- mirror retained for rollback and parity — a compatibility layer. LR5.1 takes the
-- safest first teardown step (the Removal Sequencing Rule): it STOPS the authoring
-- path from writing that mirror, so the two columns go INERT — frozen at their last
-- value, written by nothing, still readable.
--
-- WHAT THIS MIGRATION DOES. It `create or replace`s the authoring RPC
-- public.hq_author_employee_capabilities(...) with a body IDENTICAL to the LR1
-- definition (migration 20260808000000) EXCEPT that the final step — the
-- `update public.ai_employees set tools_allowed = …, permissions = …` legacy mirror —
-- is REMOVED. Everything else is preserved exactly:
--   1. normalise the requested token set to sorted-distinct;
--   2. defensively format-check each token (clean envelope, not a raised constraint);
--   3. resolve the subject by canonical slug (unknown → clean envelope, no write);
--   4. DEFINE any new token in the catalogue (`hq_capabilities`);
--   5. SPLIT the authored set by catalogue kind (still computed — it backs the return
--      envelope the admin audit records; it is simply no longer written to a column);
--   6. UPSERT the employee-scoped grant — TOKENS ONLY (the authoritative write);
--   7. return the success envelope (with the parity-faithful split, unchanged).
-- (The LR1 declaration `v_emp_id` is dropped: its ONLY consumer was the mirror UPDATE,
-- which is gone. The subject still must exist — step 3's `if not found` still guards —
-- and a fresh grant still seeds its posture + memory_scope from the legacy row.)
--
-- WHAT LR5.1 DELIBERATELY does NOT do (the CEO's explicit do-not list for LR5.1):
--   * does NOT remove any legacy column — `ai_employees.tools_allowed` /
--     `permissions` / `memory_scope` all REMAIN (now inert for the two token columns);
--   * does NOT remove the MEMORY-SCOPE mirror — `hq_author_employee_memory_scope`
--     (migration 20260809000000) is untouched; `memory_scope` is shared data still
--     read by the platform, so its mirror stays (the Behaviour Preservation Rule);
--   * does NOT remove the legacy read helpers — `resolveEmployeeCapabilities` /
--     `resolveEmployeePosture` (and the parity bridge) REMAIN, reading the now-frozen
--     columns for rollback + parity (the CEO's "preserve legacy reads" instruction);
--   * does NOT retire rollback — `CAPABILITY_AUTHORITY_SOURCE=legacy` still works (a
--     later, separately-authorised increment retires it — the 2nd step of the 23rd);
--   * does NOT stop parity verification — `hq_capability_registry_parity()` and
--     `verifyRegistryParity` REMAIN (parity for a re-authored employee will now show
--     the registry DIVERGING from the frozen legacy columns: that divergence is the
--     EXPECTED, benign signature of the retired mirror, not a regression);
--   * does NOT remove the confidence audit — `auditRegistryConfidence` REMAINS;
--   * does NOT change runtime authority — the registry already serves every dimension
--     (R4/LR3); freezing the columns changes NO served behaviour;
--   * does NOT change posture — `can_execute` is never written (Directive 001);
--   * does NOT mark Directive #015 complete — contract #8 stays Reserved.
--
-- Security posture — RLS:hq. Unchanged from LR1: SECURITY DEFINER, pinned empty
-- search_path; EXECUTE revoked from public/anon/authenticated, granted only to
-- service_role. Re-stated below so this migration is self-contained.

-- ---------------------------------------------------------------------------
-- 1. Redefine the authoring entry point — WITHOUT the legacy mirror.
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
  --    value returned is the value persisted.
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
  --    never re-derives it. Unknown employee → a clean envelope and NO write. We read
  --    permissions + memory_scope to seed the posture of a FRESH grant (step 6); the
  --    employee id is no longer needed (the mirror that consumed it is retired).
  select permissions, memory_scope
    into v_permissions, v_memory_scope
  from public.ai_employees
  where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_employee', 'slug', p_slug);
  end if;

  -- 4. DEFINE every requested token in the catalogue if it is not already there.
  --    New tokens authored through the tools surface are tool permissions; tokens
  --    that already exist keep their kind (ON CONFLICT DO NOTHING), so a known scope
  --    like 'read' stays a scope and is reported back under permissions.scopes.
  insert into public.hq_capabilities (token, kind, created_by_id, created_by_email)
  select t, 'tool_permission', p_actor_id, p_actor_email
  from unnest(v_tokens) as t
  on conflict (token) do nothing;

  -- 5. Split the authored set by catalogue kind: scopes → permissions.scopes;
  --    everything else (tool permissions and forward-compat api scopes) → tools_allowed.
  --    The two halves PARTITION v_tokens, so their UNION equals the grant's token array.
  --    LR5.1 STILL computes the split — it backs the return envelope (step 7) the admin
  --    activity log records — but it NO LONGER writes the split to ai_employees: the
  --    legacy mirror is retired (the Removal Sequencing Rule, "first remove writes").
  select
    coalesce(array_agg(c.token order by c.token) filter (where c.kind <> 'scope'), '{}'::text[]),
    coalesce(array_agg(c.token order by c.token) filter (where c.kind =  'scope'), '{}'::text[])
    into v_tool_tokens, v_scope_tokens
  from public.hq_capabilities c
  where c.token = any(v_tokens);

  -- 6. UPSERT the employee-scoped grant — TOKENS ONLY. This is the AUTHORITATIVE write
  --    (the Single Source of Authority Rule). An existing grant keeps its posture,
  --    memory_scope, budget, registration and immutable audit trail untouched. A grant
  --    created here for an employee the backfill never saw seeds posture + memory_scope
  --    from the legacy model (same formula as the backfill). Either way the execution
  --    lock is PRESERVED — authoring never unlocks it.
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

  -- (LR1 step 7 — the legacy ai_employees mirror — is REMOVED here. The columns
  --  tools_allowed / permissions are now INERT: written by nothing, frozen at their
  --  last value, retained and still read for rollback + parity.)

  -- 7. Success envelope — the house style of the reference engines. The parity-faithful
  --    split is still reported (the admin activity log records it), even though it is no
  --    longer mirrored to a column.
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
-- 2. Lock down EXECUTE — service-role only (unchanged; re-stated for self-containment).
-- ---------------------------------------------------------------------------
revoke all on function public.hq_author_employee_capabilities(text, text[], uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_author_employee_capabilities(text, text[], uuid, text)
  to service_role;

-- Documentation only follows: nothing below this line changes schema or behaviour.
comment on function public.hq_author_employee_capabilities(text, text[], uuid, text) is
  'CrewFlow HQ Capability Registry LR5.1 (Directive #015 / D-05): registry-native capability authoring with the legacy mirror RETIRED. The atomic, service-role-only write path defines requested tokens in the catalogue and upserts the employee-scoped grant (tokens only — posture and memory_scope preserved); it NO LONGER mirrors to ai_employees.tools_allowed / permissions (those columns are now inert, retained for rollback + parity). The memory_scope mirror, the legacy read helpers, rollback, parity tooling and the confidence audit all remain. Removes no column; audited via admin_activity_log at the call site. The first step of the Removal Sequencing Rule (23rd): "first remove writes".';
