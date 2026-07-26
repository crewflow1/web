import { round2, toPounds } from "@/lib/money";

/**
 * Precise per-invoice retention attribution (H2-CASH M3) — PURE.
 *
 * ── The problem this fixes (the M2 "P3" approximation) ───────────────────────
 * M2 netted retention crudely at the portfolio level:
 *     collectableNow = outstanding − retentionHeld
 * where `retentionHeld` (job `accrued − released`) accrues on EVERY non-draft
 * invoice — including ones the customer has ALREADY PAID IN FULL. So retention
 * that accrued on a settled invoice still reduced the chase-now figure, which
 * UNDERSTATES the cash a builder can actually collect. M2 documented this and
 * deferred the precise model to M3.
 *
 * ── The precise model ────────────────────────────────────────────────────────
 * Retention in CrewFlow accrues per the job's contract rate on each invoice's
 * NET (ex-VAT) works value (the existing `lib/retentions` authority — VAT is
 * never retained). That rate is uniform across a job's invoices, so the
 * retention a single invoice's works attract is derivable exactly:
 *
 *     retentionAccrued_i = round2(rate% × invoice.net_i)          (ex-VAT)
 *
 * The retention still *withheld inside an unpaid balance* is only ever the part
 * of that invoice that is still owed. In the ordinary construction flow the
 * customer pays the certified value LESS retention, so retention is the last
 * slice left unpaid. We cap embedded retention at what is actually still owed:
 *
 *     retentionEmbedded_i = min(grossRemaining_i, retentionAccrued_i)
 *
 * A fully-paid invoice has `grossRemaining_i = 0`, so it contributes ZERO
 * embedded retention no matter how much it accrued — which is exactly the M2
 * defect, fixed at the source.
 *
 * ── Respecting the two independent ledgers ───────────────────────────────────
 * Cash lives in `invoice_payments`; retention releases live in the separate
 * `retention_releases` ledger (job-level, no per-invoice tag). We must not
 * subtract from collectable either (a) more than is still HELD after releases,
 * or (b) more than is still EMBEDDED in unpaid invoices. Taking the lesser of
 * the two never over-nets and never changes either ledger's meaning:
 *
 *     withheldFromCollectable_job = min(retentionHeld_job, Σ retentionEmbedded_i)
 *
 * Because every `embedded_i ≤ grossRemaining_i`, `Σ embedded ≤ outstanding`, so
 * `collectableNow = outstanding − withheldFromCollectable` is always ≥ 0 without
 * a floor (we floor anyway, defensively). This is strictly ≥ the M2 figure — it
 * only ever *recovers* wrongly-withheld cash, never invents it.
 *
 * The retention that is held but NOT embedded in any unpaid balance
 * (`heldOutsideOutstanding`) is a genuine future receivable — the customer has
 * already paid the works and the retention comes back at its release date. It is
 * surfaced through the retention schedule (`lib/retentions/schedule`), never
 * folded into invoice collectable.
 */

/** One invoice's inputs for retention attribution. */
export type AttributionInvoice = {
  /** ex-VAT net works value (`invoices.amount`) — the retention base. */
  net: number | string | null;
  /**
   * Gross balance still owed on this invoice, ALREADY floored at ≥ 0 by the
   * caller (the `max(0, total − Σpayments)` per-invoice rule). Passing a raw
   * `total − paid` would let an overpaid invoice carry negative embedded
   * retention — never do that.
   */
  grossRemaining: number;
};

/** Retention attributable to a single invoice. */
export type InvoiceRetention = {
  /** round2(rate% × net) — retention this invoice's works accrue (ex-VAT). */
  accrued: number;
  /** min(grossRemaining, accrued) — retention still unpaid on this invoice. */
  embedded: number;
};

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Attribute retention to ONE invoice given the job's contract rate. */
export function attributeInvoiceRetention(
  invoice: AttributionInvoice,
  ratePercent: number | string | null,
): InvoiceRetention {
  const rate = clampPct(toPounds(ratePercent));
  const net = round2(Math.max(0, toPounds(invoice.net)));
  const accrued = round2((rate / 100) * net);
  const remaining = round2(Math.max(0, invoice.grossRemaining));
  const embedded = round2(Math.min(remaining, accrued));
  return { accrued, embedded };
}

/** The retention-netting outcome for one job. */
export type JobRetentionNetting = {
  /** Σ retentionAccrued across the job's non-draft invoices (ex-VAT). */
  accruedTotal: number;
  /** Σ retentionEmbedded — retention still sitting in unpaid balances. */
  embeddedTotal: number;
  /** min(retentionHeld, embeddedTotal) — the amount to remove from collectable. */
  withheldFromCollectable: number;
  /**
   * retentionHeld − withheldFromCollectable — held retention NOT embedded in any
   * unpaid balance (a separate future receivable, surfaced via the schedule).
   */
  heldOutsideOutstanding: number;
};

/**
 * Net one job's retention against its invoice balances.
 *
 * `retentionHeld` MUST come from the retention authority (`computeRetentionPosition`
 * → `held = max(0, accrued − released)`), so releases already reduce it. We never
 * recompute retention here — we only decide how much of the held pool is still
 * embedded in unpaid invoices and therefore must be excluded from chase-now cash.
 */
export function computeJobRetentionNetting(input: {
  invoices: AttributionInvoice[];
  ratePercent: number | string | null;
  /** Job held retention (ex-VAT) from lib/retentions — accrued − released. */
  retentionHeld: number;
}): JobRetentionNetting {
  let accruedTotal = 0;
  let embeddedTotal = 0;
  for (const inv of input.invoices) {
    const { accrued, embedded } = attributeInvoiceRetention(inv, input.ratePercent);
    accruedTotal = round2(accruedTotal + accrued);
    embeddedTotal = round2(embeddedTotal + embedded);
  }
  const held = round2(Math.max(0, toPounds(input.retentionHeld)));
  const withheldFromCollectable = round2(Math.min(held, embeddedTotal));
  return {
    accruedTotal,
    embeddedTotal,
    withheldFromCollectable,
    heldOutsideOutstanding: round2(Math.max(0, held - withheldFromCollectable)),
  };
}

/** A job's contribution to the org-wide precise retention netting. */
export type OrgRetentionJob = {
  invoices: AttributionInvoice[];
  ratePercent: number | string | null;
  retentionHeld: number;
};

export type OrgRetentionNetting = {
  accruedTotal: number;
  embeddedTotal: number;
  /** Σ per-job min(held, embedded) — the precise portfolio retention to net. */
  withheldFromCollectable: number;
  heldOutsideOutstanding: number;
};

/**
 * Portfolio retention netting = Σ of the PER-JOB nettings. It must be summed per
 * job (not `min(Σheld, Σembedded)`) because each job has its own rate and its own
 * held pool; a global min would let one job's slack absorb another's overflow.
 */
export function computeOrgRetentionNetting(jobs: OrgRetentionJob[]): OrgRetentionNetting {
  let accruedTotal = 0;
  let embeddedTotal = 0;
  let withheldFromCollectable = 0;
  let heldOutsideOutstanding = 0;
  for (const job of jobs) {
    const n = computeJobRetentionNetting(job);
    accruedTotal = round2(accruedTotal + n.accruedTotal);
    embeddedTotal = round2(embeddedTotal + n.embeddedTotal);
    withheldFromCollectable = round2(withheldFromCollectable + n.withheldFromCollectable);
    heldOutsideOutstanding = round2(heldOutsideOutstanding + n.heldOutsideOutstanding);
  }
  return { accruedTotal, embeddedTotal, withheldFromCollectable, heldOutsideOutstanding };
}
