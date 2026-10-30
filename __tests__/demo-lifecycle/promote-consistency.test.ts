import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DemoRow } from "@/server/services/demo-lifecycle";

/**
 * Behavioural consistency coverage for promoteDemoToCustomer — the HQ
 * demo → customer provisioning step (the "move to onboarding" blocker).
 *
 * The existing demo-lifecycle suite pins provisioning behaviour at two
 * levels: the invite-recovery test executes the auth-recovery branches,
 * and contract.test.ts asserts the ordering/rollback *in source* via
 * regex. What was NOT executed end-to-end:
 *
 *   1. the idempotency early-return (a demo that already has a linked org
 *      must perform ZERO side effects — no auth user, no table writes);
 *   2. the org rollback when membership creation fails (no orphan org);
 *   3. the behaviour when the final linked_org_id stamp fails — which is
 *      the one window where a re-promote could double-provision. This
 *      test pins the current behaviour and documents the gap.
 *
 * Additive only — no product code changed.
 */

// --- Mocks (hoisted; factories run lazily at the import() below) ---------
const createUserMock = vi.fn();
const listUsersMock = vi.fn();
const generateLinkMock = vi.fn();

// Per-test overridable outcomes for the table writes promote performs.
type FromOutcomes = {
  usersUpsertError: { message: string } | null;
  orgInsert: { data: { id: string } | null; error: { message: string } | null };
  membershipInsert: {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  demoUpdateError: { message: string } | null;
};
let outcomes: FromOutcomes;

// Records of the destructive / linking writes so tests can assert them.
const orgDeletes: string[] = [];
const demoUpdates: Array<Record<string, unknown>> = [];

const fromMock = vi.fn((table: string) => ({
  upsert: async () => ({ error: outcomes.usersUpsertError }),
  insert: (_payload: unknown) => ({
    select: () => ({
      single: async () =>
        table === "organizations"
          ? outcomes.orgInsert
          : outcomes.membershipInsert,
    }),
  }),
  update: (payload: Record<string, unknown>) => ({
    eq: async (_k: string, _v: unknown) => {
      if (table === "demo_requests") demoUpdates.push(payload);
      return { error: table === "demo_requests" ? outcomes.demoUpdateError : null };
    },
  }),
  delete: () => ({
    eq: async (_k: string, v: unknown) => {
      if (table === "organizations") orgDeletes.push(String(v));
      return { error: null };
    },
  }),
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

const baseDemo: DemoRow = {
  id: "demo-1",
  name: "Jane Doe",
  email: "jane@x.test",
  company: "Acme Builders",
  phone: null,
  status: "payment_received",
  linked_org_id: null,
};
const actor = { id: "hq-1", email: "ops@crewflow.uk" };

beforeEach(() => {
  createUserMock.mockReset();
  listUsersMock.mockReset();
  generateLinkMock.mockReset();
  sendEmailMock.mockReset();
  recordAdminActivityMock.mockReset();
  fromMock.mockClear();
  orgDeletes.length = 0;
  demoUpdates.length = 0;

  // Happy-path defaults; individual tests override.
  createUserMock.mockResolvedValue({ data: { user: { id: "new-7" } }, error: null });
  generateLinkMock.mockResolvedValue({
    data: { properties: { action_link: "https://link.example/verify-abc" } },
    error: null,
  });
  sendEmailMock.mockResolvedValue({ sent: true, id: "resend-1" });
  recordAdminActivityMock.mockResolvedValue(undefined);

  outcomes = {
    usersUpsertError: null,
    orgInsert: { data: { id: "org-1" }, error: null },
    membershipInsert: { data: { id: "mem-1" }, error: null },
    demoUpdateError: null,
  };
});

describe("promoteDemoToCustomer — idempotency (already-linked demo)", () => {
  it("performs ZERO side effects when the demo already has a linked org", async () => {
    const res = await promoteDemoToCustomer({
      demo: { ...baseDemo, linked_org_id: "org-existing" },
      actor,
    });

    expect(res.ok).toBe(true);
    expect(res.done).toEqual(["already_provisioned"]);
    expect(res.meta?.org_id).toBe("org-existing");

    // The guarantee: a double-click / re-drag of an onboarded demo never
    // mints a second auth user, org, membership, or email.
    expect(createUserMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("promoteDemoToCustomer — rollback on membership failure (no orphan org)", () => {
  it("deletes the just-created org when membership insert fails, and halts", async () => {
    outcomes.membershipInsert = {
      data: null,
      error: { message: "memberships insert boom" },
    };

    const res = await promoteDemoToCustomer({ demo: baseDemo, actor });

    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(
      expect.arrayContaining([
        { step: "membership_create", reason: "memberships insert boom" },
      ]),
    );
    // The org that was created a step earlier must be rolled back so HQ
    // doesn't accumulate empty orphan orgs on each failed retry.
    expect(res.done).toContain("org_created");
    expect(orgDeletes).toEqual(["org-1"]);
    // linked_org_id is never stamped on a failed provision → a retry is
    // not short-circuited by the idempotency guard.
    expect(demoUpdates).toEqual([]);
  });

  it("creates no org at all when auth user creation fails", async () => {
    createUserMock.mockResolvedValue({
      data: { user: null },
      error: { message: "Database error creating new user" },
    });

    const res = await promoteDemoToCustomer({ demo: baseDemo, actor });

    expect(res.ok).toBe(false);
    expect(res.failed[0]?.step).toBe("auth_create_user");
    // Halted before any table write — no org, no membership, no link.
    expect(fromMock).not.toHaveBeenCalled();
    expect(orgDeletes).toEqual([]);
  });
});

describe("promoteDemoToCustomer — linked_org_id stamp failure (documented edge)", () => {
  // KNOWN NARROW GAP (flagged for product): org + membership are created,
  // but the final single-row UPDATE that stamps demo.linked_org_id fails.
  // promote treats this as NON-FATAL and returns ok:true, so the caller
  // flips the demo to active_onboarding WITHOUT a persisted linked_org_id.
  // Because the idempotency guard keys solely on linked_org_id, a
  // subsequent "move to onboarding" on the same demo would NOT short-
  // circuit and would mint a SECOND org + membership for the same user.
  //
  // Trigger is extremely narrow (a PK-keyed UPDATE failing immediately
  // after four successful writes on the same service-role connection), so
  // this is characterised rather than fixed; see the report for the
  // product decision (re-stamp from meta.org_id, or key idempotency on an
  // owner-membership lookup as a second line of defence).
  it("returns ok:true but leaves linked_org_id unpersisted (the re-promote window)", async () => {
    outcomes.demoUpdateError = { message: "update linked_org_id failed" };

    const res = await promoteDemoToCustomer({ demo: baseDemo, actor });

    expect(res.ok).toBe(true);
    expect(res.done).toContain("org_created");
    expect(res.done).toContain("membership_created");
    expect(res.done).not.toContain("demo_linked");
    expect(res.failed).toEqual(
      expect.arrayContaining([
        { step: "demo_link", reason: "update linked_org_id failed" },
      ]),
    );
    // The org was NOT rolled back (it is a real, usable workspace) — this
    // is what makes an unguarded re-promote able to double-provision.
    expect(orgDeletes).toEqual([]);
    expect(res.meta?.org_id).toBe("org-1");
  });
});
