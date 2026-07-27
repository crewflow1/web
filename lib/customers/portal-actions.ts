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
 */

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

/** Overdue = due_date strictly before today (date-only compare). */
export function isInvoiceOverdue(inv: { status: string; due_date: string | null }, todayIso: string): boolean {
  if (inv.status === "overdue") return true;
  return inv.status === "sent" && !!inv.due_date && inv.due_date.slice(0, 10) < todayIso;
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

  const overdue = input.invoices.filter((i) => isInvoiceOverdue(i, todayIso));
  for (const inv of overdue) {
    items.push({
      kind: "invoice_overdue",
      label: `Payment of ${money(inv.total)} is overdue — invoice ${inv.number ?? ""}`.trim(),
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

  const dueSoon = input.invoices.filter(
    (i) => i.status === "sent" && !isInvoiceOverdue(i, todayIso),
  );
  for (const inv of dueSoon) {
    items.push({
      kind: "invoice_due",
      label: `Payment of ${money(inv.total)} is due — invoice ${inv.number ?? ""}`.trim(),
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
