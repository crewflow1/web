import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StaffInviteMetadata } from "@/server/services/staff-invite";

/**
 * Regression coverage for the staff-invite false-success bug.
 *
 * The deployed bug: app/(app)/staff/actions.ts called
 * supabase.auth.admin.inviteUserByEmail and only guarded a thrown error.
 * supabase-js admin methods return { data, error } and DO NOT throw on
 * operational failures, so a failed invite fell through to ok:true and the
 * modal showed "Invite emailed" even though nothing was sent.
 *
 * The fix routes every invite through sendStaffInvite, which checks the
 * returned error on EACH step (createUser, listUsers, updateUserById,
 * sendEmail) and only reports ok:true when the email genuinely went out.
 *
 * These tests pin: success, failed Supabase createUser, failed email send,
 * the idempotent already-exists path, generateLink being non-fatal, and —
 * most importantly — that a failed step never returns ok:true.
 */

// --- Mocks (hoisted; factories run lazily at the import() below) ---------
const createUserMock = vi.fn();
const listUsersMock = vi.fn();
const updateUserByIdMock = vi.fn();
const generateLinkMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        createUser: createUserMock,
        listUsers: listUsersMock,
        updateUserById: updateUserByIdMock,
        generateLink: generateLinkMock,
      },
    },
  }),
}));

const sendEmailMock = vi.fn();
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock }));

// staffInviteEmail is intentionally NOT mocked — we use the real template so
// the test also proves the magic link threads through into the sent email.

const { sendStaffInvite } = await import("@/server/services/staff-invite");

const metadata: StaffInviteMetadata = {
  invited_org_id: "org-1",
  invited_role: "staff",
  invited_full_name: "Jane Doe",
  invited_phone: null,
  invited_employment_type: null,
  invited_hourly_pay: null,
  invited_emergency_contact: null,
  source: "staff_invite",
};

const baseArgs = {
  email: "jane@x.test",
  fullName: "Jane Doe",
  orgName: "Acme Builders",
  metadata,
};

// The hashed one-time token generateLink returns in `properties.hashed_token`.
// sendStaffInvite builds the embedded link as {appUrl}/auth/callback?token_hash=
// <this>&type=magiclink (see lib/auth/magic-link.ts) — NOT the GoTrue-hosted
// action_link, which would land the session in a URL hash fragment the server
// callback can't read. Hex so URL-encoding is a no-op in the assertions.
const HASHED_TOKEN = "fb9202308f44aabbccddeeff00112233445566778899aabbccddeeff";
// The action_link is DELIBERATELY present in the mock but must NOT be embedded
// (regression guard: we stopped trusting it).
const GOTRUE_ACTION_LINK =
  "http://127.0.0.1:54321/auth/v1/verify?token=raw&type=magiclink&redirect_to=x";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createUserMock.mockReset();
  listUsersMock.mockReset();
  updateUserByIdMock.mockReset();
  generateLinkMock.mockReset();
  sendEmailMock.mockReset();

  // Happy-path defaults; individual tests override.
  createUserMock.mockResolvedValue({ data: { user: { id: "new-1" } }, error: null });
  generateLinkMock.mockResolvedValue({
    data: { properties: { hashed_token: HASHED_TOKEN, action_link: GOTRUE_ACTION_LINK } },
    error: null,
  });
  sendEmailMock.mockResolvedValue({ sent: true, id: "resend-1" });

  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("sendStaffInvite — success", () => {
  it("creates the user, generates a link, emails it, and reports ok:true", async () => {
    const res = await sendStaffInvite(baseArgs);

    expect(res).toEqual({ ok: true, alreadyExisted: false, hadMagicLink: true });

    // createUser carries the invite metadata, no email_confirm.
    expect(createUserMock).toHaveBeenCalledTimes(1);
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "jane@x.test", app_metadata: metadata }),
    );
    const createArg = createUserMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(createArg?.email_confirm).toBeUndefined();

    // The branded email goes out via Resend with a link at OUR /auth/callback
    // carrying token_hash + type (the verifyOtp shape) — NOT the GoTrue hosted
    // action_link (which would deliver the session in a hash fragment the
    // server callback can't read).
    // The text body carries the link verbatim; the HTML href attr-escapes `&`
    // to `&amp;` (both are the SAME /auth/callback?token_hash=…&type=… link).
    const expectedTextLink = `/auth/callback?token_hash=${HASHED_TOKEN}&type=magiclink`;
    const expectedHtmlLink = `/auth/callback?token_hash=${HASHED_TOKEN}&amp;type=magiclink`;
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "jane@x.test",
        subject: expect.stringContaining("Acme Builders"),
        html: expect.stringContaining(expectedHtmlLink),
        text: expect.stringContaining(expectedTextLink),
      }),
    );
    // Regression: the raw GoTrue action_link must never be embedded.
    const emailArg = sendEmailMock.mock.calls[0]?.[0] as { html?: string; text?: string };
    expect(emailArg?.html).not.toContain(GOTRUE_ACTION_LINK);
    expect(emailArg?.text).not.toContain(GOTRUE_ACTION_LINK);

    // No existing-user fixups on the brand-new path.
    expect(listUsersMock).not.toHaveBeenCalled();
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });
});

