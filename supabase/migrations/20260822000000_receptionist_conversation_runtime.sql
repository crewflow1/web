-- CrewFlow HQ — Voice Receptionist AI: the MULTI-TURN CONVERSATION RUNTIME state
-- (CEO Directive #018, the AI Receptionist Programme — increment R15:
--  MULTI-TURN CONVERSATION RUNTIME).
--
-- R1–R14 built a ONE-SHOT responder: every inbound became an isolated enquiry, and the ONLY
-- outbound was the flag-gated missed-call text-back — a single dispatch with no notion of a
-- TURN or a continuing dialogue. R15 turns the receptionist into a CONVERSATION RUNTIME: the
-- single orchestration layer that, for a turn, resolves the existing conversation, loads its
-- canonical timeline, assembles its canonical context, determines the current state, generates
-- the next draft, runs Policy, Audits, ROUTES (allow→transport, review→Reply Review Inbox,
-- block→blocked flow — all UNCHANGED), and ADVANCES the conversation state.
--
-- THIS MIGRATION ADDS THE MINIMAL STATE THE RUNTIME ADVANCES — nothing more. It is a COARSE
-- TURN-OWNERSHIP MARKER (which party owes the next turn), NOT a formal conversation state
-- machine, and NOT slot filling / intent progression / booking / scheduling — those are
-- EXPLICIT R16+ NON-GOALS the runtime must not encode. The marker is advanced by a pure,
-- deterministic fold in the TypeScript runtime; it is a persisted OBSERVABLE, never a gate that
-- blocks a turn.
--
-- The hardening mirrors the R10 substrate writers (20260819000000): a single validated
-- SECURITY DEFINER entry point, EXECUTE revoked from PUBLIC / anon / authenticated and granted
-- only to service_role, with `set search_path = ''`. The list view is recreated to EXPOSE the
-- new column (the R11 read model stays the single read layer); the recreation only APPENDS a
-- column, so `create or replace view` accepts it and the timeline view is untouched.
--
-- Provably additive (P2): ONE nullable-defaulted column on the existing container, the list
-- view recreated to surface it, and ONE new function. No ledger, no pipeline object, and no
-- existing column is altered. The column defaults, so every existing row and every existing
-- code path is byte-for-byte unchanged until the runtime advances it.

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversations.runtime_state — the MINIMAL conversation state: which party
--    owes the next turn. Defaulted so it is provably additive; CHECK-bounded to the three
--    coarse ownership values the runtime's pure core defines (kept in lock-step with
--    lib/receptionist/runtime.ts::CONVERSATION_STATES). A brand-new conversation defaults to
--    'awaiting_ai' — the customer has just made contact, so the AI owes the next turn.
-- ---------------------------------------------------------------------------
alter table public.receptionist_conversations
  add column if not exists runtime_state text not null default 'awaiting_ai'
    check (runtime_state in ('awaiting_ai', 'awaiting_customer', 'awaiting_human'));

-- Backfill the rows that predate the runtime. They were serviced under the pre-R15 one-shot
-- flow, so they are NOT owed an AI turn — mark them 'awaiting_customer'. The runtime never
-- spontaneously re-drives an old thread; when a new inbound folds onto one (R10's identity key),
-- the runtime reads this state and advances from here. The column default already set every
-- existing row to 'awaiting_ai' on ADD, so this UPDATE moves the ones that have exchanged
-- messages to the conservative post-service value.
update public.receptionist_conversations
   set runtime_state = 'awaiting_customer'
 where runtime_state = 'awaiting_ai'
   and message_count > 0;

-- ---------------------------------------------------------------------------
-- 2. receptionist_conversation_list — recreated to EXPOSE runtime_state. Identical to the R11
--    definition (20260820000000) with the new column APPENDED at the end of the projection, so
--    `create or replace view` accepts the change (Postgres permits appended columns, never
--    reordered/removed ones). The read service selects columns by NAME, so the append is
--    transparent to it. `security_invoker = true` and the service_role-only grant are preserved.
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
  c.runtime_state                                     -- R15: the minimal conversation state (appended)
from public.receptionist_conversations c
  left join lateral (
    select m.direction, m.created_at as event_at
    from public.receptionist_messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) last_msg on true;

-- Re-issue the R11 grants. `create or replace view` preserves privileges, but stating them keeps
-- the view's access identical whether it is first created by R11 then replaced here, or created
-- fresh — anon / authenticated get nothing; service_role (BYPASSRLS) is the sole reader.
revoke all on public.receptionist_conversation_list
  from public, anon, authenticated, service_role;
grant select on public.receptionist_conversation_list to service_role;

-- ---------------------------------------------------------------------------
-- 3. set_receptionist_conversation_runtime_state — the SINGLE validated write entry point for
--    the runtime state. SECURITY DEFINER, service_role-only, `set search_path = ''`. ORG-SCOPED:
--    it updates only a row whose org_id matches, so a caller can only ever advance its own
--    conversation (tenant isolation, the same discipline as the R10 writers). The state value is
--    validated in-DDL against the same three coarse values as the column CHECK, so the writer can
--    never persist an out-of-vocabulary state. Idempotent (writing the same state is a no-op
--    update) and total (an unknown conversation id simply matches no row).
-- ---------------------------------------------------------------------------
create or replace function public.set_receptionist_conversation_runtime_state(
  p_conversation_id uuid,
  p_org_id          uuid,
  p_runtime_state   text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_runtime_state not in ('awaiting_ai', 'awaiting_customer', 'awaiting_human') then
    raise exception 'receptionist runtime_state must be awaiting_ai|awaiting_customer|awaiting_human, got %', p_runtime_state
      using errcode = 'check_violation';
  end if;

  update public.receptionist_conversations
     set runtime_state = p_runtime_state,
         updated_at    = now()
   where id = p_conversation_id
     and org_id = p_org_id;  -- org-scoped: a caller advances only its OWN conversation
end;
$$;

revoke all on function public.set_receptionist_conversation_runtime_state(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_receptionist_conversation_runtime_state(uuid, uuid, text)
  to service_role;
