-- MP W1 VAT — Flat Rate Scheme (FRS) configuration.
--
-- WHY THIS EXISTS
-- ---------------
-- Under HMRC's VAT Flat Rate Scheme a business pays a single flat percentage of
-- its GROSS (VAT-inclusive) turnover as VAT and does not reclaim input VAT (bar
-- capital assets over £2,000). The flat percentage depends on the trader's sector,
-- a 1% first-year-of-registration discount, and the limited-cost-trader test
-- (16.5% when relevant-goods spend is too low). None of this had a home.
--
-- This column stores the org's FRS configuration as a validated jsonb blob:
--   { enabled, sector_percent, registration_date, first_year_discount,
--     effective_from, effective_to, limited_cost }
-- The COMPUTATION (rate resolution, LCT test, first-year discount, effective-date
-- gating, and the flat box-1 calculation) lives in the single VAT authority
-- (lib/tax/compute.ts — resolveFlatRateForPeriod + computeVatQuarter's flatRate
-- option). There is still exactly one VAT calculator. The DB default is a DISABLED
-- config, so FRS never applies and no existing org's VAT figures move until it opts
-- in. Deep shape validation is at the write boundary (lib/org-config/schema.ts,
-- zod); the DB CHECK only pins that the value is a jsonb OBJECT so a scalar/array
-- can never be stored.
--
-- HOME: org_settings (20261146000000) — admin-write / member-read, one row per
-- org, absence = defaults. A member cannot change the org's FRS config even by
-- calling the API directly (DB-enforced). Non-PII business configuration
-- (sector %, dates, flags — no personal data, no secrets); the table is already
-- registered in lib/gdpr/org-tables.json (known, not excluded), so the DSAR census
-- stays green with no reverse-direction drift.
--
-- Additive, constant-default jsonb column = metadata-only DDL on PG15 (no table
-- rewrite, no data movement, no cash-path trigger touched) behind a bounded lock.
-- Reversible: alter table public.org_settings drop column if exists flat_rate_config;
set local lock_timeout = '5s';

alter table public.org_settings
  add column if not exists flat_rate_config jsonb not null default jsonb_build_object(
    'enabled', false,
    'sector_percent', 0,
    'registration_date', null,
    'first_year_discount', false,
    'effective_from', null,
    'effective_to', null,
    'limited_cost', 'auto'
  ) check (jsonb_typeof(flat_rate_config) = 'object');

comment on column public.org_settings.flat_rate_config is
  'VAT Flat Rate Scheme config (jsonb object): { enabled, sector_percent, registration_date, first_year_discount, effective_from, effective_to, limited_cost(auto|yes|no) }. Computation lives in lib/tax/compute.ts (resolveFlatRateForPeriod + computeVatQuarter flatRate option); this is data only. Default is DISABLED, so FRS never applies until an org opts in and no existing tenant''s VAT figures change. Shape validated in lib/org-config/schema.ts. Non-PII, DSAR-exportable.';
