import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CrewFlow HQ — the single permission gate (CEO Directive 007.5, Phase 4:
 * one source of truth for permissions).
 *
 * Two entry points, ONE allowlist, both pinned here so the authorization
 * behaviour lives in exactly one place:
 *   - requireHq()     — for server actions; replaced ~15 byte-identical
 *                       local `requireAdmin()` helpers. Non-allowlisted →
 *                       redirect("/dashboard").
 *   - requireHqPage() — for pages + the /admin layout; replaced the inline
 *                       requireUser()+isSuperAdminEmail()-else-notFound()
 *                       dance copy-pasted across the HQ page tree.
 *                       Non-allowlisted → notFound() (404 hides the surface).
 * Both share: unauthenticated → redirect("/login") (via requireUser), and an
 * allowlisted super-admin → returns { id, email } for audit stamping.
 *
 * The per-file suites now only assert each file is *wired* to its gate (a
 * source grep for the import + call); this suite pins the real contract.
 *
 * requireUser + isSuperAdminEmail + next/navigation are mocked; the real
 * gates run against them. redirect and notFound are stubbed to throw,
 * mirroring Next.js where they halt the caller.
 */

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
const notFoundMock = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  notFound: notFoundMock,
}));

const requireUserMock = vi.fn();
vi.mock("@/server/auth/session", () => ({ requireUser: requireUserMock }));

const isSuperAdminEmailMock = vi.fn();
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: isSuperAdminEmailMock,
}));

// Late import so the module-level mocks are applied before hq.ts binds them.
async function loadGate() {
  return await import("@/server/auth/hq");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireHq — the single HQ authorization gate", () => {
  it("bounces unauthenticated callers to /login (via requireUser)", async () => {
    // requireUser is the primitive that rejects guests; model it by throwing
    // the /login redirect the real requireUser performs.
    requireUserMock.mockImplementation(() => {
      throw new Error("REDIRECT:/login");
    });
    const { requireHq } = await loadGate();
    await expect(requireHq()).rejects.toThrow(/REDIRECT:\/login/);
    // The allowlist check is never reached without a user.
    expect(isSuperAdminEmailMock).not.toHaveBeenCalled();
  });

  it("redirects an authenticated, non-allowlisted user to /dashboard", async () => {
    requireUserMock.mockResolvedValue({ id: "u1", email: "nobody@example.com" });
    isSuperAdminEmailMock.mockReturnValue(false);
    const { requireHq } = await loadGate();
    await expect(requireHq()).rejects.toThrow(/REDIRECT:\/dashboard/);
    expect(isSuperAdminEmailMock).toHaveBeenCalledWith("nobody@example.com");
  });

  it("returns { id, email } for an allowlisted super-admin", async () => {
    requireUserMock.mockResolvedValue({
      id: "admin-1",
      email: "ceo@crewflow.uk",
    });
    isSuperAdminEmailMock.mockReturnValue(true);
    const { requireHq } = await loadGate();
    await expect(requireHq()).resolves.toEqual({
      id: "admin-1",
      email: "ceo@crewflow.uk",
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("requireHqPage — the single HQ page/layout gate", () => {
  it("bounces unauthenticated callers to /login (via requireUser)", async () => {
    requireUserMock.mockImplementation(() => {
      throw new Error("REDIRECT:/login");
    });
    const { requireHqPage } = await loadGate();
    await expect(requireHqPage()).rejects.toThrow(/REDIRECT:\/login/);
    // The allowlist check is never reached without a user.
    expect(isSuperAdminEmailMock).not.toHaveBeenCalled();
  });

  it("404s an authenticated, non-allowlisted user (hides the HQ surface)", async () => {
    requireUserMock.mockResolvedValue({ id: "u1", email: "nobody@example.com" });
    isSuperAdminEmailMock.mockReturnValue(false);
    const { requireHqPage } = await loadGate();
    await expect(requireHqPage()).rejects.toThrow(/NOT_FOUND/);
    expect(notFoundMock).toHaveBeenCalled();
    // A 404, never the actions' /dashboard redirect — the route stays hidden.
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns { id, email } for an allowlisted super-admin", async () => {
    requireUserMock.mockResolvedValue({
      id: "admin-1",
      email: "ceo@crewflow.uk",
    });
    isSuperAdminEmailMock.mockReturnValue(true);
    const { requireHqPage } = await loadGate();
    await expect(requireHqPage()).resolves.toEqual({
      id: "admin-1",
      email: "ceo@crewflow.uk",
    });
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
