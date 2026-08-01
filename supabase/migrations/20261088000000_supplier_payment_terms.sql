-- Supplier payment terms — the DDL that turns aged creditors into TRUE
-- overdue-payables ageing.
--
-- THE GAP (docs/roadmap/STATUS.md + lib/commercial/aged-creditors.ts:20-33):
-- overdue-payables ageing is "NOT COMPUTABLE" today. `finances` (which IS the
-- supplier-bill table — there is no separate one) carries `bill_date`, the date
-- printed on the supplier's invoice, and NO due date; `suppliers` carries no
-- payment-terms column. So nothing in the schema records an agreed deadline for
-- paying a supplier, and the aged-creditors surface ages from the BILL DATE as a
-- documented second-best — its columns mean "days since the bill was raised",
-- NOT "days overdue". This migration records the missing fact — the supplier's
-- payment terms — so a bill's due date, and therefore true overdue ageing, can
-- be derived.
--
-- =========================================================================
-- DESIGN DECISION 1 — TERMS LIVE ON THE SUPPLIER, NULLABLE, NO DB DEFAULT.
-- =========================================================================
-- `payment_terms_days` is the number of days after the bill date a supplier's
-- invoice is due (net-30 → 30). It is NULLABLE and carries NO database default,
-- deliberately:
--
--   * NULL means "terms not recorded", which is the truth for every existing
--     supplier and most new ones. A DB `default 30` would stamp an AGREED net-30
--     term onto every supplier as though the operator had entered it — the exact
--     fabrication lib/commercial/aged-creditors.ts' header refuses ("defaulting
--     every supplier to net-30 would put a fabricated contractual term into a
--     report an operator makes payment decisions from").
--
--   * The 30-day assumption still has to live SOMEWHERE for ageing to work, so
--     it lives in CODE (lib/commercial/overdue-payables.ts
--     `DEFAULT_PAYMENT_TERMS_DAYS = 30`), where the surface can DISCLOSE it as an
--     assumption rather than present it as a recorded term. A stored default
--     cannot be told apart from a keyed-in one after the fact; a code default,
--     applied only at read time, can.
--
-- CHECK (0..365): net-0 (due on receipt) is legitimate; 365 is a generous ceiling
-- that still rejects a fat-fingered 3000. Mirrors the "validate the range the
-- business actually uses" idiom of the site-report percent CHECK (20261078).
--
-- =========================================================================
-- DESIGN DECISION 2 — THE BILL DUE DATE IS DERIVED AT READ TIME, NOT STORED.
--                     `finances` IS LEFT BYTE-FOR-BYTE UNTOUCHED.
-- =========================================================================
-- A bill's due date is `bill_date + effective_terms`. It could be a STORED
-- `finances.due_date` set at bill creation, or a value DERIVED at read time.
-- This migration adds NO column to `finances` and computes the due date in the
-- pure lib (lib/commercial/overdue-payables.ts). Three reasons, in order:
--
--   a) A DUE DATE SHOULD TRACK THE CURRENT AGREED TERMS. If a supplier's terms
--      move from net-30 to net-60, the honest due date of an as-yet-unpaid bill
--      moves with them. A value frozen at bill-creation would keep chasing the
--      old deadline. (If the product ever wants FROZEN terms — e.g. terms as they
--      stood when the bill was raised — that is a stored `finances.due_date`
--      backfilled once and set by the write path from then on; it is an additive
--      sibling change, and this decision is called out so that choice is a
--      deliberate product one, not a silent default. See the final report's
--      "frozen-vs-live" note.)
--
--   b) NO CHANGE TO THE `finances` WRITE PATH. `finances` is the supplier-bill
--      ledger the cash-out, CIS and VAT invariants are built on
--      (lib/commercial/cash-out.ts, lib/cis/*). A stored due date means a new
--      column every bill-insert path must populate and a backfill over live
--      rows — new surface area over the most sensitive money table in the
--      product. Deriving keeps this migration to ONE additive column on a
--      reference table and leaves `finances` — its generated `vat_total`, its
--      settlement floor trigger (20261054), its org-integrity trigger
--      (20261009) — completely untouched. No money/CIS/VAT arithmetic changes.
--
--   c) NO STORED-VALUE DRIFT. A derived value cannot go stale against the terms
--      it is computed from; there is nothing to reconcile.
--
-- IMPORTANT: the derived due date changes only which AGEING BUCKET a bill lands
-- in. It does NOT change any outstanding balance — those still come solely from
-- computeBillSettlements (lib/suppliers/payments). So the TOTAL payable is
-- identical whether aged by bill date or by due date, which is the reconciliation
-- identity proved in __tests__/commercial/overdue-payables.test.ts (payables
-- ageing total == aged-creditors total == computeOrgCashOut().unpaidBills).
--
-- =========================================================================
-- ADDITIVE AND REVERSIBLE
-- =========================================================================
-- One nullable column on a reference table, guarded by IF NOT EXISTS. It adds no
-- trigger, no policy, no FK and no index; RLS on `suppliers` is untouched (the
-- existing suppliers_select/insert/update/delete policies already cover every
-- column). Replays clean from scratch. To roll back:
--   alter table public.suppliers drop column if exists payment_terms_days;

alter table public.suppliers
  add column if not exists payment_terms_days integer
    check (payment_terms_days is null
           or (payment_terms_days >= 0 and payment_terms_days <= 365));

comment on column public.suppliers.payment_terms_days is
  'Days after a bill date the supplier''s invoice is due (net-30 -> 30). '
  'NULLABLE with NO db default: NULL means "terms not recorded". The 30-day '
  'ageing assumption is applied in code (lib/commercial/overdue-payables.ts '
  'DEFAULT_PAYMENT_TERMS_DAYS) and disclosed as an assumption, never stored as '
  'though it were an agreed term. A bill''s due date (bill_date + terms) is '
  'DERIVED at read time; finances carries no stored due_date by design.';
