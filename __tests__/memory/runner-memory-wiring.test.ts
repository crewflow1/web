import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the runners' shared-memory wiring
 * (server/services/hq-runner-memory.ts → recallForTask / rememberForTask).
 *
 * This is the ONE seam the deterministic runners (research / qualification /
 * outreach) call to recall before acting and remember after. We mock ONLY the
 * admin client's RPC surface + the (dark) embedding provider, so the REAL memory
 * facet (server/sdk/memory.ts), the REAL service functions (recallMemory /
 * rememberMemory) and the REAL pure capability predicate all execute — only the
 * DB round-trip is faked. That pins:
 *
 *   - the CAPABILITY GATE is honoured BEFORE any DB call: an employee whose
 *     resolved tokens carry no memory capability (e.g. lead-qualification's
 *     read/score/qualify) never round-trips to hq_memory_recall / hq_memory_write;
 *   - a memory-capable employee (the `memory` scope, or the fine recall_memory /
 *     write_memory tools) DOES call the real primitives and gets a real result;
 *   - recall runs lexical + structural with NO embedding (the provider is dark);
 *   - degradation, not failure: a primitive error returns null, never throws, so
 *     an auxiliary memory hiccup can't sink an otherwise-good run.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));
// The embedding provider is DARK — recall must degrade to lexical + structural.
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn(() => null) }));

import { createMemory, type BoundMemory } from "@/server/sdk/memory";
import type { ResolvedCapabilitySet } from "@/server/sdk/tasks";
import {
  recallForTask,
  rememberForTask,
  type MemoryCapableContext,
} from "@/server/services/hq-runner-memory";

const EMP = "11111111-1111-1111-1111-111111111111";
const TASK = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown>;

/** A complete candidate row as hq_memory_recall projects it (snake_case). */
function memRow(over: Row = {}): Row {
  return {
    id: "m1",
    memory_class: "semantic",
    memory_type: "fact",
    title: "Acme prior research",
    summary: "Acme is a mid-size builder in the North West.",
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

function caps(tokens: string[]): ResolvedCapabilitySet {
  return Object.freeze({ tokens: Object.freeze([...tokens]), source: "registry" });
}

function ctxWith(tokens: string[]): MemoryCapableContext {
  const memory: BoundMemory = createMemory({ employeeId: EMP, currentTaskId: TASK });
  return { memory, capabilities: caps(tokens) };
}

function callsTo(fn: string): number {
  return rpcMock.mock.calls.filter((c) => c[0] === fn).length;
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe("recallForTask — capability-gated read side", () => {
  it("a memory-capable employee (the `memory` token) recalls through the real primitive", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_memory_recall") return { data: [memRow(), memRow({ id: "m2" })], error: null };
      return { data: null, error: null }; // reinforce is best-effort
    });

    const res = await recallForTask(ctxWith(["read", "research", "memory"]), {
      query: "Acme",
      subject: { kind: "organisation", id: "co-1" },
    });

    expect(res).not.toBeNull();
    expect(res!.items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(callsTo("hq_memory_recall")).toBe(1);
    // The recalled ids are captured on the bound facet as evidence (XIII §10).
    // (The runner drains ctx.memory.evidence() into the output envelope.)
  });

  it("the fine `recall_memory` tool token also opens the read side", async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === "hq_memory_recall" ? { data: [memRow()], error: null } : { data: null, error: null },
    );
    const res = await recallForTask(ctxWith(["read", "draft", "recall_memory"]), { query: "Acme" });
    expect(res).not.toBeNull();
    expect(callsTo("hq_memory_recall")).toBe(1);
  });

  it("an employee with NO memory capability never touches the DB (default-deny floor)", async () => {
    // lead-qualification's real resolved tokens — read / score / qualify.
    const res = await recallForTask(ctxWith(["read", "score", "qualify"]), { query: "Acme" });
    expect(res).toBeNull();
    expect(callsTo("hq_memory_recall")).toBe(0);
  });

  it("degrades to null (never throws) when the primitive errors", async () => {
    rpcMock.mockImplementation(() => ({ data: null, error: { message: "boom" } }));
    const res = await recallForTask(ctxWith(["memory"]), { query: "Acme" });
    expect(res).toBeNull();
  });
});

describe("rememberForTask — capability-gated write side", () => {
  it("a write-capable employee records the real outcome through hq_memory_write", async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === "hq_memory_write" ? { data: "new-mem-id", error: null } : { data: null, error: null },
    );

    const res = await rememberForTask(ctxWith(["read", "memory", "write_memory"]), {
      class: "episodic",
      type: "research_outcome",
      title: "Researched Acme",
      body: "Buying score: 72/100",
      salience: 60,
    });

    expect(res).toEqual({ id: "new-mem-id", approvalRequired: false });
    expect(callsTo("hq_memory_write")).toBe(1);
  });

  it("an employee with NO write capability never writes (default-deny floor)", async () => {
    const res = await rememberForTask(ctxWith(["read", "score", "qualify"]), {
      class: "episodic",
      type: "qualification_decision",
      title: "Qualified Acme",
      body: "qualified",
    });
    expect(res).toBeNull();
    expect(callsTo("hq_memory_write")).toBe(0);
  });

  it("degrades to null (never throws) when the write errors", async () => {
    rpcMock.mockImplementation(() => ({ data: null, error: { message: "boom" } }));
    const res = await rememberForTask(ctxWith(["memory"]), {
      class: "episodic",
      type: "research_outcome",
      title: "x",
      body: "y",
    });
    expect(res).toBeNull();
  });
});
