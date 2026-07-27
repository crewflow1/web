import { describe, it, expect } from "vitest";
import {
  REFERENCE_TOOL_REGISTRY,
  isReversibleTool,
  estimateToolCostMicros,
  type RegisteredTool,
  type ToolArgs,
} from "@/server/sdk/tools";
import {
  evaluateAction,
  type ProposedAction,
  type EmploymentPosture,
  type GateVerdict,
} from "@/server/sdk/gate";
import { REFERENCE_EXECUTOR, type ToolImplementation } from "@/server/sdk/executor";
import {
  applyOnce,
  deriveIdempotencyKey,
  resolveAppliedPayload,
  createInMemoryApplicationStore,
  DEFAULT_APPLICATION_RETRY_CEILING,
  type ExecutionIdentity,
  type ApproverAttribution,
  type ApplicationStore,
  type ApplyOnceResult,
} from "@/server/sdk/application";
import type { ResolvedCapabilitySet } from "@/server/sdk/tasks";

/**
 * CrewFlow HQ — the Reference Path, end to end through the REAL envelope
 * (CEO Directive #014 / D-04, Phase C, increment C4; ADR 0009 Decisions 1, 3, 4, 5, 6, 8, 9, 10;
 * the Reference Path Rule — Kernel Contract Map §2; the executor proposal §6).
 *
 * This is the ACCEPTANCE proof for the executor capability — the Reference Path Rule's FIRST
 * deliverable use. It is deliberately a different KIND of test from the four Phase-C unit proofs
 * (tools.test.ts, gate.test.ts, executor.test.ts, application.test.ts): each of those pins ONE
 * part in isolation; THIS file proves the parts COMPOSE — that the same Lead Qualification AI's two
 * proposals flow C1 registry → doorman verdict → C2 executor → C3 apply-once marker and land
 * exactly as the architecture promises, with every boundary holding the whole way.
 *
 * The composition is REAL, not mocked. The envelope is pure up to a single injected seam — the
 * tool implementation (executor.ts) — so the reference path needs NO mock: it drives the genuine
 * REFERENCE_TOOL_REGISTRY, the genuine evaluateAction, the genuine REFERENCE_EXECUTOR, and the
 * genuine applyOnce over an in-memory store, and supplies only the one boundary the runtime owns.
 * Purity is therefore PROVEN by composition, not asserted — exactly as Phase B's reference employee
 * proved the doorman by driving the real run-loop.
 *
 * The reference employee is the Lead Qualification AI (Volume XIII §22), now APPLYING both verdicts
 * (proposal §6): the reversible write actually written autonomously; the irreversible send actually
 * sent only AFTER a human grant. The acceptance criteria map to the CEO's C4 scope:
 *
 *   1. End-to-end (reversible) — a reversible, HQ-internal write the gate clears AUTONOMOUS is
 *      planned, applied through the boundary exactly once, and recorded as an "applied" marker.
 *   2. End-to-end (irreversible) — an irreversible send the gate PARKS (needs_approval) is REFUSED
 *      by the executor while uncleared (not_cleared), then — once a human grant clears it — applied
 *      exactly once with the reviewer's edited payload and the approver attributed.
 *   3. Replay — a second pass over an already-applied key is a NO-OP SUCCESS: the boundary is never
 *      re-crossed and the original marker is returned (both the autonomous and the approval paths).
 *   4. Idempotency — the key is a deterministic, path-namespaced function of execution identity
 *      (same identity → same key; an autonomous key and an approval key never collide; the key — and
 *      so the apply-once guarantee — is independent of the payload).
 *   5. Failure recovery — a cleared tool that THROWS leaves the action UNAPPLIED (the Application
 *      Atomicity Rule: a failure never records as applied), safe to re-attempt below the ceiling; a
 *      transient failure that then succeeds recovers to exactly ONE application; and an exhausted
 *      ceiling ESCALATES and is never auto-retried.
 *
 * The boundaries this path holds the whole way: the executor APPLIES, it never DECIDES (the Executor
 * Boundary Rule — a non-autonomous verdict is refused, not re-classified); it consumes the registry
 * READ-ONLY (the Registry Immutability Rule); it crosses the boundary at most once per key (the
 * Executor Idempotency Rule), and only on success does the marker record "applied" (the Application
 * Atomicity Rule). No runner, no facet, no DB, no migration — C4 VERIFIES; it expands nothing.
 */

