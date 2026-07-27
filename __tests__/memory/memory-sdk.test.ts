import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the `ctx.memory` SDK facet (server/sdk/memory.ts)
 * (CEO Directive 009 Module 1, PR6 — SDK Integration; Bible Volume X §12.2).
 *
 * The facet binds the already-built service layer to ONE employee and stamps
 * that identity onto every call. We mock only the admin client's RPC surface,
 * so the REAL service functions (recallMemory / rememberMemory / forgetMemory)
 * and the REAL pure ranker run end to end — only the database round-trip is
 * faked. That lets us assert the contract precisely:
 *
 *   - identity is stamped on EVERY verb (no parameter can act as another employee);
 *   - recall() maps subject/classes/limit and renders a prompt-ready context;
 *   - recall()/resolve() accumulate evidence; search() deliberately does NOT;
 *   - working/episodic remember() auto-binds the running task; durable does not;
 *   - expiresAt (a Date) is serialised; approval-withheld surfaces id:null;
 *   - search() is raw (no reinforcement round-trip);
 *   - every verb throws on a service failure (the handler ABI is throw-based).
 */

const { rpcMock, getProviderMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  getProviderMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

// No embedding provider configured → semantic recall stays dark, no network.
vi.mock("@/lib/ai/embeddings", () => ({
  getEmbeddingProvider: getProviderMock,
}));

import { createMemory } from "@/server/sdk/memory";

const EMP = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const TASK = "33333333-3333-3333-3333-333333333333";
const TASK_OVERRIDE = "44444444-4444-4444-4444-444444444444";

/** A complete candidate row as hq_memory_recall projects it (snake_case). */
function candRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    memory_class: "semantic",
    memory_type: "fact",
    title: "Pricing tiers",
    summary: "Three tiers: starter, pro, scale.",
    visibility: "public_hq",
    department: null,
    owner_employee_id: null,
    importance: "normal",
    salience: 50,
    pinned: false,
    access_count: 0,
    consolidated_into: null,
    version: 1,
    created_at: "2026-06-01T00:00:00.000Z",
    last_reinforced_at: null,
    ts_rank: 0.9,
    structural_match: 0,
    cos_sim: null,
    body_tokens: 5,
    summary_tokens: 2,
    ...over,
  };
}

/** Find the args of the first rpc() call to `fn` (or undefined). */
function argsFor(fn: string): Record<string, unknown> | undefined {
  const call = rpcMock.mock.calls.find((c) => c[0] === fn);
  return call?.[1] as Record<string, unknown> | undefined;
}

/** Did rpc() ever get called with `fn`? */
function called(fn: string): boolean {
  return rpcMock.mock.calls.some((c) => c[0] === fn);
}

beforeEach(() => {
  rpcMock.mockReset();
  getProviderMock.mockReset();
  getProviderMock.mockReturnValue(null);
});

// ---------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------

describe("ctx.memory.recall — maps inputs, stamps identity, renders context", () => {
  beforeEach(() => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_memory_recall")
        return {
          data: [
            candRow({ id: "a1", ts_rank: 0.9 }),
            candRow({ id: "a2", title: "Refund policy", ts_rank: 0.8 }),
          ],
          error: null,
        };
      return { data: null, error: null };
    });
  });

  it("forwards the bound employee id and maps subject/classes/limit", async () => {
    const mem = createMemory({ employeeId: EMP, department: "sales" });
    const res = await mem.recall({
      query: "pricing",
      subject: { kind: "feature", id: "billing" },
      classes: ["semantic", "procedural"],
      limit: 12,
    });

    const args = argsFor("hq_memory_recall")!;
    expect(args.p_employee_id).toBe(EMP);
    expect(args.p_query).toBe("pricing");
    expect(args.p_subject_kind).toBe("feature");
    expect(args.p_subject_id).toBe("billing");
    expect(args.p_class_filter).toEqual(["semantic", "procedural"]);
    expect(args.p_limit).toBe(12);

    // Items are mapped into the SDK vocabulary (class/type, not memory_class).
    expect(res.items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(res.items[0]!.class).toBe("semantic");
    expect(res.items[0]!.type).toBe("fact");

    // Context is prompt-ready, provenance-tagged, and reports the budget.
    expect(res.context.memoryCount).toBe(2);
    expect(res.context.text).toContain("[fact · public_hq] Pricing tiers");
    expect(res.context.text).toContain("Refund policy");
    expect(res.context.budget).toBe(res.manifest.budget);
  });

  it("reinforces the assembled set (the real read leaves an audit footprint)", async () => {
    const mem = createMemory({ employeeId: EMP });
    await mem.recall({ query: "pricing" });
    expect(called("hq_memory_reinforce")).toBe(true);
    expect(argsFor("hq_memory_reinforce")!.p_employee_id).toBe(EMP);
  });
});

