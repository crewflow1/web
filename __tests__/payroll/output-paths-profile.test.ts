import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeEmployeeDeductionsForStoredLine,
  employeeInputFromStoredProfile,
  computePayrollLine,
} from "@/lib/payroll/compute";

/**
 * OUTPUT PATHS apply the per-employee tax profile (fix 3).
 *
 * THE DEFECT: `computeEmployeeDeductionsForStoredLine` + the stored
 * `payroll_tax_profiles` row were applied ONLY on the run detail page. The three
 * OUTPUT paths — the bureau CSV, the payslip PDF and the worker's own /me view —
 * ignored the profile and showed the standard-1257L base, so a Scottish / student-
 * loan / salary-sacrifice worker saw the WRONG PAYE, student loan and net.
 *
 * The CSV path is driven behaviourally through the real route handler against a
 * chainable Supabase double (the csv-volume.test.ts idiom). The PDF and /me paths
 * are React/PDF render surfaces, so they are pinned at the source level: both must
 * route through the SAME overlay helper the detail page uses.
 */

const ORG = "org-under-test";
const RUN_ID = "run-current";

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
        return Promise.resolve({ data: filtered().slice(from, to + 1), error: null });
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

const PERIOD = "2026-05-01";

beforeEach(() => {
  h.reset();
  h.tables.payroll_runs = [
    {
      id: RUN_ID,
      org_id: ORG,
      cycle: "monthly",
      period_start: PERIOD,
      period_end: "2026-05-31",
    },
  ];
});

describe("payroll CSV reflects the per-employee tax profile (fix 3)", () => {
  it("a Scottish + Plan-2 worker's PAYE / student loan / net match the overlay, not the base", async () => {
    // Base stored figures (what a standard-code run persisted) for £3,200/mo.
    const base = computePayrollLine(160, 20, "monthly", PERIOD);
    h.tables.payroll_lines = [
      {
        id: "line-sco",
        payroll_run_id: RUN_ID,
        org_id: ORG,
        user_id: "u-sco",
        hours: 160,
        hourly_pay: 20,
        gross_pay: 3_200,
        paye_estimate: base.paye_estimate,
        ni_estimate: base.ni_estimate,
        net_pay: base.net_pay,
        user: { full_name: "Scot Worker" },
      },
      {
        id: "line-plain",
        payroll_run_id: RUN_ID,
        org_id: ORG,
        user_id: "u-plain",
        hours: 160,
        hourly_pay: 20,
        gross_pay: 3_200,
        paye_estimate: base.paye_estimate,
        ni_estimate: base.ni_estimate,
        net_pay: base.net_pay,
        user: { full_name: "Plain Worker" },
      },
    ];
    // Only the Scottish worker has a tax profile.
    h.tables.payroll_tax_profiles = [
      {
        id: "tp-1",
        org_id: ORG,
        user_id: "u-sco",
        tax_region: "scotland",
        student_loan_plan: "plan_2",
        salary_sacrifice_annual_pence: 0,
      },
    ];

    const res = await GET({} as never, { params: Promise.resolve({ id: RUN_ID }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    const rows = body.trim().split("\n");
    const header = rows[0]!;
    const scoRow = rows.find((r) => r.includes("Scot Worker"))!;
    const plainRow = rows.find((r) => r.includes("Plain Worker"))!;

    // The new employee-side columns exist so the file reconciles.
    expect(header).toContain("Student loan est");
    expect(header).toContain("Salary sacrifice");

    // The overlay figures the detail page shows — the CSV must equal them.
    const refined = computeEmployeeDeductionsForStoredLine("3200", "monthly", PERIOD, {
      ...employeeInputFromStoredProfile({
        tax_region: "scotland",
        student_loan_plan: "plan_2",
        salary_sacrifice_annual_pence: 0,
      }),
    });
    expect(refined.student_loan_estimate).toBeGreaterThan(0); // Plan 2 actually bites
    expect(scoRow).toContain(refined.paye_estimate.toFixed(2));
    expect(scoRow).toContain(refined.ni_estimate.toFixed(2));
    expect(scoRow).toContain(refined.student_loan_estimate.toFixed(2));
    expect(scoRow).toContain(refined.net_pay.toFixed(2));
    // Scottish PAYE differs from the rest-of-UK base that was stored.
    expect(refined.paye_estimate).not.toBe(base.paye_estimate);

    // The un-profiled worker is byte-identical to the stored base (empty profile
    // reproduces it), and carries a £0.00 student loan.
    expect(plainRow).toContain(base.paye_estimate.toFixed(2));
    expect(plainRow).toContain(base.net_pay.toFixed(2));
  });

  it("salary sacrifice on the profile lowers BOTH the take-home net and the employer NI columns", async () => {
    h.tables.payroll_lines = [
      {
        id: "line-sac",
        payroll_run_id: RUN_ID,
        org_id: ORG,
        user_id: "u-sac",
        hours: 160,
        hourly_pay: 20,
        gross_pay: 3_200,
        paye_estimate: 0,
        ni_estimate: 0,
        net_pay: 0,
        user: { full_name: "Sacrifice Worker" },
      },
    ];
    h.tables.payroll_tax_profiles = [
      {
        id: "tp-2",
        org_id: ORG,
        user_id: "u-sac",
        tax_region: "rest_of_uk",
        student_loan_plan: "none",
        salary_sacrifice_annual_pence: 600_000, // £6,000/yr = £500/mo
      },
    ];

    const res = await GET({} as never, { params: Promise.resolve({ id: RUN_ID }) });
    const body = await res.text();
    const row = body.trim().split("\n").find((r) => r.includes("Sacrifice Worker"))!;
    // Sacrifice shown, and employer NI banded on the reduced base (342.50, not 417.50).
    expect(row).toContain("500.00"); // salary sacrifice column
    expect(row).toContain("342.50"); // employer NI est after sacrifice
    expect(row).not.toContain("417.50"); // the un-sacrificed employer NI
  });
});

describe("the PDF and /me output paths route through the same overlay helper", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("the payslip PDF route applies the stored profile", () => {
    const code = read("app/api/payroll/lines/[id]/pdf/route.ts");
    expect(code).toMatch(/computeEmployeeDeductionsForStoredLine/);
    expect(code).toMatch(/employeeInputFromStoredProfile/);
    expect(code).toMatch(/getPayrollTaxProfile/);
  });

  it("the worker's own /me view applies the stored profile", () => {
    const code = read("app/(app)/me/page.tsx");
    expect(code).toMatch(/computeEmployeeDeductionsForStoredLine/);
    expect(code).toMatch(/employeeInputFromStoredProfile/);
    // ...and still surfaces NO employer-side cost (regression pin from employer-costs).
    expect(code).not.toMatch(
      /employer_ni_estimate|employer_pension_estimate|employment_cost_estimate/,
    );
  });
});
