import { describe, it, expect } from "vitest";
import {
  attributeInvoiceRetention,
  computeJobRetentionNetting,
  computeOrgRetentionNetting,
} from "@/lib/commercial/retention-attribution";

describe("attributeInvoiceRetention", () => {
  it("accrues rate% of the ex-VAT net; embeds it when the invoice is unpaid", () => {
    // 5% of £10,000 net = £500; on a £12,000 gross invoice fully unpaid, all £500 is embedded.
    const r = attributeInvoiceRetention({ net: 10_000, grossRemaining: 12_000 }, 5);
    expect(r.accrued).toBe(500);
    expect(r.embedded).toBe(500);
  });

  it("[P3 fix] a FULLY-PAID invoice embeds ZERO retention no matter what it accrued", () => {
    const r = attributeInvoiceRetention({ net: 10_000, grossRemaining: 0 }, 5);
    expect(r.accrued).toBe(500); // still accrued (contractually)
    expect(r.embedded).toBe(0); // but nothing withheld — it's been paid
  });

  it("caps embedded retention at the remaining balance (customer paid all but retention)", () => {
    // £12,000 invoice, customer paid £11,500, £500 remaining = exactly the retention.
    const r = attributeInvoiceRetention({ net: 10_000, grossRemaining: 500 }, 5);
    expect(r.embedded).toBe(500);
  });

  it("caps embedded at remaining when the customer dipped INTO retention", () => {
    // Only £200 remains but £500 accrued → can only embed what's still owed.
    const r = attributeInvoiceRetention({ net: 10_000, grossRemaining: 200 }, 5);
    expect(r.embedded).toBe(200);
  });

  it("no retention on a zero-rate job", () => {
    const r = attributeInvoiceRetention({ net: 10_000, grossRemaining: 12_000 }, 0);
    expect(r.accrued).toBe(0);
    expect(r.embedded).toBe(0);
  });
});

describe("computeJobRetentionNetting — the headline M2→M3 precision fix", () => {
  it("nets ONLY retention embedded in unpaid invoices, not retention on settled ones", () => {
    // Job rate 5%. Invoice 1 £12,000 gross fully PAID (net 10k). Invoice 2 £12,000 gross UNPAID (net 10k).
    // Both accrue £500 → job held = £1,000 (nothing released).
    const n = computeJobRetentionNetting({
      ratePercent: 5,
      retentionHeld: 1000,
      invoices: [
        { net: 10_000, grossRemaining: 0 }, // paid
        { net: 10_000, grossRemaining: 12_000 }, // unpaid
      ],
    });
    expect(n.accruedTotal).toBe(1000);
    expect(n.embeddedTotal).toBe(500); // only the unpaid invoice
    expect(n.withheldFromCollectable).toBe(500); // M3 nets £500 (M2 wrongly netted £1,000)
    expect(n.heldOutsideOutstanding).toBe(500); // the paid invoice's retention = a future receivable
  });

  it("a partial release reduces what is withheld (released retention becomes collectable)", () => {
    // £500 accrued, £200 released → held £300. Invoice still unpaid (embedded £500).
    const n = computeJobRetentionNetting({
      ratePercent: 5,
      retentionHeld: 300,
      invoices: [{ net: 10_000, grossRemaining: 12_000 }],
    });
    expect(n.embeddedTotal).toBe(500);
    expect(n.withheldFromCollectable).toBe(300); // capped at held — the £200 released is now chaseable
    expect(n.heldOutsideOutstanding).toBe(0);
  });

  it("withheld never exceeds outstanding (embedded ≤ remaining), so collectableNow ≥ 0", () => {
    const n = computeJobRetentionNetting({
      ratePercent: 50, // extreme rate
      retentionHeld: 100_000,
      invoices: [{ net: 1000, grossRemaining: 200 }],
    });
    // accrued = 500 but remaining only 200 → embedded capped at 200; withheld = min(held, 200) = 200.
    expect(n.withheldFromCollectable).toBe(200);
    expect(n.withheldFromCollectable).toBeLessThanOrEqual(200);
  });
});

describe("computeOrgRetentionNetting — per-job, never a global min", () => {
  it("sums each job's own min(held, embedded) — a global min would over-net", () => {
    // Job A: held £100 but £500 embedded → can withhold only £100.
    // Job B: held £500 but £100 embedded → can withhold only £100.
    // Correct portfolio withheld = 100 + 100 = £200.
    // A naive global min(Σheld=600, Σembedded=600) would say £600 — wrong.
    const org = computeOrgRetentionNetting([
      { ratePercent: 5, retentionHeld: 100, invoices: [{ net: 10_000, grossRemaining: 12_000 }] }, // embedded 500
      { ratePercent: 1, retentionHeld: 500, invoices: [{ net: 10_000, grossRemaining: 12_000 }] }, // embedded 100
    ]);
    expect(org.embeddedTotal).toBe(600);
    expect(org.withheldFromCollectable).toBe(200); // NOT 600
    expect(org.heldOutsideOutstanding).toBe(400); // (100-100) + (500-100)
  });

  it("empty portfolio nets nothing", () => {
    const org = computeOrgRetentionNetting([]);
    expect(org).toEqual({ accruedTotal: 0, embeddedTotal: 0, withheldFromCollectable: 0, heldOutsideOutstanding: 0 });
  });
});
