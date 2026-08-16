-- ============================================================================
-- MP Wave R4 · Communications audit + reviewer + inbox consolidation
-- ----------------------------------------------------------------------------
-- GAP / RECON (measured against origin/main; prod was NOT measured — no DB
-- access from this build):
--
--   * Email (Resend) is the ONLY live outbound transport, but NOTHING records
--     what happened to an outbound message after we handed it to the provider:
--     no delivered / opened / clicked / bounced tracking. The unified inbox can
--     show `status='sent'` but never "the customer opened it" or "it bounced".
--   * There is no ONE cross-channel outbound audit — the data is scattered
--     across `messages` (inbox sends), `ai_reply_transports` /
--     `ai_reply_delivery_receipts` (receptionist SMS) with no read model over it.
--   * `whatsapp_assistant_actions` files inbound WhatsApp commitments as
--     `pending_review`, but there is NO surface to review/resolve them and no
--     columns to record who reviewed one or what they decided.
--   * Two tenant inbox surfaces still coexist — the one-way `/inbox` enquiries
--     list (reads `inbound_enquiries`) and the two-way `/inbox/conversations`
--     (reads the projected `conversations`/`messages`). The projection trigger
--     (20261135000001) mirrors every NEW enquiry into the conversation store,
--     but enquiries captured BEFORE that trigger existed were never projected.
--
-- THIS MIGRATION (additive only; no existing table/column/policy is dropped or
-- loosened):
--
--   1. `public.comm_events` — an append-only delivery-EVENT ledger. The Resend
--      delivery-events webhook (app/api/webhooks/resend) writes one row per
--      provider event (delivered/opened/clicked/bounced/…). Org-attributed by
--      matching the provider message id to an outbound `messages.provider_id`;
--      unattributable events land org-less (RLS hides them from every tenant).
--      Idempotent on (provider, provider_event_id) — the provider's per-event id
--      (Svix message id) — so an at-least-once redelivery folds to a no-op.
--
--   2. `public.messages` gains a `(id, org_id)` candidate key so `comm_events`
--      can carry the same COMPOSITE-FK cross-tenant guard the rest of the schema
--      uses (a comm_event can only ever reference a message in its own org).
--
--   3. `public.whatsapp_assistant_actions` gains reviewer columns + two new
--      terminal statuses (`converted`,`dismissed`) + a member UPDATE policy, so
--      the pending_review queue can be resolved BY A HUMAN through the app (the
--      receptionist doctrine: AI never commits work; a human converts a draft
--      into a real variation/task through the existing session-bound writer).
--
--   4. A one-time IDEMPOTENT BACKFILL projects any historical `inbound_enquiries`
--      into `conversations`/`messages` (same mapping the projection trigger uses)
--      so the unified inbox is the single, complete surface.
--
-- REVERSE DDL (for a rollback):
--   drop table if exists public.comm_events;
--   drop index if exists public.messages_id_org_uniq;
--   alter table public.whatsapp_assistant_actions
--     drop column if exists reviewed_by,
--     drop column if exists reviewed_at,
--     drop column if exists review_resolution,
--     drop column if exists review_note;
--   -- (restore the original 4-value status check; drop the member UPDATE policy)
--   -- The backfill is data-only and safe to leave in place.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2. messages: a (id, org_id) candidate key for the composite FK below.
--    id is already the PK (globally unique), so (id, org_id) is trivially unique
--    and this index cannot fail against existing data.
-- ----------------------------------------------------------------------------
create unique index if not exists messages_id_org_uniq
  on public.messages (id, org_id);

