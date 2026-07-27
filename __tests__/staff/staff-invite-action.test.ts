import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression coverage for the staff-invite server actions
 * (app/(app)/staff/actions.ts): inviteStaff + resendStaffInvite.
 *
 * Pins:
 *  - A failed invite (sendStaffInvite ok:false) NEVER returns ok:true — the
 *    deployed false-success bug.
 *  - Role cannot escalate: role "owner" is refused at the action layer and
 *    no invite is sent.
 *  - The metadata sent to sendStaffInvite carries invited_role = the
 *    requested staff/admin role (and source:"staff_invite", invited_org_id).
 *  - resendStaffInvite has the same error handling as inviteStaff.
 */

// --- Mocks ---------------------------------------------------------------
const sendStaffInviteMock = vi.fn();
vi.mock("@/server/services/staff-invite", () => ({
  sendStaffInvite: sendStaffInviteMock,
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1", name: "Acme Builders" } },
    user: { id: "user-1" },
  })),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const redirectMock = vi.fn((url: string) => {
  // Real next/navigation redirect throws to halt the action; mirror that so
  // an unexpected forbidden path fails loudly instead of falling through.
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

// Leave-email helpers are unrelated to invites; stub to avoid pulling the
// real Resend/template stack in at import time.
vi.mock("@/lib/email/send-leave", () => ({
  notifyOwnersOfLeaveRequest: vi.fn(),
  notifyStaffOfLeaveDecision: vi.fn(),
}));

// Server client: requireAdmin reads memberships.role; the action then looks
// up public.users by email. Both go through createClient().from(table).
let membershipRole: string | null = "admin";
let existingUser: Record<string, unknown> | null = null;
let membershipDup: Record<string, unknown> | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.single = async () =>
        table === "memberships"
          ? { data: membershipRole ? { role: membershipRole } : null, error: null }
          : { data: null, error: null };
      chain.maybeSingle = async () => {
        if (table === "users") return { data: existingUser, error: null };
        if (table === "memberships") return { data: membershipDup, error: null };
        return { data: null, error: null };
      };
      chain.insert = async () => ({ data: null, error: null });
      return chain;
    },
  })),
}));

// Admin client: resendStaffInvite calls listUsers; Case B profile update
// calls from().update().eq().
let adminListUsersResult: { data: { users: unknown[] } | null; error: unknown } = {
  data: { users: [] },
  error: null,
};
const adminListUsersMock = vi.fn(async () => adminListUsersResult);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { listUsers: adminListUsersMock } },
    from: () => ({ update: () => ({ eq: async () => ({ data: null, error: null }) }) }),
  }),
}));

const { inviteStaff, resendStaffInvite } = await import("@/app/(app)/staff/actions");

function makeForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  sendStaffInviteMock.mockReset();
  sendStaffInviteMock.mockResolvedValue({ ok: true, alreadyExisted: false, hadMagicLink: true });
  revalidatePathMock.mockReset();
  redirectMock.mockClear();
  adminListUsersMock.mockClear();
  membershipRole = "admin";
  existingUser = null;
  membershipDup = null;
  adminListUsersResult = { data: { users: [] }, error: null };
});

describe("inviteStaff — role cannot escalate", () => {
  it("refuses role 'owner' and never sends an invite", async () => {
    const res = await inviteStaff(makeForm({ email: "boss@x.test", role: "owner" }));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/Owner role can only be assigned during onboarding/i);
      expect(res.fieldErrors?.role).toBeTruthy();
    }
    expect(sendStaffInviteMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown role at the schema layer without inviting", async () => {
    const res = await inviteStaff(makeForm({ email: "x@x.test", role: "superuser" }));
    expect(res.ok).toBe(false);
    expect(sendStaffInviteMock).not.toHaveBeenCalled();
  });
});

