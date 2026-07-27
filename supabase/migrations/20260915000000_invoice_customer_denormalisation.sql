-- Issue #349 Phase 1 — anchor invoices to their customer directly.
--
-- The problem
-- -----------
-- invoices.quote_id is `on delete set null` (20260515190000_invoices.sql), so
-- an invoice today reaches its customer ONLY through its quote
-- (quote -> customer). When the quote is gone, so is the customer identity: the
-- portal can't find the invoice, its PDF 404s, and the reminder cron silently
-- stops chasing it. #348 stopped NEW orphans; this makes the invoice
-- structurally self-anchoring so losing the quote no longer loses the customer.
--
-- The shape — mirrors #351 (invoice_payments org integrity)
-- --------------------------------------------------------
--   1. customers gains a candidate key on (id, org_id). `id` is already the PK,
--      so this grants NO new uniqueness and rejects no existing row; it exists
--      solely so a composite FK can target it (Postgres requires a unique/PK
--      target).
--   2. invoices gains `customer_id`, backfilled from the source quote, with a
--      COMPOSITE FK (customer_id, org_id) -> customers (id, org_id). That makes
--      "an invoice's customer must live in the invoice's org" a DATABASE
--      invariant, enforced for every writer regardless of role — the
--      service-role/admin client included. RLS cannot express this (it guards
--      the row being written, not the FK it points at), exactly as in #351.
--
-- Nullable, deliberately
-- ----------------------
-- customer_id is NULLABLE. A pre-existing orphan invoice (quote already gone)
-- has no source to backfill from, and must NOT be dropped or block the
-- migration — repairing those is out of Phase 1 scope (Issue #349, later). New
-- invoices get customer_id set at creation (application change), and every
-- quote-derived invoice backfills below. So NULL means "legacy orphan, customer
-- unknown", not "unconstrained": the composite FK still forbids a
-- cross-org customer whenever customer_id IS set.
--
-- ON DELETE: deleting a customer cascades to their invoices (matches the
-- existing org cascade and the quote->customer relationship). ON UPDATE stays
-- NO ACTION — moving a customer between orgs is unsupported, and the FK says so.
--
-- Backfill safety — MEASURED before writing (linked project
-- jzntbskdqdopzwdqwvkp, read-only): 0 invoices total; 0 with quote_id NULL; 0
-- whose quote has no customer; 0 whose quote-customer is in a different org; 0
-- dangling quote_id. So every invoice backfills unambiguously (vacuously here).
-- Other environments were NOT measured. The backfill below is INNER-join
-- scoped and org-matched, so it can only ever set a same-org customer; any row
-- it can't resolve is simply left NULL, never guessed.

-- 1. Candidate key on customers so the composite FK has a target.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_id_org_key'
  ) then
    alter table public.customers
      add constraint customers_id_org_key unique (id, org_id);
  end if;
end $$;

-- 2. The denormalised column. Nullable; placed after quote_id conceptually
--    (Postgres appends physically — column order is not load-bearing).
alter table public.invoices
  add column if not exists customer_id uuid;

comment on column public.invoices.customer_id is
  'Denormalised customer anchor (Issue #349 Phase 1). The invoice''s own '
  'customer identity, independent of quote_id (which is ON DELETE SET NULL). '
  'NULL only for legacy orphans whose quote was already gone at migration time. '
  'Reads should prefer this over walking quote -> customer.';

-- 3. Backfill from the source quote. INNER joins + the org match mean only a
--    same-org customer can ever be written; unresolvable rows stay NULL.
update public.invoices i
   set customer_id = q.customer_id
  from public.quotes q
 where i.quote_id = q.id
   and i.customer_id is null
   and q.customer_id is not null
   and q.org_id = i.org_id;

-- 4. The invariant: a set customer_id must name a customer in the SAME org.
--    Composite FK — enforced by Postgres for every writer. NULL customer_id is
--    permitted (MATCH SIMPLE default: a partly-null key is not checked), which
--    is what lets legacy orphans coexist without being repaired here.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_customer_org_fkey'
  ) then
    alter table public.invoices
      add constraint invoices_customer_org_fkey
      foreign key (customer_id, org_id)
      references public.customers (id, org_id)
      on delete cascade;
  end if;
end $$;

comment on constraint invoices_customer_org_fkey on public.invoices is
  'Tenant integrity (Issue #349 Phase 1): an invoice may reference only a '
  'customer in the same org. RLS cannot enforce this — it guards the row being '
  'written, not the customer the row points at. Mirrors #351.';

-- 5. Index the new FK column for the customer-scoped invoice reads (portal,
--    customer detail, reporting). The composite unique on customers already
--    indexes the referenced side.
create index if not exists invoices_customer_id_idx
  on public.invoices (customer_id)
  where customer_id is not null;
