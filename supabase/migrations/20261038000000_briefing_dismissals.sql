-- Daily Briefing — per-user "dismiss for today".
--
-- The dashboard Daily Briefing composes CrewFlow's live signals (overdue
-- invoices, H&S expiry, tomorrow's unassigned jobs, retention due, stalled
-- quotes, cold leads, compliance expiry) into a ranked attention feed. A user
-- can clear an item they've dealt with; it returns tomorrow if the underlying
-- condition still holds. Dismissals are PER-USER (not org-wide) and DATED, so
-- "done for today" resets each day.
--
-- Read-model only: nothing here drives money/safety state — it merely hides one
-- signal family from ONE user's feed for ONE day. Additive + reversible:
--   drop table public.briefing_dismissals;
-- No new bucket, cron, function, provider or env. Migrate-first safe: the app
-- reads it best-effort (absent table -> empty dismissal set -> full briefing).

create table if not exists public.briefing_dismissals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  -- Stable signal-family key from lib/briefing/compose.ts (BRIEFING_ITEM_KEYS),
  -- e.g. 'overdue_invoices'. Bounded so a crafted client can't store blobs.
  item_key      text not null
                  check (length(trim(item_key)) > 0 and length(item_key) <= 100),
  -- The calendar day (UTC) the dismissal applies to; the feed filters on today.
  dismissed_on  date not null default (now() at time zone 'utc')::date,
  created_at    timestamptz not null default now(),
  -- One dismissal per user per family per day (idempotent snooze).
  constraint briefing_dismissal_unique unique (org_id, user_id, item_key, dismissed_on)
);

create index if not exists briefing_dismissals_lookup_idx
  on public.briefing_dismissals (org_id, user_id, dismissed_on);

alter table public.briefing_dismissals enable row level security;

-- A user may see, create and remove ONLY their own dismissals, and only within
-- an org they belong to. org_id is validated against current_org_ids()
-- (impersonation-aware) and user_id is pinned to auth.uid() — a member can never
-- dismiss on behalf of another user or write into another tenant. No UPDATE
-- policy: a dismissal is create/delete only (least privilege).
create policy "briefing_dismissals_select_own" on public.briefing_dismissals
  for select
  using (org_id in (select public.current_org_ids()) and user_id = auth.uid());

create policy "briefing_dismissals_insert_own" on public.briefing_dismissals
  for insert
  with check (org_id in (select public.current_org_ids()) and user_id = auth.uid());

create policy "briefing_dismissals_delete_own" on public.briefing_dismissals
  for delete
  using (org_id in (select public.current_org_ids()) and user_id = auth.uid());
