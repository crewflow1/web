import { describe, it, expect } from "vitest";
import { buildReportDocument } from "@/lib/reports/report-data";
import { computeAllJobsProfitability } from "@/lib/profitability/compute";
import type { ReportsDb } from "@/lib/reports/aggregates";

/**
 * PROFIT REPORT — per-job cost must include time-tracked labour + employer
 * on-costs, not `finances` alone.
 *
 * The defect: `buildProfitDocument` called `computeAllJobsProfitability(jobs,
 * invoices, finances)` with BARE finances — it never loaded `time_entries` /
 * `users.hourly_pay` nor built the shared `buildJobCostInput`, so the /reports
 * profit doc (and its PDF/CSV export + scheduled email) overstated gross profit
 * and margin on every job with clocked labour. The two other call sites
 * (company-health, dashboard) build the cost input; the report now does too.
 *
 * This test drives the REAL `buildReportDocument("profit")` through a fake
 * org-pinned client and proves the per-job Costs cell exceeds what bare
 * finances alone would produce (i.e. labour is now included).
 */

// A tiny fake of the supabase query-builder chain used by report-data:
//   from(table).select().eq().order().range()   (+ .in() for the users pay read)
// `range` resolves to a single full page ({ data, error }); rows are routed by
// table name. A per-table `org_id` capture lets us assert the org pin holds.
function makeClient(
  tables: Record<string, unknown[]>,
  seenOrgIds: Record<string, string> = {},
): ReportsDb {
  const build = (table: string) => {
    const chain = {
      select: () => chain,
      eq: (key: string, value: string) => {
        if (key === "org_id") seenOrgIds[table] = value;
        return chain;
      },
      in: () => chain,
      order: () => chain,
      range: async () => ({ data: tables[table] ?? [], error: null }),
      then: undefined,
    };
    return chain;
  };
  return { from: (table: string) => build(table) } as unknown as ReportsDb;
}

const now = new Date("2026-06-15T12:00:00Z");
const ORG = "org-1";

// A closed 10-hour entry (no breaks) → hours are deterministic regardless of `now`.
const TEN_HOURS = {
  id: "te-1",
  user_id: "u-1",
  job_id: "job-1",
  started_at: "2026-06-01T09:00:00Z",
  ended_at: "2026-06-01T19:00:00Z",
  breaks: [],
};

function fixtures() {
  return {
    jobs: [
      { id: "job-1", customer_id: "cust-1", site_city: "Leeds", site_postcode: null, site_address_line1: null },
    ],
    invoices: [{ id: "inv-1", job_id: "job-1", amount: 1000, created_at: "2026-06-02T00:00:00Z", paid_at: null }],
    finances: [{ id: "fin-1", job_id: "job-1", amount: 100, category: "materials", created_at: "2026-06-02T00:00:00Z" }],
    customers: [{ id: "cust-1", name: "Acme Ltd" }],
    time_entries: [TEN_HOURS],
    memberships: [{ user_id: "u-1" }],
    users: [{ id: "u-1", hourly_pay: 20 }],
  };
}

/** Read the Costs cell (index 2) for the single job from the "Job profitability" section. */
function jobCost(doc: Awaited<ReturnType<typeof buildReportDocument>>): number {
  const section = doc.sections.find((s) => s.title === "Job profitability");
  if (!section) throw new Error("missing Job profitability section");
  expect(section.rows.length).toBe(1);
  const costCell = section.rows[0]?.[2];
  if (!costCell) throw new Error("missing Costs cell");
  return Number(costCell.csv);
}

describe("buildProfitDocument — per-job cost includes labour", () => {
  it("adds time-tracked labour + employer on-costs on top of finances", async () => {
    const data = fixtures();
    const client = makeClient(data);
    const doc = await buildReportDocument(client, ORG, "profit", { now });

    // What bare finances alone would have produced (the defective behaviour).
    const bareRow = computeAllJobsProfitability(data.jobs, data.invoices, data.finances)[0];
    if (!bareRow) throw new Error("expected a bare-finances profitability row");
    const bareFinancesCost = bareRow.costs_total;
    expect(bareFinancesCost).toBe(100);

    const cost = jobCost(doc);
    // Labour is 10h × £20 = £200 gross, plus employer NI + pension on-costs (> 0),
    // so cost must exceed bare finances AND be at least finances + gross labour.
    expect(cost).toBeGreaterThan(bareFinancesCost);
    expect(cost).toBeGreaterThanOrEqual(100 + 200);
  });

  it("with NO time entries the cost equals bare finances (no phantom labour)", async () => {
    const data = fixtures();
    data.time_entries = [];
    const doc = await buildReportDocument(makeClient(data), ORG, "profit", { now });
    expect(jobCost(doc)).toBe(100);
  });

  it("org-pins every ledger read (never blends a dual-org member's companies)", async () => {
    const seen: Record<string, string> = {};
    await buildReportDocument(makeClient(fixtures(), seen), ORG, "profit", { now });
    for (const table of ["jobs", "invoices", "finances", "customers", "time_entries", "memberships"]) {
      expect(seen[table]).toBe(ORG);
    }
  });
});
