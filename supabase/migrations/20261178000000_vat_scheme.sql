-- MP W1 VAT — org VAT accounting SCHEME (output-VAT basis).
--
-- WHY THIS EXISTS
-- ---------------
-- The deterministic VAT authority (lib/tax/compute.ts computeVatQuarter) has
-- always computed OUTPUT VAT on a CASH basis — it falls due when the cash is
-- received (the invoice_payments ledger). UK VAT-registered businesses may instead
-- be on the STANDARD (accrual) scheme, where output VAT falls due at the invoice
-- TAX POINT (the invoice date), whether or not it has been paid. INPUT VAT is
-- accrual under both schemes and does not move.
--
-- This column records which output-VAT basis an org accounts on. The BRANCH lives
-- in the single VAT authority (computeVatQuarter's `scheme` option) — there is
-- still exactly one VAT calculator. Default 'cash' reproduces the current
-- behaviour EXACTLY, so no existing org's figures move until it opts in.
--
-- HOME: org_settings (20261146000000) — admin-write / member-read, one row per
-- org, absence = defaults. A member cannot change the org's VAT scheme even by
-- calling the API directly (DB-enforced). Non-PII business configuration; the
-- table is already registered in lib/gdpr/org-tables.json (known, not excluded),
-- so the DSAR census stays green with no reverse-direction drift.
--
-- Additive, constant-default column = metadata-only DDL on PG15 (no table
-- rewrite, no data movement, no cash-path trigger touched) behind a bounded lock.
-- Reversible: alter table public.org_settings drop column if exists vat_scheme;
set local lock_timeout = '5s';

alter table public.org_settings
  add column if not exists vat_scheme text not null default 'cash'
    check (vat_scheme in ('cash', 'standard'));

comment on column public.org_settings.vat_scheme is
  'VAT output-VAT basis: cash (output VAT when paid — DEFAULT, existing behaviour) or standard (output VAT at the invoice tax point / accrual). Drives the output leg only inside lib/tax/compute.ts computeVatQuarter; input VAT is accrual under both. Default reproduces existing cash-basis behaviour.';
