-- Phase 1 — Ops telemetry.
--
-- `cron_runs` records one row per cron invocation across all 5
-- routes (alerts-poll, notifications-drain, health-recompute,
-- invoice-reminders, quote-followup). Each row captures:
--
--   - which route ran
--   - when it started + finished (duration derivable)
--   - whether it succeeded
--   - a per-route summary jsonb (whatever the route returns)
--   - the error message + truncated stack if it failed
--
-- Powers the /admin/ops "last successful job" tile + a recent-
-- failures list. Service-role only — no RLS policies. HQ ops
-- dashboard reads via createAdminClient() after the page's
-- isSuperAdminEmail gate.

create table if not exists public.cron_runs (
  id              uuid primary key default gen_random_uuid(),
  route           text not null,
  started_at      timestamp with time zone not null default now(),
  completed_at    timestamp with time zone,
  ok              boolean,
  summary         jsonb,
  error_message   text,
  error_detail    text,
  -- Useful for the HQ dashboard's "X duration" badge without
  -- recomputing it on every render.
  duration_ms     integer
);

create index if not exists cron_runs_route_started_idx
  on public.cron_runs (route, started_at desc);

create index if not exists cron_runs_ok_started_idx
  on public.cron_runs (ok, started_at desc);

-- RLS enabled with no policies — service-role only.
alter table public.cron_runs enable row level security;
