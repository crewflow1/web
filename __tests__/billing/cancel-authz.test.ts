import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHO may cancel, export, or ask to reactivate — the billing-account guard and
 * the server actions / route that sit behind it.
 *
 * The REAL guard (server/auth/billing-account.ts) and the REAL actions + route
 * run here; only the session lookups and the downstream services are stubbed.
 * The point of every case: the org that gets acted on is the one derived from
 * the SESSION, the caller must be its real `owner`, and a denied caller never
 * reaches the cancellation service at all.
 */

const OWN_ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  ctx: null as null | { membership: { org_id: string; role: string }; org: { id: string; name: string; status: string } },
  superAdmin: false,
  requireOrgContext: vi.fn(async () => ({})),
  getOrgForUser: vi.fn(),
  cancel: vi.fn(),
  reactivate: vi.fn(),
  buildOrgExport: vi.fn(),
  recordGdprExport: vi.fn(async () => ({ ok: true })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({
  getUser: async () => h.user,
  requireUser: async () => {
    if (!h.user) throw new Error("NEXT_REDIRECT:/login");
    return h.user;
  },
  getOrgForUser: h.getOrgForUser,
  orgHasActiveAccess: (s: string) => s === "active" || s === "trial",
  requireOrgContext: h.requireOrgContext,
}));
vi.mock("@/server/auth/superadmin", () => ({ isSuperAdminEmail: () => h.superAdmin }));
vi.mock("@/server/services/subscription-cancellation", () => ({
  cancelOrgSubscription: h.cancel,
  requestReactivation: h.reactivate,
  wireCancellationDeps: () => ({ wired: "cancel" }),
  wireReactivationDeps: () => ({ wired: "reactivate" }),
}));
vi.mock("@/server/services/gdpr-export", () => ({
  buildOrgExport: h.buildOrgExport,
  recordGdprExport: h.recordGdprExport,
}));

const { cancelSubscriptionAction, requestReactivationAction } = await import(
  "@/app/account/billing/actions"
);
const { GET: exportGET } = await import("@/app/api/account/export/route");
const { resolveBillingOwner } = await import("@/server/auth/billing-account");

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function signIn(role: string, status = "active") {
  h.user = { id: "user-1", email: "someone@example.test" };
  h.ctx = {
    membership: { org_id: OWN_ORG, role },
    org: { id: OWN_ORG, name: "Acme", status },
  };
}

beforeEach(() => {
  h.user = null;
  h.ctx = null;
  h.superAdmin = false;
  h.requireOrgContext.mockClear();
  h.getOrgForUser.mockReset();
  h.getOrgForUser.mockImplementation(async () => h.ctx);
  h.cancel.mockReset();
  h.cancel.mockResolvedValue({
    ok: true,
    outcome: "cancelled",
    accessRevoked: true,
    subscriptionsCancelled: ["sub_1"],
    refundReview: "not_applicable",
    emailSent: true,
  });
  h.reactivate.mockReset();
  h.reactivate.mockResolvedValue({ ok: true, outcome: "requested" });
  h.buildOrgExport.mockReset();
  h.buildOrgExport.mockResolvedValue({
    manifest: { generated_at: "2026-01-01T00:00:00.000Z", table_count: 1, total_rows: 1, complete: true },
    tables: [{ table: "customers", rows: [{ id: "c1" }] }],
  });
  h.recordGdprExport.mockClear();
});

const cancelAs = (fields: Record<string, string> = { expected_org_id: OWN_ORG }) =>
  cancelSubscriptionAction({ status: "idle" }, form(fields));

