-- CrewFlow HQ — The Capability Registry, R2: Backfill + Parity Gate (CEO Directive #015 / D-05).
--
-- ADR: docs/bible/decisions/0010-capability-registry.md (Accepted), Decision 10
-- (migration strategy) steps 1–3. Governing rule: the Migration Parity Rule
-- (Kernel Contract Map §2, the fourteenth standard, set on the R1 review).
--
-- R2 is the second authorised slice. R1 landed the registry's STORAGE (the two
-- tables, empty, dark). R2 POPULATES that storage from the existing authority
-- data and proves — deterministically and re-runnably — that the registry
-- resolves to the SAME authority the legacy model does, for every live employee.
--
-- What this migration creates:
--   1. POPULATE the catalogue (hq_capabilities) from the live authority data:
--      every distinct token an employee actually holds today — the union of
--      every ai_employees.tools_allowed entry and every permissions.scopes entry.
--   2. POPULATE the grants (hq_capability_grants) as a FLAT MIRROR: exactly one
--      employee-scoped grant per ai_employees row, carrying that employee's own
--      resolved authority — tokens (tools_allowed ∪ scopes), posture
--      (can_execute / requires_approval), and memory_scope.
--   3. a PARITY FUNCTION (public.hq_capability_registry_parity()) — the
--      continuously-verifiable, deterministic check the Migration Parity Rule
--      requires: for every employee it computes the legacy-resolved authority and
--      the registry-resolved authority and reports parity_ok. Re-runnable on
--      demand (ops / CI / the integration tier), it is the registry's standing
--      drift detector during the migration window.
--   4. an IN-MIGRATION PARITY ASSERTION (the fail-closed gate) — a DO block that
--      aborts this migration if ANY employee is out of parity, so the backfill can
--      never land a registry that disagrees with the legacy source.
--
-- WHY A FLAT MIRROR (the parity-safety property — read before "improving" this).
-- The legacy resolution is FLAT and per-employee: resolveEmployeeCapabilities()
-- (server/sdk/tasks.ts) returns sorted-distinct(tools_allowed ∪ permissions.scopes)
-- for that ONE row; there is no inheritance. The registry's inheritance model
-- (global ⊇ organization ⊇ department ⊇ employee — ADR 0010 Decision 5) resolves an
-- employee's tokens as the UNION across all applicable scope levels. So the ONLY
-- backfill that preserves EXACT parity is one that populates the most-specific
-- (employee) level alone: with no higher-scope grants, the union collapses to the
-- employee grant, which equals the legacy set by construction. Factoring common
-- tokens UP to department/organization/global (e.g. "read") would make every
-- employee inherit their scope-mates' tokens — granting authority the legacy model
-- never gave them and BREAKING parity. Factoring is a deliberate, post-migration
-- authoring act (CEO / Boardroom), never a mechanical backfill. R2 mirrors; it does
-- not refactor.
--
-- Because the mirror is employee-only, the employee grant's own posture is also the
-- resolved posture (nothing higher to ratchet approval up or veto execute), and its
-- memory_scope is the resolved memory_scope (most-specific-wins). So comparing the
-- employee grant DIRECTLY to the legacy row is a sound proxy for resolver parity —
-- which is how R2 proves parity WITHOUT a runtime resolver (that seam is R3).
--
-- What this migration DELIBERATELY does NOT do (R2 boundary — the CEO's scope):
--   * NO runtime resolver. The parity function is OFFLINE verification tooling; it
--     is never on the request path and nothing in the SDK/gate calls it. The
--     identity→ResolvedCapabilitySet seam stays in server/sdk/tasks.ts reading
--     ai_employees. R3 repoints it; not here.
--   * NO SDK wiring. ctx, the gate, the facets, ResolvedCapabilitySet, and
--     EmploymentPosture are untouched.
--   * NO removal of legacy authority. The four ai_employees columns
--     (tools_allowed / permissions / memory_scope / department) remain THE
--     authoritative source. This migration only ever READS them — it never ALTERs,
--     UPDATEs, or DROPs ai_employees. The registry is a one-directional MIRROR of
--     the legacy source (Migration Parity Rule: a mirror is never independently
--     authoritative). Mirror-then-drop is a later slice (R4), gated on proven parity.
--   * NO behavioural change. No request-serving authority decision changes. Nothing
--     reads the registry yet; the platform behaves exactly as before.
--   * NO registration / budget. Registration metadata (the four manifest surfaces)
--     and budget defaults are not authority data; collapsing them is a later slice.
--     Backfilled grants leave registration '{}' and budget_default NULL.
--
-- Idempotent. The catalogue insert is ON CONFLICT (token) DO NOTHING; the grants
-- insert is guarded by NOT EXISTS. Re-applying the migration is a safe no-op.

-- ---------------------------------------------------------------------------
-- 1. The parity function — the continuously-verifiable, deterministic check.
--    SECURITY INVOKER (the default): it reads the RLS:hq tables ai_employees and
--    hq_capability_grants, so it runs with the caller's privileges and inherits
--    their RLS — service_role (BYPASSRLS) sees every row; any JWT client sees none.
--    It is NOT a client RPC, so it is neither SECURITY DEFINER nor search_path-pinned
--    (house style); every reference is schema-qualified instead.
--
--    For each employee it derives BOTH resolutions and reports parity:
--      legacy  = the exact output shape of resolveEmployeeCapabilities() +
--                resolveEmployeePosture(): tokens = sorted-distinct(tools_allowed ∪
--                permissions.scopes) with empties dropped; can_execute is true only
--                when the JSON value is literally true; requires_approval is false
--                only when the JSON value is literally false.
--      registry = the employee-scoped grant's stored authority (its tokens are
--                already sorted-distinct by the R1 validate trigger).
-- ---------------------------------------------------------------------------
create or replace function public.hq_capability_registry_parity()
returns table (
  slug                       text,
  has_grant                  boolean,
  legacy_tokens              text[],
  registry_tokens            text[],
  legacy_can_execute         boolean,
  registry_can_execute       boolean,
  legacy_requires_approval   boolean,
  registry_requires_approval boolean,
  legacy_memory_scope        text,
  registry_memory_scope      text,
  parity_ok                  boolean
)
language sql
stable
as $$
  with legacy as (
    select
      e.slug                                                            as slug,
      e.memory_scope                                                    as memory_scope,
      -- can_execute === true  (true only when the JSON value is literally true)
      coalesce((e.permissions -> 'can_execute') = 'true'::jsonb, false) as can_execute,
      -- requires_approval !== false  (false only when the JSON value is literally false)
      ((e.permissions -> 'requires_approval') is distinct from 'false'::jsonb) as requires_approval,
      -- sorted-distinct(tools_allowed ∪ permissions.scopes), empties dropped
      coalesce(
        (select array_agg(distinct tok order by tok)
         from (
           select unnest(e.tools_allowed) as tok
           union
           select jsonb_array_elements_text(e.permissions -> 'scopes')
         ) s
         where tok is not null and length(tok) > 0),
        '{}'::text[]
      ) as tokens
    from public.ai_employees e
  )
  select
    l.slug,
    (g.id is not null)            as has_grant,
    l.tokens                      as legacy_tokens,
    g.tokens                      as registry_tokens,
    l.can_execute                 as legacy_can_execute,
    g.can_execute                 as registry_can_execute,
    l.requires_approval           as legacy_requires_approval,
    g.requires_approval           as registry_requires_approval,
    l.memory_scope                as legacy_memory_scope,
    g.memory_scope                as registry_memory_scope,
    (
      g.id is not null
      and g.tokens is not distinct from l.tokens
      and g.can_execute = l.can_execute
      and g.requires_approval = l.requires_approval
      and g.memory_scope = l.memory_scope
    )                             as parity_ok
  from legacy l
  left join public.hq_capability_grants g
    on g.scope_level = 'employee' and g.scope_key = l.slug;
