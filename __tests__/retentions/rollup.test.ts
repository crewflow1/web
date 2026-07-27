import { describe, it, expect } from "vitest";
import { computeRetentionDueRollup } from "@/lib/retentions/rollup";

const NOW = new Date("2026-07-22T12:00:00Z");

describe("computeRetentionDueRollup", () => {
  it("aggregates held + due-now across jobs, ignoring jobs with no retention", () => {
    const rollup = computeRetentionDueRollup({
      jobs: [
        // Job A: 5% rate, PC in the past → first moiety due now.
        { id: "A", ratePercent: 5, practicalCompletionDate: "2026-06-01", defectsLiabilityMonths: 12, firstReleasePct: 50 },
        // Job B: 5% rate, future PC → held but not due.
        { id: "B", ratePercent: 5, practicalCompletionDate: "2026-12-01", defectsLiabilityMonths: 12, firstReleasePct: 50 },
        // Job C: no retention → ignored.
        { id: "C", ratePercent: 0, practicalCompletionDate: null, defectsLiabilityMonths: 12, firstReleasePct: 50 },
      ],
      invoices: [
        { job_id: "A", status: "sent", amount: 10000 }, // accrued 500
        { job_id: "B", status: "sent", amount: 20000 }, // accrued 1000
        { job_id: "C", status: "sent", amount: 5000 },
      ],
      releases: [],
      now: NOW,
    });
    expect(rollup.totalHeld).toBe(1500); // 500 + 1000
    expect(rollup.heldJobCount).toBe(2);
    expect(rollup.dueNow).toBe(250); // Job A first moiety = 50% of 500
    expect(rollup.dueJobCount).toBe(1);
  });

  it("is empty when no job carries retention", () => {
    const rollup = computeRetentionDueRollup({
      jobs: [{ id: "A", ratePercent: 0, practicalCompletionDate: null, defectsLiabilityMonths: 12, firstReleasePct: 50 }],
      invoices: [{ job_id: "A", status: "sent", amount: 10000 }],
      releases: [],
      now: NOW,
    });
    expect(rollup.totalHeld).toBe(0);
    expect(rollup.dueNow).toBe(0);
    expect(rollup.dueJobCount).toBe(0);
  });

  it("excludes released retention from due-now", () => {
    const rollup = computeRetentionDueRollup({
      jobs: [{ id: "A", ratePercent: 5, practicalCompletionDate: "2026-06-01", defectsLiabilityMonths: 12, firstReleasePct: 50 }],
      invoices: [{ job_id: "A", status: "sent", amount: 10000 }], // accrued 500
      releases: [{ job_id: "A", amount: 250 }], // first moiety fully released
      now: NOW,
    });
    expect(rollup.dueNow).toBe(0); // first moiety released; second not yet due
    expect(rollup.totalHeld).toBe(250);
  });
});
