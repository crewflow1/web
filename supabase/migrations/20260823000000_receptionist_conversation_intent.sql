-- CrewFlow HQ — Voice Receptionist AI: the CONVERSATION INTENT state
-- (CEO Directive #018, the AI Receptionist Programme — increment R18:
--  CONVERSATION INTENT ENGINE).
--
-- R15 gave the runtime a coarse OWNERSHIP marker (which party owes the next turn); R17 wrapped it in a
-- formal STATE MACHINE. R18 adds the next layer UP — the CONVERSATION INTENT ENGINE, the single
-- authority over a DIFFERENT question: "what does the customer WANT?" (the conversational intent). This
-- migration adds the MINIMAL persisted state that engine advances — nothing more. It is a per-turn
-- CLASSIFICATION marker the runtime resolves deterministically from the customer's latest message; it is
-- a persisted OBSERVABLE, never a gate that blocks a turn, and it NEVER moves the R15 ownership marker
-- (the two are independent: `runtime_state` = who owes the next turn; `intent` = what the customer
-- wants). Booking, AI scheduling, slot filling and human handoff are EXPLICIT R18 NON-GOALS — the engine
-- RECOGNISES the intent and stops; it acts on nothing.
--
-- The hardening mirrors the R15 runtime writer (20260822000000) EXACTLY: a single validated SECURITY
-- DEFINER entry point, EXECUTE revoked from PUBLIC / anon / authenticated and granted only to
-- service_role, with `set search_path = ''`. The list view is recreated to EXPOSE the new column (the
-- R11 read model stays the single read layer); the recreation only APPENDS a column, so
-- `create or replace view` accepts it and the timeline view is untouched.
--
-- Provably additive (P2): ONE nullable-defaulted column on the existing container, the list view
-- recreated to surface it, and ONE new function. No ledger, no pipeline object, and no existing column
-- is altered. The column defaults to 'unknown' — the honest initial value for every existing row (we
-- never classified their intent) — so NO backfill is needed and every existing row and every existing
-- code path is byte-for-byte unchanged until the runtime resolves an intent.

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversations.intent — the CONVERSATION INTENT: what the customer wants on their
--    latest turn. Defaulted so it is provably additive; CHECK-bounded to the six values the engine's
--    pure core defines (kept in lock-step with lib/receptionist/conversation-intent.ts::
--    CONVERSATION_INTENTS). A brand-new conversation defaults to 'unknown' — nothing has been resolved
--    yet. No backfill: 'unknown' is the correct, honest value for every pre-R18 row.
-- ---------------------------------------------------------------------------
alter table public.receptionist_conversations
  add column if not exists intent text not null default 'unknown'
    check (intent in (
      'unknown', 'general_enquiry', 'booking_interest', 'callback_request', 'quote_request', 'human_handoff'
    ));

-- ---------------------------------------------------------------------------
-- 2. receptionist_conversation_list — recreated to EXPOSE intent. Identical to the R15 definition
--    (20260822000000) with the new column APPENDED at the end of the projection, so
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
  c.intent                                            -- R18: the conversation intent (appended)
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
-- 3. set_receptionist_conversation_intent — the SINGLE validated write entry point for the conversation
--    intent. SECURITY DEFINER, service_role-only, `set search_path = ''`. ORG-SCOPED: it updates only a
--    row whose org_id matches, so a caller can only ever advance its own conversation (tenant isolation,
--    the same discipline as the R15 runtime writer). The intent value is validated in-DDL against the
--    same six values as the column CHECK, so the writer can never persist an out-of-vocabulary intent.
--    Idempotent (writing the same intent is a no-op update) and total (an unknown conversation id simply
--    matches no row).
-- ---------------------------------------------------------------------------
create or replace function public.set_receptionist_conversation_intent(
  p_conversation_id uuid,
  p_org_id          uuid,
  p_intent          text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_intent not in (
    'unknown', 'general_enquiry', 'booking_interest', 'callback_request', 'quote_request', 'human_handoff'
  ) then
    raise exception 'receptionist intent must be one of unknown|general_enquiry|booking_interest|callback_request|quote_request|human_handoff, got %', p_intent
      using errcode = 'check_violation';
  end if;

  update public.receptionist_conversations
     set intent     = p_intent,
         updated_at  = now()
   where id = p_conversation_id
     and org_id = p_org_id;  -- org-scoped: a caller advances only its OWN conversation
end;
$$;

revoke all on function public.set_receptionist_conversation_intent(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_receptionist_conversation_intent(uuid, uuid, text)
  to service_role;
