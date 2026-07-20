-- Financial Operations — Supplier Bills (close committed → actual).
--
-- A supplier bill is the actual invoice a supplier sends for goods/labour you
-- ordered (usually against a purchase order). Recording it must post the ACTUAL
-- cost so job profitability is truthful, and close the loop against the
-- COMMITTED spend already tracked by purchase_orders.
--
-- Design (per the architecture rule "extend the finances/expense cost flow — do
-- NOT fork"): a bill IS a `public.finances` entry, now attributable to a
-- supplier and (optionally) a purchase order. No parallel supplier_bills table.
-- This reuses finances' generated VAT, receipt attachment, job link, RLS and the
-- existing profitability feed. Both links are nullable + independent: a bill can
-- reference a PO, a supplier only (ad-hoc), or neither (a plain cost).
--
-- Additive + reversible.

alter table public.finances
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null,
  add column if not exists purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  add column if not exists reference text,   -- the supplier's own invoice number
  add column if not exists bill_date date;    -- the date printed on the supplier's invoice

-- ── DB-enforced org integrity ────────────────────────────────────────────────
-- A cost may only link to a PO / supplier in its OWN org. Single-column FKs
-- above give referential integrity + keep the cost record on parent delete
-- (SET NULL — audit history survives), but cannot stop a cross-tenant link; this
-- guard does. Mirrors the asset-domain same-org guard triggers.
create or replace function public.tg_finances_bill_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.purchase_order_id is not null
     and not exists (
       select 1 from public.purchase_orders p
       where p.id = new.purchase_order_id and p.org_id = new.org_id
     ) then
    raise exception 'purchase order % is not in this org', new.purchase_order_id
      using errcode = 'check_violation';
  end if;
  if new.supplier_id is not null
     and not exists (
       select 1 from public.suppliers s
       where s.id = new.supplier_id and s.org_id = new.org_id
     ) then
    raise exception 'supplier % is not in this org', new.supplier_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists finances_bill_org_integrity on public.finances;
create trigger finances_bill_org_integrity
  before insert or update on public.finances
  for each row execute function public.tg_finances_bill_org_integrity();

-- ── Rollup indexes (committed-vs-billed per PO; bills per supplier) ───────────
create index if not exists finances_purchase_order_id_idx
  on public.finances (purchase_order_id) where purchase_order_id is not null;
create index if not exists finances_org_supplier_idx
  on public.finances (org_id, supplier_id) where supplier_id is not null;