// ---------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------

describe("ctx.memory.evidence — recall + resolve accumulate, search does not", () => {
  it("collects distinct recalled ids across recall() and resolve()", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_memory_recall")
        return { data: [candRow({ id: "a1" }), candRow({ id: "a2" })], error: null };
      return { data: null, error: null };
    });
    const mem = createMemory({ employeeId: EMP });

    await mem.recall({ query: "x" });
    await mem.resolve({ kind: "customer", id: "acme" }); // returns a1,a2 again
    expect(mem.evidence().sort()).toEqual(["a1", "a2"]);
  });

  it("search() never contributes to evidence", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_memory_recall") return { data: [candRow({ id: "s1" })], error: null };
      return { data: null, error: null };
    });
    const mem = createMemory({ employeeId: EMP });
    await mem.search("anything");
    expect(mem.evidence()).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// remember — auto task-bind + serialisation + approval
// ---------------------------------------------------------------------

describe("ctx.memory.remember — stamps identity, auto-binds the task, serialises", () => {
  beforeEach(() => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_memory_write") return { data: "new-id", error: null };
      return { data: null, error: null };
    });
  });

  it("auto-binds working/episodic writes to the running task", async () => {
    const mem = createMemory({ employeeId: EMP, currentTaskId: TASK });
    await mem.remember({ class: "episodic", type: "note", title: "t", body: "b" });
    const args = argsFor("hq_memory_write")!;
    expect(args.p_employee_id).toBe(EMP);
    expect(args.p_bound_task_id).toBe(TASK);
  });

  it("does NOT bind durable classes to the task", async () => {
    const mem = createMemory({ employeeId: EMP, currentTaskId: TASK });
    await mem.remember({ class: "semantic", type: "fact", title: "t", body: "b" });
    expect(argsFor("hq_memory_write")!.p_bound_task_id).toBeNull();
  });

  it("lets an explicit boundTask override the running task", async () => {
    const mem = createMemory({ employeeId: EMP, currentTaskId: TASK });
    await mem.remember({
      class: "working",
      type: "scratch",
      title: "t",
      body: "b",
      boundTask: TASK_OVERRIDE,
    });
    expect(argsFor("hq_memory_write")!.p_bound_task_id).toBe(TASK_OVERRIDE);
  });

  it("serialises expiresAt (Date) to ISO and passes salience/visibility", async () => {
    const mem = createMemory({ employeeId: EMP });
    const when = new Date("2026-07-01T12:00:00.000Z");
    await mem.remember({
      class: "working",
      type: "scratch",
      title: "t",
      body: "b",
      visibility: "private",
      salience: 73,
      expiresAt: when,
    });
    const args = argsFor("hq_memory_write")!;
    expect(args.p_expires_at).toBe("2026-07-01T12:00:00.000Z");
    expect(args.p_visibility).toBe("private");
    expect(args.p_salience).toBe(73);
  });

  it("surfaces an approval-withheld write as { id: null, approvalRequired: true }", async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === "hq_memory_write" ? { data: null, error: null } : { data: null, error: null },
    );
    const mem = createMemory({ employeeId: EMP });
    const res = await mem.remember({
      class: "semantic",
      type: "fact",
      title: "shared",
      body: "company-wide knowledge",
      visibility: "public_hq",
    });
    expect(res).toEqual({ id: null, approvalRequired: true });
  });

  it("returns the new id with approvalRequired:false on an autonomous commit", async () => {
    const mem = createMemory({ employeeId: EMP });
    const res = await mem.remember({ class: "episodic", type: "note", title: "t", body: "b" });
    expect(res).toEqual({ id: "new-id", approvalRequired: false });
  });
});

// ---------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------