// ── The reference catalogue, resolved THROUGH the registry (C1 is consumed, not bypassed). ──
function mustResolve(label: string): RegisteredTool {
  const tool = REFERENCE_TOOL_REGISTRY.resolve(label);
  if (!tool) throw new Error(`the reference registry is missing "${label}"`);
  return tool;
}
const writeTool = mustResolve("memory.write");
const sendTool = mustResolve("comm.send");

// ── The Lead Qualification AI's stance and scope (the gate reads what it is GIVEN). ──
const permittingPosture: EmploymentPosture = { canExecute: true, requiresApproval: false };
const capabilities: ResolvedCapabilitySet = {
  tokens: ["memory.write", "comm.send"],
  source: "ai_employees",
};
const BUDGET = 1_000_000;

/**
 * Compose a proposed action from a resolved tool exactly as the runtime does (C1 → the gate): the
 * action's `type`/`capability` are the tool's label/permission, its `reversible` flag is DERIVED
 * from the tool (isReversibleTool), and its cost estimate from the tool (estimateToolCostMicros).
 * The registry's descriptive facts FEED the doorman — they are not restated by hand.
 */
function actionFromTool(
  tool: RegisteredTool,
  payload: ToolArgs,
  over: Partial<ProposedAction> = {},
): ProposedAction {
  return {
    type: tool.label,
    capability: tool.permission,
    subjectType: "lead",
    subjectId: "lead_42",
    reversible: isReversibleTool(tool),
    typedTarget: true,
    estimatedCostMicros: estimateToolCostMicros(tool, payload),
    payload,
    ...over,
  };
}

// The two proposals — atom-for-atom from the catalogue.
const WRITE_PAYLOAD: ToolArgs = { verdict: "qualified", score: 87 };
const SEND_PAYLOAD: ToolArgs = { channel: "sms", body: "Thanks — a rep will call you shortly." };
const reversibleWrite = actionFromTool(writeTool, WRITE_PAYLOAD);
const irreversibleSend = actionFromTool(sendTool, SEND_PAYLOAD);

// A human grant, represented as clearance (ADR 0009 Decision 4) — the doorman parks; the human clears.
const CLEARED: GateVerdict = { decision: "autonomous", reasons: [] };

// ── Execution identities — the two apply paths the idempotency key is namespaced by. ──
const autonomousIdentity: ExecutionIdentity = {
  source: "autonomous",
  correlationId: "corr_ref_c4",
  taskId: "task_ref_c4",
  toolLabel: "memory.write",
  actionId: "act_write_1",
};
const approvalIdentity: ExecutionIdentity = {
  source: "approval",
  correlationId: "corr_ref_c4",
  approvalId: "appr_ref_c4",
  toolLabel: "comm.send",
  actionId: "act_send_1",
};
const approver: ApproverAttribution = {
  approverId: "reviewer_1",
  approverEmail: "ceo@crewflow.uk",
};

// ── The injected boundary — the ONE place an effect happens; never a real effect here. ──

/** A boundary that records every crossing and returns a fixed result. */
function recordingBoundary(result: unknown = { ok: true }): {
  invoke: ToolImplementation;
  calls: () => ToolArgs[];
} {
  const calls: ToolArgs[] = [];
  const invoke: ToolImplementation = async (args) => {
    calls.push(args);
    return result;
  };
  return { invoke, calls: () => calls };
}

/**
 * A boundary scripted per crossing — "throw" raises (the executor CAPTURES it as a failed outcome,
 * it never propagates), "ok" returns the result. It records every crossing, so a test can prove the
 * boundary was crossed the EXACT number of times the apply-once contract permits, and no more.
 */
