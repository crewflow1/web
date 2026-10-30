import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — job invoicing surfaces (billing + valuations).
 *
 * A job's "get paid" workflow — progress-billing plans/stages and interim
 * valuations / applications-for-payment — is the invoicing function and an
 * explicitly staff-prohibited money surface. R4 gates both on the `invoices`
 * capability rather than the coarse management role:
 *
 *   billing/page.tsx                 → requireCapability("invoices","view")
 *   billing: createBillingPlan       → invoices:create
 *   billing: addBillingStage         → invoices:create
 *   billing: generateStageInvoice    → invoices:create
 *   billing: deleteBillingStage      → invoices:edit
 *   billing: cancelBillingPlan       → invoices:edit
 *   valuations/page.tsx              → requireCapability("invoices","view")
 *   valuation: createValuation       → invoices:create
 *   valuation: generateValuationInvoice → invoices:create
 *   valuation: updateValuation/submitValuation/cancelValuation/linkVariation/
 *              unlinkVariation       → invoices:edit
 *   valuation: certifyValuation      → invoices:approve   (freezes the figures)
 *
 * SECURITY NOTE pinned here: previously the billing actions used an inline
 * owner/admin check and the valuation actions relied on the page's management
 * gate + RLS — so a staff member could POST a draft-valuation action directly.
 * The hasCapability gates close that path. Source pins + a behavioural
 * per-capability matrix prove it.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("job-invoicing pages gate on invoices:view (no residual management gate)", () => {
  for (const file of [
    "app/(app)/jobs/[id]/billing/page.tsx",
    "app/(app)/jobs/[id]/valuations/page.tsx",
  ]) {
    it(`${file} requires invoices:view`, () => {
      const code = codeOf(read(file));
      expect(code).toMatch(/requireCapability\(\s*"invoices",\s*"view"\s*\)/);
      expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    });
  }
});

describe("job-invoicing actions carry the right invoices capability", () => {
  const sliceFn = (code: string, name: string): string => {
    const start = code.indexOf(`export async function ${name}`);
    expect(start, `${name} present`).toBeGreaterThanOrEqual(0);
    const next = code.indexOf("export async function ", start + 1);
    return code.slice(start, next === -1 ? undefined : next);
  };

  const BILLING = codeOf(read("app/(app)/jobs/[id]/billing/actions.ts"));
  const VALUATION = codeOf(read("app/(app)/jobs/[id]/valuation-actions.ts"));

  const CASES: Array<{ src: string; fn: string; action: string }> = [
    { src: "billing", fn: "createBillingPlan", action: "create" },
    { src: "billing", fn: "addBillingStage", action: "create" },
    { src: "billing", fn: "generateStageInvoice", action: "create" },
    { src: "billing", fn: "deleteBillingStage", action: "edit" },
    { src: "billing", fn: "cancelBillingPlan", action: "edit" },
    { src: "valuation", fn: "createValuation", action: "create" },
    { src: "valuation", fn: "updateValuation", action: "edit" },
    { src: "valuation", fn: "submitValuation", action: "edit" },
    { src: "valuation", fn: "cancelValuation", action: "edit" },
    { src: "valuation", fn: "certifyValuation", action: "approve" },
    { src: "valuation", fn: "generateValuationInvoice", action: "create" },
    { src: "valuation", fn: "linkVariation", action: "edit" },
    { src: "valuation", fn: "unlinkVariation", action: "edit" },
  ];

  for (const { src, fn, action } of CASES) {
    it(`${fn} → invoices:${action}`, () => {
      const body = sliceFn(src === "billing" ? BILLING : VALUATION, fn);
      expect(body).toMatch(
        new RegExp(`hasCapability\\(\\s*ctx,\\s*user,\\s*"invoices",\\s*"${action}"\\s*\\)`),
      );
    });
  }

  it("billing no longer uses an inline isManager role check", () => {
    expect(BILLING).not.toMatch(/isManager/);
  });

  it("every billing + valuation export is capability-gated (gate count ≥ action count)", () => {
    for (const [code, label] of [
      [BILLING, "billing"],
      [VALUATION, "valuation"],
    ] as const) {
      const exported = (code.match(/export async function /g) ?? []).length;
      const gates = (code.match(/hasCapability\(\s*ctx,\s*user,\s*"invoices",/g) ?? []).length;
      expect(exported, `${label} exports an action`).toBeGreaterThan(0);
      expect(gates, `${label}: ${gates} gates for ${exported} actions`).toBeGreaterThanOrEqual(
        exported,
      );
    }
  });
});

// =====================================================================
// Behavioural — hasCapability (the real gate these actions call) returns the
// right boolean per role/grant. Only the admin-client grant read is mocked.
// =====================================================================
let mockRole: string | null = "owner";
let mockGrants: Array<{ module: string; action: string }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "memberships"
                ? { data: { id: "mem-1", role: mockRole }, error: null }
                : { data: null, error: null },
          }),
          limit: async () =>
            table === "membership_permissions"
              ? { data: mockGrants, error: null }
              : { data: [], error: null },
        }),
      }),
    }),
  }),
}));
const { hasCapability } = await import("@/server/auth/capabilities");
const CTX = (role: string | null) =>
  ({ membership: { org_id: "o", role }, org: { id: "o" } }) as never;
const USER = { id: "u" } as never;

beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("invoices capability semantics gate the job-invoicing actions", () => {
  it("an admin with invoices:create can create but not edit or approve", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "invoices", action: "create" }];
    expect(await hasCapability(CTX("admin"), USER, "invoices", "create")).toBe(true);
    expect(await hasCapability(CTX("admin"), USER, "invoices", "edit")).toBe(false);
    expect(await hasCapability(CTX("admin"), USER, "invoices", "approve")).toBe(false);
  });

  it("an admin with invoices:manage can create, edit and approve", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "invoices", action: "manage" }];
    for (const action of ["view", "create", "edit", "approve"] as const) {
      expect(await hasCapability(CTX("admin"), USER, "invoices", action)).toBe(true);
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "edit", "approve"] as const) {
      expect(await hasCapability(CTX("owner"), USER, "invoices", action)).toBe(true);
    }
  });

  it("staff are denied every job-invoicing write, even with a stray grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "invoices", action: "manage" }];
    for (const action of ["view", "create", "edit", "approve"] as const) {
      expect(await hasCapability(CTX("staff"), USER, "invoices", action)).toBe(false);
    }
  });
});
