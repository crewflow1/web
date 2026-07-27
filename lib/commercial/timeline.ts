import { toPounds } from "@/lib/money";

/**
 * Commercial lifecycle timeline (Programme D) — PURE aggregation of a job's
 * money-moving events into one chronological, deep-linked stream.
 *
 * Built from SOURCE TABLES, not the activity_log: the log has no triggers for
 * retention/PO/payment events, doesn't render or link them, and is purged at 24
 * months — shorter than a construction retention/defects horizon. Source tables
 * carry every timestamp + £ and are always-truthful. Actor ("who") is therefore
 * out of scope here (nullable overlay for a later slice).
 *
 * Curated to money-moving CONTRACT events only — no reschedules, assignments,
 * photo changes, `*.viewed`, or finance edits (those stay in the general
 * activity feed). Vocabulary is UK-construction-native.
 *
 * Security (F2): payment events are per-invoice allocations of THIS job's
 * invoices; a parent receipt total is never surfaced (that could leak another
 * customer's share of a split receipt).
 */

export type CommercialEventKind =
  | "contract_agreed"
  | "variation_approved"
  | "variation_declined"
  | "variation_raised"
  | "invoiced"
  | "payment_received"
  | "retention_released"
  | "order_placed"
  | "cost_recorded";

/** Which way money moves — drives sign + colour in the UI. */
export type CommercialFlow = "in" | "out" | "neutral";

export type CommercialEvent = {
  /** Normalised ISO instant for sorting (date-only anchored to 00:00:00Z). */
  occurredAt: string;
  /** YYYY-MM-DD for display. */
  date: string;
  kind: CommercialEventKind;
  flow: CommercialFlow;
  label: string;
  /** £ magnitude (always positive); null when the event carries no figure. */
  amount: number | null;
  /** In-app deep link, or null. */
  href: string | null;
};

const FLOW: Record<CommercialEventKind, CommercialFlow> = {
  contract_agreed: "in",
  variation_approved: "in",
  variation_declined: "neutral",
  variation_raised: "neutral",
  invoiced: "in",
  payment_received: "in",
  retention_released: "out",
  order_placed: "out",
  cost_recorded: "out",
};

export const COMMERCIAL_EVENT_LABEL: Record<CommercialEventKind, string> = {
  contract_agreed: "Contract agreed",
  variation_approved: "Variation approved",
  variation_declined: "Variation declined",
  variation_raised: "Variation raised",
  invoiced: "Invoiced",
  payment_received: "Payment received",
  retention_released: "Retention released",
  order_placed: "Order placed",
  cost_recorded: "Cost recorded",
};

const ACCEPTED = "accepted";
const DECLINED = "declined";
const PENDING = new Set(["sent", "viewed"]);
const INVOICE_RAISED = new Set(["sent", "awaiting_payment", "partially_paid", "paid", "overdue"]);
const PO_LIVE = new Set(["draft", "sent", "received"]); // not cancelled

/** date-only → ISO instant; pass full timestamps through; null-safe. */
function toIso(v: string | null | undefined): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v;
}

export type TimelineQuote = {
  id: string;
  number: string | null;
  variation_number: number | null;
  status: string;
  total: number | string | null;
  accepted_at: string | null;
  declined_at: string | null;
  created_at: string | null;
  public_token: string | null;
};

export type TimelineInvoice = {
  id: string;
  number: string | null;
  total: number | string | null;
  status: string;
  created_at: string | null;
  sent_at: string | null;
};

export type TimelinePayment = {
  invoice_id: string;
  amount: number | string | null;
  paid_at: string | null;
  reference: string | null;
};

export type TimelineRetentionRelease = {
  id: string;
  amount: number | string | null;
  released_on: string | null;
};

export type TimelinePurchaseOrder = {
  id: string;
  number: string | null;
  total: number | string | null;
  status: string;
  created_at: string | null;
  supplierName?: string | null;
};

export type TimelineCost = {
  id: string;
  amount: number | string | null;
  category: string | null;
  created_at: string | null;
};

function push(
  events: CommercialEvent[],
  kind: CommercialEventKind,
  at: string | null,
  label: string,
  amount: number | null,
  href: string | null,
): void {
  const occurredAt = toIso(at);
  if (!occurredAt) return; // no anchor date → not placeable on a timeline
  events.push({
    occurredAt,
    date: occurredAt.slice(0, 10),
    kind,
    flow: FLOW[kind],
    label,
    amount: amount != null ? Math.abs(amount) : null,
    href,
  });
}

export function buildCommercialTimeline(input: {
  quotes: TimelineQuote[];
  invoices: TimelineInvoice[];
  payments: TimelinePayment[];
  retentionReleases: TimelineRetentionRelease[];
  purchaseOrders: TimelinePurchaseOrder[];
  costs: TimelineCost[];
}): CommercialEvent[] {
  const events: CommercialEvent[] = [];

  for (const q of input.quotes) {
    const total = toPounds(q.total);
    const href = q.public_token ? `/q/${q.public_token}` : null;
    if (q.variation_number == null) {
      // Base contract quote — the "contract agreed" moment.
      if (q.status === ACCEPTED) {
        push(events, "contract_agreed", q.accepted_at ?? q.created_at, "Contract agreed", total, href);
      }
    } else {
      const vlabel = `Variation ${q.variation_number}`;
      if (q.status === ACCEPTED) {
        push(events, "variation_approved", q.accepted_at ?? q.created_at, `${vlabel} approved`, total, href);
      } else if (q.status === DECLINED) {
        push(events, "variation_declined", q.declined_at ?? q.created_at, `${vlabel} declined`, total, href);
      } else if (PENDING.has(q.status)) {
        push(events, "variation_raised", q.created_at, `${vlabel} raised`, total, href);
      }
    }
  }

  const invoiceNumber = new Map<string, string | null>();
  for (const inv of input.invoices) {
    invoiceNumber.set(inv.id, inv.number);
    if (!INVOICE_RAISED.has(inv.status)) continue;
    const label = inv.number ? `Invoiced — ${inv.number}` : "Invoiced";
    push(events, "invoiced", inv.sent_at ?? inv.created_at, label, toPounds(inv.total), `/invoices/${inv.id}`);
  }

  for (const p of input.payments) {
    const num = invoiceNumber.get(p.invoice_id);
    const ref = p.reference ? ` (${p.reference})` : "";
    const label = num ? `Payment received — ${num}${ref}` : `Payment received${ref}`;
    push(events, "payment_received", p.paid_at, label, toPounds(p.amount), `/invoices/${p.invoice_id}`);
  }

  for (const r of input.retentionReleases) {
    push(events, "retention_released", r.released_on, "Retention released", toPounds(r.amount), null);
  }

  for (const po of input.purchaseOrders) {
    if (!PO_LIVE.has(po.status)) continue;
    const who = po.supplierName ? ` to ${po.supplierName}` : "";
    const label = po.number ? `Order placed — ${po.number}${who}` : `Order placed${who}`;
    push(events, "order_placed", po.created_at, label, toPounds(po.total), `/purchase-orders/${po.id}`);
  }

  for (const c of input.costs) {
    const label = c.category ? `Cost recorded — ${c.category}` : "Cost recorded";
    push(events, "cost_recorded", c.created_at, label, toPounds(c.amount), null);
  }

  // Newest first; stable id tie-break keeps ordering deterministic.
  return events.sort((a, b) =>
    a.occurredAt === b.occurredAt ? (a.label < b.label ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1,
  );
}