-- ----------------------------------------------------------------------------
-- 1. comm_events — the outbound delivery-event ledger.
-- ----------------------------------------------------------------------------
create table if not exists public.comm_events (
  id                  uuid        primary key default gen_random_uuid(),
  -- Org attribution. NULLABLE on purpose: a delivery event whose provider
  -- message id matches no outbound message we stored (e.g. a transactional
  -- invoice/quote email that never created a `messages` row) is unattributable
  -- to a tenant. We still record it (telemetry), but with org_id NULL — and the
  -- member SELECT policy (`org_id in current_org_ids()`) makes a NULL-org row
  -- invisible to every tenant, so an unattributed event can never leak.
  org_id              uuid        references public.organizations (id) on delete cascade,
  -- The outbound message this event concerns, when we can attribute it. NULL for
  -- unattributable events. Composite FK (below) pins it to the same org.
  message_id          uuid,
  -- The transport that produced the event. Free string (not an enum) so a new
  -- provider needs no schema edit; 'resend' is the only writer today.
  provider            text        not null default 'resend',
  -- The provider's stable per-EVENT id (Resend/Svix `svix-id`). This — not the
  -- message id — is the idempotency key: one email yields many events
  -- (delivered, opened, clicked), each with its own id, so deduping on it folds
  -- an at-least-once redelivery without collapsing distinct events.
  provider_event_id   text        not null,
  -- The provider's message id (Resend `email_id`) — the join key to messages.
  provider_message_id text,
  -- The normalised event type: delivered|opened|clicked|bounced|complained|
  -- delivery_delayed|... Free string; the read model interprets a known set.
  event_type          text        not null,
  -- The recipient the event is about (email address), for the audit read model.
  recipient           text,
  -- When the provider says the event occurred (its `created_at`), else ingest time.
  occurred_at         timestamptz not null default now(),
  -- The raw provider payload (redaction handled at DSAR-export time).
  payload             jsonb,
  created_at          timestamptz not null default now(),
  -- Cross-tenant integrity: a comm_event can only ever reference a message in
  -- its OWN org. MATCH SIMPLE (the default) skips the check when either column
  -- is NULL, so an unattributed (org_id/message_id NULL) event is still allowed.
  constraint comm_events_message_org_fkey
    foreign key (message_id, org_id)
    references public.messages (id, org_id)
    on delete set null
);

comment on table public.comm_events is
  'Append-only outbound delivery-EVENT ledger (Resend webhook). One row per '
  'provider event; org-attributed via provider_message_id -> messages.provider_id; '
  'idempotent on (provider, provider_event_id). Registered in lib/gdpr/org-tables.json '
  '`known` (exported — a customer''s comms record; the payload redactor strips secrets).';

-- Idempotency: one row per provider event. A redelivery hits this and the writer
-- treats the 23505 as a benign duplicate.
create unique index if not exists comm_events_provider_event_uniq
  on public.comm_events (provider, provider_event_id);

-- The audit read model pages an org's events newest-first.
create index if not exists comm_events_org_occurred_idx
  on public.comm_events (org_id, occurred_at desc);

-- Fold events onto their message (the audit joins by message_id, and by
-- provider_message_id when a message row is matched at ingest time).
create index if not exists comm_events_message_idx
  on public.comm_events (message_id);
create index if not exists comm_events_provider_msg_idx
  on public.comm_events (provider_message_id);

alter table public.comm_events enable row level security;

-- Member SELECT only — the tenant sees its own events (NULL-org rows excluded).
drop policy if exists "comm_events: members can select" on public.comm_events;
create policy "comm_events: members can select" on public.comm_events
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

-- NO insert/update/delete policy for `authenticated`: the ledger is written ONLY
-- by the service-role webhook handler (RLS-bypassing). Append-only is enforced by
-- the backstop triggers below, which raise for EVERY role — so not even the
-- service role can mutate or delete a recorded event.
create or replace function public.tg_comm_events_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'comm_events is append-only — % is not permitted', tg_op
    using errcode = 'check_violation';
end $$;

drop trigger if exists comm_events_no_update on public.comm_events;
create trigger comm_events_no_update
  before update on public.comm_events
  for each row execute function public.tg_comm_events_frozen();

drop trigger if exists comm_events_no_delete on public.comm_events;
create trigger comm_events_no_delete
  before delete on public.comm_events
  for each row execute function public.tg_comm_events_frozen();

