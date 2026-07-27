-- WhatsApp AI Assistant (PR3) — inbound message provider metadata + downstream idempotency.
--
-- The whatsapp_webhook_events claim (20260917) stops a re-delivery at the INGRESS. This is
-- the DOWNSTREAM backstop: even if two ingress rows somehow both reached
-- processInboundEnquiry, the same provider message must create at most one inbound_enquiries
-- row. The handler now inserts with `provider_message_id` set and short-circuits on the 23505
-- from the partial unique index below — a DB guarantee, not app logic.
--
-- Part 11 (message + provider metadata): the authoritative inbound record is
-- `inbound_enquiries`; these are the ONLY WhatsApp fields with a real draft-first consumer —
--   • provider_message_id — the Meta wamid, written by handleMessage; the idempotency key;
--   • provider_timestamp  — the provider's send time (feeds a future session-window check);
--   • has_media           — operator visibility + the gate for a later media ring.
-- The sender wa_id is already `caller`; message type/caption/media-id/mime have NO draft-first
-- consumer and are preserved forensically in whatsapp_webhook_events.payload — not added here
-- (no speculative columns). Outbound provider ids live on ai_reply_transports; delivery/read
-- state on ai_reply_delivery_receipts. There is NO second WhatsApp message table.
--
-- Every change is additive/nullable/defaulted: existing inbound_enquiries rows are byte-for-
-- byte unchanged, and the partial unique index constrains ONLY rows that set
-- provider_message_id (new WhatsApp ingestions) — legacy/phone/SMS rows with NULL are untouched
-- and any number of them coexist.

alter table public.inbound_enquiries
  add column if not exists provider_message_id text,
  add column if not exists provider_timestamp  timestamp with time zone,
  add column if not exists has_media           boolean not null default false;

comment on column public.inbound_enquiries.provider_message_id is
  'Stable per-message id from the channel provider (Meta wamid / Twilio SID). The downstream '
  'idempotency key: the partial unique index below makes a replay a no-op.';

-- Idempotency: at most one enquiry per (org, provider message). Partial, so it constrains only
-- provider-tagged rows — rows with NULL provider_message_id are untouched (multiple NULLs
-- coexist, both because SQL NULLs are distinct AND because the partial predicate excludes them).
-- org_id is in the key because a provider message id is only meaningful within its owning org;
-- it is defense-in-depth atop globally-unique wamids.
create unique index if not exists inbound_enquiries_provider_msg_uniq
  on public.inbound_enquiries (org_id, provider_message_id)
  where provider_message_id is not null;
