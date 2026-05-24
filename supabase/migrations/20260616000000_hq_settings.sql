-- Phase 4 — HQ settings store.
--
-- A single-row singleton table that holds every HQ-level platform
-- setting (notification prefs, alert thresholds, billing defaults,
-- branding, support behaviour, integrations, feature flags).
--
-- Design:
--   * One row, id='singleton' (text PK). Cheap to fetch, no joins.
--   * JSONB `data` keyed by section so the app can extend categories
--     without per-section migrations.
--   * updated_at + updated_by stamped on every write. The detailed
--     audit trail lives in admin_activity_log (one entry per save).
--
-- RLS:
--   * Enabled with NO policies — service-role only. The settings
--     page is HQ-gated at the layout + the server action re-checks
--     isSuperAdminEmail before writing.

create table if not exists public.hq_settings (
  id text primary key default 'singleton'
    check (id = 'singleton'),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.hq_settings enable row level security;

-- Seed the singleton row so getSettings() always has something to
-- read. Idempotent — if the row already exists we leave the data
-- untouched.
insert into public.hq_settings (id, data)
values ('singleton', '{}'::jsonb)
on conflict (id) do nothing;

-- Bump updated_at on every UPDATE so we always have a fresh stamp
-- even if the caller forgets to set it.
create or replace function public.hq_settings_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists hq_settings_touch_updated_at on public.hq_settings;
create trigger hq_settings_touch_updated_at
  before update on public.hq_settings
  for each row execute function public.hq_settings_touch_updated_at();