-- ----------------------------------------------------------------------------
-- 3. whatsapp_assistant_actions: reviewer columns + terminal statuses + a
--    member UPDATE policy so a human can resolve the pending_review queue.
-- ----------------------------------------------------------------------------
alter table public.whatsapp_assistant_actions
  add column if not exists reviewed_by       uuid references public.users (id) on delete set null,
  add column if not exists reviewed_at        timestamptz,
  add column if not exists review_resolution  text,
  add column if not exists review_note        text;

comment on column public.whatsapp_assistant_actions.reviewed_by is
  'The member who resolved this pending_review action (converted/dismissed). NULL until reviewed.';
comment on column public.whatsapp_assistant_actions.review_resolution is
  'What the reviewer did: converted (handed to the real variation/task writer) or dismissed.';

-- Extend the status vocabulary to carry the human decision. The original inline
-- CHECK is auto-named `whatsapp_assistant_actions_status_check`; drop it and add
-- the superset (all original values PLUS converted/dismissed) so existing rows
-- stay valid and CI cannot fail against current data.
alter table public.whatsapp_assistant_actions
  drop constraint if exists whatsapp_assistant_actions_status_check;
alter table public.whatsapp_assistant_actions
  add constraint whatsapp_assistant_actions_status_check
  check (status in ('created', 'pending_review', 'skipped', 'failed', 'converted', 'dismissed'));

-- Members may UPDATE their org's actions (the reviewer resolution). Writes still
-- ride the user-JWT client AND an explicit active-org pin in the server action;
-- this policy is the tenant boundary (the service-role insert path is unchanged).
drop policy if exists "whatsapp_assistant_actions: members can update" on public.whatsapp_assistant_actions;
create policy "whatsapp_assistant_actions: members can update" on public.whatsapp_assistant_actions
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

-- Fast lookup of the pending queue per org.
create index if not exists whatsapp_assistant_actions_org_status_idx
  on public.whatsapp_assistant_actions (org_id, status, created_at desc);

-- ----------------------------------------------------------------------------
-- 4. Backfill: project historical inbound_enquiries into the unified store.
--    IDEMPOTENT — safe to run repeatedly and safe alongside the projection
--    trigger (which already handles every enquiry inserted after it existed).
--
--    Step 4a: ensure a conversation exists per (org, mapped channel, contact_ref)
--    — the SAME identity the trigger's UPSERT uses. ON CONFLICT DO NOTHING.
--    Step 4b: insert an inbound message per enquiry ONLY when no corresponding
--    inbound message already exists in that conversation (so a row the trigger
--    already projected is never duplicated). The guard matches on the provider
--    message id when present (exact), else on body text (the null-provider case).
-- ----------------------------------------------------------------------------
insert into public.conversations (org_id, channel, contact_ref, last_message_at, created_at)
select
  e.org_id,
  public.inbox_channel_for_enquiry(e.channel),
  coalesce(nullif(lower(btrim(e.caller)), ''), 'enquiry:' || e.id::text) as contact_ref,
  e.created_at,
  e.created_at
from public.inbound_enquiries e
on conflict (org_id, channel, contact_ref) where contact_ref is not null
do nothing;

insert into public.messages (org_id, conversation_id, direction, channel, from_addr, body, status, provider_id, created_at)
select
  e.org_id,
  c.id,
  'inbound',
  public.inbox_channel_for_enquiry(e.channel),
  e.caller,
  e.raw_text,
  'received',
  e.provider_message_id,
  e.created_at
from public.inbound_enquiries e
join public.conversations c
  on c.org_id = e.org_id
 and c.channel = public.inbox_channel_for_enquiry(e.channel)
 and c.contact_ref = coalesce(nullif(lower(btrim(e.caller)), ''), 'enquiry:' || e.id::text)
where not exists (
  select 1
  from public.messages m
  where m.org_id = e.org_id
    and m.conversation_id = c.id
    and m.direction = 'inbound'
    and (
      -- exact match when the enquiry carries a provider message id
      (e.provider_message_id is not null and m.provider_id = e.provider_message_id)
      -- else the null-provider case: same thread + same body already projected
      or (e.provider_message_id is null and m.body is not distinct from e.raw_text)
    )
);
