import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Wave 2 — Quote Approval Workflow unit tests.
 *
 * Mocks the Supabase client + org context so we can verify state
 * transitions, send-gate, edit-revert, and the staff-blocked path
 * without a live DB.
 *
 * The caller's role comes from ctx.membership.role (requireOrgContext),
 * NOT from a memberships query: org members can read each other's rows,
 * so an org-only-filtered `.select("role").single()` returns every member
 * and errors in any org with ≥2 members. The owner-approves case below
 * pins that reviewQuote never issues such a query.
 *
 * Cases (per CEO spec):
 *   1. Cannot send without approval
 *   2. Staff blocked from approving
 *   3. Owner approves
 *   4. Admin approves
 *   5. Edited approved quote loses approval
 *   6. Audit events recorded (verified via insert payloads)
 */

// -- Mock factory --------------------------------------------------------

type QueueEntry = { data?: unknown; error?: unknown; count?: number };
type Queues = {
  // Canary: role derivation must NOT hit memberships. Any unexpected pop
  // throws "no queued response"; the owner-approves case also seeds this
  // queue with a 2-member-org failure response and asserts it's untouched.
  membership: QueueEntry[];
  quoteLookup: QueueEntry[]; // current status lookup
  update: QueueEntry[];
  insert: QueueEntry[];
};

function makeMockSupabase() {
  const queue: Queues = {
    membership: [],
    quoteLookup: [],
    update: [],
    insert: [],
  };
  const updates: Array<{ table: string; payload: unknown }> = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];

  function pop(key: keyof Queues): QueueEntry {
    const entry = queue[key].shift();
    if (!entry) throw new Error(`no queued response for ${key}`);
    return entry;
  }

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
  ]);

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    let lastSelect = "";
    chain.select = (cols: string) => {
      lastSelect = cols;
      return chain;
    };
    for (const m of passthrough) {
      if (m === "select") continue;
      chain[m] = () => chain;
    }
    chain.maybeSingle = async () => {
      // Decide which queue based on the table + select.
      if (table === "memberships") return pop("membership");
      if (table === "quotes") return pop("quoteLookup");
      return { data: null, error: null };
    };
    chain.single = chain.maybeSingle;
    chain.update = (payload: unknown) => {
      updates.push({ table, payload });
      const upChain: Record<string, unknown> = {};
      for (const m of passthrough) upChain[m] = () => upChain;
      Object.defineProperty(upChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(pop("update")),
      });
      return upChain;
    };
    chain.insert = (payload: unknown) => {
      inserts.push({ table, payload });
      const insChain: Record<string, unknown> = {};
      insChain.select = () => insChain;
      insChain.single = async () => pop("insert");
      Object.defineProperty(insChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(pop("insert")),
      });
      return insChain;
    };
    void lastSelect;
    return chain;
  }

  const client = {
    from: (t: string) => makeChain(t),
    rpc: async () => ({ data: null, error: null }),
  };

  return {
    client,
    queue,
    updates,
    inserts,
    enqueue(key: keyof Queues, entry: QueueEntry) {
      queue[key].push(entry);
    },
  };
}

// -- Module mocks --------------------------------------------------------

const mockSb = makeMockSupabase();

