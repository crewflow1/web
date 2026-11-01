import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: the signup flow must create a user's FIRST org and never a
 * SECOND. A user who already belongs to an org (e.g. an existing user whose
 * only membership was removed, then looping back through onboarding) re-submitting
 * the create-company form produced DUPLICATE pending orgs (observed: 6 orgs
 * named after the email, seconds apart). createOrg() must redirect such a user
 * instead of calling createOrgWithOwner again.
 */

const redirectErr = (url: string) => {
  const e = new Error(`REDIRECT:${url}`);
  (e as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
  return e;
};

const requireUser = vi.fn();
const getOrgForUser = vi.fn();
const orgHasActiveAccess = (s: string) => s === "active" || s === "trial";
const createOrgWithOwner = vi.fn();
const redirect = vi.fn((url: string) => {
  throw redirectErr(url);
});

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  requireUser,
  getOrgForUser,
  orgHasActiveAccess,
}));
vi.mock("@/server/services/bootstrap-account", () => ({ createOrgWithOwner }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  }),
}));
vi.mock("@/server/services/notifications-service", () => ({ emitNotifications: vi.fn() }));
vi.mock("@/lib/notifications/events", () => ({ notifyOnCustomerSignup: vi.fn(() => []) }));
vi.mock("@/lib/legal/tos", () => ({ CURRENT_TOS_VERSION: "test" }));

const { createOrg } = await import("@/app/onboarding/company/actions");

const fd = (entries: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const runToRedirect = async (f: FormData) => {
  try {
    await createOrg(f);
  } catch (e) {
    const m = String((e as Error).message).match(/^REDIRECT:(.+)$/);
    if (m) return m[1];
    throw e;
  }
  return null;
};

describe("createOrg — duplicate-org idempotency guard", () => {
  afterEach(() => vi.clearAllMocks());

  it("a user with a PENDING org is sent to /access-pending and NO new org is created", async () => {
    requireUser.mockResolvedValue({ id: "u1", email: "x@y.z" });
    getOrgForUser.mockResolvedValue({ membership: { org_id: "o1", role: "owner" }, org: { status: "pending" } });

    const dest = await runToRedirect(fd()); // guard runs before any validation
    expect(dest).toBe("/access-pending");
    expect(createOrgWithOwner).not.toHaveBeenCalled();
  });

  it("a user with an ACTIVE org is sent to /dashboard and NO new org is created", async () => {
    requireUser.mockResolvedValue({ id: "u1", email: "x@y.z" });
    getOrgForUser.mockResolvedValue({ membership: { org_id: "o1", role: "owner" }, org: { status: "active" } });

    const dest = await runToRedirect(fd());
    expect(dest).toBe("/dashboard");
    expect(createOrgWithOwner).not.toHaveBeenCalled();
  });

  it("a genuinely org-less user proceeds (guard does not block a first signup)", async () => {
    requireUser.mockResolvedValue({ id: "u1", email: "x@y.z" });
    getOrgForUser.mockResolvedValue(null);
    createOrgWithOwner.mockResolvedValue({ orgId: "new" });

    const dest = await runToRedirect(
      fd({
        tos_accept: "on",
        name: "Murphy Roofing",
        first_name: "John",
        phone: "+447700900123",
        postcode: "BT15 1AA",
      }),
    );
    expect(createOrgWithOwner).toHaveBeenCalledTimes(1);
    expect(dest).toBe("/onboarding/setup");
  });
});
