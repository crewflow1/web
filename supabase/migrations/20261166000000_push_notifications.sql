-- MP Wave R4 — Web Push (PWA) notification channel + channel-breadth toggles.
--
-- WHY THIS EXISTS
-- ---------------
-- CrewFlow's notification OS delivers in-app + email today. The PWA (manifest +
-- public/sw.js) has NO push, which is the single biggest PWA-vs-native gap — and
-- it is closable WITHOUT a native shell using standards-based Web Push (VAPID,
-- RFC 8291/8188/8292). This migration adds the STORAGE for that, plus two new
-- per-category channel toggles (push, sms) on the existing preferences matrix.
--
-- The channel stays DARK until VAPID keys are configured (env VAPID_PUBLIC_KEY /
-- VAPID_PRIVATE_KEY). The refuse-before-send gate lives in application code
-- (lib/notifications/push.ts): with no keys, nothing is enqueued and nothing is
-- sent. This migration is inert until that switch AND a per-user opt-in exist.
--
-- WHAT THIS ADDS
-- --------------
--   1. push_subscriptions   — one row per browser Web Push subscription, pinned
--                             to (org, user). Holds the endpoint URL and the
--                             subscription's p256dh + auth encryption keys (the
--                             send-side material). User-owned + org-pinned, RLS-
--                             readable/writable by the owner; org admins may READ
--                             (audit who is subscribed); the sender uses service
--                             role. GDPR: EXCLUDED from DSAR export (send-side
--                             credential / transient device state).
--
--   2. push_deliveries      — the per-recipient send queue, mirroring
--                             notification_email_queue: emit enqueues a row
--                             (network-free), the push-drain cron dispatches it
--                             via Web Push with exponential-backoff retry. Pure
--                             runtime delivery state; service-role only.
--
--   3. notification_preferences.push_enabled / .sms_enabled — extend the
--      category×channel matrix. push_enabled DEFAULTS TRUE (opt-DOWN, like email;
--      a push only ever fires for a user who has actually subscribed a device, so
--      subscribing is itself the opt-in). sms_enabled DEFAULTS FALSE (opt-IN; SMS
--      is intrusive/costly and its transport is Twilio-gated / dark). Critical
--      categories are never suppressed by these rows — enforced in
--      lib/notifications/preferences.ts, exactly as for in-app/email.
--
-- Additive + idempotent. RLS enabled on both new tables. No SECURITY DEFINER
-- functions are introduced (all access is RLS + service-role).

-- =====================================================================
-- 1. notification_preferences — new channel toggles (additive columns)
-- =====================================================================

alter table public.notification_preferences
  add column if not exists push_enabled boolean not null default true;

alter table public.notification_preferences
  add column if not exists sms_enabled boolean not null default false;

comment on column public.notification_preferences.push_enabled is
  'Per-category Web Push toggle. Default true (opt-down): a push only fires for a '
  'user who has subscribed a device, so the subscription is the real opt-in. '
  'Critical categories always deliver regardless (enforced in application code).';

comment on column public.notification_preferences.sms_enabled is
  'Per-category SMS toggle. Default false (opt-in): SMS is intrusive and its '
  'transport is Twilio-gated (dark). The preference + sender seam exist so '
  'activation is a config flip, not a schema change.';

-- =====================================================================
-- 2. push_subscriptions
-- =====================================================================

