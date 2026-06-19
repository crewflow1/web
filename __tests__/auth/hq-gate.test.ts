import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CrewFlow HQ — the single permission gate (CEO Directive 007.5, Phase 4:
 * one source of truth for permissions).
 *
 * `requireHq()` is the ONE implementation every HQ server action funnels
 * through; it replaced ~15 byte-identical local `requireAdmin()` helpers.
 * Those per-file suites now only assert each action file is *wired* to the
 * gate (a source grep). This suite pins the gate's actual authorization
 * contract directly, so the behaviour is proven in exactly one place:
 *
 *   - unauthenticated            → redirect("/login")  (via requireUser)
 *   - authenticated, not allowed → redirect("/dashboard")
 *   - allowlisted super-admin    → returns { id, email } for audit stamping
 *
 * requireUser + isSuperAdminEmail + next/navigation are mocked; the real
 * requireHq runs against them. redirect is stubbed to throw, mirroring
 * Next.js where redirect() halts the caller.
 */

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

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
