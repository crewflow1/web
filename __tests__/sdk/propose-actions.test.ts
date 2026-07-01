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
  EMPTY_TOOL_BOUNDARY,
  NonRetryableError,
  type EmployeeIdentity,
  type ToolBoundaryResolver,
} from "@/server/sdk/tasks";
import { REFERENCE_EXECUTOR, type Executor, type ToolImplementation } from "@/server/sdk/executor";
import {
  createInMemoryShadowObservationStore,
  type ShadowObservationRecord,
  type ShadowObservationStore,
} from "@/server/sdk/shadow";
import {
  createInMemoryApplicationStore,
  deriveIdempotencyKey,
  failedRecord,
} from "@/server/sdk/application";

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

// =====================================================================
// proposeActions — the R2 durable shadow store (CEO Directive #016 / D-06; ADR 0011)
//
// R2 gives the shadow's observation a FIRST-CLASS durable home: an INJECTED, append-only store of
// EXPLICITLY shadow-labelled records (`kind: "executor_shadow"`, never an `applied` status — the
// Shadow Truthfulness Rule). The store is a SEAM: absent, nothing is persisted (R1 in-band only);
// present, each autonomous observation is recorded durably AND the in-band audit fragment is
// preserved (planned · shadow-observed both keyed identically). It is best-effort and never the
// application store.
// =====================================================================

/** A store that fails every write (the contract's best-effort failure mode: returns, never throws). */
function failingStore(): ShadowObservationStore {
  return { record: vi.fn().mockResolvedValue({ ok: false, error: "shadow_store_down" }) };
}

