import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@supabase/supabase-js";

/**
 * HQ access gate — BEHAVIOURAL trust-boundary proofs (VERIFY + HARDEN HQ).
 *
 * `server/auth/hq.ts` is the single chokepoint that makes every HQ (`/admin/*`)
 * surface internal-operator-only. The rest of the HQ test suite pins this gate
 * at the SOURCE level (the layout calls `requireHqPage()`, each action re-checks
 * `isSuperAdminEmail`, etc.). This file is the missing half: it actually INVOKES
 * `requireHqPage()` and `requireHqApi()` and asserts the three outcomes that
 * matter, exercising the real `isSuperAdminEmail` predicate against a known
 * allowlist — so a refactor that quietly breaks the wiring (e.g. forgets the
 * `!` on the predicate, returns `ok:true` for anon, or swaps notFound→nothing)
 * fails here even while the source strings still look right.
 *
 * Why this matters for HQ specifically:
 *   - The non-allowlisted answer is 404, NEVER 403 — HQ must not announce that
 *     the surface exists. Both gates must produce the indistinguishable
 *     "not found" for a signed-in non-operator and for an anonymous caller.
 *   - A Next.js server action / route handler does NOT inherit the layout's
 *     `requireHqPage()`. The gate therefore has to work when called directly,
 *     which is exactly what these tests do.
 *
 * Harness: `isSuperAdminEmail` reads `env.CREWFLOW_SUPERADMIN_EMAILS`, so we mock
 * `@/lib/env` to a fixed two-entry allowlist and let the REAL predicate run.
 * `getUser` / `requireUser` are the only session surface the gate touches, so we
 * mock just those; `next/navigation`'s `notFound` / `redirect` throw tagged
 * sentinels we can assert on (matching how they abort the request at runtime).
 */

const SUPERADMIN = "ceo@crewflow.uk";
const SUPERADMIN_MIXED_CASE = "CEO@CrewFlow.UK";
const TENANT = "owner@acme-builders.co.uk";

vi.mock("@/lib/env", () => ({
  env: { CREWFLOW_SUPERADMIN_EMAILS: "ceo@crewflow.uk, ops@crewflow.uk" },
}));

const getUser = vi.fn<() => Promise<User | null>>();
const requireUser = vi.fn<() => Promise<User>>();
vi.mock("@/server/auth/session", () => ({
  getUser: () => getUser(),
  requireUser: () => requireUser(),
}));

class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundError";
  }
}
class RedirectError extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT:${to}`);
    this.name = "RedirectError";
  }
}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError();
  },
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

// Import AFTER the mocks are registered.
import { requireHqPage, requireHqApi } from "@/server/auth/hq";

const asUser = (email: string | null): User =>
  ({ id: "u_1", email: email ?? undefined }) as unknown as User;

beforeEach(() => {
  getUser.mockReset();
  requireUser.mockReset();
  // requireUser models the real session: redirect anonymous callers to /login,
  // otherwise return the (mock) user.
  requireUser.mockImplementation(async () => {
    const u = await getUser();
    if (!u) throw new RedirectError("/login");
    return u;
  });
});

describe("requireHqApi — the route-handler gate (returns a status, never redirects)", () => {
  it("anonymous caller → 404 Response, ok:false (does not reveal the surface)", async () => {
    getUser.mockResolvedValue(null);
    const res = await requireHqApi();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(404);
  });

  it("signed-in NON-allowlisted tenant → 404 Response, ok:false (same answer as anon)", async () => {
    getUser.mockResolvedValue(asUser(TENANT));
    const res = await requireHqApi();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(404);
  });

  it("the 404 is a 404 — never a 403 that would betray the surface's existence", async () => {
    getUser.mockResolvedValue(asUser(TENANT));
    const res = await requireHqApi();
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).not.toBe(403);
    expect(res.response.status).not.toBe(401);
  });

  it("allowlisted super-admin → ok:true with the live user", async () => {
    getUser.mockResolvedValue(asUser(SUPERADMIN));
    const res = await requireHqApi();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("gate wrongly rejected a super-admin");
    expect(res.user.email).toBe(SUPERADMIN);
  });

  it("allowlist match is case-insensitive (real predicate, mixed-case email)", async () => {
    getUser.mockResolvedValue(asUser(SUPERADMIN_MIXED_CASE));
    const res = await requireHqApi();
    expect(res.ok).toBe(true);
  });

  it("a user with a null email is never admitted", async () => {
    getUser.mockResolvedValue(asUser(null));
    const res = await requireHqApi();
    expect(res.ok).toBe(false);
  });
});

describe("requireHqPage — the page/loader gate (redirects anon, 404s non-operators)", () => {
  it("anonymous visitor → redirected to /login (might be staff not yet signed in)", async () => {
    getUser.mockResolvedValue(null);
    await expect(requireHqPage()).rejects.toMatchObject({
      name: "RedirectError",
      to: "/login",
    });
  });

  it("signed-in NON-allowlisted tenant → notFound() (404, not a dashboard redirect)", async () => {
    getUser.mockResolvedValue(asUser(TENANT));
    await expect(requireHqPage()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("allowlisted super-admin → returns the user, never calls notFound()", async () => {
    getUser.mockResolvedValue(asUser(SUPERADMIN));
    const user = await requireHqPage();
    expect(user.email).toBe(SUPERADMIN);
  });

  it("a user with a null email is 404'd, not admitted", async () => {
    getUser.mockResolvedValue(asUser(null));
    await expect(requireHqPage()).rejects.toBeInstanceOf(NotFoundError);
  });
});
