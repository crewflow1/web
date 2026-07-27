import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AI Boardroom — authorization-boundary + pure-logic contract tests
 * (CEO Directive 001, Phase 1).
 *
 * The directive requires proof that:
 *   1. Unauthenticated users are blocked.
 *   2. Normal (non-allowlisted) customer users are blocked.
 *   3. HQ / super-admin users are allowed (and their writes are audited).
 *
 * The three mutating server actions (updateAiEmployeeConfig,
 * addAiEmployeeTask, addAiEmployeeMemory) are the only state-changing
 * entry points, so the boundary is proven there: a blocked caller must
 * redirect and perform ZERO writes; an allowed caller must persist the
 * row AND record an audit-log entry.
 *
 * Supabase admin is mocked (queue-based chainable stub). redirect is
 * stubbed to throw so we can assert the bounce path — mirroring Next.js,
 * where redirect() halts the action.
 */

// ---------- Supabase admin mock --------------------------------------

type QueueEntry = { data: unknown; error: unknown };

function makeMockSupabase() {
  const insertQ: QueueEntry[] = [];
  const updateQ: QueueEntry[] = [];
  const maybeSingleQ: QueueEntry[] = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{
    table: string;
    payload: unknown;
    where: Record<string, unknown>;
  }> = [];

  const passthrough = new Set([
    "select",
    "eq",
    "in",
    "is",
    "not",
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
      const settled = insertQ.shift() ?? { data: null, error: null };
      const ic: Record<string, unknown> = {
        select: () => ic,
        single: async () => settled,
      };
      Object.defineProperty(ic, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
      });
      return ic;
    };
    chain.update = (payload: unknown) => ({
      eq: (col: string, val: unknown) => {
        updates.push({ table, payload, where: { [col]: val } });
        const settled = updateQ.shift() ?? { data: null, error: null };
        const inner: Record<string, unknown> = {};
        Object.defineProperty(inner, "then", {
          value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
        });
        return inner;
      },
    });
    return chain;
  }

  return {
    client: { from: (table: string) => makeChain(table) },
    inserts,
    updates,
    enqueueMaybeSingle: (e: QueueEntry) => maybeSingleQ.push(e),
    enqueueInsert: (e: QueueEntry) => insertQ.push(e),
    enqueueUpdate: (e: QueueEntry) => updateQ.push(e),
  };
}

const mockAdmin = makeMockSupabase();

// ---------- Module mocks ---------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockAdmin.client,
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
  return await import("@/app/admin/ai-boardroom/actions");
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const EMP_ID = "00000000-0000-0000-0000-0000000000a1";
const SLUG = "sales-ai";

function validConfigForm(): FormData {
  return makeFormData({
    id: EMP_ID,
    slug: SLUG,
    status: "working",
    memory_scope: "department",
    role: "Outbound sales strategist",
    description: "Plans outbound sequences.",
    system_prompt: "You are the Sales AI.",
    model_provider: "anthropic",
    model_name: "claude-opus-4-7",
    current_task: "Draft Q3 sequence",
  });
}

function validTaskForm(): FormData {
  return makeFormData({
    ai_employee_id: EMP_ID,
    slug: SLUG,
    title: "Draft Q3 outbound sequence",
    status: "in_progress",
    summary: "First pass at the cadence.",
  });
}

function validMemoryForm(): FormData {
  return makeFormData({
    ai_employee_id: EMP_ID,
    slug: SLUG,
    scope: "department",
    mem_key: "tone_of_voice",
    content: "Keep it concise and friendly.",
  });
}

beforeEach(() => {
  mockAdmin.inserts.length = 0;
  mockAdmin.updates.length = 0;
  redirectMock.mockClear();
  requireUserMock.mockReset();
  isSuperAdminEmailMock.mockReset();
});

// ---------- 1. Unauthenticated --------------------------------------