describe("cancelSubscriptionAction — authorisation", () => {
  it("OWNER of an active org → the service is called for the SESSION's org, with the session user as actor", async () => {
    signIn("owner");
    const r = await cancelAs({ expected_org_id: OWN_ORG, reason: "  closing down  " });
    expect(r).toEqual({ status: "done", redirectTo: "/account/billing?cancelled=1&emailed=1" });
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel.mock.calls[0]![1]).toEqual({
      orgId: OWN_ORG,
      actor: { userId: "user-1", email: "someone@example.test" },
      reason: "closing down",
    });
    // Active org → the full session policy (MFA) is enforced too.
    expect(h.requireOrgContext).toHaveBeenCalledTimes(1);
  });

  it("the org is resolved from the user's OWN membership — never via impersonation", async () => {
    signIn("owner");
    await cancelAs();
    // getOrgForUser(userId) with NO { currentEmail } option: that option is what
    // switches on the HQ-impersonation override.
    expect(h.getOrgForUser.mock.calls.every((c) => c.length === 1 && c[0] === "user-1")).toBe(true);
  });

  it.each(["admin", "staff", "member", "viewer"])(
    "%s cannot cancel — the service is never reached",
    async (role) => {
      signIn(role);
      const r = await cancelAs();
      expect(r).toMatchObject({ status: "error", code: "forbidden" });
      expect(h.cancel).not.toHaveBeenCalled();
    },
  );

  it("ANONYMOUS cannot cancel", async () => {
    const r = await cancelAs();
    expect(r).toMatchObject({ status: "error", code: "forbidden" });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("an HQ super-admin cannot cancel a customer (so neither can an impersonation session)", async () => {
    signIn("owner");
    h.superAdmin = true;
    const r = await cancelAs();
    expect(r).toMatchObject({ status: "error", code: "forbidden" });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.getOrgForUser).not.toHaveBeenCalled();
  });

  it("a user with no organisation cannot cancel", async () => {
    h.user = { id: "user-1", email: "someone@example.test" };
    h.ctx = null;
    const r = await cancelAs();
    expect(r).toMatchObject({ status: "error", code: "org_not_found" });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("OTHER ORG: an owner posting another org's id cancels NOTHING — the posted id is never a selector", async () => {
    signIn("owner");
    const r = await cancelAs({ expected_org_id: OTHER_ORG });
    expect(r).toMatchObject({ status: "error", code: "org_changed" });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("a missing / malformed expected_org_id is refused", async () => {
    signIn("owner");
    expect(await cancelAs({})).toMatchObject({ status: "error", code: "invalid" });
    expect(await cancelAs({ expected_org_id: "not-a-uuid" })).toMatchObject({ status: "error", code: "invalid" });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("SUSPENDED (payment failing) owner CAN cancel — the active-access gate is not in the way", async () => {
    signIn("owner", "suspended");
    const r = await cancelAs();
    expect(r.status).toBe("done");
    expect(h.cancel).toHaveBeenCalledTimes(1);
    // requireOrgContext would redirect a suspended org to /access-pending.
    expect(h.requireOrgContext).not.toHaveBeenCalled();
  });

  it("a CANCELLED org's owner may run it again (idempotent / 'check billing has stopped')", async () => {
    signIn("owner", "cancelled");
    h.cancel.mockResolvedValue({
      ok: true,
      outcome: "already_cancelled",
      accessRevoked: false,
      subscriptionsCancelled: [],
      refundReview: "not_applicable",
      emailSent: false,
    });
    const r = await cancelAs();
    expect(r).toEqual({ status: "done", redirectTo: "/account/billing?cancelled=1" });
  });
});

describe("cancelSubscriptionAction — failures are never reported as success", () => {
  it.each([
    "disabled",
    "in_progress",
    "billing_unavailable",
    "billing_mismatch",
    "stripe_timeout",
    "stripe_error",
    "org_not_found",
  ])("service refusal %s → error state, no redirect", async (reason) => {
    signIn("owner");
    h.cancel.mockResolvedValue({ ok: false, reason });
    const r = await cancelAs();
    expect(r).toMatchObject({ status: "error", code: reason });
    expect((r as { message: string }).message.length).toBeGreaterThan(20);
  });

  it("the service throwing → 'unexpected' (claims neither success nor 'nothing changed')", async () => {
    signIn("owner");
    h.cancel.mockRejectedValue(new Error("boom"));
    const r = await cancelAs();
    expect(r).toMatchObject({ status: "error", code: "unexpected" });
  });

  it("an over-long reason is rejected, not truncated silently into Stripe/HQ", async () => {
    signIn("owner");
    const r = await cancelAs({ expected_org_id: OWN_ORG, reason: "x".repeat(1001) });
    expect(r).toMatchObject({ status: "error", code: "invalid" });
    expect(h.cancel).not.toHaveBeenCalled();
  });
});

describe("requestReactivationAction", () => {
  const ask = (org = OWN_ORG) =>
    requestReactivationAction({ status: "idle" }, form({ expected_org_id: org }));

  it("owner of a cancelled org → request recorded for the session's org", async () => {
    signIn("owner", "cancelled");
    expect(await ask()).toEqual({ status: "requested" });
    expect(h.reactivate.mock.calls[0]![1]).toEqual({
      orgId: OWN_ORG,
      actor: { userId: "user-1", email: "someone@example.test" },
    });
  });

  it.each(["admin", "staff"])("%s cannot request reactivation", async (role) => {
    signIn(role, "cancelled");
    expect((await ask()).status).toBe("error");
    expect(h.reactivate).not.toHaveBeenCalled();
  });

  it("anonymous / another org's id → refused", async () => {
    expect((await ask()).status).toBe("error");
    signIn("owner", "cancelled");
    expect((await ask(OTHER_ORG)).status).toBe("error");
    expect(h.reactivate).not.toHaveBeenCalled();
  });

  it("the service saying 'not cancelled' is surfaced, not swallowed", async () => {
    signIn("owner", "cancelled");
    h.reactivate.mockResolvedValue({ ok: false, reason: "not_cancelled" });
    expect(await ask()).toMatchObject({ status: "error" });
  });
});

describe("GET /api/account/export — the owner keeps their data after cancelling", () => {
  it("owner of a CANCELLED org → 200 zip, private, built for the session's org, audited", async () => {
    signIn("owner", "cancelled");
    const res = await exportGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(h.buildOrgExport.mock.calls[0]![0]).toMatchObject({ orgId: OWN_ORG });
    expect(h.recordGdprExport).toHaveBeenCalledTimes(1);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // ZIP local-file-header magic "PK\x03\x04".
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("owner of a SUSPENDED org → 200", async () => {
    signIn("owner", "suspended");
    expect((await exportGET()).status).toBe(200);
  });

  it("anonymous → 401, nothing is read", async () => {
    const res = await exportGET();
    expect(res.status).toBe(401);
    expect(h.buildOrgExport).not.toHaveBeenCalled();
  });

  it.each(["admin", "staff"])("%s of a cancelled org → 403, nothing is read", async (role) => {
    signIn(role, "cancelled");
    const res = await exportGET();
    expect(res.status).toBe(403);
    expect(h.buildOrgExport).not.toHaveBeenCalled();
  });

  it("HQ super-admin → 403", async () => {
    signIn("owner", "cancelled");
    h.superAdmin = true;
    expect((await exportGET()).status).toBe(403);
    expect(h.buildOrgExport).not.toHaveBeenCalled();
  });
});

describe("resolveBillingOwner", () => {
  it("returns the session's user + org for the owner, whatever the org's status", async () => {
    for (const status of ["active", "trial", "suspended", "cancelled"]) {
      signIn("owner", status);
      const r = await resolveBillingOwner();
      expect(r.ok, status).toBe(true);
      if (r.ok) expect(r.ctx.org.id).toBe(OWN_ORG);
    }
  });
});