describe("ctx.memory.resolve — structural recall over an entity reference", () => {
  it("drives recall by subject (no free-text query) and reports found", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_memory_recall") return { data: [candRow({ id: "r1" })], error: null };
      return { data: null, error: null };
    });
    const mem = createMemory({ employeeId: EMP });
    const res = await mem.resolve({ kind: "customer", id: "acme", label: "Acme Co" });

    const args = argsFor("hq_memory_recall")!;
    expect(args.p_employee_id).toBe(EMP);
    expect(args.p_query).toBeNull();
    expect(args.p_subject_kind).toBe("customer");
    expect(args.p_subject_id).toBe("acme");
    expect(res.found).toBe(true);
    expect(res.ref.label).toBe("Acme Co");
    expect(res.items[0]!.id).toBe("r1");
  });

  it("reports found:false when the entity has no permitted memories", async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === "hq_memory_recall" ? { data: [], error: null } : { data: null, error: null },
    );
    const mem = createMemory({ employeeId: EMP });
    const res = await mem.resolve({ kind: "feature", id: "ghost" });
    expect(res.found).toBe(false);
    expect(res.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// search — raw, no assembly drop, no reinforcement
// ---------------------------------------------------------------------

describe("ctx.memory.search — raw ranked lookup, no reinforcement", () => {
  it("stamps identity, maps opts, and does NOT reinforce", async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === "hq_memory_recall"
        ? {
            data: [candRow({ id: "x1", ts_rank: 0.9 }), candRow({ id: "x2", ts_rank: 0.8 })],
            error: null,
          }
        : { data: null, error: null },
    );
    const mem = createMemory({ employeeId: EMP });
    const items = await mem.search("dup check", { limit: 5, classes: ["episodic"] });

    const args = argsFor("hq_memory_recall")!;
    expect(args.p_employee_id).toBe(EMP);
    expect(args.p_query).toBe("dup check");
    expect(args.p_class_filter).toEqual(["episodic"]);
    expect(args.p_limit).toBe(5);
    expect(items.map((i) => i.id)).toEqual(["x1", "x2"]);
    expect(called("hq_memory_reinforce")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------

describe("ctx.memory.forget — stamps identity, forwards id + reason", () => {
  it("calls hq_memory_forget with the bound employee, the id, and the reason", async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === "hq_memory_forget"
        ? { data: { ok: true, memory_id: "g1", version: 2 }, error: null }
        : { data: null, error: null },
    );
    const mem = createMemory({ employeeId: EMP });
    await mem.forget("g1", "stale");

    const args = argsFor("hq_memory_forget")!;
    expect(args.p_employee_id).toBe(EMP);
    expect(args.p_memory_id).toBe("g1");
    expect(args.p_reason).toBe("stale");
  });

  it("throws a friendly error when the employee does not own the memory", async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === "hq_memory_forget"
        ? { data: { ok: false, reason: "not_owner" }, error: null }
        : { data: null, error: null },
    );
    const mem = createMemory({ employeeId: OTHER });
    await expect(mem.forget("g1", "x")).rejects.toThrow(/only forget memory it owns/);
  });
});

// ---------------------------------------------------------------------
// identity immutability + throw-on-error
// ---------------------------------------------------------------------

describe("ctx.memory — identity is frozen and failures throw", () => {
  it("exposes a frozen copy of the bound identity", () => {
    const mem = createMemory({ employeeId: EMP, department: "sales", memoryScope: "department" });
    expect(mem.identity.employeeId).toBe(EMP);
    expect(Object.isFrozen(mem.identity)).toBe(true);
    expect(() => {
      (mem.identity as { employeeId: string }).employeeId = OTHER;
    }).toThrow();
  });

  it("every verb rejects when the underlying RPC errors", async () => {
    rpcMock.mockImplementation(() => ({ data: null, error: { message: "boom" } }));
    const mem = createMemory({ employeeId: EMP });
    await expect(mem.recall({ query: "x" })).rejects.toThrow(/recall failed/);
    await expect(
      mem.remember({ class: "episodic", type: "n", title: "t", body: "b" }),
    ).rejects.toThrow(/remember failed/);
    await expect(mem.resolve({ kind: "k", id: "i" })).rejects.toThrow(/resolve failed/);
    await expect(mem.forget("g1", "r")).rejects.toThrow(/forget failed/);
    await expect(mem.search("q")).rejects.toThrow(/search failed/);
  });
});
