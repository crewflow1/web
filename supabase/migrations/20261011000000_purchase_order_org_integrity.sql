-- Programme E reconciliation fix — purchase-order cross-tenant integrity.
--
-- 20261006 wired purchase_orders.supplier_id / job_id (and the line-items'
-- purchase_order_id) as BARE single-column FKs. RLS only checks the row's own
-- org_id, never the org of the supplier/job/parent it points at — so a writer
-- in org A could bind a PO to org B's supplier or job (the exact class of gap
-- 20260911 closed structurally for invoice_payments).
--
-- Fix: a BEFORE INSERT/UPDATE guard (mirrors tg_retention_release_guard) —
-- NOT a composite FK, because these FKs are ON DELETE SET NULL and org_id is
-- NOT NULL, so a composite FK would force ON DELETE CASCADE and wrongly delete
-- POs when a supplier/job is removed. SECURITY DEFINER + pinned search_path.

create or replace function public.tg_purchase_order_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.supplier_id is not null then
    select org_id into v_org from public.suppliers where id = new.supplier_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'purchase order: supplier % is not in this org', new.supplier_id
        using errcode = 'check_violation';
    end if;
  end if;
  if new.job_id is not null then
    select org_id into v_org from public.jobs where id = new.job_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'purchase order: job % is not in this org', new.job_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists purchase_orders_org_integrity on public.purchase_orders;
create trigger purchase_orders_org_integrity
  before insert or update on public.purchase_orders
  for each row execute function public.tg_purchase_order_org_integrity();

create or replace function public.tg_po_line_item_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.purchase_orders where id = new.purchase_order_id;
  if v_org is null or v_org <> new.org_id then
    raise exception 'purchase order line item: parent PO % is not in this org', new.purchase_order_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists po_line_items_org_integrity on public.purchase_order_line_items;
create trigger po_line_items_org_integrity
  before insert or update on public.purchase_order_line_items
  for each row execute function public.tg_po_line_item_org_integrity();
