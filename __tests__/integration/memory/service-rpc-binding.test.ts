import { beforeAll, afterAll, it, expect } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { rememberMemory, recallMemory, forgetMemory } from "@/server/services/hq-memory";

/**
 * Shared Memory — service-layer RPC binding, real-Postgres proof
 * (Directive 009 Module 1 Final Validation).
 *
 * The write-path / recall-path integration suites call the SQL primitives
 * (`hq_memory_write`, `hq_memory_recall`, `hq_memory_forget`) DIRECTLY on a
 * Supabase client, so they never exercise the service wrappers
 * (`rememberMemory` / `recallMemory` / `forgetMemory`) — which reach those same
 * primitives through the private `callRpc` helper. The unit tier mocks the
 * client. So the wrapper's call path had NO real-client coverage.
 *
 * `callRpc` once *detached* the rpc method (`const run = admin.rpc; run(...)`),
 * dropping the `this` binding. supabase-js's `rpc()` delegates to `this.rest`,
 * so EVERY service RPC threw "Cannot read properties of undefined (reading
 * 'rest')" the instant it ran against a real client — invisible to the mocked
 * unit tier AND to the primitive-only integration tier. This suite closes that
 * gap: it drives the three RPC-bearing service functions end-to-end against
 * real Postgres, so a re-detached `callRpc` (a missing `.bind(admin)`) fails
 * loudly here instead of only in production.
 *
 * Skipped locally with no database; FAILED loudly in CI if the DB is missing.
 */

type IdRow = { id: string };

const created: string[] = [];
let empId = "";

async function makeEmployee(): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await serviceClient()
    .from("ai_employees" as never)
    .insert({
      name: `it-svc-${stamp}`,
      slug: `it-svc-${stamp}`,
      role: "Integration fixture",
      department: "sales",
      permissions: { can_execute: true, requires_approval: false, scopes: ["read"] },
    } as never)
    .select("id");
  const id = (ins.data as IdRow[] | null)?.[0]?.id;
  expect(typeof id, "fixture employee id").toBe("string");
  return id as string;
}

describeIntegration("Shared Memory · service-layer RPC binding (callRpc, real client)", () => {
  beforeAll(async () => {
    empId = await makeEmployee();
  });

  afterAll(async () => {
    for (const id of created) {
      await serviceClient().from("hq_memories" as never).delete().eq("id", id);
    }
    if (empId) await serviceClient().from("ai_employees" as never).delete().eq("id", empId);
  });

  it("rememberMemory() commits owned experience through callRpc (this stays bound)", async () => {
    const r = await rememberMemory(
      {
        memoryClass: "episodic",
        memoryType: "research",
        title: `IT svc remember ${crypto.randomUUID()}`,
        summary: "service-path probe",
        body: "service path probe body",
        visibility: "private",
      },
      { id: empId },
    );
    // The failure mode this guards: a detached rpc throws BEFORE returning, so
    // `r.ok === false` with the 'rest' message — assert a real commit instead.
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (r.ok) {
      expect(typeof r.id, "an autonomous owned write returns a uuid").toBe("string");
      expect(r.approvalRequired).toBe(false);
      if (r.id) created.push(r.id);
    }
  });

  it("recallMemory() assembles the employee's own memory through callRpc", async () => {
    const r = await recallMemory({ query: null, candidateLimit: 20, reinforce: false }, { id: empId });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (r.ok) {
      expect(Array.isArray(r.items)).toBe(true);
      expect(r.candidateCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("forgetMemory() retires an owned memory through callRpc", async () => {
    const w = await rememberMemory(
      {
        memoryClass: "episodic",
        memoryType: "research",
        title: `IT svc forget ${crypto.randomUUID()}`,
        body: "to be retired",
        visibility: "private",
      },
      { id: empId },
    );
    expect(w.ok, w.ok ? "" : w.error).toBe(true);
    if (!w.ok || !w.id) return;
    created.push(w.id);

    const f = await forgetMemory(w.id, "final-validation regression probe", { id: empId });
    expect(f.ok, f.ok ? "" : f.error).toBe(true);
    if (f.ok) {
      expect(f.id).toBe(w.id);
      expect(f.version).toBeGreaterThanOrEqual(1);
    }
  });
});
