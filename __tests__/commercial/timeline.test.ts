import { describe, it, expect } from "vitest";
import {
  buildCommercialTimeline,
  COMMERCIAL_EVENT_LABEL,
  type CommercialEventKind,
  type TimelineQuote,
  type TimelineInvoice,
  type TimelinePayment,
  type TimelineRetentionRelease,
  type TimelinePurchaseOrder,
  type TimelineCost,
} from "@/lib/commercial/timeline";

const EMPTY: {
  quotes: TimelineQuote[];
  invoices: TimelineInvoice[];
  payments: TimelinePayment[];
  retentionReleases: TimelineRetentionRelease[];
  purchaseOrders: TimelinePurchaseOrder[];
  costs: TimelineCost[];
} = {
  quotes: [],
  invoices: [],
  payments: [],
  retentionReleases: [],
  purchaseOrders: [],
  costs: [],
};

function build(over: Partial<typeof EMPTY>) {
  return buildCommercialTimeline({ ...EMPTY, ...over });
}

const kinds = (evs: { kind: CommercialEventKind }[]) => evs.map((e) => e.kind);

describe("buildCommercialTimeline — event derivation", () => {
  it("emits 'contract agreed' for an accepted base quote, anchored to accepted_at", () => {
    const evs = build({
      quotes: [
        {
          id: "q1",
          number: "Q-0001",
          variation_number: null,
          status: "accepted",
          total: 10000,
          accepted_at: "2026-03-01T09:00:00Z",
          declined_at: null,
          created_at: "2026-02-20T09:00:00Z",
          public_token: "tok",
        },
      ],
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.kind).toBe("contract_agreed");
    expect(evs[0]!.flow).toBe("in");
    expect(evs[0]!.amount).toBe(10000);
    expect(evs[0]!.date).toBe("2026-03-01");
    expect(evs[0]!.href).toBe("/q/tok");
  });

  it("distinguishes approved / declined / raised variations", () => {
    const evs = build({
      quotes: [
        { id: "v1", number: "V1", variation_number: 1, status: "accepted", total: 500, accepted_at: "2026-04-01T00:00:00Z", declined_at: null, created_at: "2026-03-20T00:00:00Z", public_token: null },
        { id: "v2", number: "V2", variation_number: 2, status: "declined", total: 600, accepted_at: null, declined_at: "2026-04-05T00:00:00Z", created_at: "2026-03-22T00:00:00Z", public_token: null },
        { id: "v3", number: "V3", variation_number: 3, status: "sent", total: 700, accepted_at: null, declined_at: null, created_at: "2026-04-10T00:00:00Z", public_token: null },
      ],
    });
    const byKind = Object.fromEntries(evs.map((e) => [e.kind, e]));
    expect(byKind.variation_approved!.label).toBe("Variation 1 approved");
    expect(byKind.variation_approved!.flow).toBe("in");
    expect(byKind.variation_declined!.label).toBe("Variation 2 declined");
    expect(byKind.variation_declined!.date).toBe("2026-04-05");
    expect(byKind.variation_raised!.label).toBe("Variation 3 raised");
    expect(byKind.variation_raised!.flow).toBe("neutral");
  });

  it("includes non-draft invoices (with number in the label) and excludes drafts", () => {
    const evs = build({
      invoices: [
        { id: "i1", number: "INV-0001", total: 4000, status: "sent", created_at: "2026-05-01T00:00:00Z", sent_at: "2026-05-02T00:00:00Z" },
        { id: "i2", number: "INV-0002", total: 999, status: "draft", created_at: "2026-05-03T00:00:00Z", sent_at: null },
      ],
    });
    expect(kinds(evs)).toEqual(["invoiced"]);
    expect(evs[0]!.label).toBe("Invoiced — INV-0001");
    expect(evs[0]!.date).toBe("2026-05-02"); // prefers sent_at
    expect(evs[0]!.href).toBe("/invoices/i1");
  });

  it("emits per-payment 'payment received' with invoice number + reference, linked to the invoice", () => {
    const evs = build({
      invoices: [{ id: "i1", number: "INV-0001", total: 4000, status: "partially_paid", created_at: "2026-05-01T00:00:00Z", sent_at: null }],
      payments: [{ invoice_id: "i1", amount: 1500, paid_at: "2026-06-01", reference: "TT-99" }],
    });
    const pay = evs.find((e) => e.kind === "payment_received")!;
    expect(pay.label).toBe("Payment received — INV-0001 (TT-99)");
    expect(pay.amount).toBe(1500);
    expect(pay.flow).toBe("in");
    expect(pay.href).toBe("/invoices/i1");
    expect(pay.date).toBe("2026-06-01");
  });

  it("emits retention releases (money out) and orders, excluding cancelled POs", () => {
    const evs = build({
      retentionReleases: [{ id: "r1", amount: 250, released_on: "2026-07-01" }],
      purchaseOrders: [
        { id: "p1", number: "PO-0001", total: 800, status: "sent", created_at: "2026-06-10T00:00:00Z", supplierName: "Jewson" },
        { id: "p2", number: "PO-0002", total: 999, status: "cancelled", created_at: "2026-06-11T00:00:00Z" },
      ],
      costs: [{ id: "c1", amount: 300, category: "Materials", created_at: "2026-06-15T00:00:00Z" }],
    });
    const byKind = Object.fromEntries(evs.map((e) => [e.kind, e]));
    expect(byKind.retention_released!.flow).toBe("out");
    expect(byKind.order_placed!.label).toBe("Order placed — PO-0001 to Jewson");
    expect(byKind.order_placed!.flow).toBe("out");
    expect(byKind.cost_recorded!.label).toBe("Cost recorded — Materials");
    // cancelled PO excluded
    expect(evs.filter((e) => e.kind === "order_placed")).toHaveLength(1);
  });
});

describe("buildCommercialTimeline — ordering & robustness", () => {
  it("sorts newest first across heterogeneous date/timestamp anchors", () => {
    const evs = build({
      quotes: [
        { id: "q1", number: "Q1", variation_number: null, status: "accepted", total: 100, accepted_at: "2026-01-10T09:00:00Z", declined_at: null, created_at: null, public_token: null },
      ],
      retentionReleases: [{ id: "r1", amount: 10, released_on: "2026-08-01" }],
      payments: [{ invoice_id: "iX", amount: 5, paid_at: "2026-05-05", reference: null }],
    });
    const dates = evs.map((e) => e.date);
    expect(dates).toEqual(["2026-08-01", "2026-05-05", "2026-01-10"]);
  });

  it("drops events with no anchor date rather than placing them at epoch", () => {
    const evs = build({
      quotes: [
        { id: "q1", number: "Q1", variation_number: null, status: "accepted", total: 100, accepted_at: null, declined_at: null, created_at: null, public_token: null },
      ],
    });
    expect(evs).toHaveLength(0);
  });

  it("has a human label for every event kind", () => {
    for (const k of Object.keys(COMMERCIAL_EVENT_LABEL) as CommercialEventKind[]) {
      expect(COMMERCIAL_EVENT_LABEL[k]).toBeTruthy();
    }
  });
});
