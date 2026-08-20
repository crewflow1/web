import { describe, it, expect, vi } from "vitest";

// hq-apply-drain is server-only and its module graph reaches createAdminClient (never CALLED at
// import); stub the admin + server-only seams so the module imports cleanly in the node test env.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import {
  createGatedAutonomousApplyAuthority,
  createInMemoryApplyAuditSink,
  type BoundToolRegistry,
} from "@/server/sdk/autonomous-apply";
import {
  createGatedApplyAuthority,
  runApplyOnApprovalDrain,
  type ApprovedItem,
} from "@/server/services/hq-apply-drain";
import { createInMemoryApplicationStore } from "@/server/sdk/application";
import type { BoundToolImplementation } from "@/server/sdk/executor";
import type { ProposedAction } from "@/server/sdk/gate";

/**
 * CrewFlow HQ — the GATED production apply authorities (P2 HQ Autonomous Apply).
 *
 * These are the completed, production authorities a CEO activation would switch to (the autonomous
 * inline path + the apply-on-approval sweep). This suite proves the whole safety posture:
 *
 *   • LOCKED BY DEFAULT: with FEATURE_HQ_AUTONOMOUS_APPLY off (the production default) EVERY descriptor
 *     resolves to null — nothing is planned, executed, verified, rolled back, or applied. The only
 *     record is a `refused` audit entry.
 *   • BEHIND THE FLAG the machinery runs end-to-end: plan → execute → verify → rollback → audit, and
 *     the sweep applies exactly once through the bound boundary.
 *   • DETERMINISTIC-ONLY: an irreversible tool is declined even behind the flag.
 */

const ON = { FEATURE_HQ_AUTONOMOUS_APPLY: "on" } as const;

type Counting = BoundToolImplementation & { calls: { applied: number; rolledBack: number } };

/** A reversible bound memory.write whose apply/verify/rollback calls are counted on `.calls`. */
function memoryWriteBound(over: Partial<BoundToolImplementation> = {}): Counting {
  const calls = { applied: 0, rolledBack: 0 };
  const impl: Counting = {
    label: "memory.write",
    apply: async (args) => {
      calls.applied += 1;
      return { echoed: args };
    },
    verify: async () => true,
    rollback: async () => {
      calls.rolledBack += 1;
    },
    ...over,
    calls,
  };
  return impl;
}

function boundRegistry(impl: BoundToolImplementation): BoundToolRegistry {
  return new Map([[impl.label, impl]]);
}

const passing = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  type: "memory.write",
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: true,
  typedTarget: true,
  payload: { verdict: "qualified" },
  ...over,
});

// =====================================================================
// The autonomous authority
// =====================================================================

describe("createGatedAutonomousApplyAuthority — LOCKED by default (flag off)", () => {
  it("resolves EVERY action to null and records a refused audit entry", () => {
    const audit = createInMemoryApplyAuditSink();
    const authority = createGatedAutonomousApplyAuthority({
      env: {}, // flag off
      bound: boundRegistry(memoryWriteBound()),
      audit,
    });
    expect(authority.resolve(passing())).toBeNull();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ path: "autonomous", stage: "refused" });
    expect(audit.entries[0]!.detail).toMatch(/locked/);
  });
});

describe("createGatedAutonomousApplyAuthority — behind the flag it applies, verifies, audits", () => {
  it("returns a boundary that applies + verifies, recording the full stage trail", async () => {
    const audit = createInMemoryApplyAuditSink();
    const impl = memoryWriteBound();
    const authority = createGatedAutonomousApplyAuthority({ env: ON, bound: boundRegistry(impl), audit });
    const invoke = authority.resolve(passing());
    expect(invoke).not.toBeNull();
    const result = await invoke!({ verdict: "qualified" });
    expect(result).toEqual({ echoed: { verdict: "qualified" } });
    expect(impl.calls.applied).toBe(1);
    const entry = audit.entries.at(-1)!;
    expect(entry).toMatchObject({ path: "autonomous", stage: "verified" });
    expect(entry.steps.map((s) => s.stage)).toEqual(["approved", "executed", "verified"]);
  });

  it("a failed verification ROLLS BACK, audits rolled_back, and the boundary THROWS", async () => {
    const audit = createInMemoryApplyAuditSink();
    const impl = memoryWriteBound({ verify: async () => false });
    const authority = createGatedAutonomousApplyAuthority({ env: ON, bound: boundRegistry(impl), audit });
    const invoke = authority.resolve(passing())!;
    await expect(invoke({ verdict: "qualified" })).rejects.toThrow(/verification failed/);
    expect(impl.calls.rolledBack).toBe(1);
    expect(audit.entries.at(-1)).toMatchObject({ stage: "rolled_back" });
  });

  it("DETERMINISTIC-ONLY: an irreversible tool (comm.send) is declined even behind the flag", () => {
    const audit = createInMemoryApplyAuditSink();
    const commBound: BoundToolImplementation = { label: "comm.send", apply: async () => ({ sent: true }) };
    const authority = createGatedAutonomousApplyAuthority({
      env: ON,
      bound: boundRegistry(commBound),
      audit,
    });
    const action = passing({ type: "comm.send", payload: { channel: "email", body: "hi" } });
    expect(authority.resolve(action)).toBeNull();
    expect(audit.entries.at(-1)).toMatchObject({ stage: "refused" });
    expect(audit.entries.at(-1)!.detail).toMatch(/non-deterministic/);
  });

  it("an UNMAPPED tool declines (no bound implementation)", () => {
    const authority = createGatedAutonomousApplyAuthority({ env: ON, bound: new Map() });
    expect(authority.resolve(passing())).toBeNull();
  });

  it("an UNPLANNABLE action (payload fails the tool argSchema) declines before any effect", () => {
    const impl = memoryWriteBound();
    const authority = createGatedAutonomousApplyAuthority({ env: ON, bound: boundRegistry(impl) });
    // memory.write requires a non-empty `verdict`; an empty payload fails the schema.
    expect(authority.resolve(passing({ payload: {} }))).toBeNull();
    expect(impl.calls.applied).toBe(0);
  });
});

