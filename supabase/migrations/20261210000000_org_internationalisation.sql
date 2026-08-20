-- =============================================================================
-- Vision-2030 Phase-15 — ORGANISATION INTERNATIONALISATION CONFIG
-- =============================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- CrewFlow was built UK-only: money renders GBP/en-GB, tax is HMRC (VAT/CIS/PAYE),
-- phones assume +44, dates render Europe/London. This wave introduces the
-- ARCHITECTURAL seam for multi-country readiness. It does NOT implement any other
-- country's tax code — it records, per org, the identity dimensions the rest of the
-- platform reads to pick a locale/currency/jurisdiction: so the SAME codebase can
-- one day serve a non-UK org while every EXISTING org stays byte-identical.
--
-- The organizations table ALREADY carries two of the six dimensions:
--     country  text not null default 'GB'              (baseline schema)
--     timezone text not null default 'Europe/London'   (baseline schema)
-- This migration adds the remaining FOUR as additive, constant-default columns:
--     locale           default 'en-GB'   — BCP-47 tag for number/date/message formatting
--     currency         default 'GBP'     — ISO 4217 base currency (the money identity)
--     tax_jurisdiction default 'UK'      — selects the tax/payroll jurisdiction impl
--     phone_region     default 'GB'      — ISO 3166-1 alpha-2 default region for phone parsing
--
-- DEFAULT-SAFETY (load-bearing)
-- -----------------------------
-- Every default reproduces the pre-wave hardcoded behaviour EXACTLY:
--   GBP + en-GB  = lib/money.ts formatGbp / lib/time/format.ts UK_LOCALE
--   Europe/London = lib/time/format.ts UK_TIME_ZONE
--   UK            = the HMRC VAT/CIS/PAYE authorities (lib/tax, lib/cis, lib/payroll)
--   GB            = lib/phone.ts UK_COUNTRY_CODE fall-through
-- So a backfill of every existing row lands on the value the code already assumed,
-- and NO existing org's money, tax, payroll, dates or phone can move. The
-- formatters and the tax jurisdiction registry consult these columns but fall back
-- to the same UK constants when a value is absent (belt-and-braces for pre-migration
-- / backfill-miss rows), so the wave is inert until an org is provisioned non-UK.
--
-- WHERE ENFORCED IN TS
-- --------------------
--   lib/i18n/config.ts             — the shape, defaults + normalisers (single source)
--   lib/money.ts                   — formatCurrency(value, { locale, currency })
--   lib/tax/jurisdiction.ts        — getTaxJurisdiction(tax_jurisdiction) → UK impl
--   lib/phone.ts                   — region-aware normalisation (GB default)
--   lib/time/format.ts             — formatDateInZone(input, { locale, timeZone })
--   server/auth/session.ts         — surfaces org.i18n on the request context
--
-- Additive, constant-default columns = metadata-only DDL on PG15 (no table rewrite,
-- no data movement, no trigger touched) behind a bounded lock. RLS is unchanged —
-- these live on organizations, whose existing member-scoped policies already apply.
-- Reversible: alter table public.organizations drop column if exists <col>;
-- =============================================================================

set local lock_timeout = '5s';

alter table public.organizations
  add column if not exists locale text not null default 'en-GB'
    -- BCP-47-ish shape guard: language, optional script/region subtags. Keeps a
    -- malformed value out of the DB; the TS normaliser still degrades unknowns to
    -- the default at the read boundary.
    check (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$');

alter table public.organizations
  add column if not exists currency text not null default 'GBP'
    -- ISO 4217 alpha-3, upper-case. The org's BASE currency (the money identity all
    -- stored amounts are denominated in). Historical amounts stay GBP.
    check (currency ~ '^[A-Z]{3}$');

alter table public.organizations
  add column if not exists tax_jurisdiction text not null default 'UK'
    -- Selects the tax/payroll jurisdiction implementation. 'UK' is the only
    -- first-class impl today (HMRC VAT/CIS/PAYE); others plug in later.
    check (tax_jurisdiction ~ '^[A-Z]{2,8}$');

alter table public.organizations
  add column if not exists phone_region text not null default 'GB'
    -- ISO 3166-1 alpha-2 default region for parsing free-form / national phone
    -- numbers (libphonenumber-js). 'GB' reproduces the +44 fall-through.
    check (phone_region ~ '^[A-Z]{2}$');

comment on column public.organizations.locale is
  'BCP-47 locale tag for number/date/message formatting. Default en-GB reproduces the pre-wave hardcoded formatting. Read by lib/money.ts + lib/time/format.ts + lib/i18n.';
comment on column public.organizations.currency is
  'ISO 4217 base currency (the money identity all stored amounts are denominated in). Default GBP preserves historical monetary meaning. Read by lib/money.ts formatCurrency.';
comment on column public.organizations.tax_jurisdiction is
  'Selects the tax/payroll jurisdiction impl (lib/tax/jurisdiction.ts). Default UK = the HMRC VAT/CIS/PAYE authorities. Other jurisdictions plug in later; UK behaviour is unchanged.';
comment on column public.organizations.phone_region is
  'ISO 3166-1 alpha-2 default region for phone parsing (lib/phone.ts). Default GB reproduces the +44 fall-through for existing tenants.';
