import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EmployeeIdentity, ProposedAction, GateVerdict } from "@/server/sdk/tasks";

/**
 * CrewFlow HQ — the Reference Employee, end to end through the REAL runner
 * (CEO Directive #014 / D-04, Phase B B3; ADR 0008 Decisions 4 & 8; Bible Volume XIII §22;
 * the Phase B doorman proposal §11/§12).
 *
 * This is the ACCEPTANCE proof for the doorman — the one test that drives a single employee
 * through the whole run-loop and watches both verdict paths resolve. It is deliberately a
 * different KIND of test from its two siblings, and the three together are the doorman's
 * complete evidence:
 *
 *   • gate.test.ts            — the PURE policy, proven by a table of inputs (no runtime).
 *   • propose-actions.test.ts — the runtime composition, proven by calling the factory
 *                               (createProposeActions) in isolation (no run-loop).
 *   • THIS file               — the same behaviour proven to ARISE when a real handler runs
 *                               inside the real runner: claim → frozen RunContext →
 *                               ctx.proposeActions → audit / approval → terminal transition.
 *
 * The Reference Employee is the Lead Qualification AI recast as an SDK instance (Volume XIII
 * §22): the FIRST caller of the doorman, exercising it before Phase C ever builds an executor.
 * It proposes TWO actions and nothing more — it CLASSIFIES, it does not ACT (proposal §12
 * trap b: there is no executor in Phase B). The acceptance criteria (proposal §11):
 *
 *   1. a REVERSIBLE, HQ-internal write (a qualified verdict to the lead's memory) under a
 *      permitting posture → permitted AUTONOMOUS, and AUDITED to the spine; and
 *   2. an IRREVERSIBLE, customer-facing send (an outbound email) → parked as a PENDING
 *      APPROVAL, never run autonomously;
 *   3. and, with NO posture resolved, the LOCKED floor parks BOTH — deny-by-default is a
 *      property of the wired runtime, not of handler discipline;
 *   4. and a refused approval becomes a task FAILURE (the throw-based ABI all the way out),
 *      so a side effect the gate said a human must see is never silently dropped.
 *
 * The harness mirrors tasks-sdk.test.ts: we mock ONLY the admin client's rpc surface, so the
 * REAL run-loop, the REAL events facet and the REAL doorman execute — the autonomous audit is
 * genuinely end to end (handler → ctx.proposeActions → events.emit → emitEvent →
 * rpc("hq_emit_event")), which is what proves the spine actor is STAMPED, not spoofable. The
 * Approval Engine (`requestApproval`) is the one service the runtime hands off to, so we mock
 * IT at its boundary (it writes via the table builder, which this rpc-only harness does not
 * stub) exactly as propose-actions.test.ts does — the seam, not a re-implementation.
 */

const { rpcMock, requestApprovalMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  requestApprovalMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: rpcMock }) }));
vi.mock("@/server/services/hq-approvals", () => ({ requestApproval: requestApprovalMock }));
// Import-safety only: the run-loop pulls in the memory facet, which reaches for embeddings.
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));

import { runReadyTask, resolveEmployeePosture } from "@/server/sdk/tasks";

const EMP = "22222222-2222-2222-2222-222222222222";
const CORR = "corr-ref-1";

/**
 * The Reference Employee — the Lead Qualification AI as an SDK instance (Volume XIII §22).
 * A permitting posture by default (resolved through the REAL resolveEmployeePosture, so the
 * test cannot drift from the floor the gate reads) and the two capability tokens its actions
 * name; `over` lets a case drop the posture to prove the LOCKED default.
 */
const referenceIdentity = (over: Partial<EmployeeIdentity> = {}): EmployeeIdentity => ({
  employeeId: EMP,
  slug: "lead-qualification-ai",
  capabilities: { tokens: ["memory.write", "comm.send"], source: "ai_employees" },
  posture: resolveEmployeePosture({ permissions: { can_execute: true, requires_approval: false } }),
  ...over,
});

/** Reversible, HQ-internal, typed, in-scope → autonomous (and audited) under a permitting posture. */
const reversibleWrite: ProposedAction = {
  type: "memory.write",
  capability: "memory.write",
  subjectType: "lead",
  subjectId: "lead_8842",
  reversible: true,
  typedTarget: true,
  payload: { verdict: "qualified", score: 87 },
};

/** Irreversible, customer-facing send → needs_approval (fails P4 atom 1) even when otherwise valid. */
const irreversibleSend: ProposedAction = {
  type: "comm.send",
  capability: "comm.send",
  subjectType: "lead",
  subjectId: "lead_8842",
  reversible: false,
  typedTarget: true,
  payload: { channel: "email", body: "You're qualified — let's talk." },
};

type Row = Record<string, unknown>;

function makeTask(over: Row = {}): Row {
  return {
    id: "task-ref-1",
    task_type: "qualify_lead",
    status: "running",
    correlation_id: CORR,
    cost_budget_micros: 1_000_000,
    payload: {},
    result: null,
    ...over,
  };
}

/** Wire the rpc surface for one full claim → run → terminal cycle, plus the spine append. */
function wireRunner(): void {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === "hq_ai_task_claim") return { data: { ok: true, task: makeTask() }, error: null };
    if (fn === "hq_ai_task_complete")
      return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
    if (fn === "hq_ai_task_fail")
      return { data: { ok: true, task: makeTask({ status: "failed" }) }, error: null };
    if (fn === "hq_emit_event") return { data: 1, error: null }; // event id (non-null ⇒ ok)
    return { data: null, error: null };
  });
}

