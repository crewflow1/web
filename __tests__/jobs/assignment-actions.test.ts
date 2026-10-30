import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit coverage for the job-assignment server actions
 * (app/(app)/jobs/[id]/assignment-actions.ts): assignWorker + removeWorker.
 *
 * These back the SERVICE-ROLE-ONLY `job_assignments` table, so the Supabase
 * admin client is fully mocked (no DB). Pins:
 *  - A non-manager (jobs:manage denied) is refused and NO admin client is even
 *    constructed — no read, no write.
 *  - assignWorker validates the target is a member of the job's org, and upserts
 *    the correct payload with onConflict "job_id,user_id" + assigned_by = caller.
 *  - removeWorker calls the transactional remove_job_worker RPC (which deletes
 *    the crew row AND nulls jobs.assigned_to atomically); the delete+null
 *    behaviour itself is proven against real Postgres in the integration tier
 *    (rls/job-assignment-reconciliation.test.ts). Here we pin the call shape and
 *    the no-false-success contract.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

// --- requireOrgContext -----------------------------------------------------
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    user: { id: "user-1" },
    ctx: {
      org: { id: "org-1" },
      membership: { org_id: "org-1", role: "owner" },
    },
  })),
}));

// --- capability gate (controlled per test) ---------------------------------
let canManage = true;
const hasCapabilityMock = vi.fn(async () => canManage);
vi.mock("@/server/auth/capabilities", () => ({
  hasCapability: hasCapabilityMock,
}));

// --- next/cache ------------------------------------------------------------
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

// --- admin Supabase client -------------------------------------------------
// Configurable responses + recorded calls.
let jobRow: { id: string; assigned_to: string | null } | null = {
  id: JOB_ID,
  assigned_to: null,
};
let jobError: { message: string } | null = null;
let memberRow: { user_id: string } | null = { user_id: WORKER_ID };
let memberError: { message: string } | null = null;
let upsertError: { message: string } | null = null;
let rpcError: { message: string } | null = null;

const calls: {
  upsert: { table: string; row: Record<string, unknown>; onConflict: string }[];
  rpc: { fn: string; args: Record<string, unknown> }[];
} = { upsert: [], rpc: [] };

function selectChain(table: string) {
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  chain.maybeSingle = async () => {
    if (table === "jobs") return { data: jobRow, error: jobError };
    if (table === "memberships") return { data: memberRow, error: memberError };
    return { data: null, error: null };
  };
  return chain;
}

const createAdminClientMock = vi.fn(() => ({
  from: (table: string) => ({
    select: () => selectChain(table),
    upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => {
      calls.upsert.push({ table, row, onConflict: opts.onConflict });
      return Promise.resolve({ error: upsertError });
    },
  }),
  // removeWorker routes its atomic delete+null through the remove_job_worker RPC.
  rpc: (fn: string, args: Record<string, unknown>) => {
    calls.rpc.push({ fn, args });
    return Promise.resolve({ error: rpcError });
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: createAdminClientMock,
}));

const { assignWorker, removeWorker } = await import(
  "@/app/(app)/jobs/[id]/assignment-actions"
);

const INITIAL = { ok: false, error: null, fieldErrors: {}, values: {} };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  canManage = true;
  jobRow = { id: JOB_ID, assigned_to: null };
  jobError = null;
  memberRow = { user_id: WORKER_ID };
  memberError = null;
  upsertError = null;
  rpcError = null;
  calls.upsert = [];
  calls.rpc = [];
  hasCapabilityMock.mockClear();
  revalidatePathMock.mockClear();
  createAdminClientMock.mockClear();
});

describe("assignWorker — authorization", () => {
  it("refuses a non-manager and never constructs the admin client", async () => {
    canManage = false;
    const res = await assignWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/i);
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(calls.upsert).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("checks the jobs:manage capability for the caller's org", async () => {
    await assignWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));
    expect(hasCapabilityMock).toHaveBeenCalledWith(
      expect.objectContaining({ org: { id: "org-1" } }),
      expect.objectContaining({ id: "user-1" }),
      "jobs",
      "manage",
    );
  });
});

describe("assignWorker — validation", () => {
  it("rejects a malformed job id before any capability or DB work", async () => {
    const res = await assignWorker("not-a-uuid", INITIAL, form({ user_id: WORKER_ID }));
    expect(res.ok).toBe(false);
    expect(hasCapabilityMock).not.toHaveBeenCalled();
    expect(calls.upsert).toHaveLength(0);
  });

  it("rejects a missing/invalid worker id without writing", async () => {
    const res = await assignWorker(JOB_ID, INITIAL, form({}));
    expect(res.ok).toBe(false);
    expect(calls.upsert).toHaveLength(0);
  });

  it("refuses when the job is not in the caller's active org", async () => {
    jobRow = null;
    const res = await assignWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/workspace/i);
    expect(calls.upsert).toHaveLength(0);
  });

  it("refuses when the target is not a member of the org", async () => {
    memberRow = null;
    const res = await assignWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/member of this workspace/i);
    expect(calls.upsert).toHaveLength(0);
  });
});

describe("assignWorker — success", () => {
  it("adds the worker through the LOCKED add_job_worker RPC (not a bare upsert)", async () => {
    const res = await assignWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(true);
    // F1: the crew-add now takes the per-job advisory lock via the RPC, so it
    // can never race a concurrent remove. No bare upsert any more.
    expect(calls.upsert).toHaveLength(0);
    expect(calls.rpc).toContainEqual({
      fn: "add_job_worker",
      args: { p_job_id: JOB_ID, p_org_id: "org-1", p_user_id: WORKER_ID },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/jobs/${JOB_ID}`);
  });

  it("returns ok:false (no false success) when the RPC errors", async () => {
    rpcError = { message: "boom" };
    const res = await assignWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));
    expect(res.ok).toBe(false);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("removeWorker — authorization", () => {
  it("refuses a non-manager and never constructs the admin client", async () => {
    canManage = false;
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/i);
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(calls.rpc).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("removeWorker — atomic revoke via RPC", () => {
  it("calls remove_job_worker with the job, active org, and worker", async () => {
    // assigned_to is irrelevant to the call shape — the RPC decides whether to
    // null the primary; the action always passes the same args.
    jobRow = { id: JOB_ID, assigned_to: OTHER_ID };
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(true);
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0]).toEqual({
      fn: "remove_job_worker",
      args: { p_job_id: JOB_ID, p_org_id: "org-1", p_user_id: WORKER_ID },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/jobs/${JOB_ID}`);
  });

  it("refuses when the job is not in the caller's active org (no RPC call)", async () => {
    jobRow = null;
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/workspace/i);
    expect(calls.rpc).toHaveLength(0);
  });

  it("rejects a missing/invalid worker id without calling the RPC", async () => {
    const res = await removeWorker(JOB_ID, INITIAL, form({}));
    expect(res.ok).toBe(false);
    expect(calls.rpc).toHaveLength(0);
  });

  it("returns ok:false (no false success) when the RPC errors", async () => {
    rpcError = { message: "boom" };
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));
    expect(res.ok).toBe(false);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