describe("sendStaffInvite — failed Supabase createUser", () => {
  it("returns ok:false with the Supabase reason and sends NO email", async () => {
    createUserMock.mockResolvedValue({
      data: { user: null },
      error: { message: "service unavailable", status: 503 },
    });

    const res = await sendStaffInvite(baseArgs);

    expect(res).toEqual({ ok: false, reason: "service unavailable" });
    // Hard failure must short-circuit — never generate a link or email.
    expect(generateLinkMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("sendStaffInvite — failed email send (no false success)", () => {
  it("returns ok:false when Resend rejects, even though the user was created", async () => {
    sendEmailMock.mockResolvedValue({ sent: false, reason: "error", error: "resend down" });

    const res = await sendStaffInvite(baseArgs);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error: resend down");
    // The user got created/linked, but a failed email must NOT report success.
    expect(createUserMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the no_key reason when Resend is unconfigured", async () => {
    sendEmailMock.mockResolvedValue({ sent: false, reason: "no_key" });

    const res = await sendStaffInvite(baseArgs);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_key");
  });
});

describe("sendStaffInvite — idempotent already-exists path", () => {
  it("refreshes metadata on the existing user and re-sends (alreadyExisted:true)", async () => {
    createUserMock.mockResolvedValue({
      data: { user: null },
      error: { message: "A user with this email has already been registered", status: 422 },
    });
    listUsersMock.mockResolvedValue({
      data: { users: [{ id: "existing-9", email: "JANE@x.test" }] },
      error: null,
    });
    updateUserByIdMock.mockResolvedValue({ data: { user: { id: "existing-9" } }, error: null });

    const res = await sendStaffInvite(baseArgs);

    expect(res).toEqual({ ok: true, alreadyExisted: true, hadMagicLink: true });
    // Metadata is refreshed on the matched existing user (case-insensitive).
    expect(updateUserByIdMock).toHaveBeenCalledTimes(1);
    expect(updateUserByIdMock).toHaveBeenCalledWith("existing-9", { app_metadata: metadata });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false when the already-exists user can't be found in the list", async () => {
    createUserMock.mockResolvedValue({
      data: { user: null },
      error: { message: "already registered", status: 422 },
    });
    listUsersMock.mockResolvedValue({ data: { users: [] }, error: null });

    const res = await sendStaffInvite(baseArgs);

    expect(res.ok).toBe(false);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns ok:false when updateUserById fails", async () => {
    createUserMock.mockResolvedValue({
      data: { user: null },
      error: { message: "already registered", status: 422 },
    });
    listUsersMock.mockResolvedValue({
      data: { users: [{ id: "existing-9", email: "jane@x.test" }] },
      error: null,
    });
    updateUserByIdMock.mockResolvedValue({ data: null, error: { message: "update blew up" } });

    const res = await sendStaffInvite(baseArgs);

    expect(res).toEqual({ ok: false, reason: "update blew up" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("sendStaffInvite — generateLink is non-fatal", () => {
  it("still emails (with /login fallback) and reports hadMagicLink:false", async () => {
    generateLinkMock.mockResolvedValue({ data: null, error: { message: "link gen failed" } });

    const res = await sendStaffInvite(baseArgs);

    expect(res).toEqual({ ok: true, alreadyExisted: false, hadMagicLink: false });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // Fallback email points at /login and does NOT contain a (missing) link.
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining("/login") }),
    );
    const emailArg = sendEmailMock.mock.calls[0]?.[0] as { html?: string } | undefined;
    expect(emailArg?.html).not.toContain("/auth/callback?token_hash=");
  });

  it("treats a success with NO hashed_token as hadMagicLink:false (defensive)", async () => {
    // generateLink can succeed yet omit hashed_token; we must not embed a
    // broken link — fall back to the /login recovery copy.
    generateLinkMock.mockResolvedValue({
      data: { properties: { action_link: GOTRUE_ACTION_LINK } },
      error: null,
    });

    const res = await sendStaffInvite(baseArgs);

    expect(res).toEqual({ ok: true, alreadyExisted: false, hadMagicLink: false });
    const emailArg = sendEmailMock.mock.calls[0]?.[0] as { html?: string } | undefined;
    expect(emailArg?.html).toContain("/login");
    expect(emailArg?.html).not.toContain(GOTRUE_ACTION_LINK);
    expect(emailArg?.html).not.toContain("/auth/callback?token_hash=");
  });
});
