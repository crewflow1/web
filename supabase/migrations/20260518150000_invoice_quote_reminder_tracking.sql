-- Adds reminder-tracking columns so cron-driven follow-up emails don't
-- re-fire indefinitely.
--
-- Phase 8.2b — invoices.payment_reminder_sent_at
--   set when the "your invoice is due in N days" email goes out.
--
-- Phase 8.2c — invoices.overdue_reminder_sent_at
--   set when the "your invoice is X days overdue" email goes out.
--
-- Phase 8.2d — quotes.followup_sent_at
--   set when the "did you have a chance to look at our quote?" email
--   goes out.
--
-- All three are nullable and one-shot: a single follow-up per stage per
-- doc. Re-firing weekly is a future iteration (8.2e), not this PR.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards re-application.

alter table public.invoices
  add column if not exists payment_reminder_sent_at timestamp with time zone,
  add column if not exists overdue_reminder_sent_at timestamp with time zone;

alter table public.quotes
  add column if not exists followup_sent_at timestamp with time zone;

-- Partial indexes — only the rows we'll actually scan in cron queries.
create index if not exists invoices_payment_reminder_pending_idx
  on public.invoices (org_id, due_date)
  where payment_reminder_sent_at is null
    and paid_at is null
    and status in ('sent', 'draft');

create index if not exists invoices_overdue_reminder_pending_idx
  on public.invoices (org_id, due_date)
  where overdue_reminder_sent_at is null
    and paid_at is null
    and status in ('sent', 'overdue');

create index if not exists quotes_followup_pending_idx
  on public.quotes (org_id, sent_at)
  where followup_sent_at is null
    and viewed_at is null
    and accepted_at is null
    and declined_at is null;