create table if not exists public.push_subscriptions (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.organizations (id) on delete cascade,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  -- The Web Push endpoint URL (the push service's per-subscription address).
  -- Globally unique: the same browser subscription must map to exactly one row,
  -- so an unsubscribe/resubscribe upserts rather than duplicating.
  endpoint      text        not null,
  -- The subscription's encryption keys (base64url): p256dh is the UA public key
  -- (65-byte P-256 point), auth is the 16-byte auth secret. Required to encrypt
  -- a payload per RFC 8291.
  p256dh        text        not null check (char_length(p256dh) between 1 and 200),
  auth          text        not null check (char_length(auth) between 1 and 100),
  -- Best-effort device label for the settings UI ("Chrome on macOS"). Not trusted.
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  updated_at    timestamptz not null default now(),
  constraint push_subscriptions_endpoint_uniq unique (endpoint)
);

comment on table public.push_subscriptions is
  'Browser Web Push subscriptions, one row per (endpoint). Holds the endpoint '
  'and the subscription encryption keys (send-side material). User-owned, org-'
  'pinned; owner reads/writes own rows, org admins may read. Sender uses service '
  'role. EXCLUDED from GDPR export (send-side credential / transient device state).';

create index if not exists push_subscriptions_org_user_idx
  on public.push_subscriptions (org_id, user_id);

drop trigger if exists push_subscriptions_set_updated_at
  on public.push_subscriptions;
create trigger push_subscriptions_set_updated_at
  before update on public.push_subscriptions
  for each row execute function public.tg_set_updated_at();

alter table public.push_subscriptions enable row level security;

-- A user reads their OWN subscriptions; org admins may also read members' rows in
-- the org (audit who is subscribed). Mirrors notification_preferences: read is
-- own-or-admin, writes are strictly own-rows.
drop policy if exists "push_subscriptions: own or admin select"
  on public.push_subscriptions;
create policy "push_subscriptions: own or admin select"
  on public.push_subscriptions
  for select to authenticated
  using (
    (user_id = auth.uid() and org_id in (select public.current_org_ids()))
    or public.is_org_admin(org_id)
  );

drop policy if exists "push_subscriptions: own insert"
  on public.push_subscriptions;
create policy "push_subscriptions: own insert"
  on public.push_subscriptions
  for insert to authenticated
  with check (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  );

drop policy if exists "push_subscriptions: own update"
  on public.push_subscriptions;
create policy "push_subscriptions: own update"
  on public.push_subscriptions
  for update to authenticated
  using (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  )
  with check (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  );

drop policy if exists "push_subscriptions: own delete"
  on public.push_subscriptions;
create policy "push_subscriptions: own delete"
  on public.push_subscriptions
  for delete to authenticated
  using (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  );

-- =====================================================================
-- 3. push_deliveries — per-recipient send queue (service-role only)
-- =====================================================================

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_id_org_key') then
    alter table public.notifications add constraint notifications_id_org_key unique (id, org_id);
  end if;
end $$;

create table if not exists public.push_deliveries (
  id              uuid        primary key default gen_random_uuid(),
  notification_id uuid        not null,
  org_id          uuid        not null references public.organizations (id) on delete cascade,
  constraint push_deliveries_notif_org_fkey
    foreign key (notification_id, org_id) references public.notifications (id, org_id) on delete cascade,
  user_id         uuid        not null references auth.users (id) on delete cascade,
  -- Denormalised category (from the source notification) so the drain never has
  -- to re-join to decide anything; the eligibility decision was already made at
  -- enqueue time.
  category        text        not null check (char_length(category) between 1 and 40),
  status          text        not null default 'queued'
                    check (status in ('queued', 'sent', 'failed', 'skipped')),
  retry_count     integer     not null default 0,
  last_error      text,
  scheduled_for   timestamptz not null default now(),
  sent_at         timestamptz,
  failed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Idempotency: one delivery per (notification, recipient). Re-emitting the same
  -- notification (or an org-wide fan-out that overlaps) never double-queues.
  constraint push_deliveries_notification_user_uniq unique (notification_id, user_id)
);

comment on table public.push_deliveries is
  'Per-recipient Web Push send queue (mirror of notification_email_queue). Pure '
  'runtime delivery state — service-role only: RLS enabled with no anon/'
  'authenticated policy => default-deny.';

-- The drain scans queued rows whose scheduled_for is in the past; a partial
-- index keeps that selection cheap as the table grows.
create index if not exists push_deliveries_queued_idx
  on public.push_deliveries (scheduled_for)
  where status = 'queued';

drop trigger if exists push_deliveries_set_updated_at
  on public.push_deliveries;
create trigger push_deliveries_set_updated_at
  before update on public.push_deliveries
  for each row execute function public.tg_set_updated_at();

-- Service-role only: RLS on, NO policy for anon/authenticated => default-deny.
-- service_role bypasses RLS. Belt-and-suspenders revoke of the default grants.
alter table public.push_deliveries enable row level security;
revoke all on table public.push_deliveries from anon, authenticated;
