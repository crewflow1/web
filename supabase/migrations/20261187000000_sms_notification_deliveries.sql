-- MP Wave W4 — SMS notification channel: the per-recipient send queue.
--
-- WHY THIS EXISTS
-- ---------------
-- The notification OS delivers in-app + email + Web Push today. The SMS channel
-- had an eligibility/preference pipeline (notification_preferences.sms_enabled,
-- lib/notifications/preferences.ts resolveSmsDelivery) but NO transport: emit
-- resolved WHO would receive an SMS and then sent nothing (darkReason
-- "no_transport"). A real Twilio transport already exists behind the comms seam
-- (lib/comms getSmsProvider → lib/comms/providers/twilio.ts). This migration adds
-- the missing STORAGE that lets emit ENQUEUE per-recipient SMS rows (network-free)
-- which the sms-drain cron then DISPATCHES via that transport — exactly mirroring
-- push_deliveries + the push-drain cron (20261166000000_push_notifications.sql).
--
-- TWO-SWITCH DARK (unchanged by this migration — it only adds inert storage):
--   * SWITCH 1 (config): TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM
--     (and COMMS_SMS_PROVIDER not disabled). Absent (the CI/dev/prod default) ⇒
--     getSmsProvider() is null ⇒ enqueue writes NOTHING and the drain marks any
--     stray row 'skipped' (refuse-before-send). No creds, no send.
--   * SWITCH 2 (opt-in): per-user, per-category notification_preferences.sms_enabled
--     (DEFAULT FALSE — opt-in; critical categories always eligible). Resolved in
--     application code (resolveSmsDelivery) before a row is ever enqueued here.
--
-- This table is inert until BOTH switches are satisfied. Additive + idempotent.
-- RLS enabled, NO anon/authenticated policy ⇒ default-deny (service-role only),
-- identical to push_deliveries. No SECURITY DEFINER functions.

-- =====================================================================
-- sms_deliveries — per-recipient SMS send queue (service-role only)
-- =====================================================================

-- The (id, org_id) composite key on notifications is created by the push
-- migration (20261166000000); recreate defensively so this migration is
-- independently applicable and the composite FK below always resolves.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_id_org_key') then
    alter table public.notifications add constraint notifications_id_org_key unique (id, org_id);
  end if;
end $$;

create table if not exists public.sms_deliveries (
  id              uuid        primary key default gen_random_uuid(),
  notification_id uuid        not null,
  org_id          uuid        not null references public.organizations (id) on delete cascade,
  constraint sms_deliveries_notif_org_fkey
    foreign key (notification_id, org_id) references public.notifications (id, org_id) on delete cascade,
  user_id         uuid        not null references auth.users (id) on delete cascade,
  -- Denormalised category (from the source notification) so the drain never has
  -- to re-join to decide anything; the eligibility decision was already made at
  -- enqueue time (resolveSmsDelivery + the sms_enabled preference).
  category        text        not null check (char_length(category) between 1 and 40),
  status          text        not null default 'queued'
                    check (status in ('queued', 'sent', 'failed', 'skipped')),
  retry_count     integer     not null default 0,
  last_error      text,
  -- The E.164 number the SMS was actually dispatched to, recorded at SEND time
  -- (the phone is resolved at drain time from public.users.phone so a number
  -- change between enqueue and send is honoured). Null until a send is attempted.
  to_phone        text,
  -- The transport's correlation id for the accepted message (Twilio message sid),
  -- recorded on a successful send so an async delivery receipt can be tied back.
  provider_message_id text,
  scheduled_for   timestamptz not null default now(),
  sent_at         timestamptz,
  failed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Idempotency: one delivery per (notification, recipient). Re-emitting the same
  -- notification (or an org-wide fan-out that overlaps a directed row) never
  -- double-queues — the enqueue upsert ignores the collision.
  constraint sms_deliveries_notification_user_uniq unique (notification_id, user_id)
);

comment on table public.sms_deliveries is
  'Per-recipient SMS send queue (mirror of push_deliveries / notification_email_queue). '
  'emit enqueues a row network-free; /api/cron/sms-drain dispatches it via the Twilio '
  'transport (lib/comms getSmsProvider) with exponential-backoff retry. Pure runtime '
  'delivery state — service-role only: RLS enabled with no anon/authenticated policy '
  '=> default-deny. Dark until Twilio is configured AND a per-category sms_enabled opt-in.';

-- The drain scans queued rows whose scheduled_for is in the past; a partial index
-- keeps that selection cheap as the table grows.
create index if not exists sms_deliveries_queued_idx
  on public.sms_deliveries (scheduled_for)
  where status = 'queued';

drop trigger if exists sms_deliveries_set_updated_at
  on public.sms_deliveries;
create trigger sms_deliveries_set_updated_at
  before update on public.sms_deliveries
  for each row execute function public.tg_set_updated_at();

-- Service-role only: RLS on, NO policy for anon/authenticated => default-deny.
-- service_role bypasses RLS. Belt-and-suspenders revoke of the default grants.
alter table public.sms_deliveries enable row level security;
revoke all on table public.sms_deliveries from anon, authenticated;
