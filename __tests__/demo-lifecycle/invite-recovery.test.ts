import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DemoRow } from "@/server/services/demo-lifecycle";

/**
 * Regression coverage for promoteDemoToCustomer's idempotent invite
 * recovery (loud-read-failures audit finding).
 *
 * The deployed bug: when createUser said "already registered", recovery
 * called auth.admin.listUsers() BARE. listUsers is paginated (50/page by
 * default), so once the auth base outgrew one page an existing account
 * beyond page 1 was invisible — recovery found nothing, and the flow
 * reported an auth_create_user failure for a perfectly recoverable
 * account instead of provisioning it.
 *
 * The fix routes recovery through findAuthUserByEmail, which walks every
 * page via the API's nextPage cursor. These tests pin:
 *   - an existing user BEYOND page 1 is recovered and fully provisioned;
 *   - a lookup transport failure is surfaced as its own loud
 *     auth_user_lookup step, never a silent "not found";
 *   - a genuinely unknown email still fails as auth_create_user;
 *   - the fresh-create path never touches listUsers.
 */

// --- Mocks (hoisted; factories run lazily at the import() below) ---------
const createUserMock = vi.fn();
const listUsersMock = vi.fn();
const generateLinkMock = vi.fn();

const fromMock = vi.fn((table: string) => ({
  upsert: async () => ({ error: null }),
  insert: () => ({
    select: () => ({
      single: async () =>
        table === "organizations"
          ? { data: { id: "org-1" }, error: null }
          : { data: { id: "mem-1" }, error: null },
    }),
  }),
  update: () => ({ eq: async () => ({ error: null }) }),
  delete: () => ({ eq: async () => ({ error: null }) }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        createUser: createUserMock,
        listUsers: listUsersMock,
        generateLink: generateLinkMock,
      },
    },
    from: fromMock,
  }),
}));

const sendEmailMock = vi.fn();
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock }));

const recordAdminActivityMock = vi.fn();
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: recordAdminActivityMock,
}));

// Imported at demo-lifecycle module top; not used by promote, mocked so the
// test never loads the Stripe SDK.
vi.mock("@/lib/stripe/demo-checkout", () => ({
  createOrReuseDemoSetupCheckout: vi.fn(),
}));

const { promoteDemoToCustomer } = await import("@/server/services/demo-lifecycle");

const demo: DemoRow = {
  id: "demo-1",
  name: "Jane Doe",
  email: "jane@x.test",
  company: "Acme Builders",
  phone: null,
  status: "payment_received",
  linked_org_id: null,
};

const actor = { id: "hq-1", email: "ops@crewflow.uk" };

const ALREADY_REGISTERED = {
  data: { user: null },
  error: { message: "A user with this email address has already been registered", status: 422 },
};

/** One auth-js-shaped listUsers page. */
const page = (users: Array<{ id: string; email?: string }>, nextPage: number | null) => ({
  data: { users, aud: "authenticated", nextPage, lastPage: 2, total: 1002 },
  error: null,
});

beforeEach(() => {
  createUserMock.mockReset();
  listUsersMock.mockReset();
  generateLinkMock.mockReset();
  sendEmailMock.mockReset();
  recordAdminActivityMock.mockReset();
  fromMock.mockClear();

  // Happy-path defaults; individual tests override.
  createUserMock.mockResolvedValue({ data: { user: { id: "new-7" } }, error: null });
  generateLinkMock.mockResolvedValue({
    data: { properties: { action_link: "https://link.example/verify-abc" } },
    error: null,
  });
  sendEmailMock.mockResolvedValue({ sent: true, id: "resend-1" });
  recordAdminActivityMock.mockResolvedValue(undefined);
});

describe("promoteDemoToCustomer — invite recovery finds users beyond page 1", () => {
  it("recovers an existing auth user on page 2 and provisions the org (the regression)", async () => {
    createUserMock.mockResolvedValue(ALREADY_REGISTERED);
    listUsersMock.mockImplementation(async ({ page: p }: { page: number }) =>
      p === 1
        ? page(
            [
              { id: "u-other-1", email: "other1@x.test" },
              { id: "u-other-2", email: "other2@x.test" },
            ],
            2,
          )
        : // Stored casing differs — the match must be case-insensitive.
          page([{ id: "existing-42", email: "JANE@x.test" }], null),
    );

    const res = await promoteDemoToCustomer({ demo, actor });

    expect(res.ok).toBe(true);
    expect(res.done).toContain("auth_user_already_existed");
    expect(res.done).not.toContain("auth_user_created");
    expect(res.meta?.auth_user_id).toBe("existing-42");

    // The lookup paged past page 1 instead of giving up on the first slice.
    expect(listUsersMock).toHaveBeenCalledTimes(2);
    expect(listUsersMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2 }),
    );

    // Recovery is audited, then provisioning continues to completion.
    expect(recordAdminActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "demo.invite_skipped",
        metadata: expect.objectContaining({ auth_user_id: "existing-42" }),
      }),
    );
    expect(res.done).toEqual(
      expect.arrayContaining(["org_created", "membership_created", "email_welcome"]),
    );
    expect(res.failed).toEqual([]);
  });

  it("surfaces a lookup transport failure as auth_user_lookup — not a bogus 'create failed'", async () => {
    createUserMock.mockResolvedValue(ALREADY_REGISTERED);
    listUsersMock.mockResolvedValue({
      data: { users: [] },
      error: { message: "auth API 500" },
    });

    const res = await promoteDemoToCustomer({ demo, actor });

    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(
      expect.arrayContaining([
        { step: "auth_user_lookup", reason: "auth API 500" },
        expect.objectContaining({ step: "auth_create_user" }),
      ]),
    );
    // No half-provisioned tenant: the flow halted before any table writes.
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("still fails as auth_create_user when the email truly has no account", async () => {
    createUserMock.mockResolvedValue(ALREADY_REGISTERED);
    listUsersMock.mockResolvedValue(page([{ id: "u-other-1", email: "other1@x.test" }], null));

    const res = await promoteDemoToCustomer({ demo, actor });

    expect(res.ok).toBe(false);
    expect(res.failed).toEqual([
      expect.objectContaining({
        step: "auth_create_user",
        reason: ALREADY_REGISTERED.error.message,
      }),
    ]);
    expect(res.failed.map((f) => f.step)).not.toContain("auth_user_lookup");
  });

  it("never calls listUsers on the fresh-create path", async () => {
    const res = await promoteDemoToCustomer({ demo, actor });

    expect(res.ok).toBe(true);
    expect(res.done).toContain("auth_user_created");
    expect(res.meta?.auth_user_id).toBe("new-7");
    expect(listUsersMock).not.toHaveBeenCalled();
  });
});
