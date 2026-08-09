import { round2, sumMoney } from "@/lib/money";
import { labelled, type LabelledMetric } from "@/lib/intelligence/provenance";
import { OUTSTANDING_STATUSES } from "@/lib/invoices/schema";

/**
 * CUSTOMER LIFETIME VALUE — deterministic, two-certainty. PURE.
 *
 * ── WHAT LTV MEANS HERE, AND WHAT IT REFUSES TO MEAN ────────────────────────
 * "Lifetime value" is usually a forecast wearing a fact's clothes — a model that
 * multiplies an average order by an invented retention curve. There is NONE of
 * that here. This module reports only what the ledger already knows, split into
 * two clearly-separate certainties (the lib/commercial/cash-out.ts idiom):
 *
 *   REALISED   Σ ex-VAT amount of the customer's PAID invoices. Money the work
 *              actually earned and the customer actually settled. A fact of the
 *              ledger, restated and summed — DERIVED.
 *   COMMITTED  Σ ex-VAT amount of the customer's ISSUED-but-not-yet-paid
 *              invoices (sent / awaiting payment / partially paid / overdue).
 *              Invoiced — so contractually committed — but not yet realised.
 *              Also DERIVED, and NEVER added silently into the realised figure:
 *              the whole point is that the reader can see how much of a
 *              customer's value has actually arrived versus is still owed.
 *
 * There is NO projected future value, NO churn probability, NO "expected" third
 * number. A total is offered (realised + committed) because both are ex-VAT £ on
 * the same axis — honest arithmetic, one denominator — but the two components
 * are always carried alongside it so the total can never be mistaken for cash in
 * the bank.
 *
 * ── EX-VAT, LIKE EVERY OTHER REVENUE FIGURE ─────────────────────────────────
 * `invoices.amount` (ex-VAT), matching lib/profitability/compute.ts and
 * lib/intelligence/concentration.ts. VAT is collected on HMRC's behalf, not
 * earned, and a customer-value figure quoted on gross would overstate every
 * customer by ~20% and quietly disagree with the concentration card next to it.
 *
 * ── ATTRIBUTION ─────────────────────────────────────────────────────────────
 * `invoices.customer_id` is the denormalised anchor; a pre-backfill row can
 * carry null, so the invoice's JOB is consulted as the fallback — the exact rule
 * lib/intelligence/concentration.ts and lib/commercial/aged-debtors.ts apply.
 * What still cannot be resolved is reported under an explicit Unattributed
 * bucket, never dropped (dropping it would flatter every named customer).
 *
 * ── DRAFT IS NOT VALUE ──────────────────────────────────────────────────────
 * A draft invoice was never issued — nothing was sold — so it counts toward
 * neither figure. The invoice status enum is
 * draft/sent/awaiting_payment/partially_paid/paid/overdue (verified in
 * lib/invoices/overdue.ts); if a `void` state is ever added it must be excluded
 * here too.
 *
 * PURE: no I/O, no clock. The read layer scopes every invoice to the active org.
 */

// ---------------------------------------------------------------------------
// Status partition (single source of truth for what counts where)
// ---------------------------------------------------------------------------

/** Fully settled — the realised value. */
const REALISED_STATUS = new Set(["paid"]);
/**
 * Issued but not yet fully settled — the committed value. Draft excluded, paid
 * excluded. This IS the canonical outstanding set (lib/invoices/schema.
 * OUTSTANDING_STATUSES = sent · awaiting_payment · partially_paid · overdue);
 * derived from it, never a local copy, so a trigger-stamped partially_paid /
 * awaiting_payment deposit can never silently drop out of committed value.
 */
const COMMITTED_STATUS = new Set<string>(OUTSTANDING_STATUSES);

export const CUSTOMER_LTV_TOP_N = 8;
export const UNATTRIBUTED_LABEL = "Unattributed";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type LtvInvoice = {
  id: string;
  status: string;
  /** EX-VAT revenue (`invoices.amount`). */
  amount: number | string | null;
  /** Denormalised anchor (20260915); null on pre-backfill rows. */
  customer_id: string | null;
  job_id: string | null;
};

