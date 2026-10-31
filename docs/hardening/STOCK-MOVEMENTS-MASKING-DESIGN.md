# stock_movements financial masking — least-privilege design

**Status: IMPLEMENTED (migrations 20261257 + 20261258) + VERIFIED.** The read-split
below is built: the cost-free operational view, the self-scoped definer quantity
balances, the base-table admin-only narrow, and the stock.ts caller split
(staff → operational view; valuation/COGS → base cost reader). One extra step the
build surfaced beyond the original design: the member WRITE-PATH RPCs
(record_stock_issue / record_stock_transfer / record_stock_adjustment) read
stock_movements internally for balance checks under SECURITY INVOKER, so the base
narrow broke them for non-admins — they were converted to SECURITY DEFINER + org
guard (20261258), same as the GRN receipt RPC. Verified: rls/stock-isolation 61/61
incl. an explicit cost-masking case (staff see quantities via the view, cost NULL;
base is admin-only; admin reads cost). Full integration + security + unit tiers green.

---
_Original design (for reference):_ This is a deliberate read-split
refactor, not a one-line RLS change. It was explicitly held out of a timed
sprint because a blanket `is_org_admin` SELECT on `stock_movements` **breaks
staff stock quantities and stock valuation**, and the naive fix mis-states every
job margin. The exact, safe plan is below so it can be executed deliberately.

## The constraint (why a blanket denial is wrong)

`stock_movements` carries BOTH:
- operational columns staff legitimately need — `qty`, `effect`, `movement_type`,
  `stock_item_id`, `site_id`, `job_id`, `occurred_at`, …
- financial columns staff must NOT see — `unit_cost`, `cost_effect`,
  `costed_qty_effect`.

Two load-bearing facts discovered in the code:
1. **The `/stock` page uses the TENANT (user-JWT) client** (`createClient()`),
   reading via `loadStockPositions → listStockMovements`. Narrowing the base
   SELECT to `is_org_admin` returns zero rows to staff → empty stock levels.
   (`app/(app)/stock/page.tsx:45`, `server/services/stock.ts:204,233`.)
2. **One shared read feeds both quantities AND cost.** `listStockMovements`
   selects `STOCK_MOVEMENT_COLUMNS` (incl. the 3 cost columns), and
   `loadStockValuationReport` (`stock.ts:265`) + `loadStockCogsCostRows`
   (`stock.ts:294`) fold `cost_effect` from that SAME read for consistency.
   If that read loses cost (or returns 0 rows), valuation → £0 and every job
   margin re-inflates. Column-level GRANTs can't help: `authenticated` is one
   role, so they cannot distinguish admin from staff at runtime — only
   `is_org_admin` (RLS / a definer view) can.

## The design (safe, least-privilege)

1. **Cost-free operational view** `public.stock_movements_operational`:
   every operational column, plus `unit_cost`/`cost_effect`/`costed_qty_effect`
   projected as `NULL::numeric` (so `StockMovementRow` still type-checks).
   `with (security_invoker = false)` + `where org_id in (select public.current_org_ids())`
   (self-scoped; quantities are org/warehouse-level, not job-private).
   `grant select to authenticated`.
2. **Split the callers in `server/services/stock.ts`:**
   - staff quantity paths — `loadStockPositions`, the history panel, low-stock —
     read `stock_movements_operational` (cost = NULL, folds `effect` fine).
   - cost paths — `loadStockValuationReport`, `loadStockCogsCostRows` — read the
     BASE table (real `cost_effect`). These surfaces are already `costs:view`-
     gated (owner/admin), so their callers hold `is_org_admin` and keep base
     access after the narrow.
   - **Audit gate:** before narrowing, confirm EVERY caller of the cost-bearing
     read is admin-only-reachable (grep `loadStockValuationReport`,
     `loadStockCogsCostRows`, `loadStockPositions` callers + their page gates).
3. **Harden the quantity balances** so they survive the base-narrow:
   - `stock_balance(p_org_id,p_item_id,p_site_id)` → `SECURITY DEFINER` +
     canonical org guard (`current_org_ids()` + `42501`); it already sums only
     `effect` (no cost).
   - `stock_balances` view → `security_invoker = false` + the `current_org_ids()`
     filter (quantity-only). Both stay byte-identical in output.
4. **Narrow base** `stock_movements` SELECT → `is_org_admin(org_id)` LAST, once
   1–3 are in place and the caller audit is green.

## Preserve (must still pass after the change)
Direct table reads (admin only) · column exposure (cost NULL for staff via the
view) · inventory balances (quantity, via definer fn/view) · stock adjustments &
goods-received confirmation & cost entry (writes unchanged — they go through the
existing SECURITY DEFINER write-path RPCs) · report RPCs (already admin-guarded,
mig 20261253) · views · exports · cross-tenant (org-scoped throughout).

## Test matrix (real Postgres, role JWTs)
owner/admin: read base incl. cost + valuation correct · staff: read
`stock_movements_operational` (cost columns NULL) + `stock_balance`/`stock_balances`
return correct quantities · staff: direct base `select cost_effect` → denied ·
cross-tenant/anon: nothing · valuation/COGS totals byte-identical to pre-change
(pin against the existing `report_profit_stock_cogs` == TS-fold invariant).

## Effort
~1 focused session: 1 migration + ~4 edited `stock.ts` functions + the caller
audit + a new `rls/stock-movements-masking.test.ts`. NOT a timed-sprint change —
the valuation consistency invariant (`stock.ts:253`, `:285`) must not be nicked.
