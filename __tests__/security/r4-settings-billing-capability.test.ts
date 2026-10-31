import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — settings/billing (self-serve tenant plan management).
 *
 * The page exposes the org's subscription status + CrewFlow (SaaS) invoices and,
 * when self-serve billing is configured (DARK today), the Stripe billing portal
 * and plan up/downgrade. Under R4:
 *   page              → settings:view   (gate BEFORE any subscription/invoice read)
 *   openBillingPortal → settings:manage
 *   changePlan        → settings:manage
 *
 * Source pins + a behavioural settings-capability matrix. (Self-serve billing is
 * dark, so the Stripe calls are unreachable regardless; this pins the authz.)
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("settings/billing is capability-gated (no residual management gate)", () => {
  it("the page requires settings:view", () => {
    const code = codeOf(read("app/(app)/settings/billing/page.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"settings",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    expect(code).not.toMatch(/\bisAdmin\b/);
  });

  it("openBillingPortal + changePlan gate settings:manage via hasCapability", () => {
    const code = codeOf(read("app/(app)/settings/billing/actions.ts"));
    const portal = code.slice(code.indexOf("export async function openBillingPortal"));
    const change = portal.slice(portal.indexOf("export async function changePlan"));
    const portalOnly = portal.slice(0, portal.indexOf("export async function changePlan"));
    expect(portalOnly).toMatch(/hasCapability\(\s*ctx,\s*user,\s*"settings",\s*"manage"\s*\)/);
    expect(change).toMatch(/hasCapability\(\s*ctx,\s*user,\s*"settings",\s*"manage"\s*\)/);
    expect(code).not.toMatch(/isAdminRole/);
  });
});

// Behavioural — settings:manage semantics; staff/ungranted admin denied.
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

describe("settings:manage gates the billing mutations", () => {
  it("owner can manage without a stored grant", async () => {
    expect(await hasCapability(CTX("owner"), USER, "settings", "manage")).toBe(true);
  });
  it("an admin with settings:manage can manage", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "settings", action: "manage" }];
    expect(await hasCapability(CTX("admin"), USER, "settings", "manage")).toBe(true);
  });
  it("an admin with only settings:view cannot manage", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "settings", action: "view" }];
    expect(await hasCapability(CTX("admin"), USER, "settings", "view")).toBe(true);
    expect(await hasCapability(CTX("admin"), USER, "settings", "manage")).toBe(false);
  });
  it("staff cannot manage even with a stray grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "settings", action: "manage" }];
    expect(await hasCapability(CTX("staff"), USER, "settings", "manage")).toBe(false);
    expect(await hasCapability(CTX("staff"), USER, "settings", "view")).toBe(false);
  });
});
