import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PAYROLL CSV — no silent 1000-row truncation (F-1).
 *
 * ── THE DEFECT (fixed in C35) ────────────────────────────────────────────────
 * The bureau CSV read `payroll_lines` with a BARE `.select().eq(...).order(...)`
 * — no paging. PostgREST caps every response at max_rows (1000), so a payroll
 * run with more than 1000 lines exported a CSV missing everyone past the first
 * page: an accountant would pay 1000 people and never know the rest existed. The
 * fix routes the read through `fetchAllRows`, which pages under the cap on a
 * unique `(gross_pay desc, id asc)` total order.
 *
 * ── WHY THIS IS BEHAVIOURAL ──────────────────────────────────────────────────
 * The route's GET handler is executed against a chainable Supabase mock that
 * honours `.range(from, to)` exactly like PostgREST — an inclusive window itself
 * hard-capped at 1000 rows per response. The run is seeded with 2500 lines. A
 * bare (single-page) read would clip the CSV to 1000 data rows; only a correctly
 * paged read emits all 2500. We also seed a DIFFERENT run and a DIFFERENT org to
 * prove the paged read still filters (no cross-run / cross-org bleed).
 */

const RESPONSE_CAP = 1000; // the real PostgREST cap the mock emulates

const ORG = "org-under-test";
const OTHER_ORG = "org-elsewhere";
const RUN_ID = "run-current";
const OTHER_RUN = "run-other";

const h = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};

  function makeBuilder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const orders: Array<[string, boolean]> = [];

    const filtered = () => {
      let rows = (tables[table] ?? []).filter((row) => {
        for (const [col, val] of eqs) if (row[col] !== val) return false;
        return true;
      });
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i]!;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      return rows;
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push([col, opts?.ascending !== false]);
        return builder;
      },
      range(from: number, to: number) {
        // Inclusive [from, to], then hard-capped at RESPONSE_CAP like PostgREST.
        const windowed = filtered().slice(from, to + 1).slice(0, RESPONSE_CAP);
        return Promise.resolve({ data: windowed, error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered()[0] ?? null, error: null });
      },
    };
    return builder;
  }

  return {
    tables,
    client: { from: (t: string) => makeBuilder(t) },
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { org: { id: ORG, name: "Test Co" }, membership: { role: "owner" } },
  }),
}));
vi.mock("@/lib/staff/secrets", () => ({
  fetchNiNumbersForOrg: async () => new Map<string, string>(),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("server-only", () => ({}));

const { GET } = await import("@/app/api/payroll/[id]/csv/route");

beforeEach(() => {
  h.reset();
  h.tables.payroll_runs = [
    { id: RUN_ID, org_id: ORG, cycle: "monthly", period_start: "2026-07-01", period_end: "2026-07-31" },
    { id: OTHER_RUN, org_id: ORG, cycle: "monthly", period_start: "2026-06-01", period_end: "2026-06-30" },
  ];
});

describe("payroll CSV pages past the 1000-row PostgREST cap (F-1)", () => {
  it("exports EVERY line of a >1000-line run, not just the first page", async () => {
    const N = 2500;
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < N; i++) {
      lines.push({
        id: `line-${String(i).padStart(6, "0")}`,
        payroll_run_id: RUN_ID,
        org_id: ORG,
        user_id: `u-${i}`,
        hours: 10,
        hourly_pay: 1,
        gross_pay: 10,
        paye_estimate: 1,
        ni_estimate: 1,
        net_pay: 8,
        user: { full_name: `Worker ${i}` },
      });
    }
    // Rows that must NOT appear: another run in the same org, and another org.
    lines.push({
      id: "line-otherrun", payroll_run_id: OTHER_RUN, org_id: ORG, user_id: "x",
      hours: 1, hourly_pay: 1, gross_pay: 999, paye_estimate: 0, ni_estimate: 0, net_pay: 999,
      user: { full_name: "Wrong Run" },
    });
    lines.push({
      id: "line-otherorg", payroll_run_id: RUN_ID, org_id: OTHER_ORG, user_id: "y",
      hours: 1, hourly_pay: 1, gross_pay: 999, paye_estimate: 0, ni_estimate: 0, net_pay: 999,
      user: { full_name: "Wrong Org" },
    });
    h.tables.payroll_lines = lines;

    const res = await GET({} as never, { params: Promise.resolve({ id: RUN_ID }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    const rows = body.trim().split("\n");
    const dataRows = rows.slice(1); // drop header

    // A single-page read would clip at 1000; the fix emits all 2500.
    expect(dataRows.length).toBe(N);
    expect(dataRows.length).toBeGreaterThan(RESPONSE_CAP);

    // No cross-run / cross-org bleed survived the paged read.
    expect(body).not.toContain("Wrong Run");
    expect(body).not.toContain("Wrong Org");

    // Gross column (index 7) sums to the full N*£10 — proves completeness, not
    // just row count.
    const grossTotal = dataRows.reduce((s, line) => s + Number(line.split(",")[7]), 0);
    expect(grossTotal).toBe(N * 10);
  });
});
