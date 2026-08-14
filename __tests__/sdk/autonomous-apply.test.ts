import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BoundEvents } from "@/server/sdk/events";
import type { EmploymentPosture, ProposedAction } from "@/server/sdk/gate";

/**
 * Unit proof for the P2 autonomous-apply path — the executor finally COMPOSED into the runner's
 * autonomous branch (server/sdk/tasks.ts, server/sdk/autonomous-apply.ts).
 *
 * The R1/R2 shadow only PLANNED (observed, never applied). P2 adds the DETERMINISTIC apply: on an
 * autonomous verdict, the runner plans, asks the sanctioned authority for a tool implementation, and
 * — only if one is bound — crosses the boundary EXACTLY ONCE via applyOnce. This suite pins:
 *
 *   - DARK BY DEFAULT: apply is off unless wired; the production authority is UNBOUND (resolves
 *     everything to null), so nothing is applied even with the flag on.
 *   - the kill-switch reads exactly CREWFLOW_EXECUTOR_APPLY === "on".
 *   - a BOUND deterministic authority applies through the executor, exactly once, idempotently.
 *   - GENERATIVE / irreversible / unmapped actions resolve to null and are skipped (the audit +
 *     shadow still happen; nothing is fabricated).
 *   - apply rides ONLY the autonomous branch; a needs-approval action never applies.
 *   - BEST-EFFORT: a throwing authority never breaks the run.
 *
 * Same harness as propose-actions.test.ts: mock the Approval Engine, stub the admin client + the
 * embeddings module so the runner's module graph imports cleanly. Nothing real is reached for.
 */

const { requestApprovalMock } = vi.hoisted(() => ({ requestApprovalMock: vi.fn() }));

