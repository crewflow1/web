import {
  invoiceDaysOverdue,
  isCollectableStatus,
} from "@/lib/invoices/overdue";
import { invoiceRemaining, type OrgCashInvoice } from "@/lib/commercial/org-cash";
import { buildAgeingLedger, type AgeingItem, type AgeingLedger } from "@/lib/commercial/ageing";

/**
 * AGED DEBTORS — the bridge from invoice rows to aged buckets. PURE.
 *
 * This module exists so the composition that MUST reconcile with the cash
 * service is testable without a database. It contributes no arithmetic: the
 * balance is `invoiceRemaining` (lib/commercial/org-cash) and the day count is
 * `invoiceDaysOverdue` (lib/invoices/overdue). It only decides which invoices
 * are in scope, who they belong to, and how to label them.
 *
 * ── THE TWO IDENTITIES THIS MODULE EXISTS TO PRESERVE ────────────────────────
 * For the same invoices, payments and as-at day:
 *
 *     composeAgedDebtors(...).totals.total   === computeOrgCashSummary(...).owedNow
 *     composeAgedDebtors(...).totals.pastDue === computeOrgCashSummary(...).overdue
 *
 * They hold because all three ingredients are shared, not re-implemented:
 *
 *   POPULATION  `isCollectableStatus` — the exported authority for the four
 *               statuses where money is still owed. `computeOrgCashSummary`
 *               filters on exactly that set. A local `new Set([...])` here would
 *               be a second copy that silently drifts the day someone adds a
 *               `void` status, so there isn't one.
 *   BALANCE     `invoiceRemaining` — max(0, total − Σ payments), capped per
 *               invoice. Same function, same call, same zero-skip.
 *   LATENESS    `invoiceDaysOverdue`, which returns null unless
 *               `isInvoiceOverdue` holds — so an invoice is in a past-due bucket
 *               if and only if /cash counts it as overdue.
 *
 * Two numbers for the same thing that disagree are worse than one report fewer,
 * so both identities are proved in
 * __tests__/commercial/aged-debtors-reconciliation.test.ts over every invoice
 * status crossed with every settlement level — including the statuses that must
 * be EXCLUDED, which is the half a happy-path fixture never checks.
 */

/** An invoice row as the aged-debtors read supplies it. */
export type DebtorInvoice = {
  id: string;
  number: string | null;
  status: string;
  /** GROSS total (VAT-inclusive) — what the customer pays. */
  total: number | string | null;
  due_date: string | null;
  /** Denormalised customer (20260915000000). Null on pre-backfill rows. */
  customer_id: string | null;
  job_id: string | null;
  /** Σ `invoice_payments.amount` for this invoice — the ledger, not the status. */
  paid: number;
};

export type DebtorNaming = {
  /** customer id → name, for the row label. */
  customerName: Map<string, string>;
  /** job id → customer id, the fallback for a pre-backfill invoice. */
  jobCustomer: Map<string, string | null>;
};

/** Label for an invoice whose customer cannot be resolved at all. */
export const UNATTRIBUTED_CUSTOMER_LABEL = "Unattributed";

/**
 * Turn invoice rows into aged-ledger items.
 *
 * A pre-denormalisation invoice can carry a null `customer_id`; its job still
 * knows the customer, so the job is consulted before giving up. Real debt must
 * not land in "Unattributed" just because the row predates a backfill — that row
 * would be excluded from every customer conversation while still counting in the
 * total, which is how a debtor gets forgotten.
 */
export function composeDebtorItems(
  invoices: DebtorInvoice[],
  naming: DebtorNaming,
  asAtIso: string,
): AgeingItem[] {
  const items: AgeingItem[] = [];
  for (const inv of invoices) {
    if (!isCollectableStatus(inv.status)) continue;

    const forRemaining: Pick<OrgCashInvoice, "total" | "paid"> = {
      total: inv.total,
      paid: inv.paid,
    };
    const amount = invoiceRemaining(forRemaining);
    if (amount <= 0) continue;

    const customerId =
      inv.customer_id ?? (inv.job_id ? naming.jobCustomer.get(inv.job_id) ?? null : null);

    items.push({
      id: inv.id,
      partyId: customerId ?? "",
      partyName: customerId
        ? naming.customerName.get(customerId) || "Unnamed customer"
        : UNATTRIBUTED_CUSTOMER_LABEL,
      amount,
      ageDays: invoiceDaysOverdue({ status: inv.status, due_date: inv.due_date }, asAtIso),
      reference: inv.number,
      dateIso: inv.due_date,
      href: `/invoices/${inv.id}`,
    });
  }
  return items;
}

/** The aged debtors ledger. */
export function composeAgedDebtors(
  invoices: DebtorInvoice[],
  naming: DebtorNaming,
  asAtIso: string,
): AgeingLedger {
  return buildAgeingLedger(composeDebtorItems(invoices, naming, asAtIso));
}
