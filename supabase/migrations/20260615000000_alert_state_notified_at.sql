-- Phase 3 — Alerts scheduler dedup.
--
-- Add notified_at to admin_alert_state so the alerts cron knows
-- whether it has already fired an HQ notification for a given
-- (rule_id, org_id) pair. First firing → notification + stamp.
-- Subsequent runs see notified_at IS NOT NULL and skip.
--
-- Cleared (set back to NULL) when the alert is resolved/snoozed —
-- so a re-fire after resolution is treated as new.

alter table public.admin_alert_state
  add column if not exists notified_at timestamp with time zone;

-- Partial index for the scheduler's "alerts I haven't notified
-- about yet" lookup.
create index if not exists admin_alert_state_unnotified_idx
  on public.admin_alert_state (rule_id, org_id)
  where notified_at is null and resolved_at is null;
