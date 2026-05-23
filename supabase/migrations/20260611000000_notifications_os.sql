-- CrewFlow HQ — Notifications OS (HQ-8).
--
-- EXTENDS the existing public.notifications table (added in
-- 20260527000000) rather than replacing it. The existing
-- activity-log fan-out trigger + the customer-side NotificationsBell
-- component keep working unchanged.
--
-- Net effect:
--   * New columns: audience, category, priority, source_module,
--     source_id, dismissed_at, metadata, updated_at.
--   * user_id becomes nullable so we can target org-wide
--     notifications (every member sees them via RLS join through
--     org_id).
--   * RLS rewritten to handle nullable user_id AND filter by
--     audience so HQ-only rows are invisible to tenant clients.
--   * Legacy columns (related_table / related_id) preserved as
--     aliases — new helpers populate BOTH old and new columns so
--     existing readers see no behaviour change.
--
-- Separate new table:
--   public.notification_email_queue — service-role-only outbox
--     for the future email provider. Status state machine,
--     retry_count, last_error. Nothing actually sends yet — the
--     provider wrapper is a stub.

-- =====================================================================
-- Extend public.notifications
-- =====================================================================

-- 1. user_id is nullable now (org-wide notifications target user_id
--    = NULL and use org_id alone for routing).
alter table public.notifications
  alter column user_id drop not null;

-- 2. New columns.
alter table public.notifications
  add column if not exists audience      text not null default 'customer'
    check (audience in ('customer', 'hq', 'both')),
  add column if not exists category      text not null default 'other'
    check (category in (
      'support',
      'billing',
      'stripe',
      'onboarding',
      'migration',
      'demo',
      'signup',
      'health',
      'alert',
      'system',
      'other'
    )),
  add column if not exists priority      text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  add column if not exists source_module text,
  add column if not exists source_id     text,
  add column if not exists dismissed_at  timestamp with time zone,
  add column if not exists metadata      jsonb not null default '{}'::jsonb,
  add column if not exists updated_at    timestamp with time zone not null default now();

-- 3. Touch trigger keeps updated_at fresh.
create or replace function public._notifications_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists notifications_touch on public.notifications;
create trigger notifications_touch
  before update on public.notifications
  for each row execute function public._notifications_touch();

-- =====================================================================
-- RLS
-- =====================================================================

-- Drop the legacy per-user-only policies and replace with the new
-- audience + nullable-user-id aware policies. Service-role bypasses
-- RLS automatically.

drop policy if exists "notifications: own select" on public.notifications;
drop policy if exists "notifications: own update" on public.notifications;
drop policy if exists notifications_select on public.notifications;
drop policy if exists notifications_update on public.notifications;

-- Tenants see notifications when:
--   * The audience targets them (customer or both — never just 'hq')
--   * AND either the row is theirs (user_id = auth.uid()) OR it's
--     an org-wide row (user_id IS NULL) for an org they're a member
--     of (via the existing current_org_ids() helper).
create policy notifications_select on public.notifications
  for select to authenticated using (
    audience in ('customer', 'both')
    and (
      user_id = auth.uid()
      or (user_id is null and org_id in (select public.current_org_ids()))
    )
  );

-- Same predicate for UPDATE so customers can mark their own
-- notifications read / dismissed.
create policy notifications_update on public.notifications
  for update to authenticated using (
    audience in ('customer', 'both')
    and (
      user_id = auth.uid()
      or (user_id is null and org_id in (select public.current_org_ids()))
    )
  )
  with check (
    audience in ('customer', 'both')
    and (
      user_id = auth.uid()
      or (user_id is null and org_id in (select public.current_org_ids()))
    )
  );

-- HQ super-admins never read via RLS — they use the service-role
-- client which bypasses all policies. The directive's "HQ can see
-- cross-tenant HQ notifications" is satisfied by that path.

-- =====================================================================
-- Indexes — supplements the existing (user_id, created_at desc) +
-- (user_id) where read_at is null. New patterns the directive lists.
-- =====================================================================

create index if not exists notifications_org_recent_idx
  on public.notifications (org_id, created_at desc);

create index if not exists notifications_audience_idx
  on public.notifications (audience, created_at desc)
  where dismissed_at is null;

create index if not exists notifications_priority_idx
  on public.notifications (priority, created_at desc)
  where dismissed_at is null and read_at is null;

create index if not exists notifications_source_idx
  on public.notifications (source_module, source_id)
  where source_module is not null;

-- Unread + un-dismissed (the count the badge fetches most often).
create index if not exists notifications_unread_active_idx
  on public.notifications (org_id, user_id)
  where read_at is null and dismissed_at is null;

-- =====================================================================
-- notification_email_queue
-- =====================================================================
--
-- The provider integration layer. No actual send happens yet —
-- sendNotificationEmail() in lib/notifications/email.ts just inserts
-- a row with status='queued'. A future PR wires the provider
-- (Postmark / Resend) and flips rows to 'sent' or 'failed'.

create table if not exists public.notification_email_queue (
  id              uuid primary key default gen_random_uuid(),
  -- The notification this email is dispatching. NULL only if the
  -- caller wanted a transactional email outside the notification
  -- system (we don't today; here as escape hatch).
  notification_id uuid references public.notifications(id) on delete cascade,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid references public.users(id) on delete set null,

  to_email        text not null,
  -- Reply-to for HQ → customer correspondence. Defaults to the
  -- system address when null.
  reply_to_email  text,
  subject         text not null,
  body_text       text not null,
  body_html       text,

  status          text not null default 'queued'
                  check (status in ('queued', 'sent', 'failed', 'skipped')),
  retry_count     integer not null default 0 check (retry_count >= 0),
  last_error      text,

  -- Optional provider hook for idempotency / inspection.
  provider        text,
  provider_message_id text,

  created_at      timestamp with time zone not null default now(),
  scheduled_for   timestamp with time zone not null default now(),
  sent_at         timestamp with time zone,
  failed_at       timestamp with time zone,
  updated_at      timestamp with time zone not null default now()
);

alter table public.notification_email_queue enable row level security;
-- No policies → service-role only.

create index if not exists notification_email_queue_status_idx
  on public.notification_email_queue (status, scheduled_for asc)
  where status in ('queued', 'failed');

create index if not exists notification_email_queue_org_idx
  on public.notification_email_queue (org_id, created_at desc);

create index if not exists notification_email_queue_notification_idx
  on public.notification_email_queue (notification_id);

-- Touch trigger.
create or replace function public._notification_email_queue_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists notification_email_queue_touch
  on public.notification_email_queue;
create trigger notification_email_queue_touch
  before update on public.notification_email_queue
  for each row execute function public._notification_email_queue_touch();
