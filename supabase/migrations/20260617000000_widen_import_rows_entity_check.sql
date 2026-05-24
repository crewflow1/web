-- Migration OS hotfix.
--
-- PR #90 (SHA ce2b00d) added three new entity types — job / quote /
-- payment — to the TypeScript registry (lib/imports/detect.ts) and
-- to the commit pipeline (app/(app)/imports/actions.ts), but the
-- matching Postgres CHECK constraint on `import_rows.entity_type`
-- was never widened. Result: when the heuristic classifier tags a
-- sheet as one of the new types, the bulk INSERT into `import_rows`
-- fails the CHECK at upload time, aborting the entire session
-- before the operator ever reaches the review screen.
--
-- This migration widens the CHECK to include the three new types.
-- No data-shape change — just admitting values the app already
-- generates.
--
-- Idempotent: drops + re-adds. Safe on any environment where the
-- previous constraint name matches; new envs land directly on the
-- wide version.

alter table public.import_rows
  drop constraint if exists import_rows_entity_type_check;

alter table public.import_rows
  add constraint import_rows_entity_type_check
  check (
    entity_type in (
      'customer',
      'invoice',
      'lead',
      'staff',
      'cost',
      'supplier',
      'job',
      'quote',
      'payment',
      'unknown'
    )
    or entity_type is null
  );