describe("inviteStaff — successful invite (new email)", () => {
  it("sends a staff invite with invited_role='staff' and reports invite_sent", async () => {
    existingUser = null; // Case A — brand-new email

    const res = await inviteStaff(
      makeForm({ email: "jane@x.test", role: "staff", full_name: "Jane Doe" }),
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outcome).toBe("invite_sent");
      expect(res.message).toContain("jane@x.test");
    }
    expect(sendStaffInviteMock).toHaveBeenCalledTimes(1);
    expect(sendStaffInviteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "jane@x.test",
        orgName: "Acme Builders",
        metadata: expect.objectContaining({
          invited_role: "staff",
          invited_org_id: "org-1",
          source: "staff_invite",
        }),
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/staff");
  });

  it("carries invited_role='admin' when admin is requested (only staff/admin reach metadata)", async () => {
    existingUser = null;

    const res = await inviteStaff(makeForm({ email: "adm@x.test", role: "admin" }));

    expect(res.ok).toBe(true);
    expect(sendStaffInviteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ invited_role: "admin" }),
      }),
    );
  });
});

describe("inviteStaff — failed invite must NOT pretend success", () => {
  it("returns ok:false when sendStaffInvite fails, and does not revalidate", async () => {
    existingUser = null;
    sendStaffInviteMock.mockResolvedValue({ ok: false, reason: "error: resend down" });

    const res = await inviteStaff(makeForm({ email: "jane@x.test", role: "staff" }));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Couldn't send the invite email/i);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("returns field errors and does not invite on an invalid email", async () => {
    const res = await inviteStaff(makeForm({ email: "not-an-email", role: "staff" }));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors).toBeTruthy();
    expect(sendStaffInviteMock).not.toHaveBeenCalled();
  });
});

describe("resendStaffInvite — same error handling as invite", () => {
  const pendingInvitee = {
    id: "u-9",
    email: "jane@x.test",
    email_confirmed_at: null,
    user_metadata: { invited_org_id: "org-1", source: "staff_invite", invited_role: "staff" },
  };

  it("resends a pending invite and reports invite_sent (parity success)", async () => {
    adminListUsersResult = { data: { users: [pendingInvitee] }, error: null };

    const res = await resendStaffInvite("jane@x.test");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outcome).toBe("invite_sent");
      expect(res.message).toContain("jane@x.test");
    }
    expect(sendStaffInviteMock).toHaveBeenCalledTimes(1);
    expect(sendStaffInviteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          invited_role: "staff",
          invited_org_id: "org-1",
        }),
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/staff");
  });

  it("returns ok:false when the resend send fails (no false success)", async () => {
    adminListUsersResult = { data: { users: [pendingInvitee] }, error: null };
    sendStaffInviteMock.mockResolvedValue({ ok: false, reason: "boom" });

    const res = await resendStaffInvite("jane@x.test");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Couldn't resend the invite email/i);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("refuses to resend to an address with no pending invite for this org", async () => {
    adminListUsersResult = {
      data: {
        users: [
          {
            id: "u-9",
            email: "jane@x.test",
            email_confirmed_at: null,
            user_metadata: { invited_org_id: "some-other-org", source: "staff_invite" },
          },
        ],
      },
      error: null,
    };

    const res = await resendStaffInvite("jane@x.test");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/No pending invite/i);
    expect(sendStaffInviteMock).not.toHaveBeenCalled();
  });

  it("refuses to resend to someone who has already joined (confirmed)", async () => {
    adminListUsersResult = {
      data: {
        users: [
          {
            id: "u-9",
            email: "jane@x.test",
            email_confirmed_at: "2026-01-01T00:00:00Z",
            user_metadata: { invited_org_id: "org-1", source: "staff_invite" },
          },
        ],
      },
      error: null,
    };

    const res = await resendStaffInvite("jane@x.test");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already joined/i);
    expect(sendStaffInviteMock).not.toHaveBeenCalled();
  });
});

describe("staff actions — no Supabase built-in invite email (source regression)", () => {
  const src = readFileSync(resolve(process.cwd(), "app/(app)/staff/actions.ts"), "utf8");

  it("does not call inviteUserByEmail (the unchecked false-success path)", () => {
    expect(src).not.toMatch(/inviteUserByEmail/);
  });

  it("routes invites through sendStaffInvite", () => {
    expect(src).toMatch(/sendStaffInvite/);
  });
});
