import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Superadmin Stripe product provisioning (final launch audit F5).
 *
 * Provisioning creates Stripe objects, so it must never run on a GET (a link,
 * a prefetch, an <img>, a top-level navigation from another site). POST only,
 * superadmin only, and only from a same-origin browser request.
 */

let isSuper = true;
const provision = vi.fn(async () => ({ ok: true, livemode: false, stripe_account_id: "acct_test", items: [], errors: [] }));

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "u-hq", email: isSuper ? "hq@crewflow.test" : "owner@crewflow.test" }),
}));
vi.mock("@/server/auth/superadmin", () => ({ isSuperAdminEmail: () => isSuper }));
vi.mock("@/lib/stripe/provisioning", () => ({ provisionStripeProducts: provision }));
vi.mock("@/lib/stripe/prices", () => ({ clearPriceCache: vi.fn() }));
vi.mock("@/server/services/hq-audit", () => ({ recordAdminActivity: vi.fn(async () => undefined) }));

const route = (await import("@/app/api/admin/stripe/provision/route")) as Record<string, unknown>;
const ORIGIN = "https://crewflow.test";
const post = (headers: Record<string, string>) =>
  (route.POST as (r: Request) => Promise<Response>)(
    new Request(`${ORIGIN}/api/admin/stripe/provision`, { method: "POST", headers }),
  );

beforeEach(() => {
  isSuper = true;
  provision.mockClear();
});

describe("Stripe provisioning is POST-only and same-origin", () => {
  it("exposes no GET handler, so a GET can never provision (Next answers 405)", async () => {
    if (typeof route.GET === "function") {
      await (route.GET as (r: Request) => Promise<Response>)(new Request(`${ORIGIN}/api/admin/stripe/provision`));
    }
    expect(route.GET).toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
  });

  it("a same-origin superadmin POST provisions", async () => {
    const res = await post({ origin: ORIGIN, "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("a cross-site POST is refused before provisioning", async () => {
    const res = await post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(provision).not.toHaveBeenCalled();
  });

  it("a POST with no Origin header is refused before provisioning", async () => {
    const res = await post({});
    expect(res.status).toBe(403);
    expect(provision).not.toHaveBeenCalled();
  });

  it("a non-superadmin POST is a 404 and never provisions", async () => {
    isSuper = false;
    const res = await post({ origin: ORIGIN, "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(404);
    expect(provision).not.toHaveBeenCalled();
  });

  it("the HQ customer page submits a POST form instead of linking to the endpoint", () => {
    const page = readFileSync(join(__dirname, "../../app/admin/customers/[id]/page.tsx"), "utf8");
    expect(page).not.toMatch(/href="\/api\/admin\/stripe\/provision"/);
    expect(page).toMatch(/method="post"[\s\S]{0,120}action="\/api\/admin\/stripe\/provision"|action="\/api\/admin\/stripe\/provision"[\s\S]{0,120}method="post"/);
  });
});
