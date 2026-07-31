import { formatGbp, round2, sumMoney, toPounds } from "@/lib/money";

/**
 * Job commercial position (Programme B slice 1) — the owner's answer to
 * "what's this job worth now?". PURE aggregation over data already owned by
 * quotes/variations/invoices — no new store, no mutation of the accepted quote
 * value (the original is preserved, the revised value is DERIVED).
 *
 * Variations are quotes with a `variation_number` on the job (20260520180000);
 * the base contract is the accepted quote with `variation_number IS NULL`.
 * Everything here is labelled by reliability — approved (accepted) values are
 * firm; pending variations are shown separately and never folded into the
 * revised value.
 */

export type PositionQuote = {
  status: string;
  total: number | string | null;
  variation_number: number | null;
  /**
   * Ex-VAT value (`quotes.subtotal`). OPTIONAL: callers that only need the cash
   * (gross) taxonomy may omit it, and the `*Net` figures below then read 0.
   *
   * It exists because COST is ex-VAT everywhere in this codebase
   * (`finances.amount`, and the whole profitability feed), so reconciling cost
   * against `revised` — which is GROSS, because cash is what moves through the
   * bank — would report a ~20 % gap on a job that is exactly on plan. Any
   * cost-vs-value comparison must use `revisedNet`.
   */
  subtotal?: number | string | null;
};

export type PositionInvoice = {
  status: string;
  total: number | string | null;
};

export type JobCommercialPosition = {
  /** Accepted base quote(s) — the original agreed value, never overwritten. */
  original: number;
  /** Sum of ACCEPTED variations — the approved scope changes. */
  approvedVariations: number;
  /** original + approvedVariations. */
  revised: number;
  /** `original`, ex-VAT (0 unless the caller selected `subtotal`). */
  originalNet: number;
  /** `approvedVariations`, ex-VAT (0 unless the caller selected `subtotal`). */
  approvedVariationsNet: number;
  /**
   * originalNet + approvedVariationsNet — the revised contract value on the SAME
   * VAT basis as cost. This is the figure a cost baseline, a forecast final cost
   * and a margin must be reconciled against; `revised` (gross) is the cash one.
   */
  revisedNet: number;
  /** Variations sent/viewed but not yet decided (shown, never in `revised`). */
  pendingVariations: number;
  /** Sum of non-draft invoices raised against the job. */
  invoiced: number;
  /** Sum of paid/partially-paid invoice totals. */
  paid: number;
  /** revised − invoiced (what's still to bill). */
  uninvoiced: number;
  /** invoiced − paid (billed but unpaid). */
  outstanding: number;
  counts: { approvedVariations: number; pendingVariations: number };
};

const ACCEPTED = "accepted";
const PENDING = new Set(["sent", "viewed"]);
const INVOICE_RAISED = new Set(["sent", "awaiting_payment", "partially_paid", "paid", "overdue"]);
const INVOICE_PAID = new Set(["paid", "partially_paid"]);

export function computeJobCommercialPosition(input: {
  quotes: PositionQuote[];
  invoices: PositionInvoice[];
}): JobCommercialPosition {
  const base = input.quotes.filter((q) => q.variation_number == null && q.status === ACCEPTED);
  const acceptedVars = input.quotes.filter((q) => q.variation_number != null && q.status === ACCEPTED);
  const pendingVars = input.quotes.filter((q) => q.variation_number != null && PENDING.has(q.status));

  const original = sumMoney(base.map((q) => q.total));
  const approvedVariations = sumMoney(acceptedVars.map((q) => q.total));
  const revised = round2(original + approvedVariations);
  const pendingVariations = sumMoney(pendingVars.map((q) => q.total));

  // The same taxonomy on the ex-VAT basis, for cost reconciliation.
  const originalNet = sumMoney(base.map((q) => q.subtotal));
  const approvedVariationsNet = sumMoney(acceptedVars.map((q) => q.subtotal));

  const invoiced = sumMoney(
    input.invoices.filter((i) => INVOICE_RAISED.has(i.status)).map((i) => i.total),
  );
  const paid = sumMoney(
    input.invoices.filter((i) => INVOICE_PAID.has(i.status)).map((i) => i.total),
  );

  return {
    original,
    approvedVariations,
    revised,
    originalNet,
    approvedVariationsNet,
    revisedNet: round2(originalNet + approvedVariationsNet),
    pendingVariations,
    invoiced,
    paid,
    uninvoiced: round2(revised - invoiced),
    outstanding: round2(invoiced - paid),
    counts: { approvedVariations: acceptedVars.length, pendingVariations: pendingVars.length },
  };
}

/** Does the job have any commercial data worth surfacing the panel for? */
export function hasCommercialPosition(p: JobCommercialPosition): boolean {
  return (
    p.original > 0 ||
    p.approvedVariations > 0 ||
    p.pendingVariations > 0 ||
    p.invoiced > 0 ||
    p.counts.approvedVariations > 0 ||
    p.counts.pendingVariations > 0
  );
}

export { formatGbp, toPounds };