export type LtvNaming = {
  customerName: Map<string, string>;
  /** job id → customer id, the pre-backfill fallback. */
  jobCustomer: Map<string, string | null>;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type CustomerLtvRow = {
  /** Null for the Unattributed bucket. */
  customerId: string | null;
  name: string;
  /** Σ ex-VAT of PAID invoices — money realised. */
  realisedValue: number;
  /** Σ ex-VAT of issued-but-unpaid invoices — committed, not yet realised. */
  committedValue: number;
  /** realisedValue + committedValue (same ex-VAT axis). */
  totalValue: number;
  /** How many of this customer's invoices are fully paid. */
  paidInvoiceCount: number;
  /** How many are issued but not yet paid. */
  openInvoiceCount: number;
  href: string;
};

export type CustomerLtv = {
  /** Every attributable customer plus the Unattributed bucket, worst-value last. */
  customers: CustomerLtvRow[];
  /** Top N by total value — what the card renders. */
  top: CustomerLtvRow[];
  /** Σ realised across all customers. */
  realisedTotal: number;
  /** Σ committed across all customers. */
  committedTotal: number;
  /** Distinct attributable customers with any realised or committed value. */
  customerCount: number;
  /** Issued invoices counted (draft excluded). */
  invoiceCount: number;
};

export function computeCustomerLtv(input: {
  invoices: LtvInvoice[];
  naming: LtvNaming;
}): CustomerLtv {
  type Acc = { realised: number; committed: number; paid: number; open: number };
  const byCustomer = new Map<string, Acc>();
  const UNATTRIBUTED_KEY = "";
  let invoiceCount = 0;

  for (const inv of input.invoices) {
    const isRealised = REALISED_STATUS.has(inv.status);
    const isCommitted = COMMITTED_STATUS.has(inv.status);
    if (!isRealised && !isCommitted) continue; // draft (or unknown) — never issued value.
    invoiceCount += 1;

    const customerId =
      inv.customer_id ??
      (inv.job_id ? input.naming.jobCustomer.get(inv.job_id) ?? null : null);
    const key = customerId ?? UNATTRIBUTED_KEY;
    const acc = byCustomer.get(key) ?? { realised: 0, committed: 0, paid: 0, open: 0 };
    if (isRealised) {
      acc.realised = sumMoney([acc.realised, inv.amount]);
      acc.paid += 1;
    } else {
      acc.committed = sumMoney([acc.committed, inv.amount]);
      acc.open += 1;
    }
    byCustomer.set(key, acc);
  }

  const customers: CustomerLtvRow[] = [...byCustomer.entries()].map(([key, acc]) => {
    const isUnattributed = key === UNATTRIBUTED_KEY;
    return {
      customerId: isUnattributed ? null : key,
      name: isUnattributed
        ? UNATTRIBUTED_LABEL
        : input.naming.customerName.get(key) || "Unnamed customer",
      realisedValue: acc.realised,
      committedValue: acc.committed,
      totalValue: round2(acc.realised + acc.committed),
      paidInvoiceCount: acc.paid,
      openInvoiceCount: acc.open,
      href: isUnattributed ? "/invoices" : `/customers/${key}`,
    };
  });

  // Deterministic total order: biggest total value, then realised, then name/id.
  customers.sort(
    (a, b) =>
      b.totalValue - a.totalValue ||
      b.realisedValue - a.realisedValue ||
      a.name.localeCompare(b.name) ||
      (a.customerId ?? "").localeCompare(b.customerId ?? ""),
  );

  return {
    customers,
    top: customers.slice(0, CUSTOMER_LTV_TOP_N),
    realisedTotal: sumMoney(customers.map((c) => c.realisedValue)),
    committedTotal: sumMoney(customers.map((c) => c.committedValue)),
    customerCount: customers.filter((c) => c.customerId != null).length,
    invoiceCount,
  };
}

// ---------------------------------------------------------------------------
// Labelled metric
// ---------------------------------------------------------------------------

/** Both figures: DERIVED — exact sums of the ledger's own ex-VAT invoice amounts. */
export function customerLtvMetric(l: CustomerLtv): LabelledMetric<CustomerLtv> {
  return labelled(l, {
    kind: "derived",
    basis:
      "Each customer's realised value is the sum of their PAID invoices (ex-VAT); their committed " +
      "value is the sum of invoices issued but not yet fully paid (sent, awaiting payment, partly " +
      "paid or overdue). The two are kept apart on purpose — committed money has been invoiced but " +
      "not yet arrived — and are never blended into a single 'lifetime' figure with an invented " +
      "future. Draft invoices are excluded (never issued); invoices whose customer can't be " +
      "resolved are shown as Unattributed, never dropped.",
    computedFrom: [
      { label: "Invoices", href: "/invoices" },
      { label: "Customers", href: "/customers" },
    ],
  });
}
