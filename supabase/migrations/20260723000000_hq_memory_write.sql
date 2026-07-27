-- CrewFlow HQ — Shared Memory: the AI write path (`hq_memory_write`)
-- (CEO Directive 009, Phase 1, Module 1 — Shared Memory, PR2).
--
-- Builds ON TOP of the Shared Memory Engine (Directive 002) and the
-- lifecycle columns from PR1 (20260722000000_memory_classes_lifecycle.sql).
-- This is the substrate evolution the CrewFlow Bible, Volume X §6/§12.1
-- describes: the engine stops being read-first and opens a SINGLE, atomic,
-- permissioned entry point for an AI employee to author its own memory.
--
-- ADDITIVE & DARK. This migration adds ONE function plus ONE provenance
-- source row; it drops/retypes nothing and changes NO existing behaviour.
-- The function has NO callers in production — the SDK that invokes it ships
-- later (PR6), behind the boardroom/employee gates — so the *absence of a
-- caller* is the dark boundary; no feature flag is needed. The existing
-- human write path (server/services/hq-memory.ts createMemory/updateMemory)
-- is untouched: ONE engine, two callers (Directive 009 "one of each").
--
-- §6 write rules, enforced here as the atomic final gate (defense in depth,
-- mirroring the pure lib/memory/model.ts `decideMemoryWrite` predicate the
-- same way `canEmployeeAccess` mirrors the SQL stage-1 read filter):
--   * own episodic/working/private memory          -> committed autonomously
--   * shared semantic/long_term/procedural          -> a PROPOSAL that needs an
--       approval checkpoint, UNLESS the employee holds the
--       `memory.write.shared` capability scope       -> committed autonomously
--   * another employee's private memory, or system  -> denied (raises)
--
-- The approval checkpoint itself (opening a `waiting_approval` task) is owned
-- by the Workflow/Task engine (Module 4 / Volume XII), which is not built yet
-- and which no existing approval subsystem can host. So a proposal that needs
-- approval is NOT committed to the company brain here: the function returns the
-- NULL sentinel (Volume X §12.1 "returns a sentinel"), and the caller surfaces
-- `approvalRequired`. Wiring the task later changes NO application code — the
-- `{ id, approvalRequired }` contract is already the Bible's §12.2 surface.
--
-- EMBEDDINGS ARE A PLUG-IN, NOT A DEPENDENCY (Directive 009 standing rule).
-- The write emits the frozen-registry verb `memory.asserted` on The Pulse in
-- THIS transaction (transactional outbox). A future PR4 embed-consumer
-- subscribes to that verb to backfill the vector — so this write path is
-- byte-identical with or without embeddings, and enabling them later touches
-- no application code. pgvector stays dormant until the Volume X §16 model
-- decision; no embedding column is written here.
--
-- hq_memories / hq_events already have RLS ENABLED with NO policies
-- (service-role only); this SECURITY DEFINER function is granted to
-- service_role alone, like every other HQ engine primitive.

-- ---------------------------------------------------------------------
-- 1. Provenance: a first-class source for AI-authored memory.
--
-- The Directive-002 seed has human channels (manual, meeting_notes, …),
-- system channels (deployment_report, …) and dormant integrations
-- (claude/openai/gemini). None marks "an AI EMPLOYEE authored this", which
-- is the provenance of every row this function writes. Add it additively;
-- idempotent so re-application is a no-op.
-- ---------------------------------------------------------------------

insert into public.hq_memory_sources (slug, label, category, is_active, sort_order)
values ('ai_employee', 'AI employee', 'system', true, 75)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- 2. hq_memory_write(...) — the AI write primitive (Volume X §12.1).
--
-- SECURITY DEFINER with a pinned empty search_path, like every HQ engine
-- function. Returns the new memory's uuid on an autonomous commit, or NULL
-- when the write is a shared-knowledge proposal withheld pending approval.
-- Raises on a §6 denial or invalid input (the caller pre-checks for a
-- friendly error; this is the authoritative gate for any direct caller).
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
  v_scopes            jsonb;
  v_has_shared        boolean;
  v_is_owner          boolean;
  v_is_durable        boolean;
  v_is_shared_durable boolean;
  v_outcome           text;
  v_memory_id         uuid;
  v_correlation       uuid;
begin
  -- Resolve the writing employee: department + capability scopes. The scopes
  -- array lives in permissions.scopes until the capability model (Volume XIII).
  select e.department, coalesce(e.permissions -> 'scopes', '[]'::jsonb)
    into v_dept, v_scopes
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
  v_has_shared        := v_scopes ? 'memory.write.shared';

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

-- Service-role-only, like every HQ engine primitive. Supabase's default
-- privileges grant EXECUTE on new public functions directly to anon/
-- authenticated, so revoking from PUBLIC alone is not enough (L-4).
revoke all on function public.hq_memory_write(
  uuid, text, text, text, text, text, text, uuid, integer,
  timestamp with time zone, uuid, uuid, jsonb
) from public, anon, authenticated;

grant execute on function public.hq_memory_write(
  uuid, text, text, text, text, text, text, uuid, integer,
  timestamp with time zone, uuid, uuid, jsonb
) to service_role;
