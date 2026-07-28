import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PATCH /api/finances/[id] — active-org scoping must NOT displace the 409
 * refusal mapping.
 *
 * Two behaviours meet on this route and they are easy to confuse:
 *
 *   - The CIS / settlement DB guards (20261053000000, 20261054000000) raise a
 *     check violation for a LEGITIMATE refusal — the bill is part-paid, so its
 *     value is frozen — which `financeWriteRefusal` maps to a 409 that names
 *     the recovery path. __tests__/finances/write-refusal.test.ts pins the pure
 *     mapping; this file pins it THROUGH THE ROUTE.
 *
 *   - The new `.eq("org_id", ctx.org.id)` predicate makes a row belonging to
 *     another of the caller's orgs match ZERO rows. No guard fires, because no
 *     row was touched, so the request must answer 404 — not 409, and not a
 *     misleading success.
 *
 * Getting this wrong in either direction is a real cost: a 409 for a foreign
 * id would leak that the bill exists and is part-paid somewhere, and losing
 * the 409 would send a user through a void-and-re-post ceremony as an opaque
 * 500.
 */

type UpdateResult = {
  error: { code?: string; message?: string } | null;
  count: number | null;
};

let updateResult: UpdateResult = { error: null, count: 1 };
let lastFilters: Array<[string, unknown]> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (_table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.update = () => chain;
      chain.delete = () => chain;
      chain.eq = (col: string, val: unknown) => {
        lastFilters.push([col, val]);
        return chain;
      };
      chain.maybeSingle = async () => ({ data: null, error: null });
      // The PATCH awaits the builder after .select("id"); resolve to the
      // configured outcome whichever terminal the route uses.
      chain.then = (resolve: (v: unknown) => unknown) => resolve(updateResult);
      return chain;
    },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  })),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-active" }, user: { id: "user-1" } },
    user: { id: "user-1", email: "u@example.test" },
  })),
}));

const { PATCH } = await import("@/app/api/finances/[id]/route");

import type { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return new Request("https://crewflow.uk/api/finances/fin-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "fin-1" });

const CIS_MESSAGE =
  "bill 7f3a has been part-paid under CIS — its value and VAT rate are frozen because a " +
  "deduction has already been calculated and reported from them. Void the CIS payments " +
  "against this bill to change it, then re-post them";

const FLOOR_MESSAGE =
  "bill 7f3a has 900.00 already settled against it by supplier payments, so its value " +
  "cannot be reduced to 100.00 — bill it for at least what has been paid, or void the " +
  "payments that no longer fit and record them again";

beforeEach(() => {
  updateResult = { error: null, count: 1 };
  lastFilters = [];
});

describe("PATCH /api/finances/[id] — active-org scoping", () => {
  it("constrains the UPDATE to the active org", () => {
    // Pinned on the filters the route actually issued, not on source text.
    return PATCH(makeRequest({ amount: 250 }), { params }).then(() => {
      expect(lastFilters).toContainEqual(["id", "fin-1"]);
      expect(lastFilters).toContainEqual(["org_id", "org-active"]);
    });
  });

  it("answers 404 when the predicate matches nothing (foreign or missing row)", async () => {
    updateResult = { error: null, count: 0 };
    const res = await PATCH(makeRequest({ amount: 250 }), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
  });

  it("still succeeds for the active org's own bill (no over-scoping)", async () => {
    const res = await PATCH(makeRequest({ amount: 250 }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("PATCH /api/finances/[id] — the 409 refusal paths still work", () => {
  it("maps the CIS freeze to 409 with its recovery path", async () => {
    updateResult = { error: { code: "23514", message: CIS_MESSAGE }, count: null };
    const res = await PATCH(makeRequest({ amount: 250 }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/part-paid under CIS/i);
    expect(body.error).toMatch(/void the CIS payments/i);
  });

  it("maps the settlement floor to 409 with its OWN recovery path", async () => {
    updateResult = { error: { code: "23514", message: FLOOR_MESSAGE }, count: null };
    const res = await PATCH(makeRequest({ amount: 100 }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already paid more than that/i);
    expect(body.error).not.toMatch(/CIS/i);
  });

  it("never echoes the raw Postgres message through the route", async () => {
    updateResult = { error: { code: "23514", message: CIS_MESSAGE }, count: null };
    const body = await (await PATCH(makeRequest({ amount: 250 }), { params })).json();
    expect(JSON.stringify(body)).not.toContain("7f3a");
  });

  it("still answers 500 for errors that are genuine server faults", async () => {
    updateResult = { error: { code: "42501", message: "permission denied" }, count: null };
    const res = await PATCH(makeRequest({ amount: 250 }), { params });
    expect(res.status).toBe(500);
  });

  it("a refusal is answered as 409, NOT swallowed into the new 404 path", async () => {
    // Ordering regression: the org predicate is applied on the query, and the
    // refusal mapping runs on the resulting error. If a future edit checked
    // `count === 0` first, a real guard refusal would silently become "Not
    // found" and the user would lose the recovery instructions entirely.
    updateResult = { error: { code: "23514", message: CIS_MESSAGE }, count: 0 };
    const res = await PATCH(makeRequest({ amount: 250 }), { params });
    expect(res.status).toBe(409);
  });
});
