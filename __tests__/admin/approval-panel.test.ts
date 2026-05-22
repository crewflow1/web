import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CEO approval-panel contract tests.
 *
 *   1. Super-admin can approve an org → status flips to trial,
 *      trial_ends_at set ~14 days out, owner is emailed.
 *   2. Super-admin can reject an org → status=rejected, rejection_reason
 *      captured, owner emailed.
 *   3. Super-admin can suspend an org → status=suspended, suspended_at
 *      stamped, owner emailed.
 *   4. Normal (non-allowlisted) user cannot reach the panel — both the
 *      org status action and the demo-request action bounce them to
 *      /dashboard via redirect (404-equivalent for the route's
 *      existence).
 *
 * Mocks Supabase admin + sendEmail. The redirect helper is stubbed so
 * we can assert it was called with the right path.
 */

// ---------- Supabase admin mock --------------------------------------

type QueueEntry = { data: unknown; error: unknown };

function makeMockSupabase() {
  const insertQ: QueueEntry[] = [];
  const updateQ: QueueEntry[] = [];
  const maybeSingleQ: QueueEntry[] = [];
  const rpcQ: QueueEntry[] = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown; where: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  const passthrough = new Set([
    "select",
    "eq",
    "in",
    "is",
    "not",
    "lt",
    "lte",
    "gt",
    "gte",
    "order",
    "limit",
    "match",
  ]);

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const whereClause: Record<string, unknown> = {};
    for (const m of passthrough) {
      if (m === "eq") {
        chain[m] = (col: string, val: unknown) => {
          whereClause[col] = val;
          return chain;
        };
      } else {
        chain[m] = () => chain;
      }
    }
    chain.maybeSingle = async () =>
      maybeSingleQ.shift() ?? { data: null, error: null };
    chain.insert = (payload: unknown) => {
      inserts.push({ table, payload });
      const ic: Record<string, unknown> = {
        select: () => ic,
        single: async () =>
          insertQ.shift() ?? { data: null, error: null },
      };
      Object.defineProperty(ic, "then", {
        value: (resolve: (v: QueueEntry) => unknown) =>
          resolve(insertQ.shift() ?? { data: null, error: null }),
      });
      return ic;
    };
    chain.update = (payload: unknown) => {
      const uc: Record<string, unknown> = {
        eq: (col: string, val: unknown) => {
          updates.push({ table, payload, where: { [col]: val } });
          const settled = updateQ.shift() ?? { data: null, error: null };
          const inner: Record<string, unknown> = {};
          Object.defineProperty(inner, "then", {
            value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
          });
          return inner;
        },
      };
      return uc;
    };
    return chain;
  }

  return {
    client: {
      from: (table: string) => makeChain(table),
      rpc: async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return rpcQ.shift() ?? { data: null, error: null };
      },
    },
    inserts,
    updates,
    rpcCalls,
    enqueueMaybeSingle: (e: QueueEntry) => maybeSingleQ.push(e),
    enqueueInsert: (e: QueueEntry) => insertQ.push(e),
    enqueueUpdate: (e: QueueEntry) => updateQ.push(e),
    enqueueRpc: (e: QueueEntry) => rpcQ.push(e),
  };
}

const mockAdmin = makeMockSupabase();

// ---------- Module mocks ---------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockAdmin.client,
}));

const sendEmailMock = vi.fn();
vi.mock("@/lib/email/send", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const redirectMock = vi.fn((path: string) => {
  // Mirror Next.js's real redirect by throwing — actions stop executing.
  throw new Error(`REDIRECT:${path}`);
});

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

const requireUserMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  requireUser: requireUserMock,
}));

const isSuperAdminEmailMock = vi.fn();
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: isSuperAdminEmailMock,
}));

