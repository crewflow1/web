import { describe, it, expect, vi, beforeEach } from "vitest";
import { redirect } from "next/navigation";

/**
 * GET /api/reports — auth outcomes (final launch audit F4).
 *
 * The handler wraps its work in a catch-all. The org guard signals "not signed
 * in" / "no workspace" by throwing Next's redirect control-flow error, and the
 * catch-all used to turn that into a 500 for every such caller. The contract:
 * signed out → 401, no usable workspace → 403, missing capability → 403,
 * authorised → 200 with the four aggregates, a data failure → generic 500 that
 * echoes nothing internal.
 */

type Mode = "signed-out" | "mfa" | "no-org" | "staff" | "owner";
let mode: Mode = "owner";
let aggregateFails = false;

vi.mock("@/server/auth/capabilities", () => ({
  requireCapabilityApi: async () => {
    if (mode === "signed-out") redirect("/login");
    if (mode === "mfa") redirect("/login/mfa");
    if (mode === "no-org") redirect("/onboarding/company");
    if (mode === "staff") return Response.json({ error: "forbidden" }, { status: 403 });
    return { user: { id: "u" }, ctx: { org: { id: "org-a" } }, grants: [] };
  },
}));

vi.mock("@/lib/reports/aggregates", () => {
  const ok = (v: unknown) => async () => {
    if (aggregateFails) throw new Error("relation \"secret_internal_table\" does not exist");
    return v;
  };
  return {
    jobsPerWeek: ok([{ week: "2026-11-09", count: 3 }]),
    revenuePerMonth: ok([{ month: "2026-11", total: 1200 }]),
    vatPerQuarter: ok([{ quarter: "2026-Q4", output: 240, input: 40, net: 200 }]),
    topCustomersByRevenue: ok([{ customer_id: "c1", name: "Acme", total: 1200 }]),
  };
});

const { GET } = await import("@/app/api/reports/route");

beforeEach(() => {
  mode = "owner";
  aggregateFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/reports auth outcomes", () => {
  it("a signed-out caller gets 401, not 500", async () => {
    mode = "signed-out";
    expect((await GET()).status).toBe(401);
  });

  it("a caller who still owes an MFA step gets 401", async () => {
    mode = "mfa";
    expect((await GET()).status).toBe(401);
  });

  it("a signed-in user with no usable workspace gets 403, not 500", async () => {
    mode = "no-org";
    expect((await GET()).status).toBe(403);
  });

  it("staff without reports:view get 403", async () => {
    mode = "staff";
    expect((await GET()).status).toBe(403);
  });

  it("an authorised owner gets 200 with all four aggregates", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    for (const k of ["jobs_per_week", "revenue_per_month", "vat_per_quarter", "top_customers"]) {
      expect(Array.isArray(body[k]), k).toBe(true);
    }
  });

  it("a data failure is a generic 500 that leaks no internal detail", async () => {
    aggregateFails = true;
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/secret_internal_table|relation/);
  });
});
