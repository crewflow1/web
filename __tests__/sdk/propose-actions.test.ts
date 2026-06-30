import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BoundEvents } from "@/server/sdk/events";
import type { EmploymentPosture, ProposedAction } from "@/server/sdk/gate";

/**
 * Unit proof for the doorman RUNTIME — the `ctx.proposeActions`
 * composition (server/sdk/tasks.ts)
 * (CEO Directive #014 / D-04, Phase B; ADR 0008 Decisions 4 & 8; Bible Volume XIII §8/§16).
 *
 * The PURE gate (gate.ts) decides POLICY; this is the MECHANISM it must never know about
 * (the Policy vs Mechanism rule — Kernel Contract Map §2). The gate is proven by a table in
 * gate.test.ts; here we pin exactly what the runtime ADDS on top of a verdict:
 *
 *   - proposeActions ROUTES by verdict (CEO §11): an `autonomous` action emits one audit
 *     event (`ai.action_permitted`) and NO approval row; a `needs_approval` action calls
 *     requestApproval ONCE, threading the run's correlation, and emits NO audit event.
 *   - the audit emit is BEST-EFFORT — a failed spine append (the facet returns { ok:false })
 *     never breaks the run; proposeActions still resolves with the verdict.
 *   - the approval hand-off is the THROW-BASED ABI — a refused/failed requestApproval becomes
 *     a thrown Error, so the Task Engine records the run as a failure rather than silently
 *     dropping a side effect the gate said a human must see.
 *   - verdicts are returned in input order; the runtime collects, it does not reorder.
 *
 * The Approval Engine is the one service this seam hands off to, so we mock IT (mirroring
 * comms-sdk.test.ts) and inject a fake events facet; the admin client + embeddings are
 * stubbed only so the runner module graph imports cleanly. Nothing real is reached for.
 */

const { requestApprovalMock } = vi.hoisted(() => ({ requestApprovalMock: vi.fn() }));

vi.mock("@/server/services/hq-approvals", () => ({ requestApproval: requestApprovalMock }));
// Import-safety only: the runner's module graph pulls these in; neither is exercised here.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai/embeddings", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));

import {
  createProposeActions,
  LOCKED_POSTURE,
  EMPTY_CAPABILITIES,
  type EmployeeIdentity,
} from "@/server/sdk/tasks";
import { REFERENCE_EXECUTOR, type Executor } from "@/server/sdk/executor";

const CORR = "corr-run-1";

/** A posture that PERMITS autonomy — the opposite of the Built default-locked floor. */
const permits: EmploymentPosture = { canExecute: true, requiresApproval: false };

/** A spy events facet recording every emit; resolves ok by default (best-effort surface). */
function makeEvents() {
  const emit = vi.fn().mockResolvedValue({ ok: true, id: 1 });
  const facet: BoundEvents = { identity: Object.freeze({ slug: "research-ai" }), emit };
  return { facet, emit };
}

/** The deps the runner closes over in buildContext — overridable per case. */
function deps(over: Partial<Parameters<typeof createProposeActions>[0]> = {}) {
  const { facet, emit } = makeEvents();
  const built = {
    identity: { employeeId: "emp-1", slug: "research-ai" } as EmployeeIdentity,
    posture: permits,
    capabilities: EMPTY_CAPABILITIES,
    budget: 1_000,
    correlationId: CORR,
    events: facet,
    ...over,
  };
  return { built, emit };
}

/** A proposed action that passes every layer + atom under `permits` (so it is autonomous). */
const passing = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  type: "memory.write",
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: true,
  typedTarget: true,
  ...over,
});

beforeEach(() => {
  requestApprovalMock.mockReset();
  requestApprovalMock.mockResolvedValue({ ok: true, approval: { id: "appr-1" } });
});

// =====================================================================
// proposeActions — autonomous routing (audit emit, no approval)
// =====================================================================

