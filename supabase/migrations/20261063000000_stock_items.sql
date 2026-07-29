-- O3 OPERATIONAL STOCK, part 1 of 3 — the ITEM REGISTER.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — READ THIS BEFORE CHANGING ANYTHING HERE.      ║
-- ║                                                                          ║
-- ║  This milestone is an OPERATIONAL QUANTITY LEDGER ONLY. It records       ║
-- ║  WHERE THINGS ARE, never WHAT THEY ARE WORTH.                            ║
-- ║                                                                          ║
-- ║  Stock movements NEVER post to `public.finances`. Purchased materials    ║
-- ║  are ALREADY expensed when the supplier's bill is recorded               ║
-- ║  (recordSupplierBill → finances, 20261009000000). Issuing 10 boards to   ║
-- ║  Job A records "10 boards moved Depot → Job A" and NO NEW EXPENSE: a     ║
-- ║  second posting would double-count the same spend and inflate cost of    ║
-- ║  sale on every affected job.                                             ║
-- ║                                                                          ║
-- ║  So there is NO inventory asset value, NO COGS posting, NO VAT change    ║
-- ║  and NO unit cost anywhere in these three migrations. The question       ║
-- ║  "should stock be capitalised as an asset and released to cost when it   ║
-- ║  is issued?" is CEO decision D1 and it is UNDECIDED. This is the         ║
-- ║  authorised SAFE INTERIM: quantities only, so that whichever way D1      ║
-- ║  lands, nothing recorded here has to be unwound — a movement history is  ║
-- ║  a strict prerequisite for a valuation layer, never a contradiction of   ║
-- ║  one.                                                                    ║
-- ║                                                                          ║
-- ║  Enforced, not merely stated: __tests__/security/operational-stock.test  ║
-- ║  asserts that no file in this diff contains an executable reference to   ║
-- ║  `finances`, no insert/update/delete against it, and no trigger on it.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── WHAT THIS TABLE IS ───────────────────────────────────────────────────────
-- `stock_items` is the catalogue: the named things a builder keeps a running
-- quantity of. "25kg bag of C16", "4x2 CLS 2.4m", "Sika AT Facade black". It is
-- REFERENCE DATA — it holds no quantity of its own. Quantity lives entirely in
-- the append-only movement ledger (20261064000000) and is DERIVED by summing
-- it. There is deliberately no `current_quantity` column on this table, or on
-- any other table in this milestone: a stored balance is a second source of
-- truth that drifts from the ledger the first time a write is lost, and then
-- silently lies for ever.
--
-- ── WHY IT IS NOT purchase_order_line_items ──────────────────────────────────
-- PO lines are FREE TEXT (`description text not null`, `qty numeric(12,2)`,
-- `unit text` — 20261006000000). Two orders for the same cement read "25kg C16
-- cement", "Cement C16 25kg bags" and "cement". You cannot sum free text, so an
-- ordered line can never be a stock identity. The bridge between the two is an
-- explicit human MATCH at receiving time (20261065000000's receipt RPC), never
-- an inferred one — see that file's header for why silent inference is refused.
--
-- ── RLS: MEMBERS WRITE, ADMINS DELETE — the `suppliers` posture, not `sites` ──
-- The two reference-data precedents in this schema disagree, deliberately, and
-- picking between them is a real decision rather than a copy:
--
--   sites      (20261061000000)  members read / ADMINS write. Justified there
--                                by blast radius: renaming a depot re-labels
--                                every van and every custody record in the
--                                company, and depots are established once and
--                                referenced for years.
--   suppliers  (20260623000000)  members read / MEMBERS write, admins delete.
--                                Justified by cadence: suppliers are added
--                                constantly, mid-job, by whoever is buying.
--
-- A stock item is the SUPPLIERS shape on both counts. Cadence: the first time a
-- product turns up on a lorry, the person standing at the lorry needs to be
-- able to name it and put it away — an admin-only register would dead-end the
-- receive-into-stock flow for exactly the person doing the work, and the
-- predictable result is that nobody uses it. Blast radius: renaming an item
-- re-labels that item's own movements and nothing else; it cannot re-point a
-- vehicle, a custody record or a job. DELETE stays admin-only (the suppliers
-- rule) and is additionally refused outright by the ledger's FK once the item
-- has any movement history — deactivate instead.
--
-- ── CASE-INSENSITIVE NAME UNIQUENESS (the suppliers precedent, verbatim) ─────
-- `suppliers_org_name_unique on (org_id, lower(name))`. Same reason: "Cement
-- 25kg" and "cement 25kg" are one product, and a picker that offers both has
-- already lost — two half-balances that never add up is the single most common
-- way a stock system stops being believed.
--
-- Additive and reversible. To roll back:
--   drop trigger if exists stock_items_supplier_org on public.stock_items;
--   drop function if exists public.tg_stock_items_supplier_org();
--   drop trigger if exists stock_items_set_updated_at on public.stock_items;
--   drop table if exists public.stock_items;

-- ── stock_items ──────────────────────────────────────────────────────────────
create table if not exists public.stock_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,

  -- What a storeman actually says. Bounded at 200 to match
  -- purchase_order_line_items.description's practical width, so a description
  -- copied off an order always fits.
  name          text not null
                check (length(trim(name)) between 1 and 200),

  description   text check (description is null or length(description) <= 2000),

  -- The company's OWN code, when it has one. Nullable, because most small
  -- builders do not run codes at all and forcing one invents data. Unique per
  -- org WHERE PRESENT (partial index below) so two items cannot share a code
  -- while the overwhelming majority that have none are unconstrained.
  sku           text check (sku is null or length(trim(sku)) between 1 and 64),

  -- Free text, NOT an enum. UK merchanting units are unbounded and regional
  -- ("ea", "bag", "m", "m2", "m3", "lin m", "roll", "tub", "sheet", "pack of
  -- 100", "tonne"). The registration/VIN lesson from 20261056000000 applies:
  -- an over-tight CHECK on a vocabulary you do not control is a support trap
  -- that needs a migration to relax. The unit is a LABEL — the ledger never
  -- converts between units, and two items measured differently are two items.
  unit          text not null default 'ea'
                check (length(trim(unit)) between 1 and 24),

  -- DEACTIVATE, NEVER DELETE, once it has history. A discontinued product is
  -- still the truthful answer to "what did we issue to that job in 2026".
  active        boolean not null default true,

  -- Who we normally buy it from, and their code for it — so a re-order can be
  -- raised without hunting. Org-guarded by trigger below (a composite FK is
  -- impossible: ON DELETE SET NULL cannot coexist with a NOT NULL org_id in a
  -- composite FK — the 20261011000000 reasoning).
  preferred_supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_reference    text check (supplier_reference is null or length(trim(supplier_reference)) <= 120),

  -- THE LOW-STOCK THRESHOLDS. Both nullable and both meaningless on their own:
  -- an item with no reorder_level simply never raises a low-stock signal, which
  -- is the correct default for the long tail nobody tracks closely.
  --   reorder_level  at or below this, re-order (lib/stock/balance.ts:
  --                  available <= reorder_level, boundary inclusive).
  --   target_level   what a full shelf looks like; drives "how many to order",
  --                  never a rule of its own.
  -- numeric(12,2) matches goods_received_lines.qty_received and
  -- purchase_order_line_items.qty EXACTLY, so a decimal unit (12.5 m³) crosses
  -- from order to receipt to stock without a rounding fork.
  reorder_level numeric(12, 2) check (reorder_level is null or reorder_level >= 0),
  target_level  numeric(12, 2) check (target_level  is null or target_level  >= 0),

  notes         text check (notes is null or length(notes) <= 2000),

  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now(),

  -- Candidate key for the ledger's composite, org-binding FK. The additive
  -- idiom used by invoices_id_org_key (20260911), customers_id_org_key
  -- (20260915), payments_id_org_key (20261010) and both PO keys (20261059).
  -- A unique constraint on a SUPERSET of an existing PK can never reject a row.
  constraint stock_items_id_org_key unique (id, org_id)
);

-- One name per org, CASE-INSENSITIVELY (suppliers_org_name_unique, verbatim).
create unique index if not exists stock_items_org_name_unique
  on public.stock_items (org_id, lower(name));

-- One code per org WHERE THE ITEM HAS ONE. Partial, and case-insensitive for
-- the same reason as the name: "CEM-25" and "cem-25" are one code.
create unique index if not exists stock_items_org_sku_unique
  on public.stock_items (org_id, lower(sku))
  where sku is not null;

-- The register's default board and every picker read: this org's items, active
-- first. org_id leads, so it also serves the bare org_id predicate RLS applies.
create index if not exists stock_items_org_active_idx
  on public.stock_items (org_id, active);

-- "What do we buy from this supplier" — the re-order path.
create index if not exists stock_items_supplier_idx
  on public.stock_items (preferred_supplier_id)
  where preferred_supplier_id is not null;

drop trigger if exists stock_items_set_updated_at on public.stock_items;
create trigger stock_items_set_updated_at before update on public.stock_items
  for each row execute function public.tg_set_updated_at();

-- ── cross-tenant control on preferred_supplier_id ────────────────────────────
-- RLS only ever checks the ROW's own org_id; it says nothing about the org of
-- the thing the row POINTS AT. Without this a writer in org A could bind an
-- item to org B's supplier and leak that supplier's name straight back out
-- through the item register — the exact class 20261011000000 closed for
-- purchase orders and 20261061000000 closed for sites.
--
-- SECURITY DEFINER + pinned search_path, mirroring
-- tg_site_reference_org_integrity: the check must read the TRUE owning org of
-- the referenced supplier, not the subset of `suppliers` the caller's RLS
-- happens to expose. It leaks nothing — it returns no data, and its message
-- repeats only the supplier id the caller itself supplied.
create or replace function public.tg_stock_items_supplier_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.preferred_supplier_id is null then
    return new;
  end if;
  select org_id into v_org from public.suppliers where id = new.preferred_supplier_id;
  if v_org is null or v_org <> new.org_id then
    raise exception 'supplier % is not in org %', new.preferred_supplier_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists stock_items_supplier_org on public.stock_items;
create trigger stock_items_supplier_org
  before insert or update on public.stock_items
  for each row execute function public.tg_stock_items_supplier_org();

-- ── RLS — members S/I/U, admins delete (the `suppliers` posture; see header) ──
alter table public.stock_items enable row level security;

drop policy if exists "stock_items: members can select" on public.stock_items;
create policy "stock_items: members can select" on public.stock_items
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "stock_items: members can insert" on public.stock_items;
create policy "stock_items: members can insert" on public.stock_items
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "stock_items: members can update" on public.stock_items;
create policy "stock_items: members can update" on public.stock_items
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "stock_items: admins can delete" on public.stock_items;
create policy "stock_items: admins can delete" on public.stock_items
  for delete to authenticated using (public.is_org_admin(org_id));

comment on table public.stock_items is
  'Operational stock catalogue. Holds NO quantity and NO value — quantity is derived by summing public.stock_movements (20261064000000); valuation is out of scope (CEO decision D1 undecided). See the 20261063000000 header.';
comment on column public.stock_items.unit is
  'Display label only. The ledger never converts between units — two items measured differently are two items.';
comment on column public.stock_items.reorder_level is
  'Low-stock threshold, INCLUSIVE: a signal is raised when available <= reorder_level. Null means this item is never flagged.';