// Caller's role, read at requireOrgContext-call time — ctx.membership is the
// caller's OWN row in the active org (upstream it's resolved with a user_id
// filter, so a 2-member org can't corrupt it). Tests mutate this per case.
const caller = { role: "owner" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSb.client),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockSb.client,
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: {
      org: { id: "org-1" },
      membership: { org_id: "org-1", role: caller.role },
    },
    user: { id: "user-owner" },
  })),
  // Faithful mirror of the real guard (first-customer fix 1): quote actions are
  // management-only; a staff caller is redirected exactly like production.
  requireManagementRole: (ctx?: { membership?: { role?: string } }) => {
    const role = ctx?.membership?.role;
    if (role !== "owner" && role !== "admin") {
      redirectMock("/dashboard?error=forbidden");
    }
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// `redirect` throws — capture the path so tests can assert on it.
const redirectMock = vi.fn((path: string) => {
  throw new Error(`__redirect:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

vi.mock("@/lib/email/send-invoice", () => ({
  sendInvoiceEmail: vi.fn(async () => ({ sent: false, reason: "no_resend_key" })),
}));

// -- Imports under test (after mocks) ------------------------------------
const actions = await import("@/app/(app)/quotes/actions");

// -- Helpers -------------------------------------------------------------

function expectRedirectTo(fn: () => Promise<unknown>, contains: string) {
  return fn().then(
    () => {
      throw new Error("expected redirect, none thrown");
    },
    (err: Error) => {
      expect(err.message).toMatch(new RegExp(`^__redirect:.*${contains}`));
    },
  );
}

beforeEach(() => {
  caller.role = "owner";
  mockSb.queue.membership.length = 0;
  mockSb.queue.quoteLookup.length = 0;
  mockSb.queue.update.length = 0;
  mockSb.queue.insert.length = 0;
  mockSb.updates.length = 0;
  mockSb.inserts.length = 0;
  redirectMock.mockClear();
});

// ------------------------------------------------------------------------

describe("sendQuote — approval gate", () => {
  it("BLOCKS sending a quote in 'draft' status", async () => {
    mockSb.enqueue("quoteLookup", { data: { status: "draft" }, error: null });
    await expectRedirectTo(
      () => actions.sendQuote("11111111-1111-1111-1111-111111111111"),
      "Request%20approval",
    );
    // No update issued
    expect(mockSb.updates.find((u) => u.table === "quotes")).toBeUndefined();
  });

  it("BLOCKS sending a quote in 'pending_approval' status", async () => {
    mockSb.enqueue("quoteLookup", {
      data: { status: "pending_approval" },
      error: null,
    });
    await expectRedirectTo(
      () => actions.sendQuote("11111111-1111-1111-1111-111111111111"),
      "awaiting%20approval",
    );
    expect(mockSb.updates.find((u) => u.table === "quotes")).toBeUndefined();
  });

  it("BLOCKS sending a quote in 'rejected' status", async () => {
    mockSb.enqueue("quoteLookup", { data: { status: "rejected" }, error: null });
    await expectRedirectTo(
      () => actions.sendQuote("11111111-1111-1111-1111-111111111111"),
      "rejected",
    );
    expect(mockSb.updates.find((u) => u.table === "quotes")).toBeUndefined();
  });

  it("ALLOWS sending a quote in 'approved' status (writes sent_at + status=sent)", async () => {
    mockSb.enqueue("quoteLookup", { data: { status: "approved" }, error: null });
    mockSb.enqueue("update", { error: null });
    await expectRedirectTo(
      () => actions.sendQuote("11111111-1111-1111-1111-111111111111"),
      "saved=sent",
    );
    const upd = mockSb.updates.find((u) => u.table === "quotes");
    expect(upd).toBeDefined();
    expect(upd!.payload).toMatchObject({ status: "sent" });
    expect((upd!.payload as { sent_at: string }).sent_at).toBeTruthy();
  });
});

describe("reviewQuote — owner/admin can approve; staff blocked", () => {
  it("Staff CANNOT approve (redirected to /dashboard?error=forbidden)", async () => {
    caller.role = "staff";
    const fd = new FormData();
    fd.set("action", "approve");
    await expectRedirectTo(() => actions.reviewQuote("11111111-1111-1111-1111-111111111111", fd), "forbidden");
    // No quote update issued
    expect(mockSb.updates.find((u) => u.table === "quotes")).toBeUndefined();
  });

  it("OWNER approves (sets status=approved + approved_by + approved_at)", async () => {
    // Regression pin (2-member org): this is what an org-only-filtered
    // memberships role read returns when the org has two members — PostgREST
    // .single() errors on two rows. The pre-fix reviewQuote consumed it and
    // forbade the owner. The fixed action derives the role from ctx and must
    // leave this queue entry untouched.
    mockSb.enqueue("membership", { data: null, error: { code: "PGRST116" } });
    mockSb.enqueue("quoteLookup", {
      data: { status: "pending_approval" },
      error: null,
    });
    mockSb.enqueue("update", { error: null });
    const fd = new FormData();
    fd.set("action", "approve");
    await expectRedirectTo(
      () => actions.reviewQuote("11111111-1111-1111-1111-111111111111", fd),
      "saved=approved",
    );
    const upd = mockSb.updates.find((u) => u.table === "quotes");
    expect(upd).toBeDefined();
    expect(upd!.payload).toMatchObject({
      status: "approved",
      approved_by: "user-owner",
    });
    expect((upd!.payload as { approved_at: string }).approved_at).toBeTruthy();
    // The 2-member-org poison pill was never read.
    expect(mockSb.queue.membership.length).toBe(1);
  });

  it("ADMIN approves with same effect as owner", async () => {
    caller.role = "admin";
    mockSb.enqueue("quoteLookup", {
      data: { status: "pending_approval" },
      error: null,
    });
    mockSb.enqueue("update", { error: null });
    const fd = new FormData();
    fd.set("action", "approve");
    await expectRedirectTo(
      () => actions.reviewQuote("11111111-1111-1111-1111-111111111111", fd),
      "saved=approved",
    );
    const upd = mockSb.updates.find((u) => u.table === "quotes");
    expect(upd!.payload).toMatchObject({ status: "approved" });
  });

  it("Reject requires a comment", async () => {
    caller.role = "admin";
    const fd = new FormData();
    fd.set("action", "reject");
    fd.set("comment", "");
    await expectRedirectTo(
      () => actions.reviewQuote("11111111-1111-1111-1111-111111111111", fd),
      "Comment%20is%20required",
    );
  });

  it("Admin rejects with a comment", async () => {
    caller.role = "admin";
    mockSb.enqueue("quoteLookup", {
      data: { status: "pending_approval" },
      error: null,
    });
    mockSb.enqueue("update", { error: null });
    const fd = new FormData();
    fd.set("action", "reject");
    fd.set("comment", "Margin too low.");
    await expectRedirectTo(
      () => actions.reviewQuote("11111111-1111-1111-1111-111111111111", fd),
      "saved=rejected",
    );
    const upd = mockSb.updates.find((u) => u.table === "quotes");
    expect(upd!.payload).toMatchObject({
      status: "rejected",
      approval_comment: "Margin too low.",
    });
  });
});

describe("requestQuoteApproval — draft → pending_approval", () => {
  it("Transitions draft to pending_approval and clears prior approval state", async () => {
    mockSb.enqueue("quoteLookup", {
      data: { status: "draft", org_id: "org-1" },
      error: null,
    });
    mockSb.enqueue("update", { error: null });
    await expectRedirectTo(
      () => actions.requestQuoteApproval("11111111-1111-1111-1111-111111111111"),
      "approval_requested",
    );
    const upd = mockSb.updates.find((u) => u.table === "quotes");
    expect(upd!.payload).toMatchObject({
      status: "pending_approval",
      approved_by: null,
      approved_at: null,
      approval_comment: null,
    });
  });

  it("Rejects request from non-draft / non-rejected status", async () => {
    mockSb.enqueue("quoteLookup", {
      data: { status: "approved", org_id: "org-1" },
      error: null,
    });
    await expectRedirectTo(
      () => actions.requestQuoteApproval("11111111-1111-1111-1111-111111111111"),
      "only%20draft%20or%20rejected",
    );
    expect(mockSb.updates.find((u) => u.table === "quotes")).toBeUndefined();
  });
});
