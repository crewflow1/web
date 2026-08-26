import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reports CSV export — one download, four deterministic sections.
 *
 * The /reports page renders four aggregates (jobs per week, revenue per
 * month, VAT per quarter, top customers). This route serialises THOSE
 * SAME aggregates to a single multi-section CSV. The whole point of the
 * increment is REUSE-not-recompute: the route must reach its figures
 * only through `@/lib/reports/aggregates` (never its own SQL), quote
 * through the one shared `@/lib/csv` escaper, and stay behind the same
 * `requireOrgContext` org gate as the page — matching the finances and
 * invoices export routes.
 *
 * The aggregate module and the auth gate are MOCKED so the handler runs
 * with no Supabase, no env, and no `server-only` boundary. The real
 * `csvEscape` (reached via the route) does the quoting, so the escaping
 * assertions exercise the true shared implementation.
 */

const {
  jobsPerWeekMock,
  revenuePerMonthMock,
  vatPerQuarterMock,
  topCustomersMock,
  requireOrgContextMock,
} = vi.hoisted(() => ({
  jobsPerWeekMock: vi.fn(),
  revenuePerMonthMock: vi.fn(),
  vatPerQuarterMock: vi.fn(),
  topCustomersMock: vi.fn(),
  requireOrgContextMock: vi.fn(),
}));

vi.mock("@/lib/reports/aggregates", () => ({
  jobsPerWeek: jobsPerWeekMock,
  revenuePerMonth: revenuePerMonthMock,
  vatPerQuarter: vatPerQuarterMock,
  topCustomersByRevenue: topCustomersMock,
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: requireOrgContextMock,
  // Faithful mirror of requireManagementApi (fix 1): the export route is
  // management-only. Derives from the SAME requireOrgContextMock so each test's
  // configured ctx keeps driving the outcome; a non-management role gets the
  // same 403 JSON the real helper returns.
  requireManagementApi: vi.fn(async () => {
    const res = await requireOrgContextMock();
    const role = (res as { ctx?: { membership?: { role?: string } } })?.ctx
      ?.membership?.role;
    if (role !== "owner" && role !== "admin") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return res;
  }),
}));

// Import under test AFTER the mocks are registered.
const { GET } = await import("@/app/api/reports/export/route");

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

beforeEach(() => {
  jobsPerWeekMock.mockReset();
  revenuePerMonthMock.mockReset();
  vatPerQuarterMock.mockReset();
  topCustomersMock.mockReset();
  requireOrgContextMock.mockReset();

  requireOrgContextMock.mockResolvedValue({
    ctx: { org: { id: "org-1" }, membership: { org_id: "org-1", role: "owner" } },
  });
  jobsPerWeekMock.mockResolvedValue([
    { week_start: "2026-06-01", total: 4, completed: 3 },
  ]);
  revenuePerMonthMock.mockResolvedValue([
    { month: "2026-06-01", revenue: 12000 },
  ]);
  vatPerQuarterMock.mockResolvedValue([
    { quarter: "2026-04-01", output_vat: 3000, input_vat: 1200, net_vat: 1800 },
  ]);
  // Customer name carries a comma on purpose — proves the shared escaper runs.
  topCustomersMock.mockResolvedValue([
    { id: "c1", name: "Acme, Inc.", revenue: 54000, invoice_count: 12 },
  ]);
});

// ---------------------------------------------------------------------
// Behavioural — the real handler, deterministic aggregates mocked
// ---------------------------------------------------------------------

describe("GET /api/reports/export — reuses the deterministic aggregates", () => {
  it("gates on requireOrgContext and calls every aggregate exactly once (no recompute)", async () => {
    await GET();
    expect(requireOrgContextMock).toHaveBeenCalledTimes(1);
    expect(jobsPerWeekMock).toHaveBeenCalledTimes(1);
    expect(revenuePerMonthMock).toHaveBeenCalledTimes(1);
    expect(vatPerQuarterMock).toHaveBeenCalledTimes(1);
    expect(topCustomersMock).toHaveBeenCalledTimes(1);
  });

  it("serves a CSV attachment with a date-stamped reports filename", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="crewflow-reports-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
  });

  it("emits four labelled sections, each under its own column header", async () => {
    const text = await (await GET()).text();
    expect(text).toContain("Jobs per week");
    expect(text).toContain("week_start,total,completed");
    expect(text).toContain("Revenue per month");
    expect(text).toContain("month,revenue");
    expect(text).toContain("VAT per quarter");
    expect(text).toContain("quarter,output_vat,input_vat,net_vat");
    expect(text).toContain("Top customers");
    expect(text).toContain("rank,customer,revenue,invoice_count");
  });

  it("emits money as raw two-dp numbers — never £-formatted or comma-grouped", async () => {
    const text = await (await GET()).text();
    expect(text).toContain("2026-06-01,12000.00"); // revenue row
    expect(text).toContain("2026-04-01,3000.00,1200.00,1800.00"); // vat row
    expect(text).not.toContain("£");
    expect(text).not.toContain("12,000");
  });

  it("renders integer counts and a 1-based rank", async () => {
    const text = await (await GET()).text();
    expect(text).toContain("2026-06-01,4,3"); // jobs: week,total,completed
    expect(text.split("\n").some((l) => l.startsWith("1,"))).toBe(true); // rank 1
  });

  it("escapes a comma-bearing customer name exactly once via the shared csvEscape", async () => {
    const text = await (await GET()).text();
    expect(text).toContain('1,"Acme, Inc.",54000.00,12');
    expect(text).not.toContain('"""'); // no double-escaping
  });

  it("separates the sections with a blank line and never queries the DB itself", async () => {
    const text = await (await GET()).text();
    // Exactly three blank lines — one between each of the four sections.
    const blanks = text.split("\n").filter((l) => l === "").length;
    expect(blanks).toBe(3);
  });
});

// ---------------------------------------------------------------------
// Source-pinned architecture — reuse, not recompute
// ---------------------------------------------------------------------

describe("reports export wiring (source-pinned architecture)", () => {
  const ROUTE = "app/api/reports/export/route.ts";

  it("reuses the one shared csvEscape — defines no local escaper", () => {
    const code = read(ROUTE);
    expect(code).toMatch(/from ["']@\/lib\/csv["']/);
    expect(code).not.toMatch(/function csvEscape/);
  });

  it("reuses the deterministic aggregates and never touches Supabase directly", () => {
    const code = read(ROUTE);
    expect(code).toMatch(/from ["']@\/lib\/reports\/aggregates["']/);
    // No direct DB access → the route cannot recompute; it can only reuse.
    expect(code).not.toMatch(/@\/lib\/supabase\/server/);
    expect(code).not.toMatch(/createClient/);
  });

  it("is org-isolated AND management-gated behind requireManagementApi", () => {
    // Strengthened (fix 1): the route funnels through requireManagementApi,
    // which wraps requireOrgContext (org isolation) and ADDS the owner/admin
    // gate — this CSV carries revenue/VAT/top-customers, never staff-readable.
    const code = read(ROUTE);
    expect(code).toMatch(/requireManagementApi\s*\(\s*\)/);
    expect(code).not.toMatch(/requireOrgContext\s*\(\s*\)/);
  });

  it("introduces no AI surface", () => {
    const code = read(ROUTE);
    expect(code).not.toMatch(/getTextProvider|anthropic|openai/i);
  });
});
