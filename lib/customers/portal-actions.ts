/**
 * Customer portal — the action centre (pure).
 *
 * Aggregates "what needs your attention" from data the portal pages already
 * load: quotes awaiting a response, invoices due/overdue, and published
 * reports with client decisions outstanding. Every item carries a PRECISE
 * label ("Approve £2,400 quote", never "Continue"), its consequence/deadline,
 * and a deep link to the EXISTING single-authority surface for the action
 * (/q/<public_token> for quote decisions; the portal invoice/report pages
 * otherwise). Pure + unit-tested; no clocks (caller passes today).
 *
 * OVERDUE / OUTSTANDING is decided by the ONE canonical authority
 * (lib/invoices/overdue.ts) — not a local copy. A previous local
 * `isInvoiceOverdue` here recognised only {overdue, sent}, so an
 * `awaiting_payment` or `partially_paid` invoice (the latter stamped by the
 * payment-sync trigger on ANY deposit) appeared in NEITHER the overdue nor the
 * due-soon list — it silently vanished from "Needs your attention" on a
 * customer-facing surface. Every collectable status now spans both lists.
 *
 * MONEY is labelled NET of payments via the C53 receivables primitive
 * (`invoiceRemaining`), never gross `total`: a £10k invoice with a £3k deposit
 * reads "£7,000.00", not "£10,000.00".
 */

import {
  OVERDUE_COLLECTABLE_STATUSES,
  isInvoiceOverdue,
} from "@/lib/invoices/overdue";
import { invoiceRemaining } from "@/lib/invoices/receivables";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type PortalActionQuote = {
  id: string;
  number: string | null;
  status: string;
  total: number | string | null;
  valid_until: string | null;
  public_token: string | null;
};

export type PortalActionInvoice = {
  id: string;
  number: string | null;
  status: string;
  total: number | string | null;
  due_date: string | null;
  /**
   * Σ invoice_payments.amount for THIS invoice (the ledger). Optional so a
   * caller with no payments to hand still type-checks; absent means £0 paid.
   * Labels are netted with this via `invoiceRemaining`, never gross `total`.
   */
  paid?: number | string | null;
};

export type PortalActionReport = {
  id: string;
  title: string;
  decisions_outstanding: boolean;
};

export type PortalActionItem = {
  kind: "quote" | "invoice_overdue" | "invoice_due" | "report_decision";
  label: string;
  sub: string;
  href: string;
};

export function money(v: number | string | null): string {
  return GBP.format(Number(v ?? 0));
}

/** Net amount still owed on ONE invoice — the C53 primitive, never gross total. */
function remainingOf(inv: PortalActionInvoice): number {
  return invoiceRemaining({ total: inv.total, paid: inv.paid ?? 0 });
}

/**
 * Invoices with money still owed: a canonical COLLECTABLE status AND a positive
 * net balance. This is the population the overdue/due-soon lists partition — it
 * spans sent, awaiting_payment, partially_paid and (legacy) overdue, so no
 * outstanding invoice can slip out of "Needs your attention".
 */
function outstandingInvoices(invoices: PortalActionInvoice[]): PortalActionInvoice[] {
  const collectable = new Set<string>(OVERDUE_COLLECTABLE_STATUSES);
  return invoices.filter((i) => collectable.has(i.status) && remainingOf(i) > 0);
}

/**
 * Build the ordered action list. Priority: overdue payments → quotes awaiting
 * a response (soonest expiry first) → payments coming due → report decisions.
 */
export function buildPortalActionItems(input: {
  token: string;
  todayIso: string;
  quotes: PortalActionQuote[];
  invoices: PortalActionInvoice[];
  reports: PortalActionReport[];
}): PortalActionItem[] {
  const { token, todayIso } = input;
  const items: PortalActionItem[] = [];

  // The outstanding pool (every collectable status with a net balance), split
  // into overdue vs due-soon by the ONE canonical predicate. Labels are NET.
  const outstanding = outstandingInvoices(input.invoices);
  const overdue = outstanding.filter((i) => isInvoiceOverdue(i, todayIso));
  for (const inv of overdue) {
    items.push({
      kind: "invoice_overdue",
      label: `Payment of ${money(remainingOf(inv))} is overdue — invoice ${inv.number ?? ""}`.trim(),
      sub: inv.due_date ? `Was due ${inv.due_date.slice(0, 10)}.` : "Payment is past due.",
      href: `/customer-portal/${token}/invoices`,
    });
  }

  // Quotes the customer can act on: sent/viewed (the portal never surfaces
  // drafts or internal approval states). Soonest expiry first.
  const actionableQuotes = input.quotes
    .filter((q) => (q.status === "sent" || q.status === "viewed") && q.public_token)
    .sort((a, b) => (a.valid_until ?? "9999") < (b.valid_until ?? "9999") ? -1 : 1);
  for (const q of actionableQuotes) {
    items.push({
      kind: "quote",
      label: `Review and respond — ${money(q.total)} quote${q.number ? ` ${q.number}` : ""}`,
      sub: q.valid_until
        ? `Valid until ${q.valid_until.slice(0, 10)}. Accepting confirms the work can go ahead.`
        : "Accepting confirms the work can go ahead.",
      href: `/q/${q.public_token}`,
    });
  }

  // Due soon = outstanding but NOT overdue (all collectable statuses, not just
  // `sent`) — so an awaiting_payment / partially_paid invoice that is not yet
  // past due still surfaces here instead of vanishing.
  const dueSoon = outstanding.filter((i) => !isInvoiceOverdue(i, todayIso));
  for (const inv of dueSoon) {
    items.push({
      kind: "invoice_due",
      label: `Payment of ${money(remainingOf(inv))} is due — invoice ${inv.number ?? ""}`.trim(),
      sub: inv.due_date ? `Due by ${inv.due_date.slice(0, 10)}.` : "Payment details are on the invoice.",
      href: `/customer-portal/${token}/invoices`,
    });
  }

  for (const r of input.reports.filter((r) => r.decisions_outstanding)) {
    items.push({
      kind: "report_decision",
      label: `Decisions needed — ${r.title}`,
      sub: "The latest progress report lists choices we need from you.",
      href: `/customer-portal/${token}/reports/${r.id}`,
    });
  }

  return items;
}
