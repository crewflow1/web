-- P3 Inbox — the tenant-facing UNIFIED COMMUNICATIONS INBOX (Master Plan comms).
--
-- WHAT THIS IS. The database half of a tenant-facing conversation view that unifies a
-- customer's inbound + outbound messages across channels (email / sms / whatsapp /
-- voice / chat) into ONE thread, with a reply composer that rides the already-dark
-- comms senders (Resend / Twilio / Meta). Today `/inbox` is a one-way list of
-- `inbound_enquiries`; only support tickets are two-way. This lays the two-way store.
--
-- ── REUSE, NOT DUPLICATE ────────────────────────────────────────────────────
-- The container/timeline pair this feature needs ALREADY EXISTS in the schema baseline
-- (00000000000000_baseline_existing_schema.sql): `public.conversations` (id, org_id,
-- lead_id, customer_id, channel, external_id, last_message_at) and `public.messages`
-- (id, org_id, conversation_id, direction, from_addr, to_addr, body, media_urls,
-- status, provider_id). Both are RLS-enabled with full member-scoped policies
-- (20260515150000_jobs_table_and_rls_policies.sql), both carry the org FKs and the
-- (org_id,…) indexes, both are in the generated types and registered in
-- lib/gdpr/org-tables.json — but NOTHING in the app has ever read or written them.
-- They are production-ready scaffolding left unwired. Rather than mint a third,
-- near-identical conversations/messages pair (which would DUPLICATE the exact shape the
-- standards forbid), this migration HARDENS the existing pair into the P3 inbox:
-- a handful of additive columns for a usable thread UI + reply composer, the
-- idempotency + cross-tenant-FK guarantees the standards require, and a counter trigger.
-- The AI receptionist's OWN thread substrate (receptionist_conversations /
-- receptionist_messages) is a SEPARATE concern: service-role-only (RLS:hq, zero
-- policies), content-by-reference (no body column), AI-employee-scoped. It cannot serve
-- a tenant-facing composer, and is left entirely untouched.
--
-- ── ADDITIVE + SAFE ─────────────────────────────────────────────────────────
-- The two tables are empty in every environment (never wired), so new columns, new
-- CHECKs and new unique indexes cannot fail against existing data. The CHECKs are added
-- NOT VALID regardless, so even a stray legacy row could never block the apply — they
-- constrain new/updated rows only. No column is dropped, no policy is loosened; the
-- existing member-select / member-insert / member-update / admin-delete RLS is the
-- unchanged tenant boundary.
--
-- Rollback: drop the trigger + function, drop the added indexes/constraints, drop the
-- added columns. No data migration to unwind.

