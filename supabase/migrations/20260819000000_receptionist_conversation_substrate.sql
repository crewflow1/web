-- CrewFlow HQ — Voice Receptionist AI: the conversation & contact-identity substrate
-- (CEO Directive #018, the AI Receptionist Programme — increment R10:
--  CONVERSATION & CONTACT-IDENTITY SUBSTRATE).
--
-- R1–R9 built a STATELESS, single-shot responder: every inbound message became an
-- isolated `inbound_enquiries` row (+ a fresh `leads` row) with NO container grouping a
-- contact's messages, NO durable contact identity, and NO thread. The audit ledger even
-- LABELS `ai_reply_audits.enquiry_id` "the conversation" while it points at a single
-- message. R10 lays the missing substrate: a persistent, org-scoped CONVERSATION keyed by
-- a resolved contact identity, plus a threaded MESSAGE timeline — WITHOUT changing any AI
-- behaviour, without a multi-turn runtime, and without opening any new outbound path.
--
-- IT IS FOUNDATION, NOT BEHAVIOUR. The deterministic acknowledgement, the canonical
-- Draft → Policy → Audit → Transport → Delivery-Receipt pipeline, and the three append-only
-- ledgers are UNTOUCHED. This substrate sits BENEATH the pipeline as shared infrastructure:
-- the existing single-shot flow simply WRITES INTO it. There remains exactly one source of
-- truth — a message row references its authoritative content row (an inbound enquiry, or a
-- reply audit) rather than copying it, so no content is duplicated and no ledger is mutated.
--
-- Reuses the established container/message architecture already in the repository — the
-- shape mirrors, feature for feature, the Support OS (`support_tickets` + `support_messages`,
-- 20260610000000): a thread CONTAINER plus its ordered ENTRIES. The hardening mirrors the
-- reply ledgers (20260815/16/17):
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER write
--     primitives are the only paths in; every JWT client (anon / authenticated) is denied.
--     (A per-organisation / customer-portal read PROJECTION is a deliberate later increment.)
--   • Identity + threading writes go through single validated SECURITY DEFINER entry points,
--     EXECUTE revoked from PUBLIC / anon / authenticated and granted only to service_role.
--
-- Provably additive (P2): two brand-new tables + two functions + one nullable link column on
-- `inbound_enquiries`. No ledger is altered. No producer is wired by this migration (the
-- canonical service threads the substrate in TypeScript). The link column is nullable and
-- defaults to NULL, so every existing row and every existing code path is byte-for-byte
-- unchanged until the service populates it.

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversations — the thread CONTAINER. One row per contact, per
--    channel, per organisation. The UNIQUE (org_id, channel, contact_ref) key IS the
--    contact identity: it makes a repeat contact resolve into the SAME conversation and
--    it enforces organisation isolation (a contact_ref in org A can never collide with the
--    same string in org B). `contact_ref` is the NORMALISED identifier (trim + casefold);
--    normalisation lives in the resolver below so it can never drift.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversations (
  id               uuid        primary key default gen_random_uuid(),
  org_id           uuid        not null references public.organizations(id) on delete cascade,
  employee_slug    text        not null,               -- the AI employee (voice-receptionist-ai)
  channel          text        not null                -- the channel this conversation lives on
                               check (channel in (
                                 'phone', 'sms', 'whatsapp_msg', 'whatsapp_call',
                                 'instagram_dm', 'facebook_dm', 'manual')),
  contact_ref      text        not null                -- the resolved, normalised contact identity
                               check (btrim(contact_ref) <> ''),
  contact_name     text,                                -- best-known display name, if any (never overwritten)
  status           text        not null default 'active'
                               check (status in ('active', 'archived')),
  message_count    integer     not null default 0 check (message_count >= 0),
  first_message_at timestamptz not null default now(),
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- THE CONTACT IDENTITY KEY. Exactly one conversation per (org, channel, contact).
  unique (org_id, channel, contact_ref)
);