describe("ctx.proposeActions — the R2 durable shadow store records explicit shadow-labelled facts", () => {
  it("a plannable autonomous action records ONE shadow-labelled record beside the in-band fragment", async () => {
    const store = createInMemoryShadowObservationStore();
    const { built, emit } = deps({ shadow: true, taskId: "task-1", shadowStore: store });

    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    const recorded = store.recorded();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      kind: "executor_shadow",
      outcome: "planned",
      source: "autonomous",
      correlationId: CORR,
      taskId: "task-1",
      actionId: "lead:lead_1:memory.write",
      toolLabel: "memory.write",
      idempotencyKey: "autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·corr-run-1",
      reason: null,
      detail: "",
    });
    // the in-band audit fragment is still emitted (R1 behaviour preserved, additive)
    expect(emit.mock.calls[0]![0]!.payload).toMatchObject({ shadow: { outcome: "planned" } });
  });

  it("the durable record's key EQUALS the in-band fragment's key (planned · shadow-observed, one key)", async () => {
    const store = createInMemoryShadowObservationStore();
    const { built, emit } = deps({ shadow: true, taskId: "task-1", shadowStore: store });
    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
    const inBand = (emit.mock.calls[0]![0]!.payload as { shadow: { idempotencyKey: string } }).shadow;
    expect(store.recorded()[0]!.idempotencyKey).toBe(inBand.idempotencyKey);
  });

  it("a REFUSED observation is recorded too — shadow-observed, with a null idempotency key", async () => {
    const store = createInMemoryShadowObservationStore();
    const { built } = deps({ shadow: true, taskId: "task-1", shadowStore: store });
    await createProposeActions(built)([passing()]); // no payload → invalid_args refusal
    const rec = store.recorded()[0]!;
    expect(rec).toMatchObject({
      kind: "executor_shadow",
      outcome: "refused",
      reason: "invalid_args",
      toolLabel: null,
      idempotencyKey: null,
    });
  });

  it("records one shadow-labelled fact per AUTONOMOUS action in a batch — never for the approval one", async () => {
    const store = createInMemoryShadowObservationStore();
    const { built } = deps({ shadow: true, taskId: "task-1", shadowStore: store });
    await createProposeActions(built)([
      passing({ payload: { verdict: "qualified" } }), // autonomous → recorded (planned)
      passing({ reversible: false }), //                  needs_approval → NOT recorded
      passing(), //                                       autonomous → recorded (refused)
    ]);
    const recorded: readonly ShadowObservationRecord[] = store.recorded();
    expect(recorded.map((r) => r.outcome)).toEqual(["planned", "refused"]);
    expect(recorded.every((r) => r.kind === "executor_shadow")).toBe(true);
  });

  it("shadow ON but NO store injected → nothing durable, the in-band fragment still rides the audit", async () => {
    const { built, emit } = deps({ shadow: true, taskId: "task-1" }); // no shadowStore
    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
    // The store is optional; absent, the durable write simply does not happen (no throw, no record).
    expect(emit.mock.calls[0]![0]!.payload).toMatchObject({ shadow: { outcome: "planned" } });
  });

  it("shadow OFF but a store injected → the store is NEVER written (the kill-switch gates persistence)", async () => {
    const store = createInMemoryShadowObservationStore();
    const { built, emit } = deps({ shadow: false, taskId: "task-1", shadowStore: store });
    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
    expect(store.recorded()).toHaveLength(0);
    // and the payload stays byte-identical to the pre-shadow shape
    expect(emit.mock.calls[0]![0]!.payload).toEqual({ action: "memory.write", capability: null });
  });

  it("a needs-approval action records NOTHING durable (the store rides only the autonomous branch)", async () => {
    const store = createInMemoryShadowObservationStore();
    const { built } = deps({ shadow: true, taskId: "task-1", shadowStore: store });
    await createProposeActions(built)([passing({ reversible: false })]); // → needs_approval
    expect(store.recorded()).toHaveLength(0);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });

  it("BEST-EFFORT: a failing store never breaks the run — the verdict still resolves", async () => {
    const store = failingStore();
    const { built } = deps({ shadow: true, taskId: "task-1", shadowStore: store });
    const [verdict] = await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
    expect(verdict!.decision).toBe("autonomous"); // resolved, not thrown
    expect(store.record).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// proposeActions — R3 controlled LIVE autonomous execution (CEO Directive #016 / D-06; ADR 0011)
//
// R3 turns the autonomous branch into a controlled LIVE apply behind its OWN default-off kill-switch:
// when `live` is on AND a durable application store + a tool boundary are injected, the runtime
// CROSSES the executor boundary via applyOnce over the store — apply EXACTLY ONCE (the Executor
// Idempotency Rule) — and audits `ai.tool_called` AFTER `ai.action_permitted` (ADR 0009 Decision 10).
// The shadow is RETAINED (comparison, not replacement). TWO independent safety layers gate a cross:
// the kill-switch AND the tool boundary (an unbound tool ⇒ nothing crosses — the R3 production
// default). The application store is NEVER the shadow store (the Shadow Isolation Rule).
// =====================================================================

/** The idempotency key the live apply of the canonical `passing()` action files under (taskId task-1). */
const APPLIED_KEY = deriveIdempotencyKey({
  source: "autonomous",
  correlationId: CORR,
  taskId: "task-1",
  toolLabel: "memory.write",
  actionId: "lead:lead_1:memory.write",
});

/** A tool boundary that RESOLVES to an implementation returning `result` — records every crossing. */
function boundaryReturning(result: unknown) {
  const invoke = vi.fn(async () => result);
  const resolve: ToolBoundaryResolver = () => invoke as unknown as ToolImplementation;
  return { resolve, invoke };
}

/** A tool boundary whose implementation THROWS — the executor captures it as a `failed` outcome. */
function boundaryThrowing(message: string) {
  const invoke = vi.fn(async () => {
    throw new Error(message);
  });
  const resolve: ToolBoundaryResolver = () => invoke as unknown as ToolImplementation;
  return { resolve, invoke };
}

/** The identity the seeded failure record is keyed by (matches the canonical `passing()` action). */
const APPLIED_IDENTITY = {
  source: "autonomous",
  correlationId: CORR,
  taskId: "task-1",
  toolLabel: "memory.write",
  actionId: "lead:lead_1:memory.write",
} as const;

describe("ctx.proposeActions — R3 live execution is OFF by default and gated by BOTH seams", () => {
  it("live OFF (default): even with a store and boundary injected, nothing crosses (the kill-switch gates)", async () => {
    const store = createInMemoryApplicationStore();
    const { resolve, invoke } = boundaryReturning({ wrote: true });
    const { built, emit } = deps({ live: false, taskId: "task-1", applicationStore: store, resolveTool: resolve });

    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    expect(invoke).not.toHaveBeenCalled();
    expect(emit.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted"]); // no tool_called
    expect(await store.get(APPLIED_KEY)).toBeUndefined();
  });

  it("live ON but the tool boundary is EMPTY (R3 production default): unbound ⇒ nothing crosses", async () => {
    const store = createInMemoryApplicationStore();
    const { built, emit } = deps({
      live: true,
      taskId: "task-1",
      applicationStore: store,
      resolveTool: EMPTY_TOOL_BOUNDARY,
    });

    const [verdict] = await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    expect(verdict!.decision).toBe("autonomous");
    expect(emit.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted"]); // no tool_called
    expect(await store.get(APPLIED_KEY)).toBeUndefined(); // applyOnce never reached
  });

  it("live ON but no application store injected → nothing crosses (BOTH seams are required)", async () => {
    const { resolve, invoke } = boundaryReturning({ wrote: true });
    const { built, emit } = deps({ live: true, taskId: "task-1", resolveTool: resolve }); // no applicationStore

    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    expect(invoke).not.toHaveBeenCalled();
    expect(emit.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted"]);
  });
});

describe("ctx.proposeActions — R3 live, ON and bound, crosses the boundary EXACTLY once", () => {
  it("crosses once, records an APPLIED record, and audits ai.tool_called AFTER ai.action_permitted", async () => {
    const store = createInMemoryApplicationStore();
    const { resolve, invoke } = boundaryReturning({ wrote: true });
    const { built, emit } = deps({ live: true, taskId: "task-1", applicationStore: store, resolveTool: resolve });

    const [verdict] = await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    expect(verdict!.decision).toBe("autonomous");
    expect(invoke).toHaveBeenCalledTimes(1); // the ONE boundary crossing
    // audit ORDER: action_permitted THEN tool_called (ADR 0009 Decision 10)
    expect(emit.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted", "ai.tool_called"]);
    expect(emit.mock.calls[1]![0]).toMatchObject({
      verb: "ai.tool_called",
      objectType: "lead",
      objectId: "lead_1",
      payload: {
        action: "memory.write",
        tool: "memory.write",
        status: "applied",
        idempotencyKey: APPLIED_KEY,
      },
    });
    // the durable record is APPLIED, filed under the idempotency key, carrying the tool's result
    const rec = await store.get(APPLIED_KEY);
    expect(rec).toMatchObject({
      status: "applied",
      key: APPLIED_KEY,
      label: "memory.write",
      attempts: 1,
      result: { wrote: true },
    });
  });

  it("is IDEMPOTENT: a re-run under the same identity re-applies nothing and emits no second tool_called", async () => {
    const store = createInMemoryApplicationStore();
    const { resolve, invoke } = boundaryReturning({ wrote: true });

    // first run — crosses once
    await createProposeActions(
      deps({ live: true, taskId: "task-1", applicationStore: store, resolveTool: resolve }).built,
    )([passing({ payload: { verdict: "qualified" } })]);
    expect(invoke).toHaveBeenCalledTimes(1);

    // second run — SAME identity, SAME store — a no-op success (already_applied)
    const { built: b2, emit: e2 } = deps({
      live: true,
      taskId: "task-1",
      applicationStore: store,
      resolveTool: resolve,
    });
    await createProposeActions(b2)([passing({ payload: { verdict: "qualified" } })]);

    expect(invoke).toHaveBeenCalledTimes(1); // unchanged — the boundary was NOT crossed again
    expect(e2.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted"]); // no second tool_called
  });

  it("live rides ONLY the autonomous branch — a needs-approval action never crosses the boundary", async () => {
    const store = createInMemoryApplicationStore();
    const { resolve, invoke } = boundaryReturning({ wrote: true });
    const { built, emit } = deps({ live: true, taskId: "task-1", applicationStore: store, resolveTool: resolve });

    await createProposeActions(built)([passing({ reversible: false })]); // → needs_approval

    expect(invoke).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(await store.get(APPLIED_KEY)).toBeUndefined();
  });

  it("an executor refusal (gate cleared, executor declines) crosses nothing and audits no tool_called", async () => {
    const store = createInMemoryApplicationStore();
    const { resolve, invoke } = boundaryReturning({ wrote: true });
    const { built, emit } = deps({ live: true, taskId: "task-1", applicationStore: store, resolveTool: resolve });

    const [verdict] = await createProposeActions(built)([passing()]); // no payload → invalid_args refusal

    expect(verdict!.decision).toBe("autonomous");
    expect(invoke).not.toHaveBeenCalled(); // executor.plan refused before any cross
    expect(emit.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted"]); // no tool_called
    expect(await store.get(APPLIED_KEY)).toBeUndefined();
  });
});

describe("ctx.proposeActions — R3 live failure is captured, never recorded as applied", () => {
  it("a failing tool records a FAILED record, audits ai.tool_called(status:failed), and THROWS (retryable)", async () => {
    const store = createInMemoryApplicationStore();
    const { resolve, invoke } = boundaryThrowing("db exploded");
    const { built, emit } = deps({ live: true, taskId: "task-1", applicationStore: store, resolveTool: resolve });

    const err = await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]).catch(
      (e: unknown) => e,
    );

    // THROW-BASED ABI: a failed apply surfaces so the runner fails + re-attempts (idempotency-safe)
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError); // a plain failure is RETRYABLE
    expect((err as Error).message).toMatch(/live apply failed for memory\.write: db exploded/);
    expect(invoke).toHaveBeenCalledTimes(1); // it DID cross, and the tool threw

    // the failure is a durable FAILED record — never an applied one (the Application Atomicity Rule)
    const rec = await store.get(APPLIED_KEY);
    expect(rec).toMatchObject({ status: "failed", error: "db exploded", escalated: false, attempts: 1 });

    // a tool WAS invoked, so ai.tool_called is audited (status failed), after ai.action_permitted
    expect(emit.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted", "ai.tool_called"]);
    expect(emit.mock.calls[1]![0]!.payload).toMatchObject({ status: "failed", error: "db exploded" });
  });

  it("an apply that exhausts the retry ceiling ESCALATES: throws NonRetryableError and audits escalated:true", async () => {
    const store = createInMemoryApplicationStore();
    // seed a prior failed record at attempts=2 (default ceiling 3): the next failure escalates
    await store.put(
      failedRecord({
        key: APPLIED_KEY,
        identity: APPLIED_IDENTITY,
        label: "memory.write",
        error: "prior failure",
        escalated: false,
        attempts: 2,
      }),
    );
    const { resolve } = boundaryThrowing("still broken");
    const { built, emit } = deps({ live: true, taskId: "task-1", applicationStore: store, resolveTool: resolve });

    const err = await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(NonRetryableError); // a human owns it — do NOT auto-retry
    const rec = await store.get(APPLIED_KEY);
    expect(rec).toMatchObject({ status: "failed", escalated: true, attempts: 3 });
    expect(emit.mock.calls[1]![0]!.payload).toMatchObject({ status: "failed", escalated: true });
  });
});

describe("ctx.proposeActions — R3 RETAINS the shadow beside live (comparison preserved)", () => {
  it("shadow records the observation AND the boundary is crossed — both keyed identically", async () => {
    const appStore = createInMemoryApplicationStore();
    const shadowStore = createInMemoryShadowObservationStore();
    const { resolve, invoke } = boundaryReturning({ wrote: true });
    const { built, emit } = deps({
      shadow: true,
      live: true,
      taskId: "task-1",
      shadowStore,
      applicationStore: appStore,
      resolveTool: resolve,
    });

    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);

    // shadow-observed (planned) AND applied — the three-way distinction preserved
    expect(shadowStore.recorded()).toHaveLength(1);
    expect(shadowStore.recorded()[0]).toMatchObject({
      kind: "executor_shadow",
      outcome: "planned",
      idempotencyKey: APPLIED_KEY,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const applied = await appStore.get(APPLIED_KEY);
    expect(applied).toMatchObject({ status: "applied" });
    // the SAME idempotency key threads shadow-observed AND applied (future cut-over comparison)
    expect(applied!.key).toBe(shadowStore.recorded()[0]!.idempotencyKey);
    // action_permitted carries the shadow fragment; tool_called follows it
    expect(emit.mock.calls.map((c) => c[0]!.verb)).toEqual(["ai.action_permitted", "ai.tool_called"]);
    expect(emit.mock.calls[0]![0]!.payload).toMatchObject({ shadow: { outcome: "planned" } });
  });
});
