-- O3 OPERATIONAL STOCK — REORDER POINTS / REPLENISHMENT.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — READ THIS BEFORE CHANGING ANYTHING HERE.      ║
-- ║                                                                          ║
-- ║  Replenishment is an OPERATIONAL, QUANTITY-ONLY feature. It records how  ║
-- ║  MANY to re-order, never WHAT THAT COSTS. `reorder_quantity` is a count  ║
-- ║  in the item's own unit (bags, sheets, metres), exactly like            ║
-- ║  reorder_level and target_level beside it. There is no price, no cost,   ║
-- ║  no valuation and NO reference to `public.finances` anywhere in this     ║
-- ║  migration or the code that reads it.                                    ║
-- ║                                                                          ║
-- ║  This matters because the replenishment handoff RAISES A MATERIAL        ║
-- ║  REQUEST, and it would be one line of code away to stamp an estimated    ║
-- ║  cost onto it. It must not: purchased materials are already expensed by  ║
-- ║  recordSupplierBill (20261009000000), so any cost attached here would    ║
-- ║  double-count the same spend. Stock valuation is CEO decision D1 and is  ║
-- ║  UNDECIDED — see docs/operational-stock.md and the 20261063000000       ║
-- ║  header. Enforced on source by                                          ║
-- ║  __tests__/security/stock-reorder.test.ts.                              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── WHAT THIS ADDS, AND — DELIBERATELY — WHAT IT DOES NOT ─────────────────────
-- ONE new column: `stock_items.reorder_quantity`.
--
-- There is NO new `reorder_point` column, and that is a decision, not an
-- omission. `stock_items.reorder_level` (20261063000000) ALREADY IS the reorder
-- point — its own column comment reads "Low-stock threshold, INCLUSIVE: a signal
-- is raised when available <= reorder_level", and lib/stock/balance.ts computes
-- the `low` state against it inclusively. Adding a second threshold column would
-- be a second source of truth for the same concept: two fields that must agree,
-- a form that can set them apart, and a reader that has to choose between them.
-- So replenishment REUSES reorder_level as the reorder point and adds only the
-- genuinely missing piece — how many to buy when you hit it.
--
-- ── reorder_quantity vs the existing target_level ────────────────────────────
-- These are the two classic replenishment policies, and the reader honours both
-- (lib/stock/reorder.ts):
--   target_level      ORDER-UP-TO: buy enough to refill the shelf, i.e.
--                     target_level − available. Already present; drives the
--                     "how many to reach target" hint on /stock today.
--   reorder_quantity  FIXED BATCH (this migration): buy a set amount every time,
--                     the economic-order-quantity / "we always get a pallet"
--                     shape. When set it TAKES PRECEDENCE over the order-up-to
--                     figure, because a deliberate batch size is a stronger
--                     signal than a computed shortfall.
-- Both are nullable and neither is required: an item with a reorder_level but
-- neither a reorder_quantity nor a target_level is flagged as low but produces
-- NO auto-suggestion — the reader never fabricates a number it was not given.
--
-- ── numeric(12,2), matching every other stock quantity ───────────────────────
-- Same type as reorder_level / target_level / goods_received_lines.qty_received
-- / purchase_order_line_items.qty, so a decimal batch (12.5 m³) crosses from
-- this suggestion into a material-request line and on to a PO without a
-- rounding fork. CHECK is strictly > 0: a reorder level of 0 is meaningful
-- ("flag when it hits zero") but a re-order of 0 units is not — it would be a
-- suggestion to buy nothing.
--
-- ── TENANCY / RLS — INHERITED, and that is correct ───────────────────────────
-- This is a column on the existing org-scoped `stock_items` table. It is
-- covered, unchanged, by that table's four policies (20261063000000: members
-- S/I/U, admins delete), all keyed on `org_id in (select current_org_ids())`.
-- No new table, no new policy, nothing to enable. Every READ of the column is
-- additionally ACTIVE-ORG PINNED in the service layer (`.eq("org_id", orgId)`),
-- the #456/#468 discipline, because current_org_ids() admits every org a
-- dual-org member belongs to.
--
-- ADDITIVE and reversible. To roll back:
--   alter table public.stock_items drop column if exists reorder_quantity;

alter table public.stock_items
  add column if not exists reorder_quantity numeric(12, 2)
    check (reorder_quantity is null or reorder_quantity > 0);

comment on column public.stock_items.reorder_quantity is
  'Replenishment batch size (quantity, NOT money): how many to re-order when '
  'available <= reorder_level. When set, takes precedence over the '
  'target_level order-up-to figure. Null means no fixed batch — the reader '
  'falls back to (target_level − available) or, if that is unset too, offers '
  'no suggestion. See 20261107000000 header and the ACCOUNTING BOUNDARY '
  '(quantity only; D1 undecided; double-count risk if a cost is ever added).';
