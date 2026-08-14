-- P2 Communications — INBOUND EMAIL ingestion → receptionist router (DARK).
--
-- WHAT THIS IS. The database half of "a customer emails the org's inbound address
-- and the AI receptionist ingests it": org↔destination-address ROUTING
-- (email_inbound_routes), the ingress claim/replay ledger that makes the webhook
-- idempotent (email_webhook_events), and the widening of the receptionist channel
-- vocabulary so `email` is a first-class inbound channel alongside phone / sms /
-- whatsapp / instagram / facebook / manual.
--
-- Outbound email (Resend) is already live; this is the missing INBOUND edge. It
-- feeds the UNCHANGED `processInboundEnquiry` core — the same ingestion path phone,
-- SMS and WhatsApp already take — so email creates the same enquiry + lead +
-- conversation + notification, and NO new AI drafting/transport path is opened
-- (transportChannelForInbound(email) is null; canRunReceptionistChannel(email) is
-- false — a mailed reply is never sent).
--
-- ── DARK BY DEFAULT (two-switch) ────────────────────────────────────────────
-- Nothing here is reachable while the feature is off. The webhook route
-- (app/api/webhooks/email) 404s before any work unless BOTH
-- NEXT_PUBLIC_FEATURE_INBOUND_EMAIL="true" AND INBOUND_EMAIL_WEBHOOK_SECRET is set
-- — both absent in prod, CI and dev. An `email_inbound_routes` row is
-- admin-provisioned; an `email_webhook_events` row is written ONLY by the
-- service-role webhook handler. This migration writes NO rows.
--
-- ── ORG ATTRIBUTION IS A DB LOOKUP, NOT A GUESS ─────────────────────────────
-- A single shared inbound-webhook secret authenticates every tenant's delivery
-- (as with whatsapp_number_routes' shared WHATSAPP_APP_SECRET and the shared
-- CHANNEL_INBOUND_SECRET), so org attribution is a lookup on the DESTINATION
-- address the customer emailed (the infra identity they reached), never a per-org
-- credential and never a guess. An email to an address with no active route is
-- ack-dropped (claimed + completed + an HQ audit event), never processed against a
-- guessed org — an unattributable webhook must not touch tenant data.
--
-- Additive and reversible. To roll back:
--   drop table public.email_webhook_events;
--   drop table public.email_inbound_routes;
--   (and narrow the three channel CHECKs back to their pre-email vocabulary.)

-- ── (a) Widen the receptionist channel vocabulary to include 'email' ─────────
-- The channel CHECK is pinned identically on the enquiry table (20260623), the
-- conversation substrate and its message timeline (20260819). All three must admit
-- 'email' or an insert with channel='email' would be rejected by the DB. This is an
-- additive SUPERSET: every existing row already satisfies the widened predicate, so
-- there is no row rewrite and no validation failure. Widening the CHECK enables NO
-- outbound path — canRunReceptionistChannel(email) is false and
-- transportChannelForInbound(email) is null; it only lets an email enquiry be
-- RECORDED instead of rejected by the constraint.
--
-- All three are anonymous inline column checks, so PostgreSQL auto-named them
-- `<table>_channel_check` (each table has exactly one check on `channel`). Drop by
-- that deterministic name in the SAME statement as the re-add (no IF EXISTS — a
-- wrong name must fail LOUDLY in CI, never leave a stale narrow constraint silently
-- in force alongside the new one; the 20261044 transport-widening idiom).
alter table public.inbound_enquiries
  drop constraint inbound_enquiries_channel_check,
  add constraint inbound_enquiries_channel_check
    check (channel in ('phone', 'sms', 'whatsapp_msg', 'whatsapp_call',
                       'instagram_dm', 'facebook_dm', 'email', 'manual'));

alter table public.receptionist_conversations
  drop constraint receptionist_conversations_channel_check,
  add constraint receptionist_conversations_channel_check
    check (channel in ('phone', 'sms', 'whatsapp_msg', 'whatsapp_call',
                       'instagram_dm', 'facebook_dm', 'email', 'manual'));

alter table public.receptionist_messages
  drop constraint receptionist_messages_channel_check,
  add constraint receptionist_messages_channel_check
    check (channel in ('phone', 'sms', 'whatsapp_msg', 'whatsapp_call',
                       'instagram_dm', 'facebook_dm', 'email', 'manual'));