function scriptedBoundary(
  script: ReadonlyArray<"throw" | "ok">,
  result: unknown = { ok: true },
): { invoke: ToolImplementation; calls: () => ToolArgs[] } {
  const calls: ToolArgs[] = [];
  let i = 0;
  const invoke: ToolImplementation = async (args) => {
    calls.push(args);
    const step = script[i] ?? "ok";
    i += 1;
    if (step === "throw") throw new Error("transient boundary failure");
    return result;
  };
  return { invoke, calls: () => calls };
}

/**
 * Drive ONE cleared action down the real path: plan it on the REFERENCE_EXECUTOR (C2), then record
 * it through applyOnce (C3) over the injected boundary. This is the composition under test — the
 * executor's plan/apply wrapped by the marker's apply-once, the exact shape the rollout will wire.
 * It expects a CLEARED action (the doorman's refusal is proven separately); an unexpected refusal
 * throws, because the helper's precondition is a cleared verdict.
 */
async function applyClearedThroughExecutor(opts: {
  store: ApplicationStore;
  action: ProposedAction;
  verdict: GateVerdict;
  identity: ExecutionIdentity;
  invoke: ToolImplementation;
  approver?: ApproverAttribution;
  ceiling?: number;
}): Promise<ApplyOnceResult> {
  const planned = REFERENCE_EXECUTOR.plan(opts.action, opts.verdict);
  if (!planned.ok) {
    throw new Error(`expected a cleared plan, got refusal "${planned.refusal.reason}"`);
  }
  const { plan } = planned;
  return applyOnce({
    store: opts.store,
    identity: opts.identity,
    apply: () => REFERENCE_EXECUTOR.apply(plan, opts.invoke),
    ...(opts.approver ? { approver: opts.approver } : {}),
    ...(opts.ceiling !== undefined ? { ceiling: opts.ceiling } : {}),
  });
}

// =====================================================================
// 1. End-to-end — a reversible write applies autonomously.
// =====================================================================

describe("the Reference Path — a reversible write applies autonomously, end to end", () => {
  it("the registry's facts feed the doorman, which clears the write", () => {
    // C1 → the gate: the action's reversibility and cost are DERIVED from the tool, not restated.
    expect(reversibleWrite.reversible).toBe(true);
    expect(reversibleWrite.estimatedCostMicros).toBe(0);

    const verdict = evaluateAction(reversibleWrite, permittingPosture, capabilities, BUDGET);
    expect(verdict.decision).toBe("autonomous");
    expect(verdict.reasons).toEqual([]);
  });

  it("plans, applies through the boundary exactly once, and records an 'applied' marker", async () => {
    const verdict = evaluateAction(reversibleWrite, permittingPosture, capabilities, BUDGET);
    const store = createInMemoryApplicationStore();
    const boundary = recordingBoundary({ written: true });

    const result = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected an applied result");

    // The boundary was crossed once, with the VALIDATED args (parsed against the tool's schema).
    expect(boundary.calls()).toEqual([WRITE_PAYLOAD]);
    // The marker is filed under the deterministic key, frozen, carrying the implementation's result.
    expect(result.key).toBe(deriveIdempotencyKey(autonomousIdentity));
    expect(result.record.label).toBe("memory.write");
    expect(result.record.result).toEqual({ written: true });
    // An autonomous application has no human approver.
    expect(result.record.approver).toBeNull();
    expect(Object.isFrozen(result.record)).toBe(true);
  });
});

// =====================================================================
// 2. End-to-end — an irreversible send: parked, refused uncleared, applied post-grant.
// =====================================================================

