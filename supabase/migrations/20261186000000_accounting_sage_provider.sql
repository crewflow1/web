-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIT 'sage' AS A THIRD ACCOUNTING PROVIDER
--
-- WHAT THIS IS. The accounting-connect substrate (migration 20261095) shipped a
-- provider vocabulary of exactly ('xero', 'quickbooks'), and the push-once ledger
-- (20261110) + the export log (20261093) pinned the same two-value vocabularies.
-- This wave adds a third bookkeeping adapter — Sage Business Cloud Accounting —
-- built on the SAME two-switch dark gate (FEATURE_ACCOUNTING_CONNECT +
-- SAGE_CLIENT_ID/SECRET). For a `sage` connection / pushed-entity / export-log row
-- to be REPRESENTABLE, three CHECK constraints must admit the new value.
--
-- WHY A MIGRATION AT ALL. The provider / format vocabularies are DB-enforced (a
-- CHECK, deliberately, so a bad value is a database error, not an app-only one).
-- The value set is the ONE thing that has to change to make Sage storable; the
-- new value stays otherwise inert until the adapter is activated. Everything else
-- (the adapter, the OAuth binding, the readiness snapshot) is code, added in the
-- same wave.
--
-- ADDITIVE + REVERSIBLE + TENANT-SAFE. This only WIDENS three CHECK constraints
-- (xero/quickbooks → xero/quickbooks/sage; csv/xero/quickbooks →
-- csv/xero/quickbooks/sage). It writes no rows, touches no RLS policy, adds no
-- trigger, and reads no token. Existing rows all still satisfy the widened checks,
-- so the rewrite validation cannot fail. It changes NOTHING about who may read or
-- write these tables — the admin-write / member-read RLS from the original
-- migrations is untouched.
--
-- The inline column checks from the original migrations carry Postgres' generated
-- names (`<table>_<column>_check`); we DROP each IF EXISTS and ADD a NAMED
-- replacement so the widened constraint is explicit and re-runs are safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. accounting_connections.provider — the bound bookkeeping provider.
alter table public.accounting_connections
  drop constraint if exists accounting_connections_provider_check;
alter table public.accounting_connections
  add constraint accounting_connections_provider_check
  check (provider in ('xero', 'quickbooks', 'sage'));

-- 2. accounting_pushed_entities.provider — the push-once ledger's provider.
alter table public.accounting_pushed_entities
  drop constraint if exists accounting_pushed_entities_provider_check;
alter table public.accounting_pushed_entities
  add constraint accounting_pushed_entities_provider_check
  check (provider in ('xero', 'quickbooks', 'sage'));

-- 3. accounting_export_log.format — the export/sync audit log's format tag.
--    syncToProvider records format = the provider, so a Sage sync's log row needs
--    'sage' to be an admissible format.
alter table public.accounting_export_log
  drop constraint if exists accounting_export_log_format_check;
alter table public.accounting_export_log
  add constraint accounting_export_log_format_check
  check (format in ('csv', 'xero', 'quickbooks', 'sage'));
