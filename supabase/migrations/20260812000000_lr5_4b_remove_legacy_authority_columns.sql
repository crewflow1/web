-- CrewFlow HQ — LR5.4B: remove the legacy authority columns (CEO Directive #015 /
-- D-05, Legacy Removal increment 5.4B — the FINAL implementation increment of the
-- Capability Registry directive).
--
-- ADR: docs/bible/decisions/0010-capability-registry.md (Accepted).
-- Authorising standard (Kernel Contract Map §2): the **Legacy Independence Rule (28th)**,
-- set by the CEO on the LR5.4A review — "Physical legacy structures may only be removed
-- after they have become completely independent of runtime execution. Independence
-- requires: no write dependencies, no read dependencies, no hidden SQL dependencies, no
-- rollback dependencies, no operational dependencies. Deletion is authorised only after
-- independence has been independently demonstrated and reviewed." This migration performs
-- the removal that independence authorises, sequenced last by the **Data Removal Rule
-- (26th)** ("physical deletion comes last") and gated by the **Hidden Read Path Rule
-- (27th)** ("every SQL reader migrated BEFORE the drop").
--
-- THE FIVE INDEPENDENCE FACES, each banked by a prior increment, are why the drop is safe:
--   * no WRITE dependency      — LR5.1 retired the capability mirror; the columns went inert.
--   * no READ dependency       — LR5.2 migrated every application read onto the served registry.
--   * no ROLLBACK dependency   — LR5.3 retired CAPABILITY_AUTHORITY_SOURCE=legacy; the runtime
--                                fail-safe is the default-deny floor, not a legacy model.
--   * no HIDDEN-SQL dependency  — LR5.4A migrated hq_memory_write onto the registry; THIS
--                                migration migrates the last two SQL readers (the authoring
--                                RPCs below) and drops the obsolete parity oracle, so AFTER it
--                                no database object names tools_allowed / permissions.
--   * no OPERATIONAL dependency — the memory benchmark fixture seed was severed from the
--                                permissions column in the same change set.
--
-- WHAT THIS MIGRATION DOES, in dependency-then-removal order:
--   1. RE-POINTS public.hq_author_employee_capabilities(...) off ai_employees.permissions
--      (the fresh-grant posture is seeded from the deny floor instead). memory_scope — which
--      SURVIVES — is still read to seed a fresh grant's scope.
--   2. RE-POINTS public.hq_author_employee_memory_scope(...) off ai_employees.permissions /
--      tools_allowed (the fresh-grant tokens + posture are seeded from the deny floor). The
--      surviving memory_scope mirror write is PRESERVED — memory_scope is shared data the
--      platform still reads, and is OUT OF SCOPE for this drop.
--   3. DROPS the obsolete parity oracle public.hq_capability_registry_parity() — it compared
--      the registry to the legacy columns; with the columns gone there is nothing to compare,
--      so it is "obsolete parity oracle" on the CEO's remove list.
--   4. DROPS the columns: alter table public.ai_employees drop tools_allowed, drop permissions.
--
-- BEHAVIOUR-PRESERVING — the re-points change NO served or authored behaviour. The legacy
-- seeding the two RPCs removed fired ONLY on the fresh-grant ("created") branch — reached only
-- for an employee with no employee-scoped grant. The LR5.1 backfill created one grant per
-- seeded employee, so the live roster always takes the "updated" branch and never touched the
-- removed code. And for a genuinely new employee the seed is identically the deny floor anyway:
-- a Phase-1 employee is created default-locked (Directive 001 — permissions can_execute=false,
-- requires_approval=true, scopes=[]; tools_allowed={}), so resolving that legacy default and
-- using the floor constant yield the SAME grant. No production employee is affected.
--
-- WHAT THIS MIGRATION PRESERVES (the CEO's explicit preserve list):
--   * migration history + every historical migration — untouched (nothing is edited or deleted;
--     the seeds that populate tools_allowed / permissions still run, in order, while the columns
--     exist, BEFORE this migration drops them on a fresh reset);
--   * audit history — admin_activity_log, hq_memory_events and the immutable grant audit trail
--     are untouched;
--   * production-confidence evidence — the registry confidence audit (auditRegistryConfidence)
--     remains, now measuring registry serving HEALTH (no legacy baseline to compare against);
--   * ai_employees.memory_scope + ai_employees.department — both REMAIN (shared platform data),
--     with the memory_scope mirror still written atomically by RPC #2.
--
-- Security posture — RLS:hq. Both re-pointed functions stay SECURITY DEFINER with a pinned
-- empty search_path; EXECUTE revoked from public/anon/authenticated and granted only to
-- service_role. Re-stated below so this migration is a self-contained, auditable statement.

-- ---------------------------------------------------------------------------
-- 1. Re-point hq_author_employee_capabilities — OFF ai_employees.permissions.
--    Byte-for-byte identical to LR5.1 (20260810000000) EXCEPT: the subject read no
--    longer selects `permissions` (only the surviving `memory_scope`), and the
--    fresh-grant posture is seeded from the deny floor instead of permissions.scopes /
--    can_execute / requires_approval. The catalogue-kind split (step 5) reads the
--    catalogue (hq_capabilities), never the legacy columns, so the return envelope is
--    unchanged. The execution lock is never written (Directive 001).
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
  v_memory_scope       text;
  v_can_execute        boolean;
  v_requires_approval  boolean;
  v_tool_tokens        text[];
  v_scope_tokens       text[];
  v_grant_id           uuid;
  v_action             text;
begin
  -- 1. Normalise the requested set to sorted-distinct, dropping NULL/blank tokens.
  v_tokens := coalesce(
    (select array_agg(distinct t order by t)
       from unnest(p_tokens) as t
      where t is not null and char_length(t) > 0),
    '{}'::text[]
  );

  -- 2. Defensive token-format check — a clean envelope, not a raised constraint.
  select t into v_bad_token
  from unnest(v_tokens) as t
  where t !~ '^[a-z0-9]+([._-][a-z0-9]+)*$' or char_length(t) > 120
  limit 1;
  if v_bad_token is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_token', 'token', v_bad_token);
  end if;

  -- 3. Resolve the subject by canonical slug. LR5.4B severed the legacy `permissions`
  --    read (the Hidden Read Path Rule, 27th) — only the SURVIVING `memory_scope` is read,
  --    to seed a FRESH grant's scope (step 6). Unknown employee → clean envelope, NO write.
  select memory_scope
    into v_memory_scope
  from public.ai_employees
  where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_employee', 'slug', p_slug);
  end if;

  -- 4. DEFINE every requested token in the catalogue if not already present.
  insert into public.hq_capabilities (token, kind, created_by_id, created_by_email)
  select t, 'tool_permission', p_actor_id, p_actor_email
  from unnest(v_tokens) as t
  on conflict (token) do nothing;

  -- 5. Split the authored set by catalogue kind (reads hq_capabilities, NOT the legacy
  --    columns): scopes → permissions.scopes; everything else → tools_allowed. Still
  --    computed — it backs the return envelope the admin activity log records.
  select
    coalesce(array_agg(c.token order by c.token) filter (where c.kind <> 'scope'), '{}'::text[]),
    coalesce(array_agg(c.token order by c.token) filter (where c.kind =  'scope'), '{}'::text[])
    into v_tool_tokens, v_scope_tokens
  from public.hq_capabilities c
  where c.token = any(v_tokens);

  -- 6. UPSERT the employee-scoped grant — TOKENS ONLY (the authoritative write). An existing
  --    grant keeps its posture, memory_scope, budget, registration and audit trail untouched.
  --    A grant created here for an employee the backfill never saw seeds posture from the DENY
  --    FLOOR (LR5.4B — no legacy permissions to read) and memory_scope from the surviving
  --    column. The execution lock is PRESERVED — authoring never unlocks it (Directive 001).
  update public.hq_capability_grants
     set tokens = v_tokens
   where scope_level = 'employee' and scope_key = p_slug
  returning id into v_grant_id;

  if found then
    v_action := 'updated';
  else
    -- Deny floor: a fresh Phase-1 grant is born locked (Directive 001). This is identical
    -- to the value the retired legacy seeding produced for a default-locked new employee.
    v_can_execute       := false;
    v_requires_approval := true;
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

  -- 7. Success envelope — the parity-faithful split is still reported (catalogue-sourced),
  --    even though no legacy column is written.
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

revoke all on function public.hq_author_employee_capabilities(text, text[], uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_author_employee_capabilities(text, text[], uuid, text)
  to service_role;

comment on function public.hq_author_employee_capabilities(text, text[], uuid, text) is
  'CrewFlow HQ Capability Registry LR5.4B (Directive #015 / D-05): registry-native capability authoring, re-pointed OFF the legacy ai_employees.permissions column (the Legacy Independence Rule, 28th; the Hidden Read Path Rule, 27th). The atomic, service-role-only write path defines requested tokens in the catalogue and upserts the employee-scoped grant (tokens only — posture + memory_scope preserved); a fresh grant''s posture is seeded from the deny floor, identical to the default-locked legacy value it replaced. Reads no dropped column; audited via admin_activity_log at the call site.';

-- ---------------------------------------------------------------------------
-- 2. Re-point hq_author_employee_memory_scope — OFF ai_employees.permissions /
--    tools_allowed. Identical to LR2 (20260809000000) EXCEPT: the subject read is now
--    identity-only (just e.id, for the surviving memory_scope mirror write), and the
--    fresh-grant branch seeds TOKENS + posture from the deny floor instead of the legacy
--    token union — so it no longer reads the dropped columns nor needs the catalogue
--    pre-seed (an empty token set is trivially valid against the R1 validate trigger).
--    The memory_scope mirror (step 4) is PRESERVED — that column SURVIVES LR5.4B.
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
  v_emp_id    uuid;
  v_grant_id  uuid;
  v_action    text;
begin
  -- 1. Validate the requested scope against the fixed memory-scope vocabulary.
  if p_memory_scope is null
     or p_memory_scope not in ('isolated', 'department', 'organization', 'global') then
    return jsonb_build_object(
      'ok', false, 'reason', 'invalid_memory_scope', 'memory_scope', p_memory_scope
    );
  end if;

  -- 2. Resolve the subject by canonical slug — IDENTITY ONLY. LR5.4B severed the legacy
  --    authority reads (permissions / tools_allowed — the Hidden Read Path Rule, 27th); a
  --    fresh grant is seeded from the deny floor below, not from the dropped columns. We keep
  --    e.id solely for the surviving memory_scope mirror (step 4). Unknown → clean envelope.
  select e.id
    into v_emp_id
  from public.ai_employees e
  where e.slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_employee', 'slug', p_slug);
  end if;

  -- 3. UPSERT the employee-scoped grant — MEMORY_SCOPE ONLY. An existing grant (the backfill
  --    created one per seeded employee) keeps its tokens, posture, budget, registration and
  --    audit trail untouched; only memory_scope moves. A grant created here for an employee the
  --    backfill never saw is born at the DENY FLOOR — no tokens, locked posture (Directive 001)
  --    — taking the authored memory_scope. (Identical to the value the retired legacy seeding
  --    produced for a default-locked new employee, so behaviour is preserved.)
  update public.hq_capability_grants
     set memory_scope = p_memory_scope
   where scope_level = 'employee' and scope_key = p_slug
  returning id into v_grant_id;

  if found then
    v_action := 'updated';
  else
    begin
      insert into public.hq_capability_grants
        (scope_level, scope_key, tokens, can_execute, requires_approval,
         memory_scope, created_by_id, created_by_email)
      values
        ('employee', p_slug, '{}'::text[], false, true,
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

  -- 4. MIRROR to the SURVIVING ai_employees.memory_scope in the SAME transaction (the Mirror
  --    Integrity Rule's deterministic, atomic mirror). memory_scope is shared platform data,
  --    OUT OF SCOPE for the LR5.4B drop, so this dual write is PRESERVED. The touch trigger
  --    stamps updated_at.
  update public.ai_employees
     set memory_scope = p_memory_scope
   where id = v_emp_id;

  -- 5. Success envelope.
  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'slug', p_slug,
    'grant_id', v_grant_id,
    'memory_scope', p_memory_scope
  );
end;
$$;

revoke all on function public.hq_author_employee_memory_scope(text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_author_employee_memory_scope(text, text, uuid, text)
  to service_role;

comment on function public.hq_author_employee_memory_scope(text, text, uuid, text) is
  'CrewFlow HQ Capability Registry LR5.4B (Directive #015 / D-05): registry-native memory-scope authoring, re-pointed OFF the legacy ai_employees.permissions / tools_allowed columns (the Legacy Independence Rule, 28th; the Hidden Read Path Rule, 27th). The atomic, service-role-only write path upserts the employee-scoped grant (memory_scope only — tokens + posture preserved) and mirrors the new memory_scope to the SURVIVING ai_employees.memory_scope column, in one transaction (the Mirror Integrity Rule). A fresh grant is born at the deny floor. Reads no dropped column; audited via admin_activity_log at the call site.';

-- ---------------------------------------------------------------------------
-- 3. Drop the obsolete parity oracle. hq_capability_registry_parity() compared the
--    registry grant to the legacy ai_employees authority (tokens, posture, memory_scope)
--    and reported parity_ok. With the legacy authority columns removed there is no
--    baseline to compare against, so the oracle is obsolete (the CEO's "obsolete parity
--    oracle"). It is `language sql` and names the dropped columns, so it MUST go before
--    the drop. Its only callers were the registry test suites, updated in lockstep.
-- ---------------------------------------------------------------------------
drop function if exists public.hq_capability_registry_parity();

-- ---------------------------------------------------------------------------
-- 4. Drop the legacy authority columns. Every reader is now independent (the five faces
--    above), so the physical structures may be removed (the Legacy Independence Rule, 28th;
--    sequenced last by the Data Removal Rule, 26th). memory_scope and department REMAIN.
-- ---------------------------------------------------------------------------
alter table public.ai_employees
  drop column tools_allowed,
  drop column permissions;
