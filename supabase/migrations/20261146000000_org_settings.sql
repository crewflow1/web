-- P3W2 Org config — per-org working-hours + tax/defaults settings.
--
-- WHY THIS EXISTS
-- ---------------
-- Settings already covers branding / business / quote-terms / bank details
-- (columns on public.organizations, edited by app/(app)/settings). Two general
-- pieces of org configuration have had NO home:
--
--   1. Working hours / working days. Today the ONLY place a business's hours
--      live is a FREE-TEXT string inside AI-receptionist setup
--      (ai_receptionist_setups.business_hours, AI context only) — unreadable by
--      rota / scheduling. This gives a STRUCTURED per-org config other features
--      can read for scheduling defaults.
--
--   2. Tax & defaults. VAT rates are hardcoded 0/5/20 across the app and there
--      is no org-level default VAT rate, CIS default rate, financial-year start
--      or default payment terms. This stores those defaults so surfaces can read
--      one authority instead of assuming. (This migration only ADDS the config;
--      it does NOT rip out existing hardcoded 0/5/20 usage — that wiring is a
--      separate, larger change.)
--
-- WHY A NEW TABLE, NOT MORE COLUMNS ON organizations. organizations is
-- member-UPDATEABLE at the DB (its UPDATE policy is members-of-org; admin is
-- enforced only in the server action). This config is admin-owned, so it gets
-- its OWN table whose RLS is genuinely admin-write / member-read — a member
-- cannot change the org's VAT default or working hours even by calling the API
-- directly. One row per org (unique org_id); absence of a row means "defaults"
-- (mirrors notification_preferences), so existing orgs need no backfill.
--
-- NO PII / NO SECRETS. Every column here is non-personal business configuration
-- (rates, day/time windows, term lengths). It is org-scoped and belongs in the
-- GDPR DSAR export — registered in lib/gdpr/org-tables.json (known, NOT
-- excluded) so the F-1 reverse-direction guard stays green.
--
-- Additive, RLS enabled, reversible:
--   drop table if exists public.org_settings;

create table if not exists public.org_settings (
  -- Surrogate id so the DSAR export's default stable page-order key (`id`)
  -- applies with no order_keys override. One row per org is enforced by the
  -- unique(org_id) below, not by making org_id the PK.
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null unique references public.organizations(id) on delete cascade,

  -- WORKING HOURS ----------------------------------------------------------
  -- Structured per-weekday config other features read for scheduling defaults.
  -- jsonb object keyed by the lowercase 3-letter weekday (mon..sun); each value
  -- is either null (a non-working / closed day) or {"open":"HH:MM","close":"HH:MM"}.
  -- Deep shape validation lives in lib/org-config/schema.ts (zod) at the write
  -- boundary; the DB CHECK only pins that it is a jsonb OBJECT so a scalar / array
  -- can never be stored.
  working_hours jsonb not null default jsonb_build_object(
    'mon', jsonb_build_object('open', '08:00', 'close', '17:00'),
    'tue', jsonb_build_object('open', '08:00', 'close', '17:00'),
    'wed', jsonb_build_object('open', '08:00', 'close', '17:00'),
    'thu', jsonb_build_object('open', '08:00', 'close', '17:00'),
    'fri', jsonb_build_object('open', '08:00', 'close', '17:00'),
    'sat', null,
    'sun', null
  ) check (jsonb_typeof(working_hours) = 'object'),

  -- TAX & DEFAULTS ---------------------------------------------------------
  -- Default VAT rate — one of the UK rates the app already recognises (0/5/20).
  default_vat_rate           smallint not null default 20
    check (default_vat_rate in (0, 5, 20)),
  -- Default CIS deduction rate — 0 (gross), 20 (registered), 30 (higher/unverified),
  -- matching the CIS domain's gross / standard_20 / higher_30 statuses.
  cis_default_rate           smallint not null default 20
    check (cis_default_rate in (0, 20, 30)),
  -- Financial-year start MONTH (1=Jan .. 12=Dec). UK default is April (4).
  financial_year_start_month smallint not null default 4
    check (financial_year_start_month between 1 and 12),
  -- Default payment terms in days for new invoices (0 = due on receipt).
  default_payment_terms_days smallint not null default 30
    check (default_payment_terms_days between 0 and 365),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Keep updated_at honest on every edit (shared trigger fn, used by 80+ tables).
drop trigger if exists tg_org_settings_set_updated_at on public.org_settings;
create trigger tg_org_settings_set_updated_at
  before update on public.org_settings
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — member-READ, admin-WRITE. A member of the org can read the config
-- (scheduling / pricing surfaces need it); only owners/admins can change it.
-- is_org_admin is impersonation-aware and SECURITY DEFINER (see
-- 20260701000000). No DELETE policy — a config row is removed only via the
-- org_id cascade at org teardown.
-- ---------------------------------------------------------------------------
alter table public.org_settings enable row level security;

drop policy if exists "org_settings: member read" on public.org_settings;
create policy "org_settings: member read" on public.org_settings
  for select using (org_id in (select public.current_org_ids()));

drop policy if exists "org_settings: admin insert" on public.org_settings;
create policy "org_settings: admin insert" on public.org_settings
  for insert with check (public.is_org_admin(org_id));

drop policy if exists "org_settings: admin update" on public.org_settings;
create policy "org_settings: admin update" on public.org_settings
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

comment on table public.org_settings is
  'Per-org general configuration: structured working-hours (scheduling defaults) + tax/defaults (default VAT rate, CIS default rate, financial-year start month, default payment terms). One row per org (absence = defaults). Member-read, admin-write. Non-PII, DSAR-exportable. See 20261146000000.';