// =====================================================================
// The apply-on-approval authority
// =====================================================================

function approvedItem(id: string, over: Partial<ApprovedItem> = {}): ApprovedItem {
  return {
    kind: "approval",
    id,
    identity: {
      source: "approval",
      correlationId: `corr-${id}`,
      approvalId: id,
      toolLabel: "memory.write",
      actionId: `lead:${id}:memory.write`,
    },
    approver: { approverId: "rev-1", approverEmail: "reviewer@crewflow.uk" },
    descriptor: {
      type: "memory.write",
      subjectType: "lead",
      subjectId: id,
      payload: { verdict: "qualified" },
    },
    ...over,
  };
}

describe("createGatedApplyAuthority — LOCKED by default (flag off)", () => {
  it("resolves EVERY item to null and records a refused audit entry", () => {
    const audit = createInMemoryApplyAuditSink();
    const authority = createGatedApplyAuthority({
      env: {},
      bound: boundRegistry(memoryWriteBound()),
      audit,
    });
    expect(authority.resolve(approvedItem("a"))).toBeNull();
    expect(audit.entries.at(-1)).toMatchObject({ path: "approval", stage: "refused" });
    expect(audit.entries.at(-1)!.detail).toMatch(/locked/);
  });
});

describe("createGatedApplyAuthority — behind the flag the sweep applies exactly once", () => {
  it("applies an approved item through the bound boundary, verified, and idempotently", async () => {
    const audit = createInMemoryApplyAuditSink();
    const impl = memoryWriteBound();
    const store = createInMemoryApplicationStore();
    const deps = {
      env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on", FEATURE_HQ_AUTONOMOUS_APPLY: "on" },
      store,
      authority: createGatedApplyAuthority({ env: ON, bound: boundRegistry(impl), audit }),
      readApproved: async () => [approvedItem("a")],
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    };
    const first = await runApplyOnApprovalDrain(deps);
    expect(first).toMatchObject({ enabled: true, swept: 1, applied: 1, skipped: 0 });
    expect(impl.calls.applied).toBe(1);
    expect(audit.entries.at(-1)).toMatchObject({ path: "approval", stage: "verified" });

    // A re-run (the sweep re-ticks) must NOT re-apply — apply-once short-circuits.
    const second = await runApplyOnApprovalDrain(deps);
    expect(second).toMatchObject({ applied: 0, alreadyApplied: 1 });
    expect(impl.calls.applied).toBe(1);
  });

  it("a failed verification rolls back and records a FAILED apply (never a stuck applied marker)", async () => {
    const audit = createInMemoryApplyAuditSink();
    const impl = memoryWriteBound({ verify: async () => false });
    const store = createInMemoryApplicationStore();
    const summary = await runApplyOnApprovalDrain({
      env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" },
      store,
      authority: createGatedApplyAuthority({ env: ON, bound: boundRegistry(impl), audit }),
      readApproved: async () => [approvedItem("a")],
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(summary).toMatchObject({ applied: 0, failed: 1 });
    expect(impl.calls.rolledBack).toBe(1);
    expect(audit.entries.at(-1)).toMatchObject({ stage: "rolled_back" });
  });

  it("a strategic hq.decision has no tool to apply → declined (unmapped)", () => {
    const authority = createGatedApplyAuthority({ env: ON, bound: boundRegistry(memoryWriteBound()) });
    const decision: ApprovedItem = {
      kind: "decision",
      id: "d1",
      identity: {
        source: "approval",
        correlationId: "d1",
        approvalId: "d1",
        toolLabel: "hq.decision",
        actionId: "decision:d1",
      },
      approver: null,
      descriptor: { type: "hq.decision", payload: {} },
    };
    expect(authority.resolve(decision)).toBeNull();
  });
});

describe("the gated authority stays DARK inside a real sweep while the flag is off", () => {
  it("kill-switch ON but FEATURE flag OFF ⇒ every item skipped, nothing applied or recorded", async () => {
    const impl = memoryWriteBound();
    const inner = createInMemoryApplicationStore();
    let puts = 0;
    const store = {
      get: inner.get,
      put: async (r: Parameters<typeof inner.put>[0]) => {
        puts += 1;
        return inner.put(r);
      },
    };
    const summary = await runApplyOnApprovalDrain({
      env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" }, // sweep on, but FEATURE flag absent (locked)
      store,
      authority: createGatedApplyAuthority({ env: {}, bound: boundRegistry(impl) }),
      readApproved: async () => [approvedItem("a"), approvedItem("b")],
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(summary).toMatchObject({ enabled: true, swept: 2, applied: 0, skipped: 2 });
    expect(impl.calls.applied).toBe(0);
    expect(puts, "a locked authority must never record an application marker").toBe(0);
  });
});
