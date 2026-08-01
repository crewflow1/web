import { describe, it, expect } from "vitest";
import { MIN_RATED_SAMPLE } from "@/lib/suppliers/performance";
import {
  NO_JOB_LABEL,
  NO_TRADE_LABEL,
  computeSnagPatterns,
  snagPatternsMetric,
  type SnagRow,
} from "@/lib/intelligence/snag-patterns";

const TODAY = "2026-08-01";

let seq = 0;
function snag(over: Partial<SnagRow>): SnagRow {
  seq += 1;
  return {
    id: `s-${seq}`,
    job_id: "job-1",
    trade: "Plumbing",
    status: "open",
    priority: "medium",
    due_date: null,
    ...over,
  };
}

const jobLabel = new Map([["job-1", "12 Mill Lane"], ["job-2", "Unit 4, Park Rd"]]);

describe("counts by status", () => {
  const p = computeSnagPatterns({
    snags: [
      snag({ status: "open" }),
      snag({ status: "in_progress", priority: "high" }),
      snag({ status: "fixed" }),
      snag({ status: "verified" }),
      snag({ status: "wont_fix" }),
    ],
    jobLabel,
    todayIso: TODAY,
  });

  it("counts each stored status where it belongs", () => {
    expect(p.total).toBe(5);
    expect(p.open).toBe(2); // open + in_progress
    const g = p.byJob[0]!;
    expect(g.fixedAwaitingVerify).toBe(1);
    expect(g.verified).toBe(1);
    expect(g.wontFix).toBe(1);
    expect(g.highPriorityOpen).toBe(1);
  });

  it("verification = verified / (fixed + verified), withheld below the floor", () => {
    // 1 of 2 — n < MIN_RATED_SAMPLE → the Ratio authority withholds the pct.
    expect(p.verification.count).toBe(1);
    expect(p.verification.n).toBe(2);
    expect(p.verification.pct).toBeNull();
    expect(MIN_RATED_SAMPLE).toBe(5);
  });
});

describe("verification rate at an earned sample", () => {
  it("prints the rate once n reaches the floor", () => {
    const p = computeSnagPatterns({
      snags: [
        ...Array.from({ length: 4 }, () => snag({ status: "verified" })),
        snag({ status: "fixed" }),
      ],
      jobLabel,
      todayIso: TODAY,
    });
    expect(p.verification.n).toBe(5);
    expect(p.verification.pct).toBe(80);
  });
});

describe("grouping", () => {
  it("normalises free-text trades (trim + case) but keeps the first-seen label", () => {
    const p = computeSnagPatterns({
      snags: [snag({ trade: "Plumbing" }), snag({ trade: " plumbing " }), snag({ trade: null })],
      jobLabel,
      todayIso: TODAY,
    });
    expect(p.byTrade).toHaveLength(2);
    const plumbing = p.byTrade.find((g) => g.label === "Plumbing")!;
    expect(plumbing.total).toBe(2);
    expect(p.byTrade.find((g) => g.label === NO_TRADE_LABEL)!.total).toBe(1);
  });

  it("snags with no job group under an explicit label, never dropped", () => {
    const p = computeSnagPatterns({
      snags: [snag({ job_id: null })],
      jobLabel,
      todayIso: TODAY,
    });
    expect(p.byJob[0]!.label).toBe(NO_JOB_LABEL);
  });

  it("job groups carry the site label and a drill-through href", () => {
    const p = computeSnagPatterns({
      snags: [snag({ job_id: "job-2" })],
      jobLabel,
      todayIso: TODAY,
    });
    expect(p.byJob[0]!.label).toBe("Unit 4, Park Rd");
    expect(p.byJob[0]!.href).toBe("/jobs/job-2");
  });
});

describe("overdue — the invoice-authority boundary", () => {
  it("not overdue ON the due date; overdue strictly after; terminal never overdue", () => {
    const p = computeSnagPatterns({
      snags: [
        snag({ due_date: "2026-08-01" }), // due today → not late
        snag({ due_date: "2026-07-31" }), // past → late
        snag({ due_date: "2026-07-01", status: "verified" }), // terminal → never
        snag({ due_date: "2026-07-01", status: "wont_fix" }),
      ],
      jobLabel,
      todayIso: TODAY,
    });
    expect(p.overdue).toBe(1);
  });
});

describe("the refusals, pinned", () => {
  it("no group ever names a supplier — attribution is unrepresentable", () => {
    const p = computeSnagPatterns({ snags: [snag({})], jobLabel, todayIso: TODAY });
    const flat = JSON.stringify(p).toLowerCase();
    expect(flat).not.toContain("supplier");
  });

  it("no reopen figure exists — there is no tenant-readable transition record", () => {
    const p = computeSnagPatterns({ snags: [snag({})], jobLabel, todayIso: TODAY });
    expect(JSON.stringify(p).toLowerCase()).not.toContain("reopen");
    const m = snagPatternsMetric(p);
    expect(m.provenance.basis).toContain("Reopen rates are not shown");
  });
});