$$;

-- ---------------------------------------------------------------------------
-- 2. Populate the catalogue (hq_capabilities) from the live authority data.
--    Every distinct token an employee holds today becomes a definition. A token
--    is classified 'tool_permission' if it appears in any tools_allowed, else
--    'scope' (bool_or gives tool_permission precedence for tokens that are both —
--    e.g. 'prioritize', 'triage'). kind is forward-compatible metadata, not used
--    in resolution; the classification only needs to be deterministic.
--    ON CONFLICT (token) DO NOTHING keeps the backfill idempotent.
-- ---------------------------------------------------------------------------
insert into public.hq_capabilities (token, kind)
select
  s.tok,
  case when bool_or(s.is_tool) then 'tool_permission' else 'scope' end
from (
  select unnest(tools_allowed) as tok, true as is_tool
  from public.ai_employees
  union all
  select jsonb_array_elements_text(permissions -> 'scopes') as tok, false as is_tool
  from public.ai_employees
) s
where s.tok is not null and length(s.tok) > 0
group by s.tok
on conflict (token) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Populate the grants (hq_capability_grants) as a FLAT MIRROR — one
--    employee-scoped grant per ai_employees row, carrying that employee's own
--    resolved authority. The R1 validate trigger normalises tokens to
--    sorted-distinct and enforces tokens ⊆ hq_capabilities (satisfied: the
--    catalogue was populated in step 2). NOT EXISTS makes this idempotent.
--    registration and budget_default are intentionally left at their defaults
--    ('{}' and NULL) — they are not authority data and are out of R2 scope.
-- ---------------------------------------------------------------------------
insert into public.hq_capability_grants
  (scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope)
select
  'employee',
  e.slug,
  coalesce(
    (select array_agg(distinct tok order by tok)
     from (
       select unnest(e.tools_allowed) as tok
       union
       select jsonb_array_elements_text(e.permissions -> 'scopes')
     ) s
     where tok is not null and length(tok) > 0),
    '{}'::text[]
  ),
  coalesce((e.permissions -> 'can_execute') = 'true'::jsonb, false),
  ((e.permissions -> 'requires_approval') is distinct from 'false'::jsonb),
  e.memory_scope
from public.ai_employees e
where not exists (
  select 1 from public.hq_capability_grants g
  where g.scope_level = 'employee' and g.scope_key = e.slug
);

-- ---------------------------------------------------------------------------
-- 4. The parity gate — fail closed. The Migration Parity Rule: a legacy source
--    is removed only after parity is demonstrated, and parity must be continuously
--    verifiable. This block demonstrates it AT MIGRATION TIME: if any employee's
--    registry authority does not match the legacy authority, the migration aborts
--    with the offending slugs, so a divergent backfill can never be committed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_mismatched text[];
begin
  select array_agg(p.slug order by p.slug)
    into v_mismatched
  from public.hq_capability_registry_parity() p
  where not p.parity_ok;

  if v_mismatched is not null then
    raise exception
      'Capability Registry R2 backfill parity check FAILED for % employee(s): %',
      cardinality(v_mismatched), v_mismatched
      using errcode = 'data_exception';
  end if;
end;
$$;
