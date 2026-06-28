-- CrewFlow HQ — The Capability Registry, R1: Registry Schema (CEO Directive #015 / D-05).
--
-- ADR: docs/bible/decisions/0010-capability-registry.md (Accepted).
--
-- R1 is the SMALLEST SAFE SLICE the CEO authorised: it lands the registry's
-- STORAGE only. It ships DARK — nothing reads it yet.
--
-- What this migration creates:
--   1. public.hq_capabilities        — the capability DEFINITION table: the
--                                       declarative catalogue of capability tokens
--                                       that exist (a token + its kind + a
--                                       description). The universe a grant draws from.
--   2. public.hq_capability_grants    — the capability GRANT table: a scoped,
--                                       declarative grant of authority — the tokens
--                                       held at a scope, the employment posture, the
--                                       memory scope, the budget default, and (at the
--                                       employee scope) the registration metadata that
--                                       will collapse the four manifest surfaces.
--   3. the inheritance SCOPE MODEL    — four nested levels (global ⊇ organization ⊇
--                                       department ⊇ employee) on the grant, mirroring
--                                       the existing memory_scope vocabulary so the
--                                       platform gains no new hierarchy concept
--                                       (ADR 0010 Decision 5).
--   4. immutable AUDIT FIELDS         — created_at / created_by_id / created_by_email
--                                       are frozen once written (BEFORE UPDATE guard),
--                                       and a grant's scope identity (scope_level,
--                                       scope_key) cannot silently move; updated_at is
--                                       touched on update.
--   5. database CONSTRAINTS           — the default-deny floor mirrored as column
--                                       defaults (can_execute=false,
--                                       requires_approval=true); scope-key shape per
--                                       level; department / employee key vocabularies;
--                                       registration confined to the employee scope;
--                                       and referential integrity of grant tokens to
--                                       the definition catalogue (validated + normalised
--                                       to sorted-distinct by trigger).
--
-- What this migration DELIBERATELY does NOT do (R1 boundary — the CEO's scope):
--   * NO runtime resolver. The identity→ResolvedCapabilitySet seam stays in
--     server/sdk/tasks.ts reading ai_employees. R3 repoints it; not here.
--   * NO SDK wiring. ctx, the gate, the facets, ResolvedCapabilitySet, and
--     EmploymentPosture are untouched.
--   * NO migration away from the legacy columns. ai_employees.tools_allowed /
--     permissions / memory_scope / department remain authoritative. The backfill +
--     parity gate are R2; the seam repoint is R3; surface-collapse is R4.
--   * NO seed / backfill data. This is the schema; populating the catalogue and
--     backfilling grants is a later, parity-gated slice (R2). The tables ship empty.
--
-- Security posture — RLS:hq. Mirroring ai_employees and every hq_* table: RLS is
-- enabled with ZERO policies, so only the Supabase service_role (BYPASSRLS) can
-- read or write. No customer/staff JWT client can ever see authority data. No
-- tenant table is touched, so the change is provably additive.
--
-- The default-deny floor. ADR 0010 Decision 4: the floor is the locked posture
-- { can_execute:false, requires_approval:true, scopes:["read"] } and absence
-- resolves to it. The floor itself is the ABSENCE of a grant (resolved in code at
-- R3, never stored); these column defaults mirror the locked posture so that even
-- an explicitly-inserted grant with no posture stated is locked down by default.

-- ---------------------------------------------------------------------------
-- 1. hq_capabilities — the capability definition catalogue.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_capabilities (
  id            uuid primary key default gen_random_uuid(),

  -- The opaque capability token, matched-not-interpreted at runtime. Tokens look
  -- like a tool permission ('memory.write', 'comm.send'), a scope ('read'), or a
  -- future api scope ('api.openai'). Unique + format-checked; immutable once set
  -- (a rename would orphan grants — add a new token and migrate instead).
  token         text not null unique
                check (token ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
                       and char_length(token) between 1 and 120),

  -- Forward-compatible classification. 'api_scope' keeps the registry
  -- gateway-ready with zero gateway knowledge today (ADR 0010 Decision 9).
  kind          text not null default 'tool_permission'
                check (kind in ('tool_permission', 'scope', 'api_scope')),

  description   text not null default '' check (char_length(description) <= 1000),

  -- Immutable audit fields. created_by_* is a SOFT reference (no FK) so the row
  -- stays immutable even if the user is later deleted — the event spine's
  -- actor-id pattern, the right choice for immutable platform metadata.
  created_at        timestamptz not null default now(),
  created_by_id     uuid,
  created_by_email  text check (created_by_email is null or char_length(created_by_email) <= 320),
  updated_at        timestamptz not null default now()
);

alter table public.hq_capabilities enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------------
-- 2. hq_capability_grants — the scoped grant of authority.
--    Keyed by (scope_level, scope_key); the inheritance scope model lives here.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_capability_grants (
  id            uuid primary key default gen_random_uuid(),

  -- The inheritance scope model — four nested levels mirroring memory_scope
  -- (ADR 0010 Decision 5). scope_key identifies which scope: NULL for global,
  -- the org id for organization, the department for department, the
  -- EmployeeIdentity.slug for employee.
  scope_level   text not null
                check (scope_level in ('global', 'organization', 'department', 'employee')),
  scope_key     text check (scope_key is null or char_length(scope_key) between 1 and 120),

  -- Capability tokens held at this scope. Validated ⊆ hq_capabilities and
  -- normalised to sorted-distinct by a trigger (deterministic, parity-ready).
  -- Empty by default — the floor grants nothing.
  tokens        text[] not null default '{}',

  -- Employment posture — the default-deny floor mirrored as defaults.
  can_execute       boolean not null default false,
  requires_approval boolean not null default true,

  -- Memory scope — non-security metadata; resolves most-specific-wins (Decision 5).
  memory_scope  text not null default 'isolated'
                check (memory_scope in ('isolated', 'department', 'organization', 'global')),

  -- Budget default — the read-only ceiling ctx.budget threads (a NUMBER; the
  -- gateway meters, the registry only supplies the default — Decision 9). NULL =
  -- no explicit ceiling at this scope.
  budget_default numeric(12, 2) check (budget_default is null or budget_default >= 0),

  -- Registration metadata — collapses the four manifest surfaces (schedule / nav
  -- / dashboard / roster). Confined to the employee scope by a constraint below.
  registration  jsonb not null default '{}'::jsonb
                check (jsonb_typeof(registration) = 'object'),

  -- Immutable audit fields (soft author reference, as on hq_capabilities).
  created_at        timestamptz not null default now(),
  created_by_id     uuid,
  created_by_email  text check (created_by_email is null or char_length(created_by_email) <= 320),
  updated_at        timestamptz not null default now(),

  -- scope_key shape: global carries none; every other level must name its scope.
  constraint hq_capability_grants_scope_key_shape check (
    (scope_level = 'global' and scope_key is null)
    or (scope_level <> 'global' and scope_key is not null)
  ),

  -- A department-scoped grant's key must be a known department (mirrors the
  -- ai_employees.department vocabulary exactly).
  constraint hq_capability_grants_department_key check (
    scope_level <> 'department'
    or scope_key in (
      'executive', 'engineering', 'sales', 'marketing', 'design', 'quality',
      'documentation', 'product', 'finance', 'support', 'operations'
    )
  ),

  -- An employee-scoped grant's key must look like an EmployeeIdentity.slug
  -- (mirrors the ai_employees.slug format). The registry KEYS to canonical
  -- identity; it never re-derives it.
  constraint hq_capability_grants_employee_key check (
    scope_level <> 'employee'
    or scope_key ~ '^[a-z0-9-]{1,60}$'
  ),

  -- Registration metadata belongs only to the employee scope (Decision 4).
  constraint hq_capability_grants_registration_scope check (
    scope_level = 'employee' or registration = '{}'::jsonb
  )
);