/** Args of the first rpc() call to `fn` (or undefined). */
function argsFor(fn: string): Row | undefined {
  return rpcMock.mock.calls.find((c) => c[0] === fn)?.[1] as Row | undefined;
}

/** How many times `fn` was rpc'd. */
function callsTo(fn: string): number {
  return rpcMock.mock.calls.filter((c) => c[0] === fn).length;
}

beforeEach(() => {
  rpcMock.mockReset();
  requestApprovalMock.mockReset();
  requestApprovalMock.mockResolvedValue({ ok: true, approval: { id: "appr-ref-1" } });
});

// =====================================================================
// 1. Both verdict paths, end to end, under a permitting posture.
// =====================================================================

describe("Reference Employee — reversible→autonomous-audited, irreversible→approval (end to end)", () => {
  it("routes each action by its verdict, audits the autonomous one, and queues the irreversible one", async () => {
    wireRunner();
    let verdicts: GateVerdict[] = [];

    const outcome = await runReadyTask(
      "qualify_lead",
      async (ctx) => {
        // Classify, do not act: the handler PROPOSES both side effects, runs neither.
        verdicts = await ctx.proposeActions([reversibleWrite, irreversibleSend]);
        return { qualified: true };
      },
      referenceIdentity(),
    );

    // The doorman classified; it did not break the run. The runner completed the task.
    expect(outcome.status).toBe("completed");

    // Verdicts in input order: the reversible write is autonomous, the send needs approval.
    expect(verdicts.map((v) => v.decision)).toEqual(["autonomous", "needs_approval"]);
    expect(verdicts[1]!.reasons).toContain("p4.irreversible");

    // AUTONOMOUS PATH (genuinely end to end): the REAL events facet stamped the bound actor
    // (no spoofing) and threaded the run's correlation onto ONE ai.action_permitted audit.
    expect(callsTo("hq_emit_event")).toBe(1);
    expect(argsFor("hq_emit_event")).toMatchObject({
      p_verb: "ai.action_permitted",
      p_actor_type: "ai_employee",
      p_actor_id: "lead-qualification-ai",
      p_object_type: "lead",
      p_object_id: "lead_8842",
      p_correlation_id: CORR,
      p_payload: { action: "memory.write", capability: "memory.write" },
    });

    // APPROVAL PATH: the irreversible send was handed to the Approval Engine exactly ONCE,
    // with the run's correlation threaded and the proposed payload carried through.
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(requestApprovalMock.mock.calls[0]![0]).toMatchObject({
      aiEmployeeId: EMP,
      subjectType: "lead",
      subjectId: "lead_8842",
      action: "comm.send",
      proposedPayload: { channel: "email", body: "You're qualified — let's talk." },
      correlationId: CORR,
    });
  });
});

// =====================================================================
// 2. The LOCKED floor — a missing posture parks BOTH (deny-by-default).
// =====================================================================

describe("Reference Employee — the LOCKED floor parks both actions when no posture is resolved", () => {
  it("defaults to deny-by-default end to end: even the reversible write needs approval, nothing is audited", async () => {
    wireRunner();
    let verdicts: GateVerdict[] = [];

    const outcome = await runReadyTask(
      "qualify_lead",
      async (ctx) => {
        verdicts = await ctx.proposeActions([reversibleWrite, irreversibleSend]);
        return undefined;
      },
      // No posture on the identity → the runner defaults to LOCKED_POSTURE.
      referenceIdentity({ posture: undefined }),
    );

    expect(outcome.status).toBe("completed");

    // Posture failure is decisive on its own — the otherwise-autonomous write is parked too.
    expect(verdicts.map((v) => v.decision)).toEqual(["needs_approval", "needs_approval"]);
    expect(verdicts[0]!.reasons).toEqual(
      expect.arrayContaining(["posture.can_execute", "posture.requires_approval"]),
    );

    // Nothing was permitted, so NOTHING was audited as permitted; both were queued for a human.
    expect(callsTo("hq_emit_event")).toBe(0);
    expect(requestApprovalMock).toHaveBeenCalledTimes(2);
  });
});

// =====================================================================
// 3. The throw-based ABI, end to end — a refused approval FAILS the run.
// =====================================================================

describe("Reference Employee — a refused approval becomes a task failure (throw-based ABI, end to end)", () => {
  it("fails the run via hq_ai_task_fail rather than silently dropping the human-required side effect", async () => {
    wireRunner();
    requestApprovalMock.mockResolvedValue({ ok: false, error: "invalid_input" });

    const outcome = await runReadyTask(
      "qualify_lead",
      async (ctx) => {
        // The irreversible send needs approval; a refused request throws out of proposeActions,
        // and that throw is the handler's throw — the runner must record a failure.
        await ctx.proposeActions([irreversibleSend]);
        return { unreachable: true };
      },
      referenceIdentity(),
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("ctx.proposeActions: requestApproval failed: invalid_input");
    }
    // The terminal transition was a FAILURE, not a completion, and it carried the reason.
    expect(callsTo("hq_ai_task_fail")).toBe(1);
    expect(callsTo("hq_ai_task_complete")).toBe(0);
    expect(argsFor("hq_ai_task_fail")).toMatchObject({
      p_error: expect.stringContaining("ctx.proposeActions: requestApproval failed: invalid_input"),
    });
  });
});