-- ── (b) email_inbound_routes — destination address → org routing ─────────────
-- The routing key is the NORMALISED destination address (lowercased + trimmed) the
-- customer emailed. UNIQUE: one org owns an inbound address. Distinct from the
-- free-text sender/reply addresses in RESEND_* config — this is the infra identity
-- the mail was addressed TO, provisioned during onboarding.
create table if not exists public.email_inbound_routes (
  id               uuid primary key default gen_random_uuid(),
  -- Normalised (lowercase, trimmed) destination address. UNIQUE routing key.
  inbound_address  text not null unique
                   check (btrim(inbound_address) <> '' and inbound_address = lower(inbound_address)),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  active           boolean not null default true,
  created_at       timestamp with time zone not null default now(),
  updated_at       timestamp with time zone not null default now()
);

create index if not exists email_inbound_routes_org_idx
  on public.email_inbound_routes (org_id);

alter table public.email_inbound_routes enable row level security;

-- Members may READ their org's routes (an operator can see which inbound address is
-- wired). Provisioning is admin/service-role: the mapping is HQ-populated during
-- onboarding, and the webhook handler resolves it on the service-role client.
-- Mirrors whatsapp_number_routes' member-read / admin-write posture exactly.
drop policy if exists "email_inbound_routes: members can select" on public.email_inbound_routes;
create policy "email_inbound_routes: members can select" on public.email_inbound_routes
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

drop policy if exists "email_inbound_routes: admins can insert" on public.email_inbound_routes;
create policy "email_inbound_routes: admins can insert" on public.email_inbound_routes
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "email_inbound_routes: admins can update" on public.email_inbound_routes;
create policy "email_inbound_routes: admins can update" on public.email_inbound_routes
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ── (c) email_webhook_events — inbound replay/claim ledger ───────────────────
-- Providers deliver AT-LEAST-ONCE and retry on any non-2xx, so the webhook must be
-- idempotent and concurrency-safe. This is the ingress claim table, mirroring the
-- whatsapp_webhook_events / billing_events / automation_runs claim protocol
-- VERBATIM:
--   - `event_key` is UNIQUE — 'email:<provider_message_id>'. A re-delivery collides.
--   - The handler INSERTs (the atomic claim); a concurrent/retry loser reclaims
--     ONLY a row that is `processed_at IS NULL` AND (failed OR its `claimed_at`
--     lease has expired). `processed_at` — never row existence — is the sole proof
--     of completion, so a crash mid-dispatch stays retryable (the #350/#355 rule).
--   - Service-role only: RLS enabled, ZERO policies — same posture as
--     whatsapp_webhook_events and the receptionist_* substrate. No tenant reads or
--     writes ingress rows; the org is resolved downstream by the routing lookup.
create table if not exists public.email_webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  -- Idempotency identity. UNIQUE so a re-delivery of the same message collides and
  -- is claimed exactly once. 'email:<provider_message_id>'.
  event_key          text not null unique,
  -- The provider's stable per-message id (RFC 5322 Message-ID / provider id).
  provider_message_id text not null,
  -- The sender + destination addresses (normalised), for operator triage.
  from_address       text,
  to_address         text,
  -- Resolved org, nullable: an unrouted address is ack-dropped, not rejected.
  org_id             uuid references public.organizations(id) on delete set null,
  payload            jsonb not null,
  -- The ONLY proof of completion. NULL = claimed but not finished = retryable.
  processed_at       timestamp with time zone,
  error_message      text,
  -- Lease clock: a 'claimed but unprocessed' row older than the handler's lease is
  -- orphaned and may be reclaimed by exactly one caller.
  claimed_at         timestamp with time zone,
  created_at         timestamp with time zone not null default now()
);

comment on column public.email_webhook_events.processed_at is
  'Sole proof of completion. Row existence is NOT proof — a crash mid-dispatch '
  'leaves this NULL so the retry re-runs, never silently drops (the #350/#355 rule).';
comment on column public.email_webhook_events.claimed_at is
  'In-flight lease clock. A processed_at-NULL row older than the handler lease is '
  'orphaned and reclaimable by exactly one caller.';

-- Operator lookups for stuck/in-flight ingress; excludes the completed majority.
create index if not exists email_webhook_events_inflight_idx
  on public.email_webhook_events (claimed_at)
  where processed_at is null;
create index if not exists email_webhook_events_org_idx
  on public.email_webhook_events (org_id, created_at desc);

alter table public.email_webhook_events enable row level security;
-- No policies: service-role / SECURITY DEFINER only, exactly like whatsapp_webhook_events.