alter table public.hq_capability_grants enable row level security;
-- NO policies → service-role only.

-- At most ONE global grant; at most ONE grant per (scope_level, scope_key)
-- otherwise. Partial unique indexes handle the NULL global key portably.
create unique index if not exists hq_capability_grants_global_uniq
  on public.hq_capability_grants (scope_level)
  where scope_level = 'global';

create unique index if not exists hq_capability_grants_scoped_uniq
  on public.hq_capability_grants (scope_level, scope_key)
  where scope_level <> 'global';

-- "Which scopes hold token T?" — the registry's canonical membership question
-- (audit / administration). Resolution is keyed by scope (the unique indexes
-- above); this GIN supports the inverse lookup over the token arrays.
create index if not exists hq_capability_grants_tokens_gin
  on public.hq_capability_grants using gin (tokens);

-- ---------------------------------------------------------------------------
-- 3. Token referential integrity + normalisation (grants ⊆ definitions).
--    Postgres has no FK on array elements, so a BEFORE INSERT/UPDATE trigger
--    enforces it: every token must be defined in hq_capabilities, and the array
--    is normalised to sorted-distinct so storage is deterministic and the R2
--    parity comparison is a mechanical set match.
-- ---------------------------------------------------------------------------
create or replace function public.hq_capability_grants_validate_tokens()
returns trigger
language plpgsql
as $$
declare
  v_unknown text;
