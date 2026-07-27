-- CrewFlow HQ — LR5.4A: migrate the shared-memory write gate to the Capability
-- Registry (CEO Directive #015 / D-05, Legacy Removal increment 5.4A).
--
-- Splits the original LR5.4 in two, on the CEO's review of the LR5.4 halt: this
-- increment (5.4A) MIGRATES the one remaining legacy reader onto the registry
-- and PRESERVES behaviour; the column drop and tooling removal follow in LR5.4B,
-- authorised only after 5.4A is reviewed and approved.
--
-- WHY THIS EXISTS — the Hidden Read Path Rule (Kernel Contract Map §2, the 27th
-- standard). Planning the LR5.4 column drop surfaced a live read path the LR5.2
-- census had missed because it swept application code only: hq_memory_write
-- (migration 20260723000000) — a `security definer` SQL function — still read
-- `ai_employees.permissions -> 'scopes'` to decide whether a shared-knowledge
-- write could commit autonomously (the `memory.write.shared` capability). A
-- column dropped under a PL/pgSQL reader does NOT fail at migration time
-- (PostgreSQL records no dependency from a function body to the columns it
-- names) — it fails at the reader's next call, in production. Database code is
-- production code; this migration brings that reader onto the registry under the
-- same discipline as every application reader migrated in LR5.2 / LR5.3.
--
-- BEHAVIOUR-PRESERVING. The LR5.1 backfill (20260807000000) folded every
-- employee's `permissions.scopes ∪ tools_allowed` into their registry grant and
-- the capability catalogue, so an employee that held `memory.write.shared` in
-- the legacy column holds it in the registry too. Resolving the same token from
-- the registry therefore returns the same boolean for every employee — the §6
-- decision is unchanged. (No production employee currently holds the token, so
-- the live decision is identically `approval_required` before and after.)
--
-- NO SCHEMA DELETION. This migration ADDS one function and REPLACES one; it
-- drops no column, no function, no policy and no data. The legacy `permissions`
-- column remains in place — LR5.4B removes it — merely no longer read by this
-- gate. ADDITIVE & BEHAVIOUR-DARK, like the original write-path migration.
--
-- ADR 0010 Decision 5 (the inheritance law) is the contract the new resolver
-- mirrors: it is the SQL twin of `applicableGrants` composed to a token UNION in
-- server/sdk/registry-resolver.ts. Keeping the two in lockstep is the §6
-- "mirror the pure predicate EXACTLY" discipline applied at the capability layer.

-- ---------------------------------------------------------------------
-- 1. hq_employee_has_capability(employee, token) — the SQL capability oracle.
--
-- Returns true iff the employee holds `p_token` in the resolved capability set,
-- by the ADR 0010 Decision 5 inheritance law. The TS twin is applicableGrants()
-- composed to a token UNION (server/sdk/registry-resolver.ts): a token is held
-- iff ANY applicable grant lists it, where a grant applies when it is
--   * global                                   — applies to everyone; or
--   * department  and scope_key = e.department  — the employee's department; or
--   * employee    and scope_key = e.slug        — the employee itself.
-- organization grants never apply (no per-employee organization key exists —
-- mirroring applicableGrants' `return false`). DENY-BY-DEFAULT: no matching
-- grant ⇒ the token is not held (the AUTHORITY_FLOOR's empty token set).
--
-- SECURITY DEFINER with a pinned empty search_path, like every HQ engine
-- primitive — so it reads hq_capability_grants (RLS enabled, zero policies:
-- service-role only) regardless of caller, and is independently testable as
-- service_role. Granted to service_role alone.
-- ---------------------------------------------------------------------

create or replace function public.hq_employee_has_capability(
  p_employee_id uuid,
  p_token       text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dept text;
  v_slug text;
  v_has  boolean;
begin
  -- The two scope coordinates the inheritance law keys off: e.department (for
  -- department grants) and e.slug (for employee grants). Global grants need
  -- neither; organization grants are never matched.
  select e.department, e.slug
    into v_dept, v_slug
  from public.ai_employees e
  where e.id = p_employee_id;

  -- Unknown employee: no identity, so no grant can apply. Deny by default.
  if v_slug is null then
    return false;
  end if;

  -- Token possession across the applicable grant set — the resolved capability
  -- set's token UNION reduced to a membership test.
  select exists (
    select 1
    from public.hq_capability_grants g
    where p_token = any (g.tokens)
      and (
            g.scope_level = 'global'
        or (g.scope_level = 'department' and g.scope_key = v_dept)
        or (g.scope_level = 'employee'   and g.scope_key = v_slug)
      )
  )
  into v_has;

  return coalesce(v_has, false);
end;
$$;

-- Service-role-only, like every HQ engine primitive. Supabase's default
-- privileges grant EXECUTE on new public functions directly to anon/
-- authenticated, so revoking from PUBLIC alone is not enough (L-4).
revoke all on function public.hq_employee_has_capability(uuid, text)
  from public, anon, authenticated;

grant execute on function public.hq_employee_has_capability(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------
-- 2. hq_memory_write(...) — REPLACED to source `memory.write.shared` from the
--    registry instead of `ai_employees.permissions -> 'scopes'`.
--
-- Byte-for-byte identical to 20260723000000 EXCEPT the capability resolution:
--   * the employee lookup selects only e.department (no permissions read);
--   * v_has_shared is now hq_employee_has_capability(employee, 'memory.write.shared').
-- Every §6 rule, the insert / version / event / Pulse emit, and the privilege
-- grants are unchanged. `create or replace` preserves the existing ACL; the
-- grants are re-issued below to keep this migration self-contained and auditable.
-- ---------------------------------------------------------------------

create or replace function public.hq_memory_write(
  p_employee_id    uuid,
  p_class          text,
  p_type           text,
  p_title          text,
  p_summary        text        default '',
  p_body           text        default '',
  p_visibility     text        default 'private',
  p_owner          uuid        default null,
  p_salience       integer     default 50,
  p_expires_at     timestamp with time zone default null,
  p_bound_task_id  uuid        default null,
  p_correlation_id uuid        default null,
  p_context        jsonb       default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dept              text;
  v_has_shared        boolean;
  v_is_owner          boolean;
  v_is_durable        boolean;
  v_is_shared_durable boolean;
  v_outcome           text;
  v_memory_id         uuid;
  v_correlation       uuid;
begin
  -- Resolve the writing employee's department (for a department-scoped memory
  -- and the unknown-employee guard). The capability that gates a shared-
  -- knowledge write is now resolved from the Capability Registry, not from
  -- permissions.scopes (LR5.4A; the Hidden Read Path Rule — Kernel Contract Map
  -- §2). One source of authority: the registry (the Single Source of Authority
  -- Rule, the thirteenth standard).
  select e.department
    into v_dept
  from public.ai_employees e
  where e.id = p_employee_id;

  if v_dept is null then
    raise exception 'hq_memory_write: unknown employee %', p_employee_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Validate the cognitive class against the engine's fixed enum (mirrors the
  -- hq_memories CHECK so a bad class fails fast with a clear message).
  if p_class not in ('semantic', 'episodic', 'working', 'long_term', 'procedural') then
    raise exception 'hq_memory_write: invalid memory_class %', p_class
      using errcode = 'check_violation';
  end if;

  -- §6 decision — mirror lib/memory/model.ts decideMemoryWrite EXACTLY.
  v_is_owner          := p_owner is not null and p_owner = p_employee_id;
  v_is_durable        := p_class in ('semantic', 'long_term', 'procedural');
  v_is_shared_durable := v_is_durable and p_visibility in ('public_hq', 'department');
  -- The `memory.write.shared` capability, resolved from the registry (LR5.4A).
  v_has_shared        := public.hq_employee_has_capability(p_employee_id, 'memory.write.shared');

  v_outcome := case
    when p_visibility = 'system' then 'denied'
    when p_owner is not null and not v_is_owner
         and p_visibility in ('private', 'restricted') then 'denied'
    when v_is_shared_durable and v_has_shared then 'autonomous'
    when v_is_shared_durable then 'approval_required'
    when v_is_owner and (p_class in ('episodic', 'working') or p_visibility = 'private')
      then 'autonomous'
    else 'denied'
  end;

  if v_outcome = 'denied' then
    raise exception
      'hq_memory_write: write denied by Volume X §6 (employee=%, class=%, visibility=%)',
      p_employee_id, p_class, p_visibility
      using errcode = 'insufficient_privilege';
  end if;

  if v_outcome = 'approval_required' then
    -- Shared company-brain knowledge without the capability scope: a PROPOSAL.
    -- Do NOT touch the company brain. Return the NULL sentinel; the
    -- waiting_approval task is opened by the Module 4 Workflow/Task engine.
    return null;
  end if;

  -- ---- AUTONOMOUS write. Atomic in THIS transaction (transactional outbox):
  -- insert + version-1 snapshot + per-memory timeline event + Pulse event.
  v_correlation := coalesce(p_correlation_id, gen_random_uuid());

  insert into public.hq_memories (
    title, summary, body, memory_type, department, source, visibility,
    memory_class, owner_employee_id, salience, expires_at, bound_task_id,
    last_reinforced_at
  )
  values (
    p_title,
    coalesce(p_summary, ''),
    coalesce(p_body, ''),
    p_type,
    -- A department-scoped memory carries the author's department; everything
    -- else is company-wide (public_hq) or private experience -> null.
    case when p_visibility = 'department' then v_dept else null end,
    'ai_employee',
    p_visibility,
    p_class,
    p_owner,
    coalesce(p_salience, 50),
    p_expires_at,
    p_bound_task_id,
    now()
  )
  returning id into v_memory_id;

  -- Version 1 snapshot (parity with the human write path; edited_by_email is
  -- a human field -> null for AI, authorship is on the event below).
  insert into public.hq_memory_versions (
    memory_id, version, title, summary, body, memory_type, department,
    importance, tags, status, edited_by_email
  )
  select id, version, title, summary, body, memory_type, department,
         importance, tags, status, null
  from public.hq_memories
  where id = v_memory_id;

  -- Per-memory timeline event — records AI authorship via ai_employee_id, so
  -- the existing memory-detail audit view shows who wrote it.
  insert into public.hq_memory_events (
    memory_id, event_type, actor_email, ai_employee_id, detail
  )
  values (
    v_memory_id, 'created', null, p_employee_id,
    jsonb_build_object('class', p_class, 'via', 'ai_write')
      || coalesce(p_context, '{}'::jsonb)
  );

  -- Canonical event on The Pulse, IN this transaction (Volume X §6). The
  -- frozen registry verb is `memory.asserted`. This is also the embedding
  -- plug-in seam: a future PR4 consumer subscribes here to backfill the
  -- vector, so the write is identical with or without embeddings enabled.
  perform public.hq_emit_event(
    p_actor_type     => 'ai_employee',
    p_actor_id       => p_employee_id::text,
    p_verb           => 'memory.asserted',
    p_object_type    => 'memory',
    p_object_id      => v_memory_id::text,
    p_correlation_id => v_correlation,
    p_severity       => 'info',
    p_payload        => jsonb_build_object(
                          'memory_class', p_class,
                          'visibility',   p_visibility,
                          'memory_type',  p_type,
                          'owner_employee_id', p_owner
                        ),
    p_visibility     => 'hq'
  );

  return v_memory_id;
end;
$$;

-- Service-role-only, like every HQ engine primitive. `create or replace`
-- preserves the existing ACL; re-issued here so this migration is a complete,
-- auditable statement of the function's privileges (Supabase's default grants
-- to anon/authenticated make revoking from PUBLIC alone insufficient — L-4).
revoke all on function public.hq_memory_write(
  uuid, text, text, text, text, text, text, uuid, integer,
  timestamp with time zone, uuid, uuid, jsonb
) from public, anon, authenticated;

grant execute on function public.hq_memory_write(
  uuid, text, text, text, text, text, text, uuid, integer,
  timestamp with time zone, uuid, uuid, jsonb
) to service_role;
