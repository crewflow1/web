-- Migration OS — "Needs review" status.
--
-- The guided-migration directive is explicit: when extraction is
-- uncertain we must surface the row for human review, NOT silently
-- drop it and NOT mark it "failed". Until now every parsed row landed
-- as `pending`, and commitImport only processed
-- `status = 'pending' AND confidence >= 50` — so low-confidence and
-- unknown-entity rows were quietly excluded from the import with no
-- visible trace. The operator had no way to see, confirm, or correct
-- them.
--
-- This migration widens the `import_rows.status` CHECK to admit a new
-- `needs_review` value. Uncertain rows are routed there at upload time
-- (app/(app)/imports/actions.ts) and surfaced in the wizard
-- (app/(app)/imports/[id]/page.tsx), where the operator can confirm,
-- re-classify, or skip each one before commit.
--
-- No data-shape change — just admitting a value the app now generates.
--
-- Idempotent: drops + re-adds the named constraint, so it is safe to
-- run on an environment that already has the narrow constraint and on a
-- fresh environment alike. The constraint name matches Postgres's
-- auto-generated name for the inline CHECK declared in
-- 20260526000000_migration_os.sql (<table>_<column>_check).
--
-- ORDERING NOTE: this migration MUST be applied before (or together
-- with) the code that writes `needs_review`. If the code ships first,
-- every uncertain row trips the old CHECK, falls back to a per-row
-- insert, fails again, and is written as `error` ("db rejected row")
-- — worse than the current behaviour. Deploy the migration with the
-- code change, never after it.

alter table public.import_rows
  drop constraint if exists import_rows_status_check;

alter table public.import_rows
  add constraint import_rows_status_check
  check (
    status in (
      'pending',
      'needs_review',
      'imported',
      'skipped',
      'error',
      'duplicate',
      'merged'
    )
  );