describe("authorization — unauthenticated callers are blocked", () => {
  beforeEach(() => {
    // The real requireUser() redirects to /login when there's no session,
    // which throws and halts the action before any write.
    requireUserMock.mockImplementation(() => {
      throw new Error("REDIRECT:/login");
    });
    isSuperAdminEmailMock.mockReturnValue(false);
  });

  it("updateAiEmployeeConfig bounces to /login without writing", async () => {
    const { updateAiEmployeeConfig } = await loadActions();
    await expect(updateAiEmployeeConfig(validConfigForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });

  it("addAiEmployeeTask bounces to /login without writing", async () => {
    const { addAiEmployeeTask } = await loadActions();
    await expect(addAiEmployeeTask(validTaskForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });

  it("addAiEmployeeMemory bounces to /login without writing", async () => {
    const { addAiEmployeeMemory } = await loadActions();
    await expect(addAiEmployeeMemory(validMemoryForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
  });
});

// ---------- 2. Normal customer (authenticated, not allowlisted) ------

describe("authorization — non-allowlisted customer users are blocked", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({
      id: "cust-1",
      email: "owner@some-tenant.test",
    });
    isSuperAdminEmailMock.mockReturnValue(false);
  });

  it("updateAiEmployeeConfig redirects to /dashboard without writing", async () => {
    const { updateAiEmployeeConfig } = await loadActions();
    await expect(updateAiEmployeeConfig(validConfigForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(isSuperAdminEmailMock).toHaveBeenCalledWith("owner@some-tenant.test");
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });

  it("addAiEmployeeTask redirects to /dashboard without writing", async () => {
    const { addAiEmployeeTask } = await loadActions();
    await expect(addAiEmployeeTask(validTaskForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });

  it("addAiEmployeeMemory redirects to /dashboard without writing", async () => {
    const { addAiEmployeeMemory } = await loadActions();
    await expect(addAiEmployeeMemory(validMemoryForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
  });
});

// ---------- 3. HQ super-admin (allowed) ------------------------------

describe("authorization — HQ super-admin is allowed and audited", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({
      id: "admin-1",
      email: "ceo@crewflow.uk",
    });
    isSuperAdminEmailMock.mockReturnValue(true);
  });

  it("updateAiEmployeeConfig persists safe fields + audit, never can_execute", async () => {
    const { updateAiEmployeeConfig } = await loadActions();
    await expect(updateAiEmployeeConfig(validConfigForm())).rejects.toThrow(
      /REDIRECT:\/admin\/ai-boardroom\/sales-ai\?saved=config/,
    );

    const empUpdate = mockAdmin.updates.find((u) => u.table === "ai_employees");
    expect(empUpdate).toBeTruthy();
    const payload = empUpdate?.payload as Record<string, unknown>;
    expect(payload.status).toBe("working");
    expect(payload.role).toBe("Outbound sales strategist");
    expect(payload.model_provider).toBe("anthropic");
    expect(payload.model_name).toBe("claude-opus-4-7");
    // LR2 (Directive #015 / D-05, the Mirror Integrity Rule): memory_scope is
    // capability authority, authored at the registry — NOT written direct to the
    // legacy model here. Even when the form submits it, the config action ignores it.
    expect(payload).not.toHaveProperty("memory_scope");
    // Framework-mode invariant: the config action must NEVER touch
    // execution permissions.
    expect(payload).not.toHaveProperty("permissions");
    expect(payload).not.toHaveProperty("can_execute");
    expect(empUpdate?.where).toEqual({ id: EMP_ID });

    // Audit row written to admin_activity_log.
    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    expect(audit).toBeTruthy();
    expect((audit?.payload as { action: string }).action).toBe(
      "ai_employee.config_updated",
    );
    expect((audit?.payload as { actor_email: string }).actor_email).toBe(
      "ceo@crewflow.uk",
    );
  });

  it("addAiEmployeeTask inserts the task, stamps activity, and audits", async () => {
    const { addAiEmployeeTask } = await loadActions();
    await expect(addAiEmployeeTask(validTaskForm())).rejects.toThrow(
      /REDIRECT:\/admin\/ai-boardroom\/sales-ai\?saved=task/,
    );

    const taskInsert = mockAdmin.inserts.find(
      (i) => i.table === "ai_employee_tasks",
    );
    expect(taskInsert).toBeTruthy();
    const tp = taskInsert?.payload as Record<string, unknown>;
    expect(tp.title).toBe("Draft Q3 outbound sequence");
    expect(tp.status).toBe("in_progress");
    expect(tp.ai_employee_id).toBe(EMP_ID);
    expect(tp.created_by_email).toBe("ceo@crewflow.uk");
    // in_progress is not terminal → no completion stamp.
    expect(tp.completed_at).toBeNull();

    // last_activity_at bumped on the employee row.
    const actBump = mockAdmin.updates.find((u) => u.table === "ai_employees");
    expect(actBump).toBeTruthy();
    expect(actBump?.payload).toHaveProperty("last_activity_at");

    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    expect((audit?.payload as { action: string }).action).toBe(
      "ai_employee.task_logged",
    );
  });

  it("addAiEmployeeTask stamps completed_at for terminal statuses", async () => {
    const { addAiEmployeeTask } = await loadActions();
    const fd = validTaskForm();
    fd.set("status", "completed");
    await expect(addAiEmployeeTask(fd)).rejects.toThrow(/REDIRECT:/);
    const taskInsert = mockAdmin.inserts.find(
      (i) => i.table === "ai_employee_tasks",
    );
    expect(
      (taskInsert?.payload as { completed_at: string | null }).completed_at,
    ).toBeTruthy();
  });

  it("addAiEmployeeMemory inserts the entry and audits", async () => {
    const { addAiEmployeeMemory } = await loadActions();
    await expect(addAiEmployeeMemory(validMemoryForm())).rejects.toThrow(
      /REDIRECT:\/admin\/ai-boardroom\/sales-ai\?saved=memory/,
    );

    const memInsert = mockAdmin.inserts.find(
      (i) => i.table === "ai_employee_memory",
    );
    expect(memInsert).toBeTruthy();
    const mp = memInsert?.payload as Record<string, unknown>;
    expect(mp.content).toBe("Keep it concise and friendly.");
    expect(mp.mem_key).toBe("tone_of_voice");
    expect(mp.scope).toBe("department");

    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    expect((audit?.payload as { action: string }).action).toBe(
      "ai_employee.memory_added",
    );
  });

  it("rejects invalid input before any write (bad status enum)", async () => {
    const { updateAiEmployeeConfig } = await loadActions();
    const fd = validConfigForm();
    fd.set("status", "h4 x0r"); // not a real status
    await expect(updateAiEmployeeConfig(fd)).rejects.toThrow(
      /REDIRECT:\/admin\/ai-boardroom\?error=/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });
});

// ---------- 4. Pure model logic --------------------------------------

describe("model — countByStatus tallies the roster", () => {
  it("counts known statuses and ignores unknown ones", async () => {
    const { countByStatus } = await import("@/lib/ai-employees/model");
    const counts = countByStatus([
      { status: "idle" },
      { status: "idle" },
      { status: "working" },
      { status: "error" },
      { status: "totally-made-up" },
    ]);
    expect(counts.idle).toBe(2);
    expect(counts.working).toBe(1);
    expect(counts.error).toBe(1);
    expect(counts.waiting_approval).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.disabled).toBe(0);
  });
});

describe("model — relativeTime formats activity timestamps", () => {
  it("handles null, recent, and old timestamps", async () => {
    const { relativeTime } = await import("@/lib/ai-employees/model");
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime(new Date(Date.now() - 30_000).toISOString())).toBe(
      "just now",
    );
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe(
      "5m ago",
    );
    expect(
      relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString()),
    ).toBe("3h ago");
    expect(
      relativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString()),
    ).toBe("2d ago");
    // > 30 days falls back to an ISO date prefix.
    expect(relativeTime("2020-01-15T10:00:00.000Z")).toBe("2020-01-15");
  });
});
