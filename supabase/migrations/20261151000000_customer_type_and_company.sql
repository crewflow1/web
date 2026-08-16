-- Companies as a first-class CRM entity — business vs individual customers,
-- firmographics, and an OPTIONAL grouping so multiple customer records (sites,
-- branches, named contacts held as their own rows) can ROLL UP under one
-- business account.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY (recon)
-- ─────────────────────────────────────────────────────────────────────────────
-- Today `customers` is a flat person record: name / email / phone / address /
-- notes. There is no business-vs-individual distinction and no hierarchy, so a
-- multi-site B2B client (one company, several sites/contacts) cannot be grouped
-- and rolled up. This migration adds that, ADDITIVELY and BACKWARD-COMPATIBLY:
-- every existing row stays valid and unchanged.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. customer_type      — 'individual' | 'business'. DEFAULT 'individual' so
--                         every existing row is valid the instant this lands and
--                         nothing about the current UI behaviour changes.
-- 2. company_number     — Companies House registration (business only, optional).
--    vat_number         — UK VAT number, same validation the CIS module uses.
--                         Both are NULLABLE with no default; they apply only when
--                         the operator marks a customer as a business.
-- 3. parent_customer_id — nullable self-reference. The MINIMAL grouping design:
--                         no new table (so no lib/gdpr/org-tables.json change —
--                         the customers table is already registered), no
--                         membership join. A child customer (a site/contact row)
--                         points at ONE parent business; NULL = ungrouped (the
--                         default for every existing and future row).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY — tenant integrity + RLS
-- ─────────────────────────────────────────────────────────────────────────────
-- The parent link is bound by a COMPOSITE FK (parent_customer_id, org_id) →
-- customers (id, org_id), the same candidate key (customers_id_org_key, live
-- since 20260915) that invoices / jobs / customer_contacts already use. A parent
-- in ANOTHER org is therefore UNREPRESENTABLE for every role including
-- service_role — RLS alone can't do this, as it guards the row being written,
-- not the row it points at.
--
-- RLS: unchanged and still sufficient. These are columns on the EXISTING
-- customers table, whose policies (20260515150000) scope SELECT/INSERT/UPDATE to
-- org members and DELETE to admins/owners via org_id. New columns inherit them;
-- no policy touches specific columns, so nothing to re-grant.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TEARDOWN SAFETY (the 20261052 lesson)
-- ─────────────────────────────────────────────────────────────────────────────
-- The self-FK uses the PG15+ column-list form `on delete set null
-- (parent_customer_id)` — deleting a parent business UN-GROUPS its children
-- (parent_customer_id → NULL) rather than deleting them, and crucially leaves
-- the NOT NULL org_id intact (a plain composite SET NULL would try to null
-- org_id too). This mirrors jobs_customer_org_fkey / quotes' cross-tenant FKs.
-- On an org teardown the children are removed by the existing
-- customers_org_id_fkey CASCADE regardless; the SET NULL edge never blocks it.
--
-- Fully additive + idempotent. No backfill, no data rewrite, no RESTRICT.

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table public.customers
  add column if not exists customer_type text not null default 'individual'
    check (customer_type in ('individual', 'business')),
  -- Companies House registration number. Business-only, optional. Lenient
  -- format (8-char UK numbers incl. SC/NI/OC prefixes) — bounded, alphanumeric.
  add column if not exists company_number text
    check (company_number is null or company_number ~ '^[A-Za-z0-9]{1,20}$'),
  -- UK VAT registration number: 9 or 12 digits, optional GB prefix. Same
  -- validation as cis_subcontractors.vat_number so the two stay in lockstep.
  add column if not exists vat_number text
    check (vat_number is null or vat_number ~ '^(GB)?([0-9]{9}|[0-9]{12})$'),
  -- Optional parent business. NULL = ungrouped (default for every row).
  add column if not exists parent_customer_id uuid;

comment on column public.customers.customer_type is
  'Business-vs-individual discriminator. DEFAULT ''individual'' keeps every '
  'pre-existing row valid and unchanged; ''business'' unlocks firmographics + '
  'child grouping in the UI. Validated with Zod at the write boundary too.';
comment on column public.customers.company_number is
  'Companies House registration number (business customers only, optional).';
comment on column public.customers.vat_number is
  'UK VAT number (business customers only, optional). Same format constraint as '
  'cis_subcontractors.vat_number.';
comment on column public.customers.parent_customer_id is
  'Optional parent business this customer rolls up under (sites/branches/'
  'contacts held as their own rows). NULL = ungrouped. Bound to the same org by '
  'customers_parent_org_fkey; a parent in another org is unrepresentable.';

-- ── 2. No-self-parent guard ─────────────────────────────────────────────────
-- A customer can never be its own parent. Added separately (not inline) so the
-- ADD is idempotent across re-runs.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_parent_not_self'
  ) then
    alter table public.customers
      add constraint customers_parent_not_self
      check (parent_customer_id is null or parent_customer_id <> id);
  end if;
end $$;

-- ── 3. Composite (cross-tenant) FK for the parent link ──────────────────────
-- (parent_customer_id, org_id) → customers (id, org_id). MATCH SIMPLE default:
-- a NULL parent is not checked, so ungrouped rows are unaffected. ON DELETE SET
-- NULL (parent_customer_id) un-groups children on parent delete while keeping
-- org_id NOT NULL (PG15+ column-list form — see module note).
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_parent_org_fkey'
  ) then
    alter table public.customers
      add constraint customers_parent_org_fkey
      foreign key (parent_customer_id, org_id)
      references public.customers (id, org_id)
      on delete set null (parent_customer_id);
  end if;
end $$;

comment on constraint customers_parent_org_fkey on public.customers is
  'Tenant integrity: a customer may roll up only under a parent in the SAME '
  'org. RLS cannot enforce this — it guards the row being written, not the '
  'parent it points at. Mirrors invoices_customer_org_fkey (#349). ON DELETE '
  'SET NULL (parent_customer_id) un-groups children on parent delete while '
  'preserving the NOT NULL org_id.';

-- ── 4. Indexes ──────────────────────────────────────────────────────────────
-- Roll-up read: "children of this business, in this org".
create index if not exists customers_org_parent_idx
  on public.customers (org_id, parent_customer_id)
  where parent_customer_id is not null;

-- List-page type filter: "businesses in this org", newest first.
create index if not exists customers_org_type_idx
  on public.customers (org_id, customer_type, created_at desc);
