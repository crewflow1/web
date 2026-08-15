-- P3 Notifications — per-user notification preferences + digest cursors.
--
-- WHY THIS EXISTS
-- ---------------
-- Today CrewFlow has an in-app notification centre (public.notifications) and a
-- transactional email bridge (public.notification_email_queue drained by the
-- notifications-drain cron). But there are NO per-user preferences: email routing
-- is decided purely by a notification's audience + organizations.email, and every
-- email-directive notification produces ONE email immediately. A user cannot say
-- "email me the support stuff but not onboarding" or "roll my low-priority
-- notifications into a daily digest instead of a stream of separate emails".
--
-- This migration adds the storage for that:
--
--   1. notification_preferences — one row per (org, user, category). Two channel
--      toggles (in_app_enabled, email_enabled) and an email delivery cadence
--      (immediate | daily | weekly). The ABSENCE of a row means "defaults" —
--      in-app on, email immediate — so existing behaviour is unchanged until a
--      user deliberately opts a category down. Critical categories are NEVER
--      suppressed by these rows (enforced in lib/notifications/preferences.ts,
--      not here): a declined-card / security alert always sends.
--
--   2. notification_digest_cursors — a per-(org, user) high-water-mark the digest
--      cron advances. A digest batches every digest-eligible notification created
--      SINCE the cursor into one email, then moves the cursor forward, so a
--      notification is digested exactly once and org-wide notifications (user_id
--      null, seen by every member) are correctly fanned out per user.
--
-- ACCESS MODEL
-- ------------
-- notification_preferences is USER-OWNED, org-pinned, and directly RLS-readable
-- by the browser (unlike mfa_recovery_codes, which holds secret material and is
-- service-role only): a settings page reads/writes it under the user's JWT.
--   * A user manages ONLY their OWN rows (user_id = auth.uid()) within an org
--     they belong to (org_id in current_org_ids()).
--   * Org admins may READ (select only) their members' rows within the org, so
--     an admin can audit who has muted what. Admins CANNOT write another user's
--     preferences.
-- notification_digest_cursors is pure runtime delivery state (a timestamp, no
-- business data), touched ONLY by the digest cron via the service-role client.
-- RLS is enabled with NO anon/authenticated policy => default-deny for the
-- PostgREST roles; service_role bypasses RLS.
--
-- Additive + idempotent. RLS enabled on both tables.

-- =====================================================================
-- 1. notification_preferences
-- =====================================================================

create table if not exists public.notification_preferences (
  id              uuid        primary key default gen_random_uuid(),
  org_id          uuid        not null references public.organizations (id) on delete cascade,
  user_id         uuid        not null references auth.users (id) on delete cascade,
  -- Free-text category rather than an enum: the notification category set lives
  -- in lib/notifications/types.ts (NOTIFICATION_CATEGORIES) and is READ-mapped
  -- at display time; pinning a DB enum here would force a migration every time a
  -- category is added. A CHECK keeps it non-blank + bounded.
  category        text        not null check (char_length(category) between 1 and 40),
  in_app_enabled  boolean     not null default true,
  email_enabled   boolean     not null default true,
  email_cadence   text        not null default 'immediate'
                    check (email_cadence in ('immediate', 'daily', 'weekly')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One preference row per user per category per org — the settings UI upserts
  -- on this key.
  constraint notification_preferences_user_category_uniq
    unique (org_id, user_id, category)
);

comment on table public.notification_preferences is
  'Per-user, per-category notification delivery preferences (in-app / email '
  'channel toggles + email cadence: immediate|daily|weekly). Absence of a row = '
  'defaults (in-app on, email immediate). Critical categories are never '
  'suppressed by these rows (enforced in application code). User-owned, org-'
  'pinned; admins may read within org.';

create index if not exists notification_preferences_org_user_idx
  on public.notification_preferences (org_id, user_id);

-- The digest cron scans for users who have opted a category into a batched
-- cadence; a partial index keeps that selection cheap as the table grows.
create index if not exists notification_preferences_digest_idx
  on public.notification_preferences (org_id, user_id)
  where email_enabled and email_cadence in ('daily', 'weekly');

drop trigger if exists notification_preferences_set_updated_at
  on public.notification_preferences;
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.tg_set_updated_at();

alter table public.notification_preferences enable row level security;

-- A user reads their OWN rows; org admins may also read members' rows in the org.
drop policy if exists "notification_preferences: own or admin select"
  on public.notification_preferences;
create policy "notification_preferences: own or admin select"
  on public.notification_preferences
  for select to authenticated
  using (
    (user_id = auth.uid() and org_id in (select public.current_org_ids()))
    or public.is_org_admin(org_id)
  );

-- Writes are strictly own-rows: user_id must be the caller AND the org must be
-- one they belong to. Admins do NOT get to write another user's preferences.
drop policy if exists "notification_preferences: own insert"
  on public.notification_preferences;
create policy "notification_preferences: own insert"
  on public.notification_preferences
  for insert to authenticated
  with check (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  );

drop policy if exists "notification_preferences: own update"
  on public.notification_preferences;
create policy "notification_preferences: own update"
  on public.notification_preferences
  for update to authenticated
  using (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  )
  with check (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  );

drop policy if exists "notification_preferences: own delete"
  on public.notification_preferences;
create policy "notification_preferences: own delete"
  on public.notification_preferences
  for delete to authenticated
  using (
    user_id = auth.uid() and org_id in (select public.current_org_ids())
  );

-- =====================================================================
-- 2. notification_digest_cursors
-- =====================================================================

create table if not exists public.notification_digest_cursors (
  org_id       uuid        not null references public.organizations (id) on delete cascade,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  -- ONE cursor PER CADENCE. A single per-user cursor would corrupt mixed
  -- cadences: a daily run advancing the shared cursor past a not-yet-due weekly
  -- notification would drop it from the weekly digest. Keyed by cadence, the
  -- daily and weekly high-water-marks advance independently.
  cadence      text        not null check (cadence in ('daily', 'weekly')),
  -- High-water-mark: notifications created AFTER this instant are candidates for
  -- the next digest of this cadence. A fresh user (no row) is treated by the
  -- cron as "digest a bounded recent window".
  last_sent_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (org_id, user_id, cadence)
);

comment on table public.notification_digest_cursors is
  'Per-user, per-cadence digest high-water-mark advanced by the '
  'notifications-digest cron. Runtime delivery state only (no business data). '
  'Service-role only: RLS enabled with no anon/authenticated policy.';

drop trigger if exists notification_digest_cursors_set_updated_at
  on public.notification_digest_cursors;
create trigger notification_digest_cursors_set_updated_at
  before update on public.notification_digest_cursors
  for each row execute function public.tg_set_updated_at();

-- Service-role only: RLS on, NO policy for anon/authenticated => default-deny.
-- service_role bypasses RLS. Belt-and-suspenders revoke of the default grants.
alter table public.notification_digest_cursors enable row level security;
revoke all on table public.notification_digest_cursors from anon, authenticated;
