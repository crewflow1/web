import { describe, it, expect } from "vitest";
import { deriveStageStatus, scheduledTotals } from "@/lib/billing/plan";
import { computeGetPaidSummary } from "@/lib/billing/summary";
import { readyToInvoiceSignal } from "@/lib/billing/signals";
import type { CommercialCashPosition } from "@/lib/commercial/cash";

const TODAY = "2026-07-26";

describe("deriveStageStatus", () => {
  it("planned when there is no invoice", () => {
    expect(deriveStageStatus(null, TODAY)).toBe("planned");
  });
  it("invoiced when the invoice is raised but unpaid", () => {
    expect(deriveStageStatus({ status: "sent", due_date: "2026-08-30", total: 1200, paid: 0 }, TODAY)).toBe("invoiced");
  });
  it("part_paid when some but not all is paid", () => {
    expect(deriveStageStatus({ status: "partially_paid", due_date: "2026-08-30", total: 1200, paid: 600 }, TODAY)).toBe("part_paid");
  });
  it("paid when the ledger covers the total", () => {
    expect(deriveStageStatus({ status: "paid", due_date: "2026-08-30", total: 1200, paid: 1200 }, TODAY)).toBe("paid");
  });
  it("overdue when past the due date and still owed", () => {
    expect(deriveStageStatus({ status: "sent", due_date: "2026-07-01", total: 1200, paid: 0 }, TODAY)).toBe("overdue");
  });
  it("paid beats overdue", () => {
    expect(deriveStageStatus({ status: "paid", due_date: "2026-07-01", total: 1200, paid: 1200 }, TODAY)).toBe("paid");
  });
});

describe("scheduledTotals", () => {
  it("sums net and gross", () => {
    const t = scheduledTotals([
      { amount: 1000, gross: 1200 },
      { amount: 2000, gross: 2400 },
    ]);
    expect(t).toEqual({ net: 3000, gross: 3600 });
  });
});

describe("computeGetPaidSummary — the retention-netting fix", () => {
  const cash = (o: Partial<CommercialCashPosition>): CommercialCashPosition =>
    ({
      original: 0, approvedVariations: 0, revised: 0, pendingVariations: 0,
      billed: 0, received: 0, outstanding: 0, overdue: 0, stillToBill: 0,
      counts: { approvedVariations: 0, pendingVariations: 0 },
      ...o,
    }) as CommercialCashPosition;

  it("nets withheld retention out of the chase-now debtor", () => {
    const s = computeGetPaidSummary({
      cash: cash({ billed: 80_000, received: 70_000, outstanding: 6000, overdue: 0, stillToBill: 20_000 }),
      retentionHeld: 4000,
      contractNet: 100_000,
      scheduledNet: 100_000,
      hasPlan: true,
    });
    expect(s.outstanding).toBe(6000);
    expect(s.retentionHeld).toBe(4000);
    expect(s.collectableNow).toBe(2000); // 6000 outstanding − 4000 retention
  });

  it("never goes negative when retention exceeds bare outstanding", () => {
    const s = computeGetPaidSummary({
      cash: cash({ outstanding: 3000 }),
      retentionHeld: 4000,
      contractNet: 0,
      scheduledNet: 0,
      hasPlan: false,
    });
    expect(s.collectableNow).toBe(0);
  });

  it("computes unscheduled contract on the net axis", () => {
    const s = computeGetPaidSummary({
      cash: cash({}),
      retentionHeld: 0,
      contractNet: 40_000,
      scheduledNet: 24_000,
      hasPlan: true,
    });
    expect(s.unscheduledNet).toBe(16_000);
  });
});

describe("readyToInvoiceSignal (briefing seam)", () => {
  it("summarises planned stages as one ready-to-invoice signal", () => {
    const sigs = readyToInvoiceSignal({
      jobId: "job-1",
      jobLabel: "Smith kitchen",
      readyStages: [{ name: "First fix", amount: 8000 }, { name: "Second fix", amount: 4000 }],
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.key).toBe("billing_ready:job-1");
    expect(sigs[0]!.href).toBe("/jobs/job-1/billing");
    expect(sigs[0]!.amount).toBe(12_000);
    expect(sigs[0]!.title).toContain("£12,000");
  });
  it("is silent when nothing is ready", () => {
    expect(readyToInvoiceSignal({ jobId: "j", jobLabel: "x", readyStages: [] })).toEqual([]);
    expect(readyToInvoiceSignal({ jobId: "j", jobLabel: "x", readyStages: [{ name: "z", amount: 0 }] })).toEqual([]);
  });
});
