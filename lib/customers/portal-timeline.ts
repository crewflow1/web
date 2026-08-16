/**
 * Customer portal — the unified activity timeline (pure).
 *
 * Weaves the customer's own quotes, invoices, payments and published reports
 * into ONE reverse-chronological feed ("quote sent → you accepted → invoice
 * issued → payment received → report published"), so the customer can see the
 * whole relationship at a glance instead of hopping between tabs.
 *
 * CUSTOMER-SAFE BY CONSTRUCTION: this module is pure and accepts ONLY the
 * narrow, already-scoped primitives the caller reads (numbers, statuses, dates,
 * public tokens, report ids/titles). It has no DB access, so it can never widen
 * a query; and its input types carry no internal notes, staff identity, cost
 * basis or another customer's data — there is no field for them to ride in on.
 * Every event's deep link points at an EXISTING single-authority portal surface.
 *
 * DETERMINISTIC: events sort by timestamp DESC, ties broken by a stable
 * (kind, id) key, so the same inputs always render in the same order.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type TimelineQuote = {
  id: string;
  number: string | null;
  status: string;
  total: number | string | null;
  sent_at: string | null;
  accepted_at: string | null;
  public_token: string | null;
};

export type TimelineInvoice = {
  id: string;
  number: string | null;
  total: number | string | null;
  sent_at: string | null;
};

export type TimelinePayment = {
  id: string;
  amount: number | string | null;
  /** When the payment was recorded/received. */
  at: string | null;
};

export type TimelineReport = {
  id: string;
  title: string;
  report_number: string | null;
  portal_published_at: string | null;
};

export type PortalTimelineEvent = {
  kind:
    | "quote_sent"
    | "quote_accepted"
    | "invoice_issued"
    | "payment_received"
    | "report_published";
  /** ISO timestamp the event happened at (the sort key). */
  at: string;
  title: string;
  sub: string;
  href: string;
};

function money(v: number | string | null): string {
  return GBP.format(Number(v ?? 0));
}

/**
 * Build the reverse-chronological feed. `token` scopes every portal-relative
 * link to this customer's own session; quote links use the public /q/<token>
 * surface (the quote's own decision authority), matching the action centre.
 */
export function buildPortalTimeline(input: {
  token: string;
  quotes: TimelineQuote[];
  invoices: TimelineInvoice[];
  payments: TimelinePayment[];
  reports: TimelineReport[];
}): PortalTimelineEvent[] {
  const { token } = input;
  // Each event pairs with a stable tie key (kind:id) so identical timestamps
  // never reorder between renders. The key stays OUT of the returned event.
  const rows: Array<{ tie: string; event: PortalTimelineEvent }> = [];

  for (const q of input.quotes) {
    const quoteHref = q.public_token
      ? `/q/${q.public_token}`
      : `/customer-portal/${token}/quotes`;
    if (q.sent_at) {
      rows.push({
        tie: `quote_sent:${q.id}`,
        event: {
          kind: "quote_sent",
          at: q.sent_at,
          title: `Quote ${q.number ?? ""}`.trim() + ` for ${money(q.total)}`,
          sub: "We sent you a quote to review.",
          href: quoteHref,
        },
      });
    }
    if (q.accepted_at) {
      rows.push({
        tie: `quote_accepted:${q.id}`,
        event: {
          kind: "quote_accepted",
          at: q.accepted_at,
          title: `You accepted quote ${q.number ?? ""}`.trim(),
          sub: `${money(q.total)} — thank you. We'll get the work scheduled.`,
          href: quoteHref,
        },
      });
    }
  }

  for (const inv of input.invoices) {
    if (inv.sent_at) {
      rows.push({
        tie: `invoice_issued:${inv.id}`,
        event: {
          kind: "invoice_issued",
          at: inv.sent_at,
          title: `Invoice ${inv.number ?? ""}`.trim() + ` for ${money(inv.total)}`,
          sub: "An invoice was issued to you.",
          href: `/customer-portal/${token}/invoices`,
        },
      });
    }
  }

  for (const p of input.payments) {
    if (p.at) {
      rows.push({
        tie: `payment_received:${p.id}`,
        event: {
          kind: "payment_received",
          at: p.at,
          title: `Payment of ${money(p.amount)} received`,
          sub: "Thank you — your payment has been recorded.",
          href: `/customer-portal/${token}/invoices`,
        },
      });
    }
  }

  for (const r of input.reports) {
    if (r.portal_published_at) {
      const ref = r.report_number ? ` (${r.report_number})` : "";
      rows.push({
        tie: `report_published:${r.id}`,
        event: {
          kind: "report_published",
          at: r.portal_published_at,
          title: `Report: ${r.title}${ref}`,
          sub: "A progress report was shared with you.",
          href: `/customer-portal/${token}/reports/${r.id}`,
        },
      });
    }
  }

  rows.sort((a, b) => {
    // Newest first; stable tie-break so identical timestamps never reorder.
    if (a.event.at !== b.event.at) return a.event.at < b.event.at ? 1 : -1;
    return a.tie < b.tie ? -1 : 1;
  });

  return rows.map((r) => r.event);
}