-- ── (a) conversations — thread container hardening ───────────────────────────
-- New columns:
--   contact_ref  — the NORMALISED (lower+trim) contact identity for this channel; the
--                  grouping key that folds a repeat contact into the SAME thread. The
--                  projection trigger (20261135000001) synthesises it from the enquiry.
--   contact_name — best-known display name for the contact (never overwritten once set).
--   subject      — an optional thread subject (email threads carry one; SMS/voice don't).
--   status       — active | archived, so an operator can archive a resolved thread.
--   updated_at   — touched by the message counter trigger below.
alter table public.conversations
  add column if not exists contact_ref  text,
  add column if not exists contact_name text,
  add column if not exists subject      text,
  add column if not exists status       text not null default 'active',
  add column if not exists updated_at    timestamptz not null default now();

-- Constrain status to the known vocabulary (NOT VALID: new/updated rows only).
alter table public.conversations
  drop constraint if exists conversations_status_check;
alter table public.conversations
  add constraint conversations_status_check
    check (status in ('active', 'archived')) not valid;

-- The channel vocabulary the unified inbox speaks. NOT VALID so it governs only rows
-- this feature writes, never any pre-existing legacy value.
alter table public.conversations
  drop constraint if exists conversations_channel_inbox_check;
alter table public.conversations
  add constraint conversations_channel_inbox_check
    check (channel in ('email', 'sms', 'whatsapp', 'voice', 'chat')) not valid;

-- THE contact-identity key: exactly one conversation per (org, channel, contact). A
-- repeat contact resolves into the same thread; a contact_ref in org A can never
-- collide with the same string in org B. Partial (contact_ref may be NULL for a legacy
-- row); the projection always supplies a non-null ref.
create unique index if not exists conversations_org_channel_contact_uniq
  on public.conversations (org_id, channel, contact_ref)
  where contact_ref is not null;

-- Composite (id, org_id) uniqueness — the target for the messages composite FK below.
-- It is what lets a child row prove its parent lives in the SAME org, closing the
-- cross-tenant-reference gap a bare id FK leaves open.
alter table public.conversations
  drop constraint if exists conversations_id_org_uniq;
alter table public.conversations
  add constraint conversations_id_org_uniq unique (id, org_id);

-- Recent-first list read: the inbox is ordered by last activity, org-pinned.
create index if not exists conversations_org_status_last_idx
  on public.conversations (org_id, status, last_message_at desc);

-- ── (b) messages — timeline entry hardening ─────────────────────────────────
-- New columns:
--   channel        — denormalised from the conversation so a message row is
--                    self-describing (mirrors receptionist_messages.channel).
--   failure_reason — why an outbound send did not reach a provider
--                    (provider_not_configured / no_transport_channel /
--                    invalid_destination / provider_error). NULL on inbound + clean sends.
--   created_by     — the operator who composed an outbound reply (provenance). NULL for
--                    inbound (the customer) and for system-projected rows.
alter table public.messages
  add column if not exists channel        text,
  add column if not exists failure_reason text,
  add column if not exists created_by     uuid references public.users(id) on delete set null;

-- direction / status / channel vocabularies (NOT VALID: new rows only).
alter table public.messages
  drop constraint if exists messages_direction_check;
alter table public.messages
  add constraint messages_direction_check
    check (direction in ('inbound', 'outbound')) not valid;

-- Outbound lifecycle is dark-safe: a reply whose provider is unset is QUEUED (recorded,
-- never sent), not failed-hard and never crashed. Inbound lands 'received'.
alter table public.messages
  drop constraint if exists messages_status_check;
alter table public.messages
  add constraint messages_status_check
    check (status is null or status in ('received', 'queued', 'sent', 'failed', 'delivered'))
    not valid;

alter table public.messages
  drop constraint if exists messages_channel_inbox_check;
alter table public.messages
  add constraint messages_channel_inbox_check
    check (channel is null or channel in ('email', 'sms', 'whatsapp', 'voice', 'chat'))
    not valid;

-- IDEMPOTENCY on the provider message id. A provider's per-message id is globally unique
-- per provider, so a second delivery of the SAME inbound message (or a double-record of
-- the same outbound acceptance) collides here and is refused/ignored. Partial: many rows
-- (voice, chat, queued outbound) carry no provider id and are unconstrained. This is the
-- inbox-side twin of inbound_enquiries' (org_id, provider_message_id) dedup backstop.
create unique index if not exists messages_org_provider_uniq
  on public.messages (org_id, provider_id)
  where provider_id is not null;

-- COMPOSITE (conversation_id, org_id) FK — a message can only ever reference a
-- conversation IN ITS OWN ORG. The baseline already FKs conversation_id → conversations(id)
-- and org_id → organizations(id) independently, which alone would let a forged insert pair
-- a conversation from org A with org_id = B. This composite FK (onto the (id, org_id)
-- unique above) makes that structurally impossible. NOT VALID: new rows only.
alter table public.messages
  drop constraint if exists messages_conversation_org_fk;
alter table public.messages
  add constraint messages_conversation_org_fk
    foreign key (conversation_id, org_id)
    references public.conversations (id, org_id)
    on delete cascade
    not valid;

-- ── (c) counter trigger — keep the container's last_message_at fresh ─────────
-- Mirrors support_messages_after_insert: every new message advances its thread's
-- last_message_at (drives the recent-first list order) and updated_at. SECURITY DEFINER
-- with a pinned empty search_path; it touches only the parent row.
create or replace function public.touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at),
         updated_at      = now()
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation_on_message();