describe("the Reference Path — an irreversible send is parked, refused uncleared, then applied post-grant", () => {
  it("the doorman parks the send on reversibility alone (it is otherwise in-posture, in-scope, in-budget)", () => {
    expect(irreversibleSend.reversible).toBe(false);
    expect(irreversibleSend.estimatedCostMicros).toBe(1_000);

    const verdict = evaluateAction(irreversibleSend, permittingPosture, capabilities, BUDGET);
    expect(verdict.decision).toBe("needs_approval");
    // The ONLY reason is irreversibility — the C1 tool property, not posture/scope/budget.
    expect(verdict.reasons).toEqual(["p4.irreversible"]);
  });

  it("the executor REFUSES to apply the send while it is uncleared (not_cleared)", () => {
    const parked = evaluateAction(irreversibleSend, permittingPosture, capabilities, BUDGET);
    const planned = REFERENCE_EXECUTOR.plan(irreversibleSend, parked);
    expect(planned.ok).toBe(false);
    if (planned.ok) throw new Error("expected the executor to refuse an uncleared action");
    expect(planned.refusal.reason).toBe("not_cleared");
  });

  it("once a human grants it, the send applies once — with the reviewer's edited payload and the approver attributed", async () => {
    // The reviewer revises the proposal before granting: edited_payload ?? proposed_payload.
    const editedPayload = resolveAppliedPayload(SEND_PAYLOAD, {
      channel: "email",
      body: "Reviewed and revised before sending.",
    });
    const grantedSend: ProposedAction = { ...irreversibleSend, payload: editedPayload };

    const store = createInMemoryApplicationStore();
    const boundary = recordingBoundary({ sent: true });

    const result = await applyClearedThroughExecutor({
      store,
      action: grantedSend,
      verdict: CLEARED, // the human grant, represented as clearance (ADR 0009 Decision 4)
      identity: approvalIdentity,
      invoke: boundary.invoke,
      approver,
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected an applied result");

    // The boundary received the EDITED payload — the reviewer's revision, not the proposal.
    expect(boundary.calls()).toEqual([
      { channel: "email", body: "Reviewed and revised before sending." },
    ]);
    // Filed under the approval-path key, with the human approver attributed (ADR 0009 Decision 10).
    expect(result.key).toBe(deriveIdempotencyKey(approvalIdentity));
    expect(result.record.label).toBe("comm.send");
    expect(result.record.approver).toEqual(approver);
  });
});

// =====================================================================
// 3. Replay — a second pass is a no-op success (the central no-double-apply guarantee).
// =====================================================================

describe("the Reference Path — replay is a no-op success (the central no-double-apply guarantee)", () => {
  it("the autonomous path: a second pass returns already_applied and never re-crosses the boundary", async () => {
    const verdict = evaluateAction(reversibleWrite, permittingPosture, capabilities, BUDGET);
    const store = createInMemoryApplicationStore();
    const boundary = recordingBoundary({ written: true });

    const first = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });
    expect(first.status).toBe("applied");

    const second = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });
    expect(second.status).toBe("already_applied");
    if (second.status !== "already_applied") throw new Error("expected already_applied");

    // The boundary was crossed exactly once across both passes; the original marker is returned.
    expect(boundary.calls()).toHaveLength(1);
    expect(second.record).toBe(first.record);
  });

  it("the approval path: a granted send, once applied, also replays to a no-op success", async () => {
    const store = createInMemoryApplicationStore();
    const boundary = recordingBoundary({ sent: true });
    const grantedSend: ProposedAction = {
      ...irreversibleSend,
      payload: { channel: "email", body: "Granted." },
    };

    const first = await applyClearedThroughExecutor({
      store,
      action: grantedSend,
      verdict: CLEARED,
      identity: approvalIdentity,
      invoke: boundary.invoke,
      approver,
    });
    expect(first.status).toBe("applied");

    const second = await applyClearedThroughExecutor({
      store,
      action: grantedSend,
      verdict: CLEARED,
      identity: approvalIdentity,
      invoke: boundary.invoke,
      approver,
    });
    expect(second.status).toBe("already_applied");
    expect(boundary.calls()).toHaveLength(1);
  });
});

// =====================================================================
// 4. Idempotency — the key is deterministic and path-namespaced.
// =====================================================================

