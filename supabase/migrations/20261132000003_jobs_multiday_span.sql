-- Multi-day job spans — an OPTIONAL end date so a job can occupy a range of
-- days on the calendar, without breaking the single-date jobs that exist today.
--
-- THE GAP THIS CLOSES. jobs carries one `scheduled_date` — a single calendar
-- booking with no duration. A two-week extension shows as a single dot on one
-- day. Adding an optional `scheduled_end_date` lets a job be a BAR across days
-- (the gantt / resource views read it) while every existing job — and every new
-- single-day job — leaves it null and behaves EXACTLY as before.
--
-- ── STRICTLY ADDITIVE, BACKWARD-COMPATIBLE ───────────────────────────────────
--   * NULL end date  → single-day job, identical to today's behaviour. Every
--     existing row is untouched and reads as a one-day booking.
--   * A CHECK guarantees an end date is only ever set alongside a start date and
--     never before it — so a span is always a real, forward window. It does NOT
--     require scheduled_date to be non-null in general (jobs may be unscheduled);
--     it only constrains the END relative to the START.
--
-- The week/month calendar keeps rendering on scheduled_date alone (unchanged);
-- the new gantt + resource-lane views (app/(app)/jobs/calendar?view=gantt|
-- resource) read the span. The drag-drop reschedule endpoint continues to move
-- scheduled_date; shifting an end date is a form edit.
--
-- Additive and reversible. To roll back:
--   alter table public.jobs drop constraint jobs_span_forward;
--   alter table public.jobs drop column scheduled_end_date;

alter table public.jobs
  add column if not exists scheduled_end_date date;

alter table public.jobs
  add constraint jobs_span_forward check (
    scheduled_end_date is null
    or (scheduled_date is not null and scheduled_end_date >= scheduled_date)
  );

-- Index the span lower bound so the gantt/resource window read stays an index
-- range scan (mirrors the existing scheduled_date access pattern).
create index if not exists jobs_org_span_idx
  on public.jobs (org_id, scheduled_date, scheduled_end_date);
