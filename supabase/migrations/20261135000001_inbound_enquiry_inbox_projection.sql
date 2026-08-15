-- P3 Inbox — project inbound enquiries into the unified inbox (conversations/messages).
--
-- WHAT THIS IS. The bridge that makes the tenant-facing inbox actually POPULATED. Every
-- inbound enquiry the AI receptionist ingests (phone / sms / whatsapp / instagram /
-- facebook / email / manual) is projected into the unified `conversations` + `messages`
-- store the P3 inbox reads, mapped onto the inbox's five canonical channels
-- (email/sms/whatsapp/voice/chat) and grouped into one thread per contact per channel.
--
-- ── WHY A TRIGGER, NOT A SERVICE EDIT ───────────────────────────────────────
-- The ingestion core (server/services/receptionist.ts `processInboundEnquiry`) is the AI
-- receptionist's heart, guarded by a large, delicate test suite. A DB trigger keeps the
-- projection ENTIRELY decoupled from that TypeScript path: it fires on the enquiry INSERT
-- the service already performs, so no ingestion code — and none of its tests — changes by
-- one byte. The enquiry insert is itself the dedup point (its partial unique
-- (org_id, provider_message_id) short-circuits redelivery upstream), so this projection
-- runs at most once per genuinely-new enquiry.
--
-- ── IDEMPOTENT + FAIL-SOFT ──────────────────────────────────────────────────
-- The conversation upsert is ON CONFLICT DO UPDATE on the contact-identity key; the
-- message insert is ON CONFLICT DO NOTHING on (org_id, provider_id) — so a re-projection
-- (were one ever to occur) can neither fork a thread nor duplicate a timeline entry. The
-- function schema-qualifies everything under a pinned empty search_path and is SECURITY
-- DEFINER so it writes the RLS-protected inbox tables from the ingestion path.
--
-- Rollback: drop the trigger + function. The projected rows (if any) can be left or
-- truncated; nothing else references them.

-- Map an inbound_enquiries.channel to the inbox's canonical channel vocabulary.
--   phone / whatsapp_call → voice   (a spoken turn; no text transport)
--   sms                   → sms
--   whatsapp_msg          → whatsapp
--   email                 → email
--   instagram_dm / facebook_dm / manual / anything else → chat
-- Kept as its own IMMUTABLE function so the mapping is single-sourced and testable.
create or replace function public.inbox_channel_for_enquiry(p_channel text)
returns text
language sql
immutable
as $$
  select case p_channel
    when 'phone'         then 'voice'
    when 'whatsapp_call' then 'voice'
    when 'sms'           then 'sms'
    when 'whatsapp_msg'  then 'whatsapp'
    when 'email'         then 'email'
    else 'chat'
  end;
$$;

create or replace function public.project_inbound_enquiry_to_inbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel      text;
  v_contact_ref  text;
  v_conversation uuid;
begin
  v_channel := public.inbox_channel_for_enquiry(new.channel);

  -- Normalised contact identity. A withheld/absent caller cannot group, so it falls back
  -- to a per-enquiry synthetic ref (unique, non-null) — its own single-message thread.
  v_contact_ref := lower(btrim(coalesce(new.caller, '')));
  if v_contact_ref = '' then
    v_contact_ref := 'enquiry:' || new.id::text;
  end if;

  -- Upsert the thread container on the contact-identity key. A repeat contact on the same
  -- channel folds into the SAME conversation and advances its last_message_at.
  insert into public.conversations as c (
    org_id, channel, contact_ref, contact_name, lead_id, customer_id,
    status, last_message_at, created_at, updated_at
  ) values (
    new.org_id, v_channel, v_contact_ref, new.caller, new.lead_id, null,
    'active', new.created_at, new.created_at, now()
  )
  on conflict (org_id, channel, contact_ref) where contact_ref is not null do update
    set last_message_at = greatest(c.last_message_at, excluded.last_message_at),
        contact_name    = coalesce(c.contact_name, excluded.contact_name),
        lead_id         = coalesce(c.lead_id, excluded.lead_id),
        updated_at      = now()
  returning c.id into v_conversation;

  -- Append the inbound message. Body IS the enquiry's raw_text; provider_id carries the
  -- channel's message id (the idempotency key). A re-projection collides on
  -- (org_id, provider_id) and is ignored.
  insert into public.messages (
    org_id, conversation_id, direction, channel, from_addr, body,
    media_urls, status, provider_id, created_at
  ) values (
    new.org_id, v_conversation, 'inbound', v_channel, new.caller, new.raw_text,
    null, 'received', new.provider_message_id, new.created_at
  )
  on conflict (org_id, provider_id) where provider_id is not null do nothing;

  return new;
end;
$$;

drop trigger if exists inbound_enquiries_project_inbox on public.inbound_enquiries;
create trigger inbound_enquiries_project_inbox
  after insert on public.inbound_enquiries
  for each row execute function public.project_inbound_enquiry_to_inbox();
