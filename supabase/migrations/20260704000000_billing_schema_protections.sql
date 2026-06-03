-- Billing schema protections (launch stabilization).
--
-- Two DB-level guards that backstop the application-layer fixes:
--
--   1. invoices(quote_id) PARTIAL UNIQUE index — the universal backstop for
--      double-invoicing. acceptQuoteAsOwner, acceptQuoteByToken AND the manual
--      POST /api/invoices route all auto-create a draft invoice from a quote.
--      An in-code reuse guard now exists on the owner-accept path, but a DB
--      constraint enforces "at most one invoice per quote" across EVERY path
--      and under concurrent submits. Partial (WHERE quote_id IS NOT NULL)
--      because quote_id is nullable: standalone/manual invoices carry no
--      quote_id and must not collide with one another.
--
--   2. quotes_customer_id_fkey ON DELETE RESTRICT (made explicit). Quotes are
--      financial records and quotes.customer_id is NOT NULL, so neither
--      CASCADE (destroys the quote) nor SET NULL (NOT NULL violation; would
--      also introduce a brand-new nullable state to audit app-wide) is safe.
--      RESTRICT is already the effective behaviour (the constraint currently
--      has no explicit ON DELETE, i.e. NO ACTION) — we codify it so deleting a
--      customer who still has quotes is intentionally blocked rather than
--      relying on the implicit default.
--
-- Idempotent: re-running is a no-op (IF NOT EXISTS on the index; guarded FK
-- swap keyed on confdeltype; the dedupe UPDATE matches zero rows once each
-- quote has <= 1 linked invoice). NON-destructive: the dedupe UNLINKS
-- redundant duplicate invoices (quote_id := NULL) — it never deletes an
-- invoice row.

-- ---------------------------------------------------------------------------
-- 1a. One-time data repair. A pre-fix double-accept could leave more than one
--     invoice pointing at the same quote, which would block the UNIQUE index
--     below. Keep the earliest-created invoice linked to each quote (the
--     original — typically already 'sent' and job-linked) and NULL quote_id on
--     the rest. No invoice row is deleted; the redundant draft simply loses
--     its quote link and can be reviewed/removed by an operator.
-- ---------------------------------------------------------------------------
with ranked as (
  select id,
         row_number() over (
           partition by quote_id
           order by created_at asc, id asc
         ) as rn
  from public.invoices
  where quote_id is not null
)
update public.invoices i
set quote_id = null
from ranked r
where i.id = r.id
  and r.rn > 1;

-- ---------------------------------------------------------------------------
-- 1b. Enforce at most one invoice per quote at the database level.
-- ---------------------------------------------------------------------------
create unique index if not exists invoices_quote_id_unique
  on public.invoices (quote_id)
  where quote_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Codify the quotes -> customers delete behaviour as explicit RESTRICT.
--    Drop + re-add only when it isn't already RESTRICT ('r'), so a re-run of
--    this migration is a clean no-op.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'quotes_customer_id_fkey'
      and conrelid = 'public.quotes'::regclass
      and confdeltype <> 'r'
  ) then
    alter table public.quotes drop constraint quotes_customer_id_fkey;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'quotes_customer_id_fkey'
      and conrelid = 'public.quotes'::regclass
  ) then
    alter table public.quotes
      add constraint quotes_customer_id_fkey
      foreign key (customer_id) references public.customers(id) on delete restrict;
  end if;
end $$;
