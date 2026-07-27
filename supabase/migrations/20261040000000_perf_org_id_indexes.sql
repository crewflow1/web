-- Performance hardening (pre-launch) — org_id indexes on tenant child tables.
--
-- Phase 1 of the pre-launch hardening pass. ADDITIVE + IDEMPOTENT only:
-- no columns, constraints, data, RLS, or behaviour change — just btree
-- indexes on the org_id (tenant) foreign-key column of five child tables
-- that have none today. Indexes change only the query PLAN, never results.
--
-- Why these five:
--   * import_rows, import_files — the HQ onboarding snapshot
--     (server/services/hq-onboarding-snapshot.ts) fans out
--     `.in("org_id", [...])` across both tables. They grow with every
--     imported row/file across EVERY org, so at scale an un-indexed org_id
--     turns that admin read into a full sequential scan of the largest
--     tables in the database.
--   * import_audit, quote_line_items, payroll_lines — every RLS policy on
--     these tables evaluates an org_id predicate (is_org_admin(org_id), or
--     org_id in (select current_org_ids())), and the Phase-5 production
--     cleanup deletes data per-org (delete ... where org_id = ?). An org_id
--     index keeps both the policy checks and the org-scoped cleanup deletes
--     off a sequential scan as these tables grow.
--
-- Scope note: foreign keys that are only ever *cascade-delete* targets
-- (e.g. import_rows.file_id, import_audit.import_row_id, quotes.lead_id) are
-- intentionally NOT indexed here — they have no read consumer today and some
-- sit on hot insert paths. They are deferred to a Phase-5-timed migration so
-- they can be built CONCURRENTLY on the then-larger tables.
--
-- Deploy note: these tables are small today, so a plain (transactional)
-- index build is sub-second and matches every prior migration in this repo.
-- If this is ever re-applied AFTER significant data growth, switch each
-- statement to the CONCURRENTLY form (and run the file outside a transaction)
-- to avoid an ACCESS EXCLUSIVE lock on a large, live table.
--
-- Verified against production immediately before release (2026-07-27, prod
-- migration tip 20261039): all five tables exist, all are effectively empty
-- (reltuples 0, 48–192 kB), and none carries an (org_id) index yet — so every
-- index below is still needed and the plain build carries no lock risk.
--
-- Timestamp note: this migration was authored as `20260711000000`, which is far
-- BEHIND the applied production tip. It had never been applied anywhere, so it
-- was renamed to the next free slot (`20261040000000`) rather than being
-- inserted into already-applied history — keeping the migration ledger strictly
-- ordered and replayable from scratch.

create index if not exists import_rows_org_id_idx
  on public.import_rows (org_id);

create index if not exists import_files_org_id_idx
  on public.import_files (org_id);

create index if not exists import_audit_org_id_idx
  on public.import_audit (org_id);

create index if not exists quote_line_items_org_id_idx
  on public.quote_line_items (org_id);

create index if not exists payroll_lines_org_id_idx
  on public.payroll_lines (org_id);

-- Down (manual; not auto-run by the migration tool):
--   drop index if exists public.import_rows_org_id_idx;
--   drop index if exists public.import_files_org_id_idx;
--   drop index if exists public.import_audit_org_id_idx;
--   drop index if exists public.quote_line_items_org_id_idx;
--   drop index if exists public.payroll_lines_org_id_idx;