begin
  -- Normalise to sorted-distinct (empty stays empty).
  new.tokens := coalesce(
    (select array_agg(distinct t order by t) from unnest(new.tokens) as t),
    '{}'::text[]
  );

  -- Reject any token not defined in the catalogue (referential integrity).
  select t into v_unknown
  from unnest(new.tokens) as t
  where not exists (select 1 from public.hq_capabilities c where c.token = t)
  limit 1;

  if v_unknown is not null then
    raise exception 'unknown capability token % (not defined in hq_capabilities)', v_unknown
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists hq_capability_grants_validate_tokens on public.hq_capability_grants;
create trigger hq_capability_grants_validate_tokens
  before insert or update on public.hq_capability_grants
  for each row execute function public.hq_capability_grants_validate_tokens();

-- A defined capability cannot be deleted while a grant still references it (the
-- companion to the array integrity above — closes the orphan path).
create or replace function public.hq_capabilities_block_referenced_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.hq_capability_grants g where old.token = any(g.tokens)
  ) then
    raise exception 'capability % is referenced by a grant and cannot be deleted', old.token
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists hq_capabilities_no_referenced_delete on public.hq_capabilities;
create trigger hq_capabilities_no_referenced_delete
  before delete on public.hq_capabilities
  for each row execute function public.hq_capabilities_block_referenced_delete();

-- ---------------------------------------------------------------------------
-- 4. Immutable audit fields — freeze the audit trail + scope identity, touch
--    updated_at. Grant CONTENT (tokens, posture, scope, budget, registration)
--    stays editable by out-of-band administration; the audit trail does not.
-- ---------------------------------------------------------------------------
create or replace function public.hq_capabilities_guard()
returns trigger
language plpgsql
as $$
begin
  if new.token is distinct from old.token then
    raise exception 'hq_capabilities.token is immutable (add a new capability instead of renaming)'
      using errcode = 'restrict_violation';
  end if;
  if new.created_at is distinct from old.created_at
     or new.created_by_id is distinct from old.created_by_id
     or new.created_by_email is distinct from old.created_by_email then
    raise exception 'hq_capabilities audit fields are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hq_capabilities_guard on public.hq_capabilities;
create trigger hq_capabilities_guard
  before update on public.hq_capabilities
  for each row execute function public.hq_capabilities_guard();

create or replace function public.hq_capability_grants_guard()
returns trigger
language plpgsql
as $$
begin
  -- A grant's scope identity is immutable: it cannot silently move from one
  -- scope to another (that would fork the audit trail and dodge the unique key).
  if new.scope_level is distinct from old.scope_level
     or new.scope_key is distinct from old.scope_key then
    raise exception 'hq_capability_grants scope (scope_level, scope_key) is immutable'
      using errcode = 'restrict_violation';
  end if;
  -- Audit fields are immutable once written.
  if new.created_at is distinct from old.created_at
     or new.created_by_id is distinct from old.created_by_id
     or new.created_by_email is distinct from old.created_by_email then
    raise exception 'hq_capability_grants audit fields are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hq_capability_grants_guard on public.hq_capability_grants;
create trigger hq_capability_grants_guard
  before update on public.hq_capability_grants
  for each row execute function public.hq_capability_grants_guard();
