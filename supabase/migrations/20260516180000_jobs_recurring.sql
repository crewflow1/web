-- Slice 4: Scheduling / dispatch.
--
-- Adds jobs.recurring jsonb so the calendar can render a single parent
-- job as a series of occurrences without storing every instance as a
-- DB row.
--
-- Shape (validated app-side, not via CHECK):
--   { pattern: "weekly" | "biweekly" | "monthly" | "quarterly",
--     end_date?: "YYYY-MM-DD" }
--
-- A job with non-null recurring is the "parent". The calendar expands
-- the parent into virtual occurrences for the visible date range.
-- Mutations to occurrences are not modelled in v1 — edits go to the
-- parent and affect future occurrences (no per-occurrence overrides yet).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

alter table public.jobs
  add column if not exists recurring jsonb;
