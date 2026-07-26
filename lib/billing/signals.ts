import { round2, toPounds } from "@/lib/money";

/**
 * Billing signals for the Daily Briefing (PR #425).
 *
 * PURE + briefing-shaped. This is the SEAM — H2-CASH exposes it here rather than
 * reaching into the (still-unmerged) briefing composer, so no cross-branch
 * coupling exists. Once #425 lands, its service maps these into briefing items
 * ("Job Smith — 2 stages (£12,000) ready to invoice"). Overdue/received money is
 * already surfaced by the briefing's invoice signals, so this adds only the
 * NEW money the briefing can't otherwise see: unbilled, ready-to-invoice work.
 */
export interface BillingSignal {
  /** Stable per-job key so a consumer can dedupe/dismiss. */
  key: string;
  title: string;
  detail: string;
  href: string;
  amount: number;
}

/** A planned (un-invoiced) stage the operator could bill now. */
export interface ReadyStage {
  name: string;
  /** Ex-VAT amount. */
  amount: number;
}

/**
 * "Ready to invoice" signal for one job: the planned stages that have not yet
 * generated an invoice. Returns [] when there's nothing ready (no signal).
 */
export function readyToInvoiceSignal(input: {
  jobId: string;
  jobLabel: string;
  readyStages: ReadyStage[];
}): BillingSignal[] {
  const stages = input.readyStages.filter((s) => toPounds(s.amount) > 0);
  if (stages.length === 0) return [];
  const total = stages.reduce((acc, s) => round2(acc + toPounds(s.amount)), 0);
  const n = stages.length;
  const gbp = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(total);
  return [
    {
      key: `billing_ready:${input.jobId}`,
      title: `${gbp} ready to invoice`,
      detail: `${input.jobLabel}: ${n} ${n === 1 ? "stage is" : "stages are"} planned and not yet invoiced (${gbp} + VAT).`,
      href: `/jobs/${input.jobId}/billing`,
      amount: total,
    },
  ];
}
