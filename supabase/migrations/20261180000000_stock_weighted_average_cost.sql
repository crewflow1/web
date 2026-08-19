-- W1 STOCK COGS — WEIGHTED-AVERAGE COST VALUATION over the quantity ledger.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — RESTATED, AND NOW EXTENDED. READ THIS BEFORE   ║
-- ║  YOU TOUCH ANYTHING IN THIS FILE.                                        ║
-- ║                                                                          ║
-- ║  CEO decision D1 (stock valuation / COGS-on-issue) was UNDECIDED when    ║
-- ║  20261063/64/65 shipped the quantity-only ledger. D1 IS NOW DECIDED:     ║
-- ║  WEIGHTED-AVERAGE COST. This migration implements it ADDITIVELY, on top   ║
-- ║  of the existing ledger, changing not one quantity and dropping not one   ║
-- ║  guard.                                                                  ║
-- ║                                                                          ║
-- ║  THE MODEL — PERPETUAL WEIGHTED-AVERAGE, VALUATION-LEDGER-ONLY.           ║
-- ║  Cost is a MANAGEMENT-ACCOUNTING OVERLAY on the quantity ledger. It      ║
-- ║  NEVER writes to `public.finances` and no trigger here sits on it. The   ║
-- ║  company's General Ledger is untouched: `recordSupplierBill` remains the  ║
-- ║  SINGLE authoritative expensing of materials into `finances`, exactly    ║
-- ║  once, when the supplier's invoice is recorded (20261009000000).         ║
-- ║                                                                          ║
-- ║  ── WHY THIS IS DOUBLE-COUNT-SAFE (the #1 risk) ────────────────────────  ║
-- ║  A material must be expensed EXACTLY ONCE. Because this valuation layer   ║
-- ║  posts NOTHING to `finances`, the company-level cost of sale is byte-     ║
-- ║  identical with or without this feature — there is exactly one P&L        ║
-- ║  expense event per purchase (the supplier bill) and stock valuation adds  ║
-- ║  none. So a company total can NEVER double-count. This is the            ║
-- ║  "capitalise-on-receipt / release-on-issue" model expressed WITHOUT a    ║
-- ║  general-ledger fork: a receipt CAPITALISES value into the inventory      ║
-- ║  valuation (book_value below), an issue RELEASES it as COGS — but both    ║
-- ║  happen in this overlay, never in `finances`.                            ║
-- ║                                                                          ║
-- ║  ── THE JOB-COST INTERACTION, AND ITS ONE ASSUMPTION ───────────────────  ║
-- ║  COGS-on-issue is surfaced to job costing as an ALLOCATION stream (like   ║
-- ║  labour is composed into job cost in lib/profitability/job-cost-input),   ║
-- ║  NOT as a new expense. It RE-CLASSIFIES the depot-replenishment spend     ║
-- ║  onto the consuming job. It is double-count-safe on a JOB under the       ║
-- ║  standard convention that stock-replenishment supplier bills are booked   ║
-- ║  to the depot (finances.job_id null) while job-specific direct purchases  ║
-- ║  are NOT also issued from stock — so a job's material cost is EITHER a    ║
-- ║  direct `finances` bill OR a stock issue, never both. To keep that        ║
-- ║  auditable rather than silent, the stock-COGS allocation is exposed as a  ║
-- ║  distinct, labelled stream (buildStockCogsCostRows) that a surface        ║
-- ║  composes deliberately; it is NOT auto-injected into live job margins by  ║
-- ║  this migration. See docs/operational-stock.md and lib/stock/valuation.ts.║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── NO STORED AGGREGATE. THE AVERAGE IS DERIVED, LIKE THE BALANCE ────────────
-- The quantity ledger holds NO stored balance on principle (20261064000000):
-- a stored running total is a second source of truth that lies silently the
-- first time a write is lost. The weighted-average cost is held to the SAME
-- standard. There is NO stock_item_costs cache table. Instead every movement
-- carries two per-row IMMUTABLE derived facts, in the exact spirit of `effect`:
--
--   cost_effect  the signed VALUE impact of this movement (£).  Frozen at insert.
--   unit_cost    the per-unit basis used for it (£/unit).       Frozen at insert.
--
-- The current book value of an item is then `sum(cost_effect)` and the current
-- weighted-average unit cost is `sum(cost_effect) / sum(effect over costed rows)`
-- — a plain fold over the ledger, identical in shape to `stock_balance`. Because
-- both are exact running sums, the valuation `stock_valuation` is ALWAYS exactly
-- self-consistent, even under any interleaving of concurrent writes.
--
-- ── HOW cost_effect IS ASSIGNED (tg_stock_movements_wavg_cost) ───────────────
-- A BEFORE INSERT trigger, running AFTER tg_stock_movements_derive (its name
-- sorts after 'stock_movements_derive', so `effect` is already set), SECURITY
-- DEFINER for the same reason derive is — it must read the TRUE prior sums and
-- the TRUE corrected row, not the subset the caller's RLS exposes:
--
--   receipt            unit_cost := the ORDERED unit price of the delivery line
--                      (goods_received_lines → purchase_order_line_items.unit_price
--                      — the agreed price, the SAME basis the three-way match
--                      values the received leg at, lib/purchase-orders/matching).
--                      cost_effect := +round(qty * unit_cost, 2).
--                      A receipt with no delivery line (a hand receipt) has NO
--                      derivable price → cost_effect/unit_cost stay NULL
--                      (UNCOSTED — see historical handling below).
--   issue,             a RELEASE at the current weighted-average, CAPPED at the
--   adjustment_out,    costed pool (the S1 boundary rule above): released_costed
--   transfer_out       := least(qty, costed_qty_before); cost_effect :=
--                      -value_released; costed_qty_effect := -released_costed;
--                      unit_cost := avg. Never releases more cost than the pool
--                      holds, so book_value / costed_qty floor at 0.
--   transfer_in        MIRRORS its paired transfer_out (via transfer_group_id):
--                      cost_effect := -out.cost_effect, costed_qty_effect :=
--                      -out.costed_qty_effect, unit_cost := out.unit_cost. This
--                      makes the transfer pair net to EXACTLY zero at org level
--                      even when the out-leg crossed the boundary — the average
--                      is per (item, org) and an internal move is not a cost
--                      event.
--   adjustment_in      "found" stock re-entering at book cost: unit_cost := avg,
--                      cost_effect := +round(qty*avg,2), costed_qty_effect :=
--                      +qty. No new purchase, so the average is UNCHANGED.
--   correction         the EXACT reversal of the row it names: cost_effect :=
--                      -corrected.cost_effect, costed_qty_effect :=
--                      -corrected.costed_qty_effect, unit_cost copied. Restates
--                      current inventory value; does NOT retroactively restate
--                      COGS already released on earlier issues — standard
--                      perpetual weighted-average behaviour.
--
-- Only receipts change the average, and a receipt's cost_effect does NOT depend
-- on the current average (it is qty × the delivery's own price), so it is
-- order-independent. Issues/transfers/adjustments release at the average and
-- PRESERVE it. The residual concurrency non-determinism — which average a given
-- issue used when a receipt of the SAME item at a DIFFERENT site committed at
-- the same instant — is bounded, harmless (every outcome is a valid
-- serialisation) and never corrupts the valuation, because value and quantity
-- are exact sums. Same class of accepted residue as the ledger's own
-- unserialised-direct-insert note (20261064000000).
--
-- ── HISTORICAL CONSISTENCY (movements that predate this migration) ───────────
-- Every stock_movements row written before this migration has cost_effect NULL
-- and MUST stay safe. The fold treats a NULL-cost row as UNCOSTED: it is outside
-- the costed pool for BOTH the numerator (book value) and the denominator
-- (costed quantity), so it never drags the average toward zero and never
-- crashes a division. The valuation reports the physical on-hand AND the
-- uncosted quantity separately, so pre-cost-era stock reads honestly as "N units
-- at unknown cost" rather than as "N units worth £0". Going forward every new
-- movement is costed (or explicitly NULL for a hand receipt with no price), so
-- the unknown is bounded to legacy data and shrinks as it is issued out.
--
-- ── ADDITIVE AND REVERSIBLE ──────────────────────────────────────────────────
-- ── THE COSTED↔UNCOSTED BOUNDARY (the S1 correctness rule) ────────────────────
-- Physical on-hand can mix COSTED units (received under a known price since this
-- migration) with UNCOSTED units (pre-migration legacy, or hand receipts with no
-- price). An OUT movement (issue / adjustment_out / transfer_out) draws PHYSICAL
-- units, which may include uncosted ones — but it can only RELEASE cost for the
-- part of the draw that the costed pool actually holds. So the released cost is
-- CAPPED:
--
--     released_costed = least(out_qty, costed_qty_before)
--     value_released  = (released_costed = costed_qty_before)   -- full drain
--                         ? book_value_before                   --   → release ALL book value (no penny drift)
--                         : least(round(released_costed * avg, 2), book_value_before)
--                                                               -- partial: value at avg, but never MORE than the
--                                                               --   pool holds (4dp avg-rounding drift could
--                                                               --   otherwise over-release COGS → negative book)
--
-- The remaining (out_qty − released_costed) units are uncosted: they carry no
-- book value. This FLOORS costed_qty at 0 and book_value at 0 — neither can ever
-- go negative — and is why the pool's quantity is tracked by its OWN frozen fact
-- (`costed_qty_effect`, capped) rather than by the physical `effect`: the two
-- diverge exactly on a boundary-crossing draw (a −6 physical issue that releases
-- only −5 costed units) and on an unpriced receipt (+qty physical, +0 costed).
--
-- A TRANSFER is org-internal and must stay COST-NEUTRAL even across the boundary,
-- so the `transfer_in` leg MIRRORS its paired `transfer_out` (found via
-- transfer_group_id, exactly as a correction mirrors the row it reverses) rather
-- than re-valuing at the post-drain average — otherwise a transfer that drained
-- the costed pool would destroy book value it should merely relocate.
--
-- ── ADDITIVE AND REVERSIBLE ──────────────────────────────────────────────────
-- New nullable columns + one BEFORE INSERT trigger + one SECURITY INVOKER view.
-- Nothing existing is altered or dropped; every prior guard (append-only,
-- no-delete, composite FKs, advisory locks, admin-only adjustments, the
-- authorised-write marker, the transfer-leg correction guard) is untouched and
-- still fires. To roll back:
--   drop view if exists public.stock_valuation;
--   drop trigger if exists stock_movements_wavg_cost on public.stock_movements;
--   drop function if exists public.tg_stock_movements_wavg_cost();
--   alter table public.stock_movements drop column if exists costed_qty_effect;
--   alter table public.stock_movements drop column if exists cost_effect;
--   alter table public.stock_movements drop column if exists unit_cost;

-- ── 1. The three per-row derived cost facts (nullable ⇒ historical-safe) ─────
alter table public.stock_movements
  add column if not exists unit_cost         numeric(12, 4),
  add column if not exists cost_effect       numeric(14, 2),
  add column if not exists costed_qty_effect numeric(12, 2);

comment on column public.stock_movements.unit_cost is
  'The per-unit cost basis used for this movement (£/unit), frozen at insert by tg_stock_movements_wavg_cost. Receipt = the delivery line''s ordered price; issue/transfer/adjustment = the weighted-average at the moment; correction = copied from the row it reverses. NULL for a hand receipt with no price and for every pre-20261180000000 (uncosted) movement.';
comment on column public.stock_movements.cost_effect is
  'Signed VALUE impact of this movement (£), frozen at insert. Book value of an item = sum(cost_effect). NULL = UNCOSTED. An OUT movement releases at most the costed pool''s value (capped), so this floors book_value at 0. Posts to NO accounts — see the 20261180000000 header for the double-count-safety argument.';
comment on column public.stock_movements.costed_qty_effect is
  'Signed COSTED-QUANTITY impact (units), frozen at insert. costed_qty of an item = sum(costed_qty_effect); it differs from physical `effect` exactly at the costed↔uncosted boundary (a boundary-crossing OUT is capped at the costed pool; an unpriced receipt is +0 here). NULL = UNCOSTED. Floors costed_qty at 0, so avg = book_value/costed_qty is always well-defined and non-negative.';

-- ── 2. The cost-assignment trigger ───────────────────────────────────────────
-- SECURITY DEFINER + fixed search_path, mirroring tg_stock_movements_derive: it
-- must read the TRUE prior book value / costed quantity and the TRUE corrected
-- row, not the subset the caller's RLS exposes. It only READS and stamps NEW; it
-- writes no other table, so it is not a privileged write path.
create or replace function public.tg_stock_movements_wavg_cost()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_value      numeric(14, 2);   -- prior book value of the (org, item) pool
  v_costed_qty numeric(12, 2);   -- prior COSTED quantity of the pool (capped, ≥ 0)
  v_avg        numeric(12, 4);   -- prior weighted-average unit cost
  v_price      numeric(12, 4);   -- a receipt's ordered unit price
  v_released   numeric(12, 2);   -- costed units an OUT movement actually releases
  v_val_rel    numeric(14, 2);   -- book value that OUT movement releases
  v_out_ce     numeric(14, 2);   -- a transfer_out leg's cost_effect
  v_out_cqe    numeric(12, 2);   -- a transfer_out leg's costed_qty_effect
  v_out_uc     numeric(12, 4);   -- a transfer_out leg's unit_cost
  v_corr_ce    numeric(14, 2);   -- the corrected row's cost_effect
  v_corr_cqe   numeric(12, 2);   -- the corrected row's costed_qty_effect
  v_corr_uc    numeric(12, 4);   -- the corrected row's unit_cost
begin
  -- Prior state of the COSTED pool for this (org, item). The costed QUANTITY is
  -- summed from costed_qty_effect (capped, ≥ 0) — NOT from physical `effect` —
  -- so a boundary-crossing OUT can never have driven it negative. NULL-cost
  -- (historical / hand-receipt / fully-uncosted) rows contribute 0 to both sums,
  -- so they never distort the average and a division by zero is impossible.
  select coalesce(sum(cost_effect), 0),
         coalesce(sum(costed_qty_effect), 0)
    into v_value, v_costed_qty
    from public.stock_movements
   where org_id = new.org_id
     and stock_item_id = new.stock_item_id;

  v_avg := case when v_costed_qty > 0 then round(v_value / v_costed_qty, 4) else null end;

  if new.movement_type = 'receipt' then
    -- The delivery line's ORDERED unit price — the agreed price, the same basis
    -- lib/purchase-orders/matching values the received leg at. A hand receipt
    -- (no delivery line) has no derivable price and stays UNCOSTED.
    if new.grn_line_id is not null then
      select poli.unit_price
        into v_price
        from public.goods_received_lines grl
        join public.purchase_order_line_items poli
          on poli.id = grl.purchase_order_line_item_id
         and poli.org_id = grl.org_id
       where grl.id = new.grn_line_id
         and grl.org_id = new.org_id;
    end if;
    if v_price is not null then
      new.unit_cost         := v_price;
      new.cost_effect       := round(new.qty * v_price, 2);
      new.costed_qty_effect := new.qty;
    end if;

  elsif new.movement_type in ('issue', 'transfer_out', 'adjustment_out') then
    -- A RELEASE at the current weighted-average, CAPPED at the costed pool (the
    -- S1 boundary rule): never release more cost than the pool actually holds, so
    -- the physical units drawn beyond it are treated as uncosted. Fully uncosted
    -- while the pool is empty (only pre-cost-era stock on hand).
    if v_costed_qty > 0 then
      v_released := least(new.qty, v_costed_qty);
      -- On a FULL drain, release the entire remaining book value so it lands at
      -- exactly £0 (no rounding residue). On a PARTIAL draw, value at the average
      -- but CAP at the remaining book value: `avg` is rounded to 4dp, so on a
      -- large partial draw of a low-unit-cost blended item `round(released*avg,2)`
      -- can drift a penny or two PAST what the pool holds and over-release COGS,
      -- pushing book_value slightly negative. `least(…, v_value)` forbids ever
      -- releasing more value than is capitalised.
      v_val_rel := case
                     when v_released >= v_costed_qty then v_value
                     else least(round(v_released * v_avg, 2), v_value)
                   end;
      new.unit_cost         := v_avg;
      new.cost_effect       := - v_val_rel;
      new.costed_qty_effect := - v_released;
    end if;

  elsif new.movement_type = 'transfer_in' then
    -- MIRROR the paired transfer_out (same transfer_group_id), so an internal
    -- move nets to EXACTLY zero at org level even when the out-leg crossed the
    -- costed↔uncosted boundary. The out-leg is inserted first in the pair
    -- (record_stock_transfer), so it is already visible here.
    if new.transfer_group_id is not null then
      select cost_effect, costed_qty_effect, unit_cost
        into v_out_ce, v_out_cqe, v_out_uc
        from public.stock_movements
       where transfer_group_id = new.transfer_group_id
         and movement_type = 'transfer_out'
         and org_id = new.org_id;
      if v_out_ce is not null then
        new.unit_cost         := v_out_uc;
        new.cost_effect       := - v_out_ce;
        new.costed_qty_effect := - v_out_cqe;
      end if;
    end if;

  elsif new.movement_type = 'adjustment_in' then
    -- "Found" stock re-entering at book cost. No new purchase, so the average is
    -- unchanged; uncosted while nothing is costed.
    if v_avg is not null then
      new.unit_cost         := v_avg;
      new.cost_effect       := round(new.qty * v_avg, 2);
      new.costed_qty_effect := new.qty;
    end if;

  else
    -- correction: the exact reversal of the row it names, in BOTH value and
    -- costed quantity. `effect` was already set to -(corrected.effect) by
    -- tg_stock_movements_derive. If the corrected row was uncosted, so is this.
    select cost_effect, costed_qty_effect, unit_cost
      into v_corr_ce, v_corr_cqe, v_corr_uc
      from public.stock_movements
     where id = new.corrects_movement_id
       and org_id = new.org_id;
    if v_corr_ce is not null then
      new.unit_cost         := v_corr_uc;
      new.cost_effect       := - v_corr_ce;
      new.costed_qty_effect := - v_corr_cqe;
    end if;
  end if;

  return new;
end $$;

-- Named to sort AFTER stock_movements_derive so `effect` is populated first, and
-- after stock_movements_authorised_write so a refused direct insert never reaches
-- costing. BEFORE INSERT only — it can never sit on the org-teardown delete path.
drop trigger if exists stock_movements_wavg_cost on public.stock_movements;
create trigger stock_movements_wavg_cost
  before insert on public.stock_movements
  for each row execute function public.tg_stock_movements_wavg_cost();

-- ── 3. The valuation report — DERIVED, SECURITY INVOKER ──────────────────────
-- One row per (org, item) that has ever moved. `security_invoker = true` so the
-- caller's RLS on stock_movements applies exactly as a direct query would — a
-- member sees their own org's valuation and no one else's (a plain view runs as
-- its OWNER and would bypass RLS; the 20261064000000 stock_balances lesson).
--
--   on_hand       physical quantity (sum of effect) — matches stock_balances.
--   costed_qty    the part of on_hand that carries a known cost.
--   uncosted_qty  on_hand - costed_qty — pre-cost-era / hand-receipt stock.
--   book_value    sum(cost_effect) — the weighted-average valuation (£).
--   avg_unit_cost book_value / costed_qty — NULL when nothing is costed.
create or replace view public.stock_valuation
with (security_invoker = true) as
  select org_id,
         stock_item_id,
         sum(effect)::numeric(12, 2)                                   as on_hand,
         -- The COSTED quantity is the capped costed_qty_effect, never the
         -- physical effect — so it floors at 0 across the costed↔uncosted
         -- boundary and avg = book_value/costed_qty is always well-defined.
         coalesce(sum(costed_qty_effect), 0)::numeric(12, 2)           as costed_qty,
         (sum(effect) - coalesce(sum(costed_qty_effect), 0))::numeric(12, 2)
                                                                       as uncosted_qty,
         coalesce(sum(cost_effect), 0)::numeric(14, 2)                 as book_value,
         case
           when coalesce(sum(costed_qty_effect), 0) > 0
           then round(sum(cost_effect) / sum(costed_qty_effect), 4)
           else null
         end                                                           as avg_unit_cost,
         max(occurred_at)                                              as last_movement_at
    from public.stock_movements
   group by org_id, stock_item_id;

grant select on public.stock_valuation to authenticated;

comment on view public.stock_valuation is
  'Weighted-average inventory valuation per (org, item), DERIVED from the append-only ledger (no stored aggregate). book_value = sum(cost_effect); avg_unit_cost = book_value/costed_qty. Posts to NO accounts — CEO decision D1 (weighted-average), implemented double-count-safe as a valuation overlay. See 20261180000000 + docs/operational-stock.md.';