create index if not exists receptionist_conversations_org_last_idx
  on public.receptionist_conversations (org_id, last_message_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER write
-- primitives are the only paths in; every JWT client is denied because an RLS-enabled table
-- with no policies defaults to deny. (Tenant / customer-portal read policies are a later,
-- separately-reviewed increment — this substrate ships HQ-internal.)
alter table public.receptionist_conversations enable row level security;

-- ---------------------------------------------------------------------------
-- 2. receptionist_messages — the thread ENTRIES. The conversation TIMELINE: one row per
--    inbound or outbound message, ordered by created_at. It does NOT copy message content;
--    each entry REFERENCES its authoritative source, preserving exactly one source of truth:
--      • inbound  → the originating public.inbound_enquiries row (its raw_text IS the content);
--      • outbound → the public.ai_reply_audits row (its draft + decision IS the content).
--    This makes the substrate a pure threading index over the existing records — never a
--    second store that could drift from them.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.receptionist_conversations(id) on delete cascade,
  org_id          uuid        not null references public.organizations(id) on delete cascade,  -- denorm for cheap org scoping
  direction       text        not null check (direction in ('inbound', 'outbound')),
  channel         text        not null
                              check (channel in (
                                'phone', 'sms', 'whatsapp_msg', 'whatsapp_call',
                                'instagram_dm', 'facebook_dm', 'manual')),
  -- The authoritative content pointers. An inbound entry carries enquiry_id; an outbound
  -- entry carries audit_id. enquiry_id is FK'd (a normal operational table); audit_id is
  -- left un-FK'd — the audit ledger is append-only and deliberately un-FK'd, so the timeline
  -- references it as a durable fact without coupling to it (the ledger's own anchor idiom).
  enquiry_id      uuid        references public.inbound_enquiries(id) on delete set null,
  audit_id        uuid,                                 -- ai_reply_audits.id (logical reference; un-FK'd by design)
  created_at      timestamptz not null default now()
);

create index if not exists receptionist_messages_conversation_idx
  on public.receptionist_messages (conversation_id, created_at);
create index if not exists receptionist_messages_org_idx
  on public.receptionist_messages (org_id, created_at desc);

alter table public.receptionist_messages enable row level security;

-- ---------------------------------------------------------------------------
-- 3. inbound_enquiries.conversation_id — link EXISTING receptionist activity into its
--    conversation. Nullable + ON DELETE SET NULL + DEFAULT NULL: every existing row and
--    every existing code path is unchanged until the service threads it. This is the direct
--    enquiry → conversation link; the message timeline (above) is the ordered stream.
-- ---------------------------------------------------------------------------
alter table public.inbound_enquiries
  add column if not exists conversation_id uuid
    references public.receptionist_conversations(id) on delete set null;

create index if not exists inbound_enquiries_conversation_idx
  on public.inbound_enquiries (conversation_id)
  where conversation_id is not null;

-- ---------------------------------------------------------------------------
-- 4. resolve_receptionist_conversation — the CONTACT IDENTITY RESOLVER and single
--    validated write entry point for the container. SECURITY DEFINER, service_role-only.
--    Atomic + race-safe: a single INSERT ... ON CONFLICT DO UPDATE on the identity key, so
--    two concurrent inbound messages from the SAME contact resolve to ONE conversation, never
--    two. Normalisation (trim + casefold) lives HERE, so the resolved identity can never
--    drift between callers. An empty identifier resolves to NULL (no contact ⇒ no thread).
-- ---------------------------------------------------------------------------
create or replace function public.resolve_receptionist_conversation(
  p_org_id        uuid,
  p_employee_slug text,
  p_channel       text,
  p_contact_ref   text,
  p_contact_name  text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_id      uuid;
begin
  -- Normalise: trim + casefold. The SAME person on the SAME channel always folds to ONE
  -- conversation regardless of incidental whitespace or casing in the delivered identifier.
  v_contact := lower(btrim(coalesce(p_contact_ref, '')));
  if v_contact = '' then
    return null;  -- no contact identifier ⇒ no conversation to resolve; caller skips linkage
  end if;

  insert into public.receptionist_conversations as c (
    org_id, employee_slug, channel, contact_ref, contact_name
  ) values (
    p_org_id, p_employee_slug, p_channel, v_contact,
    nullif(btrim(coalesce(p_contact_name, '')), '')
  )
  on conflict (org_id, channel, contact_ref) do update
    set updated_at   = now(),
        -- Keep the first known name; only fill it when we still have none.
        contact_name = coalesce(c.contact_name, excluded.contact_name)
  returning c.id into v_id;

  return v_id;
end;
$$;

revoke all on function public.resolve_receptionist_conversation(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_receptionist_conversation(uuid, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. append_receptionist_message — the THREADING write entry point. SECURITY DEFINER,
--    service_role-only. Appends one timeline entry referencing its authoritative content
--    row, and advances the container's counters (message_count, last_message_at). Direction
--    is validated in-DDL so the timeline can only ever record 'inbound' | 'outbound'.
-- ---------------------------------------------------------------------------
create or replace function public.append_receptionist_message(
  p_conversation_id uuid,
  p_org_id          uuid,
  p_direction       text,
  p_channel         text,
  p_enquiry_id      uuid default null,
  p_audit_id        uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_direction not in ('inbound', 'outbound') then
    raise exception 'receptionist message direction must be inbound|outbound, got %', p_direction
      using errcode = 'check_violation';
  end if;

  insert into public.receptionist_messages (
    conversation_id, org_id, direction, channel, enquiry_id, audit_id
  ) values (
    p_conversation_id, p_org_id, p_direction, p_channel, p_enquiry_id, p_audit_id
  )
  returning id into v_id;

  update public.receptionist_conversations
     set message_count  = message_count + 1,
         last_message_at = now(),
         updated_at      = now()
   where id = p_conversation_id;

  return v_id;
end;
$$;

revoke all on function public.append_receptionist_message(uuid, uuid, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.append_receptionist_message(uuid, uuid, text, text, uuid, uuid)
  to service_role;