describe("the Reference Path — the idempotency key is deterministic and path-namespaced", () => {
  it("is a pure function of identity — same identity, same key", () => {
    expect(deriveIdempotencyKey(autonomousIdentity)).toBe(deriveIdempotencyKey(autonomousIdentity));
    expect(deriveIdempotencyKey(approvalIdentity)).toBe(deriveIdempotencyKey(approvalIdentity));
  });

  it("namespaces the two apply paths — an autonomous key never collides with an approval key", () => {
    expect(deriveIdempotencyKey(autonomousIdentity)).not.toBe(
      deriveIdempotencyKey(approvalIdentity),
    );
  });

  it("keys on identity, not payload — a re-sweep with a different payload still re-applies nothing", async () => {
    const verdict = evaluateAction(reversibleWrite, permittingPosture, capabilities, BUDGET);
    const store = createInMemoryApplicationStore();
    const boundary = recordingBoundary({ written: true });

    const first = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });
    expect(first.status).toBe("applied");

    // Same identity, a DIFFERENT (still-valid) payload — the key is unchanged, so the marker stands.
    const corrected = actionFromTool(writeTool, { verdict: "qualified", score: 91 });
    const replay = await applyClearedThroughExecutor({
      store,
      action: corrected,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });
    expect(replay.status).toBe("already_applied");
    expect(boundary.calls()).toHaveLength(1); // the differing payload never reached the boundary
  });
});

// =====================================================================
// 5. Failure recovery — honest (Atomicity), bounded (ceiling), idempotent.
// =====================================================================

describe("the Reference Path — failure recovery is honest, bounded, and idempotent", () => {
  it("a thrown boundary records a FAILURE, never an application (the Application Atomicity Rule)", async () => {
    const verdict = evaluateAction(reversibleWrite, permittingPosture, capabilities, BUDGET);
    const store = createInMemoryApplicationStore();
    const boundary = scriptedBoundary(["throw"]);

    const result = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.record.escalated).toBe(false); // below the ceiling — safe to re-attempt

    // Atomicity: the persisted marker is a FAILURE; a failed execution never appears as applied.
    const persisted = await store.get(result.key);
    expect(persisted?.status).toBe("failed");
    expect(boundary.calls()).toHaveLength(1);
  });

  it("a transient failure then success recovers to exactly ONE application, then replays", async () => {
    const verdict = evaluateAction(reversibleWrite, permittingPosture, capabilities, BUDGET);
    const store = createInMemoryApplicationStore();
    const boundary = scriptedBoundary(["throw", "ok"], { written: true });

    const failed = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });
    expect(failed.status).toBe("failed");

    const recovered = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });
    expect(recovered.status).toBe("applied");

    const replay = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
    });
    expect(replay.status).toBe("already_applied");

    // The boundary was crossed twice — the failed attempt and the successful one — never a third time.
    expect(boundary.calls()).toHaveLength(2);
  });

  it("an exhausted ceiling escalates and is never auto-retried", async () => {
    const verdict = evaluateAction(reversibleWrite, permittingPosture, capabilities, BUDGET);
    const store = createInMemoryApplicationStore();
    const ceiling = DEFAULT_APPLICATION_RETRY_CEILING;
    const boundary = scriptedBoundary(Array.from({ length: ceiling + 1 }, () => "throw" as const));

    let last: ApplyOnceResult | undefined;
    for (let attempt = 0; attempt < ceiling; attempt += 1) {
      last = await applyClearedThroughExecutor({
        store,
        action: reversibleWrite,
        verdict,
        identity: autonomousIdentity,
        invoke: boundary.invoke,
        ceiling,
      });
    }
    expect(last?.status).toBe("escalated");
    expect(boundary.calls()).toHaveLength(ceiling);

    // A further sweep does NOT re-cross the boundary — a human owns it now (Decision 9).
    const afterEscalation = await applyClearedThroughExecutor({
      store,
      action: reversibleWrite,
      verdict,
      identity: autonomousIdentity,
      invoke: boundary.invoke,
      ceiling,
    });
    expect(afterEscalation.status).toBe("escalated");
    expect(boundary.calls()).toHaveLength(ceiling); // unchanged — not auto-retried
  });
});
