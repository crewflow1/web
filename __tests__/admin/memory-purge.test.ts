import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Shared Memory — purgeMemoryAction: authorization boundary + audit contract
 * (E2, real erasure).
 *
 * The purge action is the single UI entry point to `hq_memory_purge`, and it
 * is more dangerous than every other memory action (irreversible content
 * destruction), so the boundary tests mirror __tests__/admin/memory.test.ts
 * and add the purge-specific gates:
 *
 *   1. Unauthenticated  → bounced to /login, ZERO rpc calls, ZERO writes.
 *   2. Non-allowlisted  → bounced to /dashboard, ZERO rpc calls.
 *   3. Missing/wrong confirmation word ("PURGE") → refused, ZERO rpc calls.
 *   4. Missing reason   → refused, ZERO rpc calls.
 *   5. Happy path       → calls the SQL primitive with the admin's email as
 *      actor, audits 'memory.purged' with CONTENT-FREE metadata
 *      {memory_id, reason, had_embedding, versions_scrubbed}, redirects.
 *   6. RPC refusal (already_purged / error) → error redirect, NO audit row.
 *
 * The SQL primitive's behaviour (scrub, tombstone, resurrection-proofing) is
 * proven on real Postgres in __tests__/integration/memory/purge-path.test.ts.
 */

// ---------- Supabase admin mock (from + rpc) --------------------------

type RpcCall = { fn: string; args: Record<string, unknown> };

const rpcCalls: RpcCall[] = [];
const inserts: Array<{ table: string; payload: unknown }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
};

function makeMockAdmin() {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcResult);
    },
    from: (table: string) => ({
      insert: (payload: unknown) => {
        inserts.push({ table, payload });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => makeMockAdmin(),
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

async function loadActions() {
  return await import("@/app/admin/memory/actions");
}

const MEM_ID = "00000000-0000-0000-0000-0000000000a1";

function purgeForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const fields: Record<string, string> = {
    id: MEM_ID,
    reason: "DSAR erasure request",
    confirm: "PURGE",
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== "") fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  rpcCalls.length = 0;
  inserts.length = 0;
  rpcResult = { data: null, error: null };
  redirectMock.mockClear();
  requireUserMock.mockReset();
  isSuperAdminEmailMock.mockReset();
});

// ---------- 1 + 2. Authorization boundary -----------------------------

describe("purgeMemoryAction — authorization boundary", () => {
  it("unauthenticated callers bounce to /login with ZERO rpc calls", async () => {
    requireUserMock.mockImplementation(() => {
      throw new Error("REDIRECT:/login");
    });
    isSuperAdminEmailMock.mockReturnValue(false);

    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(rpcCalls).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("non-allowlisted customers bounce to /dashboard with ZERO rpc calls", async () => {
    requireUserMock.mockResolvedValue({
      id: "cust-1",
      email: "owner@some-tenant.test",
    });
    isSuperAdminEmailMock.mockReturnValue(false);

    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(isSuperAdminEmailMock).toHaveBeenCalledWith("owner@some-tenant.test");
    expect(rpcCalls).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

// ---------- 3 + 4. The explicit-confirmation gate ---------------------

describe("purgeMemoryAction — explicit confirmation is mandatory", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({ id: "hq-1", email: "ops@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);
  });

  it("refuses without the confirmation word — zero writes", async () => {
    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm({ confirm: "" }))).rejects.toThrow(
      /REDIRECT:\/admin\/memory\/.+error=/,
    );
    expect(rpcCalls).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("refuses a wrong confirmation word (case-sensitive) — zero writes", async () => {
    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm({ confirm: "purge" }))).rejects.toThrow(
      /REDIRECT:.+error=/,
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses without a reason — zero writes", async () => {
    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm({ reason: "" }))).rejects.toThrow(
      /REDIRECT:.+error=/,
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a non-uuid id — zero writes", async () => {
    const { purgeMemoryAction } = await loadActions();
    await expect(
      purgeMemoryAction(purgeForm({ id: "not-a-uuid" })),
    ).rejects.toThrow(/REDIRECT:\/admin\/memory\?error=/);
    expect(rpcCalls).toHaveLength(0);
  });
});

// ---------- 5. Happy path — rpc + content-free audit -------------------

describe("purgeMemoryAction — allowed caller purges and audits", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({ id: "hq-1", email: "ops@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);
  });

  it("calls hq_memory_purge with the admin's email, audits content-free, redirects", async () => {
    rpcResult = {
      data: { ok: true, memory_id: MEM_ID, had_embedding: true, versions_scrubbed: 3 },
      error: null,
    };

    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/memory/${MEM_ID}\\?saved=purged`),
    );

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("hq_memory_purge");
    expect(rpcCalls[0]?.args).toEqual({
      p_memory_id: MEM_ID,
      p_actor: "ops@crewflow.uk",
      p_reason: "DSAR erasure request",
    });

    // Audit row: action 'memory.purged', metadata exactly the CEO contract —
    // {memory_id, reason, had_embedding, versions_scrubbed} — and NO content.
    const audit = inserts.find((i) => i.table === "admin_activity_log");
    expect(audit, "an admin_activity_log row").toBeDefined();
    const payload = audit?.payload as Record<string, unknown>;
    expect(payload.action).toBe("memory.purged");
    expect(payload.target_table).toBe("hq_memories");
    expect(payload.target_id).toBe(MEM_ID);
    expect(payload.metadata).toEqual({
      memory_id: MEM_ID,
      reason: "DSAR erasure request",
      had_embedding: true,
      versions_scrubbed: 3,
    });
    // No content-bearing keys can ride along.
    const metaKeys = Object.keys(payload.metadata as Record<string, unknown>);
    for (const forbidden of ["title", "summary", "body"]) {
      expect(metaKeys).not.toContain(forbidden);
    }
  });

  it("an rpc refusal (already_purged) error-redirects and writes NO audit row", async () => {
    rpcResult = { data: { ok: false, reason: "already_purged" }, error: null };

    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm())).rejects.toThrow(
      /REDIRECT:.+error=/,
    );
    expect(rpcCalls).toHaveLength(1);
    expect(inserts.filter((i) => i.table === "admin_activity_log")).toHaveLength(0);
  });

  it("an rpc error error-redirects and writes NO audit row", async () => {
    rpcResult = { data: null, error: { message: "boom" } };

    const { purgeMemoryAction } = await loadActions();
    await expect(purgeMemoryAction(purgeForm())).rejects.toThrow(
      /REDIRECT:.+error=/,
    );
    expect(inserts.filter((i) => i.table === "admin_activity_log")).toHaveLength(0);
  });
});
