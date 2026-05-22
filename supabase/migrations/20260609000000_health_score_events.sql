-- CrewFlow HQ — Health-score history (HQ-6).
--
-- The cached current health score already lives on organizations
-- (`health_score` smallint, `health_recomputed_at` timestamp — both
-- added in 20260606000000). This migration adds the HISTORY table
-- so we can answer "what was customer X's health 7 days ago?" and
-- "what triggered this drop?"
--
-- One row per recompute that actually changed the score (or that
-- was forced). The cron will skip writing when the score is
-- unchanged so the table doesn't bloat.
--
-- Service-role only: RLS enabled, no policies. Access goes through
-- /admin/* pages gated by isSuperAdminEmail.

create table if not exists public.health_score_events (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- What kicked off the recompute. Helps future debugging — was
  -- this the nightly cron or a webhook firing on payment change?
  trigger         text not null check (trigger in (
    'cron',
    'invoice_change',
    'payment_change',
    'migration_change',
    'login_change',
    'manual',
    'backfill'
  )),
  old_score       smallint check (old_score is null or (old_score between 0 and 100)),
  new_score       smallint not null check (new_score between 0 and 100),
  delta           smallint generated always as (new_score - coalesce(old_score, new_score)) stored,
  -- Pull the per-signal `reasons` list out of computeHealthScore so
  -- the analytics page can show "Health dropped because Migration
  -- went from 70%→40%".
  reasons         jsonb not null default '[]'::jsonb,
  -- Stamp the recompute, separate from created_at so a backfill
  -- can carry a historical recomputed_at.
  recomputed_at   timestamp with time zone not null default now(),
  created_at      timestamp with time zone not null default now()
);

alter table public.health_score_events enable row level security;
-- No policies → service-role only.

-- Hot lookup: "show me the last 30 days for org X".
create index if not exists health_score_events_org_recent_idx
  on public.health_score_events (org_id, recomputed_at desc);

-- Trigger-distribution queries from the analytics page
-- ("how many recomputes did the nightly cron do this week?").
create index if not exists health_score_events_trigger_idx
  on public.health_score_events (trigger, recomputed_at desc);

-- Movement queries: "show every org that dropped by 10+ this week".
create index if not exists health_score_events_delta_idx
  on public.health_score_events (recomputed_at desc, delta)
  where delta is not null;
