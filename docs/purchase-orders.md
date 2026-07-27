# Purchase orders (Programme C)

Procurement / **committed spend**: what has been ordered from a supplier but not
yet billed. Deliberately separate from the `finances` cost ledger so a cost is
never double-counted as both committed (PO) and actual (a future supplier bill).

## Model (migration `20261006000000`)

- **`purchase_orders`** — `number` (per-org `PO-NNNN` via `next_po_number`,
  mirrors `next_quote_number`), `status`, `supplier_id`/`job_id` (both nullable,
  `ON DELETE SET NULL` so the PO survives for audit), `subtotal`/`vat_total`,
  `total` (generated `= subtotal + vat_total`), `expected_date`, `notes`.
  `unique (org_id, number)`.
- **`purchase_order_line_items`** — mirrors `quote_line_items`; per-line VAT via
  the shared `computeTotals` (same rounding contract as quotes/invoices).

## Lifecycle

`draft → sent → received`, with `cancelled` reachable from any live state
(`lib/purchase-orders/schema.ts` → `canTransitionPo` / `PO_TRANSITIONS`). A
`received`/`cancelled` PO is settled and can't be edited. Transitions are the
only status writes; `setPurchaseOrderStatus` validates them server-side.

## Security

RLS mirrors `finances`: members select/insert/update within their org; admins
delete. No CIS/HMRC tax logic — a PO is a commercial commitment; nothing is
deducted or filed.

## UI

`/purchase-orders` (list) · `/purchase-orders/new` · `/purchase-orders/[id]`
(summary + status controls + inline edit for draft/sent + admin delete).

## Shipped follow-up

- **Committed-cost view on the job** (#395) — `lib/purchase-orders/committed.ts`
  (`computeCommittedCosts`) sums non-cancelled PO totals; `/jobs/[id]` renders a
  "Committed (POs)" tile next to actual costs (`finances`) and profit.

- **Supplier bills** (20261009) — record a supplier's invoice against a PO. A
  bill IS a `finances` entry attributed to a supplier + PO (**no `supplier_bills`
  fork** — extends the existing cost ledger): `finances` gained `supplier_id`,
  `purchase_order_id`, `reference`, `bill_date`. Recording one posts the ACTUAL
  cost to job profitability and closes committed → actual; the PO detail shows
  **Committed / Billed / Remaining** + a status (unbilled / part / fully / over).
  DB-enforced same-org guard trigger `finances_bill_org_integrity` prevents
  cross-tenant links (a bill can only reference a PO/supplier in its own org).
  `lib/purchase-orders/billing.ts` (`computePoBilling`) + `recordSupplierBill`
  action + real-Postgres integration test. Follow-up: a job P&L "Billed" tile
  aggregating PO-linked finances; supplier-level bill view.

## Follow-ups (pending)

- PO PDF for emailing suppliers (reuse the react-pdf pipeline).