describe("ctx.proposeActions — an autonomous verdict is audited, never queued", () => {
  it("emits ai.action_permitted once and requests NO approval", async () => {
    const { built, emit } = deps();
    const proposeActions = createProposeActions(built);

    const [verdict] = await proposeActions([passing()]);

    expect(verdict).toEqual({ decision: "autonomous", reasons: [] });
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      verb: "ai.action_permitted",
      objectType: "lead",
      objectId: "lead_1",
      payload: { action: "memory.write", capability: null },
    });
  });

  it("carries the action's capability into the audit payload", async () => {
    const { built, emit } = deps({ capabilities: { tokens: ["email.read"], source: "ai_employees" } });
    const proposeActions = createProposeActions(built);
    await proposeActions([passing({ capability: "email.read" })]);
    expect(emit.mock.calls[0]![0]).toMatchObject({ payload: { capability: "email.read" } });
  });

  it("BEST-EFFORT: a failed spine append never breaks the run", async () => {
    const { built, emit } = deps();
    emit.mockResolvedValueOnce({ ok: false, error: "spine_down" });
    const proposeActions = createProposeActions(built);
    const [verdict] = await proposeActions([passing()]);
    expect(verdict!.decision).toBe("autonomous"); // resolved, not thrown
    expect(requestApprovalMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// proposeActions — needs-approval routing (hand off, correlation-threaded)
// =====================================================================

describe("ctx.proposeActions — a needs-approval verdict is handed to the Approval Engine", () => {
  it("calls requestApproval ONCE with the threaded correlation and emits no audit event", async () => {
    const { built, emit } = deps();
    const proposeActions = createProposeActions(built);

    const [verdict] = await proposeActions([passing({ reversible: false })]); // fails P4 atom 1

    expect(verdict!.decision).toBe("needs_approval");
    expect(emit).not.toHaveBeenCalled();
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(requestApprovalMock.mock.calls[0]![0]).toMatchObject({
      aiEmployeeId: "emp-1",
      subjectType: "lead",
      subjectId: "lead_1",
      action: "memory.write",
      correlationId: CORR,
    });
  });

  it("threads the proposed payload into the approval request", async () => {
    const { built } = deps();
    const proposeActions = createProposeActions(built);
    await proposeActions([passing({ reversible: false, payload: { body: "hi" } })]);
    expect(requestApprovalMock.mock.calls[0]![0]).toMatchObject({ proposedPayload: { body: "hi" } });
  });

  it("the LOCKED posture forces approval even for an otherwise-autonomous action (deny-by-default flows through)", async () => {
    const { built, emit } = deps({ posture: LOCKED_POSTURE });
    const proposeActions = createProposeActions(built);
    const [verdict] = await proposeActions([passing()]); // every atom passes
    expect(verdict!.decision).toBe("needs_approval");
    expect(emit).not.toHaveBeenCalled();
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });

  it("THROW-BASED ABI: a refused/failed requestApproval becomes a thrown Error", async () => {
    requestApprovalMock.mockResolvedValue({ ok: false, error: "invalid_input" });
    const { built } = deps();
    const proposeActions = createProposeActions(built);
    await expect(proposeActions([passing({ reversible: false })])).rejects.toThrow(
      /ctx\.proposeActions: requestApproval failed: invalid_input/,
    );
  });
});

// =====================================================================
// proposeActions — batch composition (verdicts in input order)
// =====================================================================

describe("ctx.proposeActions — batch routing preserves order and routes each independently", () => {
  it("returns verdicts in input order, routing each by its own verdict", async () => {
    const { built, emit } = deps();
    const proposeActions = createProposeActions(built);

    const verdicts = await proposeActions([
      passing(), // autonomous → audit
      passing({ subjectId: "*" }), // unbounded blast radius → approval
      passing(), // autonomous → audit
    ]);

    expect(verdicts.map((v) => v.decision)).toEqual(["autonomous", "needs_approval", "autonomous"]);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });

  it("an empty batch is a no-op that touches neither mechanism", async () => {
    const { built, emit } = deps();
    const proposeActions = createProposeActions(built);
    expect(await proposeActions([])).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(requestApprovalMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// proposeActions — the R1 executor shadow (CEO Directive #016 / D-06; ADR 0011)
//
// R1 COMPOSES the proven `plan → key` chain onto the autonomous branch, SHADOW-FIRST: default-OFF,
// and even ON it only OBSERVES — it threads a side-effect-free observation onto the SAME
// `ai.action_permitted` event and crosses NO tool boundary (the Runtime Composition Rule: "the
// runtime composes established components; composition is orchestration, not duplication").
// =====================================================================

/** A spying executor whose `plan` delegates to `planImpl`; `apply`/`execute` are spies that must
 *  never be reached by the shadow (R1 is observe-only). Typed as {@link Executor} for the deps. */
function spyExecutor(planImpl: Executor["plan"]) {
  const plan = vi.fn(planImpl);
  const apply = vi.fn();
  const execute = vi.fn();
  return { executor: { plan, apply, execute } as unknown as Executor, plan, apply, execute };
}

describe("ctx.proposeActions — the R1 executor shadow is OFF by default (audit continuity)", () => {
  it("with no shadow flag, the autonomous payload is byte-identical to before (no `shadow` key)", async () => {
    const { built, emit } = deps(); // shadow defaults false
    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
    // EXACT equality (not toMatchObject): the payload carries ONLY the historical fields.
    expect(emit.mock.calls[0]![0]!.payload).toEqual({ action: "memory.write", capability: null });
  });

  it("explicit shadow:false is identical to the default — still no observation", async () => {
    const { built, emit } = deps({ shadow: false });
    await createProposeActions(built)([passing()]);
    expect(emit.mock.calls[0]![0]!.payload).toEqual({ action: "memory.write", capability: null });
  });
});

describe("ctx.proposeActions — the R1 executor shadow, ON, observes without crossing the boundary", () => {
  it("a plannable action records a `planned` observation: tool label + the derived idempotency key", async () => {
    const { built, emit } = deps({ shadow: true, taskId: "task-1" });

    const [verdict] = await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    expect(verdict!.decision).toBe("autonomous");
    expect(emit.mock.calls[0]![0]!.payload).toEqual({
      action: "memory.write",
      capability: null,
      shadow: {
        outcome: "planned",
        toolLabel: "memory.write",
        // autonomous · taskId · toolLabel · actionId(subjectType:subjectId:type) · correlationId
        idempotencyKey: "autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·corr-run-1",
      },
    });
  });

  it("the derived key is DETERMINISTIC — the same action yields the same key every run", async () => {
    const run = async () => {
      const { built, emit } = deps({ shadow: true, taskId: "task-1" });
      await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
      return (emit.mock.calls[0]![0]!.payload as { shadow: { idempotencyKey: string } }).shadow.idempotencyKey;
    };
    expect(await run()).toBe(await run());
  });

  it("an action the executor REFUSES records a `refused` observation (invalid_args — memory.write needs a verdict)", async () => {
    const { built, emit } = deps({ shadow: true, taskId: "task-1" });
    await createProposeActions(built)([passing()]); // no payload → fails the tool's argSchema
    const payload = emit.mock.calls[0]![0]!.payload as { shadow: { outcome: string; reason: string } };
    expect(payload.shadow.outcome).toBe("refused");
    expect(payload.shadow.reason).toBe("invalid_args");
  });

  it("an unknown tool records a `refused` observation with reason unknown_tool", async () => {
    const { built, emit } = deps({ shadow: true, taskId: "task-1" });
    await createProposeActions(built)([passing({ type: "memory.append" })]); // resolves to no reference tool
    const payload = emit.mock.calls[0]![0]!.payload as { shadow: { outcome: string; reason: string } };
    expect(payload.shadow.outcome).toBe("refused");
    expect(payload.shadow.reason).toBe("unknown_tool");
  });

  it("BEST-EFFORT: a throwing executor is captured as an `error` observation, never breaking the run", async () => {
    const { executor, apply, execute } = spyExecutor(() => {
      throw new Error("boom");
    });
    const { built, emit } = deps({ shadow: true, taskId: "task-1", executor });

    const [verdict] = await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    expect(verdict!.decision).toBe("autonomous"); // resolved, not thrown
    const payload = emit.mock.calls[0]![0]!.payload as { shadow: { outcome: string; detail: string } };
    expect(payload.shadow.outcome).toBe("error");
    expect(payload.shadow.detail).toBe("boom");
    expect(apply).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("NEVER crosses the boundary — apply/execute are untouched while plan is called once", async () => {
    const { executor, plan, apply, execute } = spyExecutor((a, v) => REFERENCE_EXECUTOR.plan(a, v));
    const { built } = deps({ shadow: true, taskId: "task-1", executor });
    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("the shadow rides ONLY the autonomous branch — a needs-approval action is never planned", async () => {
    const { executor, plan } = spyExecutor((a, v) => REFERENCE_EXECUTOR.plan(a, v));
    const { built, emit } = deps({ shadow: true, taskId: "task-1", executor });
    await createProposeActions(built)([passing({ reversible: false })]); // → needs_approval
    expect(plan).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });
});
