-- Programme C — Purchase Orders (procurement / committed spend).
--
-- CrewFlow tracked actual costs (the `finances` ledger, read by job
-- profitability) but had NO forward commitment: what has been ORDERED from
-- suppliers but not yet billed. A purchase order is that commitment. It is
-- deliberately kept SEPARATE from `finances` — a PO is committed spend, an
-- actual cost lands only when a supplier BILL is posted (a later slice). This
-- avoids double-counting a cost as both committed and actual.
--
-- Extends the existing `suppliers` + `jobs` tables; mirrors the quotes vertical
-- (per-org number allocator, line items, per-line VAT totals). No CIS/HMRC tax
-- logic — a PO is a commercial commitment, nothing is deducted or filed.

-- ── Per-org PO number allocator (mirrors next_quote_number) ──────────────────
create or replace function public.next_po_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  select coalesce(max(cast(substring(number from 'PO-(\d+)') as int)), 0) + 1
  into next_num
  from public.purchase_orders
  where org_id = target_org
    and number ~ '^PO-\d+$';
  return 'PO-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_po_number(uuid) to authenticated;

-- ── purchase_orders ──────────────────────────────────────────────────────────
create table if not exists public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- nullable + SET NULL: keep the PO record for audit if the supplier/job is
  -- later removed (mirrors jobs.customer_id).
  supplier_id  uuid references public.suppliers(id) on delete set null,
  job_id       uuid references public.jobs(id) on delete set null,
  number       text not null,
  status       text not null default 'draft'
    check (status in ('draft', 'sent', 'received', 'cancelled')),
  supplier_reference text,
  subtotal     numeric(12, 2) not null default 0,
  vat_total    numeric(12, 2) not null default 0,
  total        numeric(12, 2) generated always as (subtotal + vat_total) stored,
  expected_date date,
  notes        text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, number)
);

create index if not exists purchase_orders_org_idx        on public.purchase_orders (org_id);
create index if not exists purchase_orders_org_status_idx on public.purchase_orders (org_id, status);
create index if not exists purchase_orders_supplier_idx   on public.purchase_orders (supplier_id);
create index if not exists purchase_orders_job_idx        on public.purchase_orders (job_id);

drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at before update on public.purchase_orders
  for each row execute function public.tg_set_updated_at();

-- ── purchase_order_line_items (mirrors quote_line_items) ─────────────────────
create table if not exists public.purchase_order_line_items (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  description       text not null,
  qty               numeric(12, 2) not null default 1,
  unit              text,
  unit_price        numeric(12, 2) not null default 0,
  vat_rate          numeric(5, 2) not null default 20,
  line_total        numeric(12, 2) not null default 0,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists po_line_items_po_idx  on public.purchase_order_line_items (purchase_order_id);
create index if not exists po_line_items_org_idx on public.purchase_order_line_items (org_id);

-- ── RLS — members manage within their org; admins delete (mirrors finances) ──
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_line_items enable row level security;

drop policy if exists "purchase_orders: members can select" on public.purchase_orders;
create policy "purchase_orders: members can select" on public.purchase_orders
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "purchase_orders: members can insert" on public.purchase_orders;
create policy "purchase_orders: members can insert" on public.purchase_orders
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "purchase_orders: members can update" on public.purchase_orders;
create policy "purchase_orders: members can update" on public.purchase_orders
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "purchase_orders: admins can delete" on public.purchase_orders;
create policy "purchase_orders: admins can delete" on public.purchase_orders
  for delete to authenticated using (public.is_org_admin(org_id));

drop policy if exists "po_line_items: members can select" on public.purchase_order_line_items;
create policy "po_line_items: members can select" on public.purchase_order_line_items
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "po_line_items: members can insert" on public.purchase_order_line_items;
create policy "po_line_items: members can insert" on public.purchase_order_line_items
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "po_line_items: members can update" on public.purchase_order_line_items;
create policy "po_line_items: members can update" on public.purchase_order_line_items
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "po_line_items: members can delete" on public.purchase_order_line_items;
create policy "po_line_items: members can delete" on public.purchase_order_line_items
  for delete to authenticated using (org_id in (select public.current_org_ids()));