// Late import so all module-level mocks are applied first.
async function loadActions() {
  return await import("@/app/admin/actions");
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  mockAdmin.inserts.length = 0;
  mockAdmin.updates.length = 0;
  mockAdmin.rpcCalls.length = 0;
  sendEmailMock.mockReset();
  redirectMock.mockClear();
  requireUserMock.mockReset();
  isSuperAdminEmailMock.mockReset();
});

// ---------- Tests ----------------------------------------------------

describe("scenario 1 — super admin can approve (start 14-day trial)", () => {
  it("setOrganizationStatus(trial) updates the row and emails the owner", async () => {
    requireUserMock.mockResolvedValue({ id: "admin-1", email: "ceo@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);

    // organizations.update settles + owner lookup returns email + email sends.
    mockAdmin.enqueueUpdate({ data: null, error: null });
    mockAdmin.enqueueMaybeSingle({
      data: { user: { email: "owner@acme.test", full_name: "Owner Person" } },
      error: null,
    });
    sendEmailMock.mockResolvedValue({ sent: true, id: "email-1" });

    const { setOrganizationStatus } = await loadActions();
    await expect(
      setOrganizationStatus(
        makeFormData({
          org_id: "00000000-0000-0000-0000-000000000001",
          status: "trial",
        }),
      ),
    ).rejects.toThrow(/REDIRECT:\/admin\/organizations\?saved=trial/);

    // organizations row was updated to trial with trial_ends_at populated.
    const orgUpdate = mockAdmin.updates.find((u) => u.table === "organizations");
    expect(orgUpdate).toBeTruthy();
    const payload = orgUpdate?.payload as {
      status: string;
      trial_ends_at: string | null;
      approved_at: string | null;
      approved_by: string | null;
    };
    expect(payload.status).toBe("trial");
    expect(payload.approved_at).toBeTruthy();
    expect(payload.approved_by).toBe("admin-1");
    expect(payload.trial_ends_at).toBeTruthy();
    const daysOut =
      (new Date(payload.trial_ends_at!).getTime() - Date.now()) /
      86_400_000;
    expect(daysOut).toBeGreaterThan(13);
    expect(daysOut).toBeLessThanOrEqual(14.01);

    // Audit log + owner email.
    expect(
      mockAdmin.rpcCalls.find((r) => r.fn === "_record_activity"),
    ).toBeTruthy();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]?.[0] as { to: string; from: string };
    expect(args.to).toBe("owner@acme.test");
    expect(args.from.toLowerCase()).toContain("notify@crewflow.uk");
  });
});

describe("scenario 2 — super admin can reject", () => {
  it("setOrganizationStatus(rejected) writes rejection_reason and emails the owner", async () => {
    requireUserMock.mockResolvedValue({ id: "admin-2", email: "ceo@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);

    mockAdmin.enqueueUpdate({ data: null, error: null });
    mockAdmin.enqueueMaybeSingle({
      data: { user: { email: "owner2@acme.test", full_name: null } },
      error: null,
    });
    sendEmailMock.mockResolvedValue({ sent: true, id: "email-2" });

    const { setOrganizationStatus } = await loadActions();
    await expect(
      setOrganizationStatus(
        makeFormData({
          org_id: "00000000-0000-0000-0000-000000000002",
          status: "rejected",
          reason: "Looks like a personal account, not a business.",
        }),
      ),
    ).rejects.toThrow(/REDIRECT:\/admin\/organizations\?saved=rejected/);

    const orgUpdate = mockAdmin.updates.find((u) => u.table === "organizations");
    const payload = orgUpdate?.payload as {
      status: string;
      rejection_reason: string | null;
    };
    expect(payload.status).toBe("rejected");
    expect(payload.rejection_reason).toBe(
      "Looks like a personal account, not a business.",
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("scenario 3 — super admin can suspend", () => {
  it("setOrganizationStatus(suspended) stamps suspended_at and emails the owner", async () => {
    requireUserMock.mockResolvedValue({ id: "admin-3", email: "ceo@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);

    mockAdmin.enqueueUpdate({ data: null, error: null });
    mockAdmin.enqueueMaybeSingle({
      data: { user: { email: "owner3@acme.test", full_name: "Three" } },
      error: null,
    });
    sendEmailMock.mockResolvedValue({ sent: true, id: "email-3" });

    const { setOrganizationStatus } = await loadActions();
    await expect(
      setOrganizationStatus(
        makeFormData({
          org_id: "00000000-0000-0000-0000-000000000003",
          status: "suspended",
        }),
      ),
    ).rejects.toThrow(/REDIRECT:\/admin\/organizations\?saved=suspended/);

    const orgUpdate = mockAdmin.updates.find((u) => u.table === "organizations");
    const payload = orgUpdate?.payload as {
      status: string;
      suspended_at: string | null;
    };
    expect(payload.status).toBe("suspended");
    expect(payload.suspended_at).toBeTruthy();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("scenario 4 — non-allowlisted user cannot reach the panel actions", () => {
  it("setOrganizationStatus bounces to /dashboard without writing", async () => {
    requireUserMock.mockResolvedValue({ id: "user-9", email: "staff@elsewhere.test" });
    isSuperAdminEmailMock.mockReturnValue(false);

    const { setOrganizationStatus } = await loadActions();
    await expect(
      setOrganizationStatus(
        makeFormData({
          org_id: "00000000-0000-0000-0000-000000000099",
          status: "trial",
        }),
      ),
    ).rejects.toThrow(/REDIRECT:\/dashboard/);

    // No update, no email, no rpc.
    expect(mockAdmin.updates).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(mockAdmin.rpcCalls).toHaveLength(0);
  });

  it("setDemoRequestStatus bounces non-admins too", async () => {
    requireUserMock.mockResolvedValue({ id: "user-9", email: "staff@elsewhere.test" });
    isSuperAdminEmailMock.mockReturnValue(false);

    const { setDemoRequestStatus } = await loadActions();
    await expect(
      setDemoRequestStatus(
        makeFormData({
          demo_id: "00000000-0000-0000-0000-000000000099",
          status: "approved",
        }),
      ),
    ).rejects.toThrow(/REDIRECT:\/dashboard/);

    expect(mockAdmin.updates).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("scenario 5 — super admin can approve a demo_request", () => {
  it("setDemoRequestStatus(approved) flips the row + emails the prospect with sign-in CTA", async () => {
    requireUserMock.mockResolvedValue({ id: "admin-4", email: "ceo@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);

    // The action reads the demo row first (for email/name), then updates,
    // then RPCs, then emails.
    mockAdmin.enqueueMaybeSingle({
      data: {
        id: "demo-1",
        name: "Sarah Builder",
        email: "sarah@build.example",
        company: "Sarah Build Ltd",
        status: "pending_demo",
      },
      error: null,
    });
    mockAdmin.enqueueUpdate({ data: null, error: null });
    sendEmailMock.mockResolvedValue({ sent: true, id: "demo-email" });

    const { setDemoRequestStatus } = await loadActions();
    await expect(
      setDemoRequestStatus(
        makeFormData({
          demo_id: "00000000-0000-0000-0000-0000000000d1",
          status: "approved",
        }),
      ),
    ).rejects.toThrow(/REDIRECT:\/admin\/organizations\?saved=demo_approved/);

    // demo_requests update was applied with approved_at + reviewed_by.
    const upd = mockAdmin.updates.find((u) => u.table === "demo_requests");
    const payload = upd?.payload as {
      status: string;
      approved_at: string | null;
      reviewed_by: string | null;
    };
    expect(payload.status).toBe("approved");
    expect(payload.approved_at).toBeTruthy();
    expect(payload.reviewed_by).toBe("admin-4");

    // Prospect email sent with the "sign in" CTA.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(emailArgs.to).toBe("sarah@build.example");
    expect(emailArgs.subject.toLowerCase()).toContain("approved");
    expect(emailArgs.html).toMatch(/Sign in/i);
  });
});
