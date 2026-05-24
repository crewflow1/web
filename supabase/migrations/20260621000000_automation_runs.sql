-- Phase 4 — Automation telemetry.
--
-- One row per fired automation rule. Captures:
--   - which event triggered it (event_type)
--   - which rule ran (rule_id — stable static id)
--   - org context + the originating row (correlation id ties multiple
--     actions to the same source event for idempotency)
--   - per-action results
--   - duration + status
--
-- Idempotency model: each (rule_id, correlation_id) is UNIQUE. The
-- dispatcher checks this set before running a rule, so re-firing the
-- same event (e.g. a webhook replay) is a no-op.
--
-- Service-role only. RLS enabled with no policies. HQ ops dashboard
-- reads via createAdminClient() after isSuperAdminEmail gate.

create table if not exists public.automation_runs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  event_type      text not null,
  rule_id         text not null,
  -- Stable per-source-event identifier. Typically
  -- `{event_type}:{source_table}:{source_id}` so the same domain row
  -- can never trigger the same rule twice.
  correlation_id  text not null,
  -- Status of the whole rule run.
  status          text not null
    check (status in ('ok', 'failed', 'skipped')),
  -- jsonb summary the dispatcher returns from each action handler.
  result          jsonb,
  error_message   text,
  duration_ms     integer,
  created_at      timestamp with time zone not null default now(),
  -- Uniqueness gate for idempotency.
  unique (rule_id, correlation_id)
);

create index if not exists automation_runs_org_created_idx
  on public.automation_runs (org_id, created_at desc);
create index if not exists automation_runs_event_idx
  on public.automation_runs (event_type, created_at desc);
create index if not exists automation_runs_status_idx
  on public.automation_runs (status, created_at desc);

alter table public.automation_runs enable row level security;
