-- CrewFlow HQ — Voice Receptionist AI: the CONVERSATION INFORMATION state
-- (CEO Directive #018, the AI Receptionist Programme — increment R20:
--  CONVERSATION INFORMATION ENGINE).
--
-- R15 gave the runtime a coarse OWNERSHIP marker (which party owes the next turn); R17 wrapped it in a
-- formal STATE MACHINE; R18 added the INTENT ENGINE (what the customer WANTS); R19 added the GOAL ENGINE
-- (what the conversation is trying to ACCOMPLISH). R20 adds the next layer UP — the CONVERSATION
-- INFORMATION ENGINE, the single authority over a FOURTH question: "what STRUCTURED INFORMATION has the
-- customer actually PROVIDED?" (the extracted facts). This migration adds the MINIMAL persisted state that
-- engine accumulates — nothing more. It is a per-turn INFORMATION record the runtime resolves
-- deterministically by EXTRACTING the fields the current R19 goal needs from the canonical context (never
-- by calling a model); it is a persisted OBSERVABLE, never a gate that blocks a turn, and it NEVER moves
-- the R15 ownership marker, the R18 intent marker OR the R19 goal marker (all four are independent:
-- `runtime_state` = who owes the next turn; `intent` = what the customer wants; `goal` = what the
-- conversation is trying to accomplish; `information` = what the customer has provided). Booking execution,
-- AI scheduling, slot-fill-driven prompting, memory retrieval and human handoff are EXPLICIT R20 NON-GOALS
-- — the engine EXTRACTS the information and stops; it acts on nothing.
--
-- The hardening mirrors the R18/R19 marker writers (20260823000000 / 20260824000000) EXACTLY: a single
-- validated SECURITY DEFINER entry point, EXECUTE revoked from PUBLIC / anon / authenticated and granted
-- only to service_role, with `set search_path = ''`. The one structural difference is the column TYPE:
-- information is variable-shape, so it is a `jsonb` OBJECT (not a CHECK-bounded text marker), and the
-- writer validates the SHAPE in-DDL — every key in the closed field vocabulary, every value a string — the
-- jsonb analogue of the R18/R19 in-DDL vocabulary check. The list view is recreated to EXPOSE the new
-- column (the R11 read model stays the single read layer); the recreation only APPENDS a column, so
-- `create or replace view` accepts it and the timeline view is untouched.
--
-- Provably additive (P2): ONE object-defaulted column on the existing container, the list view recreated
-- to surface it, and ONE new function. No ledger, no pipeline object, and no existing column is altered.
-- The column defaults to '{}'::jsonb — the honest initial value for every existing row (we never extracted
-- their information) — so NO backfill is needed and every existing row and every existing code path is
-- byte-for-byte unchanged until the runtime extracts information on a turn.

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversations.information — the CONVERSATION INFORMATION: the structured facts the
--    customer has provided, as a jsonb OBJECT keyed by the engine's field vocabulary (kept in lock-step
--    with lib/receptionist/conversation-information.ts::INFORMATION_FIELDS). Object-defaulted so it is
--    provably additive, and CHECK-bounded to a jsonb object so the column can never hold an array or
--    scalar. A brand-new conversation defaults to '{}' — nothing has been extracted yet. No backfill:
--    '{}' is the correct, honest value for every pre-R20 row.
-- ---------------------------------------------------------------------------
alter table public.receptionist_conversations
  add column if not exists information jsonb not null default '{}'::jsonb
    check (jsonb_typeof(information) = 'object');

-- ---------------------------------------------------------------------------
-- 2. receptionist_conversation_list — recreated to EXPOSE information. Identical to the R19 definition
--    (20260824000000) with the new column APPENDED at the end of the projection, so
--    `create or replace view` accepts the change (Postgres permits appended columns, never
--    reordered/removed ones). The read service selects columns by NAME, so the append is transparent to
--    it. `security_invoker = true` and the service_role-only grant are preserved.
-- ---------------------------------------------------------------------------
create or replace view public.receptionist_conversation_list
  with (security_invoker = true) as
select
  c.id                          as conversation_id,
  c.org_id,
  c.employee_slug,
  c.channel,
  c.contact_ref,
  c.contact_name,
  c.status,
  c.message_count,
  c.first_message_at,
  c.last_message_at,
  c.created_at,
  c.updated_at,
  last_msg.direction            as last_direction,
  last_msg.event_at             as last_event_at,
  c.runtime_state,                                    -- R15: the minimal conversation state
  c.intent,                                           -- R18: the conversation intent
  c.goal,                                             -- R19: the conversation goal
  c.information                                       -- R20: the conversation information (appended)
from public.receptionist_conversations c
  left join lateral (
    select m.direction, m.created_at as event_at
    from public.receptionist_messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) last_msg on true;

-- Re-issue the R11 grants. `create or replace view` preserves privileges, but stating them keeps the
-- view's access identical whether it is first created by R11 then replaced here, or created fresh —
-- anon / authenticated get nothing; service_role (BYPASSRLS) is the sole reader.
revoke all on public.receptionist_conversation_list
  from public, anon, authenticated, service_role;
grant select on public.receptionist_conversation_list to service_role;

-- ---------------------------------------------------------------------------
-- 3. set_receptionist_conversation_information — the SINGLE validated write entry point for the
--    conversation information. SECURITY DEFINER, service_role-only, `set search_path = ''`. ORG-SCOPED: it
--    updates only a row whose org_id matches, so a caller can only ever advance its own conversation
--    (tenant isolation, the same discipline as the R15/R18/R19 marker writers). The information SHAPE is
--    validated in-DDL — a jsonb object whose every key is in the closed field vocabulary and whose every
--    value is a string — so the writer can never persist an out-of-vocabulary key or a non-string value.
--    Idempotent (writing the same information is a no-op update) and total (an unknown conversation id
--    simply matches no row).
-- ---------------------------------------------------------------------------
create or replace function public.set_receptionist_conversation_information(
  p_conversation_id uuid,
  p_org_id          uuid,
  p_information     jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  -- The information must be a jsonb OBJECT (never an array, a scalar, or null).
  if p_information is null or jsonb_typeof(p_information) <> 'object' then
    raise exception 'receptionist information must be a jsonb object, got %', coalesce(jsonb_typeof(p_information), 'null')
      using errcode = 'check_violation';
  end if;

  -- Every KEY must be in the closed field vocabulary, and every VALUE must be a string. This bounds the
  -- persisted shape to exactly what the engine's field vocabulary defines, so the writer can never persist
  -- an out-of-vocabulary key or a non-string value.
  for v_key in select jsonb_object_keys(p_information) loop
    if v_key not in ('email_address', 'phone_number', 'postcode', 'job_type') then
      raise exception 'receptionist information key must be one of email_address|phone_number|postcode|job_type, got %', v_key
        using errcode = 'check_violation';
    end if;
    if jsonb_typeof(p_information -> v_key) <> 'string' then
      raise exception 'receptionist information value for % must be a string', v_key
        using errcode = 'check_violation';
    end if;
  end loop;

  update public.receptionist_conversations
     set information = p_information,
         updated_at  = now()
   where id = p_conversation_id
     and org_id = p_org_id;  -- org-scoped: a caller advances only its OWN conversation
end;
$$;

revoke all on function public.set_receptionist_conversation_information(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_receptionist_conversation_information(uuid, uuid, jsonb)
  to service_role;
