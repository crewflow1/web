import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BoundEvents } from "@/server/sdk/events";
import type { EmploymentPosture, ProposedAction } from "@/server/sdk/gate";

/**
 * Unit proof for the doorman RUNTIME — `resolveEmployeePosture` + the `ctx.proposeActions`
 * composition (server/sdk/tasks.ts)
 * (CEO Directive #014 / D-04, Phase B; ADR 0008 Decisions 4 & 8; Bible Volume XIII §8/§16).
 *
 * The PURE gate (gate.ts) decides POLICY; this is the MECHANISM it must never know about
 * (the Policy vs Mechanism rule — Kernel Contract Map §2). The gate is proven by a table in
 * gate.test.ts; here we pin exactly what the runtime ADDS on top of a verdict:
 *
 *   - resolveEmployeePosture mirrors `normalizePermissions` EXACTLY — deny-by-default:
 *     can_execute is true only for literal `true`, requires_approval false only for literal
 *     `false`; an absent/garbage stance stays LOCKED. The result is frozen.
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
  resolveEmployeePosture,
  LOCKED_POSTURE,
  EMPTY_CAPABILITIES,
  type EmployeeIdentity,
} from "@/server/sdk/tasks";

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
// resolveEmployeePosture — mirrors normalizePermissions, deny-by-default
// =====================================================================

describe("resolveEmployeePosture — the coarse stance, resolved deny-by-default", () => {
  it("an absent permissions block is the LOCKED floor", () => {
    expect(resolveEmployeePosture({})).toEqual(LOCKED_POSTURE);
    expect(resolveEmployeePosture({ permissions: null })).toEqual(LOCKED_POSTURE);
    expect(resolveEmployeePosture({ permissions: {} })).toEqual({
      canExecute: false,
      requiresApproval: true,
    });
  });

  it("can_execute is true ONLY for literal true; requires_approval false ONLY for literal false", () => {
    expect(resolveEmployeePosture({ permissions: { can_execute: true, requires_approval: false } })).toEqual({
      canExecute: true,
      requiresApproval: false,
    });
    // can_execute set but approval still required → still gated
    expect(resolveEmployeePosture({ permissions: { can_execute: true } })).toEqual({
      canExecute: true,
      requiresApproval: true,
    });
    // approval waived but execution not granted → cannot act autonomously
    expect(resolveEmployeePosture({ permissions: { requires_approval: false } })).toEqual({
      canExecute: false,
      requiresApproval: false,
    });
  });

  it("garbage values never grant autonomy (only the exact booleans move the floor)", () => {
    const p = resolveEmployeePosture({
      // non-boolean truthy must NOT be read as permission
      permissions: { can_execute: 1 as unknown as boolean, requires_approval: 0 as unknown as boolean },
    });
    expect(p).toEqual({ canExecute: false, requiresApproval: true });
  });

  it("returns a frozen posture", () => {
    expect(Object.isFrozen(resolveEmployeePosture({ permissions: { can_execute: true } }))).toBe(true);
  });
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
