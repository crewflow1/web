import { describe, it, expect } from "vitest";
import {
  labourCostsFromTimeEntries,
  computeAllJobsProfitability,
} from "@/lib/profitability/compute";

describe("labourCostsFromTimeEntries", () => {
  it("converts time entries × hourly rate into virtual finance rows", () => {
    const rows = labourCostsFromTimeEntries(
      [
        { job_id: "job-A", user_id: "u1", hours: 8 },
        { job_id: "job-A", user_id: "u2", hours: 4 },
        { job_id: "job-B", user_id: "u1", hours: 2 },
      ],
      new Map([
        ["u1", 20],
        ["u2", 15],
      ]),
    );
    expect(rows).toHaveLength(3);
    const byJob = new Map(rows.map((r) => [r.job_id! + "-" + r.amount, r]));
    expect(byJob.has("job-A-160")).toBe(true); // 8 × 20
    expect(byJob.has("job-A-60")).toBe(true); // 4 × 15
    expect(byJob.has("job-B-40")).toBe(true); // 2 × 20
  });

  it("skips entries with no hourly rate set", () => {
    const rows = labourCostsFromTimeEntries(
      [{ job_id: "job-A", user_id: "u1", hours: 8 }],
      new Map(),
    );
    expect(rows).toHaveLength(0);
  });

  it("skips entries without a job_id (no attribution possible)", () => {
    const rows = labourCostsFromTimeEntries(
      [{ job_id: null, user_id: "u1", hours: 8 }],
      new Map([["u1", 20]]),
    );
    expect(rows).toHaveLength(0);
  });

  it("flows through computeAllJobsProfitability under the labour bucket", () => {
    const invoices = [{ job_id: "job-A", amount: 1000 }];
    const labour = labourCostsFromTimeEntries(
      [{ job_id: "job-A", user_id: "u1", hours: 10 }],
      new Map([["u1", 20]]),
    );
    const rows = computeAllJobsProfitability(
      [{ id: "job-A" }],
      invoices,
      labour,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costs_by_bucket.labour).toBe(200);
    expect(rows[0]!.gross_profit).toBe(800);
    expect(rows[0]!.margin_pct).toBe(80);
  });
});
