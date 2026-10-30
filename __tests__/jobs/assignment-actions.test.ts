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
 *  - removeWorker deletes the (job_id, user_id) row, and ALSO clears
 *    jobs.assigned_to when (and only when) it points at the removed worker —
 *    the access-revocation requirement.
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
let deleteError: { message: string } | null = null;
let updateError: { message: string } | null = null;

type Call = { table: string; filters: [string, unknown][] };
const calls: {
  upsert: { table: string; row: Record<string, unknown>; onConflict: string }[];
  delete: Call[];
  update: (Call & { values: Record<string, unknown> })[];
} = { upsert: [], delete: [], update: [] };

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

function writeBuilder(filters: [string, unknown][], result: () => { error: unknown }) {
  const b: Record<string, unknown> = {};
  b.eq = (col: string, val: unknown) => {
    filters.push([col, val]);
    return b;
  };
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return b;
}

const createAdminClientMock = vi.fn(() => ({
  from: (table: string) => ({
    select: () => selectChain(table),
    upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => {
      calls.upsert.push({ table, row, onConflict: opts.onConflict });
      return Promise.resolve({ error: upsertError });
    },
    delete: () => {
      const filters: [string, unknown][] = [];
      calls.delete.push({ table, filters });
      return writeBuilder(filters, () => ({ error: deleteError }));
    },
    update: (values: Record<string, unknown>) => {
      const filters: [string, unknown][] = [];
      calls.update.push({ table, values, filters });
      return writeBuilder(filters, () => ({ error: updateError }));
    },
  }),
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
  deleteError = null;
  updateError = null;
  calls.upsert = [];
  calls.delete = [];
  calls.update = [];
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
  it("upserts the assignment with the caller as assigned_by and the right conflict key", async () => {
    const res = await assignWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(true);
    expect(calls.upsert).toHaveLength(1);
    expect(calls.upsert[0]).toMatchObject({
      table: "job_assignments",
      onConflict: "job_id,user_id",
      row: {
        org_id: "org-1",
        job_id: JOB_ID,
        user_id: WORKER_ID,
        assigned_by: "user-1",
      },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/jobs/${JOB_ID}`);
  });

  it("returns ok:false (no false success) when the upsert errors", async () => {
    upsertError = { message: "boom" };
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
    expect(calls.delete).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("removeWorker — deletes and revokes access", () => {
  it("deletes the (job_id, user_id) row scoped to the org", async () => {
    jobRow = { id: JOB_ID, assigned_to: OTHER_ID }; // primary is someone else
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(true);
    expect(calls.delete).toHaveLength(1);
    const del = calls.delete[0];
    if (!del) throw new Error("expected a delete call");
    expect(del.table).toBe("job_assignments");
    expect(del.filters).toEqual(
      expect.arrayContaining([
        ["job_id", JOB_ID],
        ["user_id", WORKER_ID],
        ["org_id", "org-1"],
      ]),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith(`/jobs/${JOB_ID}`);
  });

  it("also clears jobs.assigned_to when it points at the removed worker", async () => {
    jobRow = { id: JOB_ID, assigned_to: WORKER_ID };
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(true);
    expect(calls.update).toHaveLength(1);
    const upd = calls.update[0];
    if (!upd) throw new Error("expected an update call");
    expect(upd.table).toBe("jobs");
    expect(upd.values).toEqual({ assigned_to: null });
    expect(upd.filters).toEqual(
      expect.arrayContaining([
        ["id", JOB_ID],
        ["org_id", "org-1"],
      ]),
    );
  });

  it("does NOT touch jobs.assigned_to when it points at a different worker", async () => {
    jobRow = { id: JOB_ID, assigned_to: OTHER_ID };
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));

    expect(res.ok).toBe(true);
    expect(calls.update).toHaveLength(0);
  });

  it("rejects a missing/invalid worker id without deleting", async () => {
    const res = await removeWorker(JOB_ID, INITIAL, form({}));
    expect(res.ok).toBe(false);
    expect(calls.delete).toHaveLength(0);
  });

  it("returns ok:false when the delete errors", async () => {
    deleteError = { message: "boom" };
    const res = await removeWorker(JOB_ID, INITIAL, form({ user_id: WORKER_ID }));
    expect(res.ok).toBe(false);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