vi.mock("@/server/services/hq-approvals", () => ({ requestApproval: requestApprovalMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai/embeddings", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));

import {
  createProposeActions,
  executorAutonomousApplyEnabled,
  type EmployeeIdentity,
} from "@/server/sdk/tasks";
import { createUnboundAutonomousApplyAuthority } from "@/server/sdk/autonomous-apply";
import type { AutonomousApplyAuthority } from "@/server/sdk/autonomous-apply";
import type { ToolImplementation } from "@/server/sdk/executor";
import {
  createInMemoryApplicationStore,
  type ApplicationStore,
} from "@/server/sdk/application";

const CORR = "corr-run-1";

/** A posture that PERMITS autonomy — the opposite of the Built default-locked floor. */
const permits: EmploymentPosture = { canExecute: true, requiresApproval: false };

function makeEvents() {
  const emit = vi.fn().mockResolvedValue({ ok: true, id: 1 });
  const facet: BoundEvents = { identity: Object.freeze({ slug: "research-ai" }), emit };
  return { facet, emit };
}

/** A proposed action that passes every layer + atom under `permits` (so it is autonomous). */
const passing = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  type: "memory.write",
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: true,
  typedTarget: true,
  payload: { verdict: "qualified" }, // valid memory.write args, so the executor can PLAN it
  ...over,
});

/** An authority bound to a single deterministic tool (memory.write), else declines (null). */
function boundAuthority(invoke: ToolImplementation): AutonomousApplyAuthority {
  return { resolve: (a) => (a.type === "memory.write" ? invoke : null) };
}

function deps(over: Partial<Parameters<typeof createProposeActions>[0]> = {}) {
  const { facet, emit } = makeEvents();
  const built = {
    identity: { employeeId: "emp-1", slug: "research-ai" } as EmployeeIdentity,
    posture: permits,
    capabilities: { tokens: [] as string[], source: "none" as const },
    budget: 1_000,
    correlationId: CORR,
    events: facet,
    taskId: "task-1",
    ...over,
  };
  return { built, emit };
}

beforeEach(() => {
  requestApprovalMock.mockReset();
  requestApprovalMock.mockResolvedValue({ ok: true, approval: { id: "appr-1" } });
});

// =====================================================================
// The kill-switch + the unbound authority — dark by default
// =====================================================================

describe("autonomous apply — the kill-switch is default OFF", () => {
  it("is off unless CREWFLOW_EXECUTOR_APPLY is exactly 'on'", () => {
    expect(executorAutonomousApplyEnabled({})).toBe(false);
    expect(executorAutonomousApplyEnabled({ CREWFLOW_EXECUTOR_APPLY: "off" })).toBe(false);
    expect(executorAutonomousApplyEnabled({ CREWFLOW_EXECUTOR_APPLY: "ON" })).toBe(false);
    expect(executorAutonomousApplyEnabled({ CREWFLOW_EXECUTOR_APPLY: "on" })).toBe(true);
  });
});

describe("autonomous apply — the production authority is UNBOUND (dark)", () => {
  it("resolves EVERY action to null — nothing is ever applied through it", () => {
    const authority = createUnboundAutonomousApplyAuthority();
    expect(authority.resolve(passing())).toBeNull();
    expect(authority.resolve(passing({ type: "comm.send" }))).toBeNull();
  });
});

// =====================================================================
// Apply disabled (the default) — the store is never touched
// =====================================================================

describe("autonomous apply — disabled by default, even on an autonomous verdict", () => {
  it("apply flag off → nothing is applied, though the audit still emits", async () => {
    const store = createInMemoryApplicationStore();
    const invoke = vi.fn();
    const { built, emit } = deps({
      apply: false,
      applyAuthority: boundAuthority(invoke as unknown as ToolImplementation),
      applyStore: store,
    });
    const [verdict] = await createProposeActions(built)([passing()]);
    expect(verdict!.decision).toBe("autonomous");
    expect(emit).toHaveBeenCalledTimes(1); // audit still happens
    expect(invoke).not.toHaveBeenCalled(); // but nothing crossed the boundary
    expect(await store.get("autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·corr-run-1")).toBeUndefined();
  });

  it("apply ON but UNBOUND authority → still nothing applied (dark by the authority)", async () => {
    const store = createInMemoryApplicationStore();
    const { built } = deps({
      apply: true,
      applyAuthority: createUnboundAutonomousApplyAuthority(),
      applyStore: store,
    });
    await createProposeActions(built)([passing()]);
    expect(await store.get("autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·corr-run-1")).toBeUndefined();
  });
});

// =====================================================================
// Apply enabled + a bound deterministic authority — the executor applies
// =====================================================================

describe("autonomous apply — a BOUND deterministic authority applies through the executor", () => {
  const KEY = "autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·corr-run-1";

  it("crosses the boundary once and records an APPLIED marker keyed by the autonomous identity", async () => {
    const store = createInMemoryApplicationStore();
    const invoke = vi.fn(async (args: Record<string, unknown>) => ({ echoed: args }));
    const { built } = deps({
      apply: true,
      applyAuthority: boundAuthority(invoke as unknown as ToolImplementation),
      applyStore: store,
    });

    const [verdict] = await createProposeActions(built)([passing()]);

    expect(verdict!.decision).toBe("autonomous");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toEqual({ verdict: "qualified" }); // the validated args
    const rec = await store.get(KEY);
    expect(rec).toMatchObject({ status: "applied", label: "memory.write" });
  });

  it("IDEMPOTENT: applying the same identity twice crosses the boundary only ONCE", async () => {
    const store = createInMemoryApplicationStore();
    const invoke = vi.fn(async () => ({ ok: true }));
    const built = () =>
      deps({
        apply: true,
        applyAuthority: boundAuthority(invoke as unknown as ToolImplementation),
        applyStore: store,
      }).built;

    await createProposeActions(built())([passing()]);
    await createProposeActions(built())([passing()]); // a task RETRY — same identity

    expect(invoke).toHaveBeenCalledTimes(1); // applyOnce short-circuits the second attempt
    const rec = await store.get(KEY);
    expect(rec).toMatchObject({ status: "applied" });
  });
});

// =====================================================================
// Deterministic ONLY — generative / irreversible / unmapped degrade to null
// =====================================================================

describe("autonomous apply — DETERMINISTIC ONLY; an unmapped/generative action degrades to null", () => {
  it("an action the authority declines is skipped — nothing applied, the audit still emits", async () => {
    const store = createInMemoryApplicationStore();
    // Authority declines everything except memory.write; comm.send (irreversible) → null.
    const invoke = vi.fn();
    const { built, emit } = deps({
      apply: true,
      applyAuthority: boundAuthority(invoke as unknown as ToolImplementation),
      applyStore: store,
    });

    // comm.send needs channel+body; make it a valid, bounded, reversible-flagged autonomous action
    // so the ONLY thing stopping the apply is the authority declining (deterministic-only rule).
    await createProposeActions(built)([
      passing({ type: "comm.send", payload: { channel: "email", body: "hi" } }),
    ]);

    expect(invoke).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1); // audit still happens — the action is left for approval-path
  });
});

// =====================================================================
// Apply rides ONLY the autonomous branch + best-effort
// =====================================================================

describe("autonomous apply — rides only the autonomous branch, and is best-effort", () => {
  it("a needs-approval action never applies (the store is untouched)", async () => {
    const store = createInMemoryApplicationStore();
    const invoke = vi.fn();
    const { built } = deps({
      apply: true,
      applyAuthority: boundAuthority(invoke as unknown as ToolImplementation),
      applyStore: store,
    });
    await createProposeActions(built)([passing({ reversible: false })]); // → needs_approval
    expect(invoke).not.toHaveBeenCalled();
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });

  it("BEST-EFFORT: a throwing authority never breaks the run — the verdict still resolves", async () => {
    const store = createInMemoryApplicationStore();
    const throwing: ApplicationStore = store;
    const authority: AutonomousApplyAuthority = {
      resolve: () => {
        throw new Error("authority boom");
      },
    };
    const { built } = deps({ apply: true, applyAuthority: authority, applyStore: throwing });
    const [verdict] = await createProposeActions(built)([passing()]);
    expect(verdict!.decision).toBe("autonomous"); // resolved, not thrown
  });
});
