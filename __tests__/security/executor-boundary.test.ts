import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BoundEvents } from "@/server/sdk/events";
import type { EmploymentPosture, ProposedAction, GateVerdict } from "@/server/sdk/gate";
import type { Executor, ExecutionPlanResult, ToolImplementation } from "@/server/sdk/executor";
import type { ApplicationStore, ApplicationRecord } from "@/server/sdk/application";
import type { ShadowObservationStore } from "@/server/sdk/shadow";

/**
 * CrewFlow HQ — the executor trust boundary, across the whole Live Executor Rollout
 * (CEO Directive #016 / D-06, increments R1 · R2 · R3; ADR 0011; the Executor Boundary Rule, the
 * Runtime Composition Rule, the Shadow Truthfulness Rule, the Shadow Isolation Rule, the Executor
 * Idempotency Rule, the Execution Ownership Rule, and the Policy vs Mechanism rule — Kernel Contract
 * Map §2).
 *
 * The invariant this file guards EVOLVED across the rollout, and it proves the whole shape:
 *
 *   • R1/R2 — the SHADOW path OBSERVES, it never crosses. Default-off; even ON it only plans + keys
 *     + records an EXPLICIT shadow-labelled observation (`kind: "executor_shadow"`), through a store
 *     STRUCTURALLY separate from any application store. It calls neither `apply` nor `execute`.
 *   • R3 — controlled LIVE autonomous execution. The boundary MAY now be crossed, but ONLY under
 *     runtime control, behind TWO independent safety layers: (1) the default-off
 *     `CREWFLOW_EXECUTOR_LIVE` kill-switch, and (2) {@link EMPTY_TOOL_BOUNDARY} — R3 binds NO
 *     employee tool to a real subsystem (that is R5), so even live-ON resolves every apply to
 *     `unbound` and crosses nothing in production. The crossing MECHANISM is real and idempotent
 *     (apply-exactly-once through the DURABLE application store), proven only by tests that inject a
 *     boundary; and the shadow is RETAINED beside live (comparison, not replacement), each record
 *     keyed identically yet kept in its OWN store (the Shadow Isolation Rule).
 *
 * The file proves this as BEHAVIOUR and as SOURCE, so a future edit that quietly widens the boundary
 * — flips a kill-switch default, binds a real tool in R3, routes a live apply through the shadow
 * store, or fuses plan+apply so the runtime loses control between them — fails HERE.
 *
 * What breaks if a fact silently flips:
 *   • a kill-switch default flips on → the shadow or a live apply would run in production unbidden.
 *     Asserted: BOTH `executorShadowEnabled` and `executorLiveEnabled` are default-off and strict.
 *   • the shadow calls executor.apply/execute → an OBSERVATION becomes an APPLIED effect. Asserted:
 *     the shadow path plans only; the tripwire's apply/execute throw if ever reached.
 *   • live-on binds a real tool in R3 → an autonomous action crosses with no reviewed cut-over.
 *     Asserted: production wires EMPTY_TOOL_BOUNDARY, so a live apply resolves `unbound`.
 *   • a live apply routes through the shadow store (or vice-versa) → the idempotency ground truth is
 *     poisoned / a shadow row masquerades as applied. Asserted: the shadow lands in the shadow store
 *     and the apply in the application store — two distinct records under one key (Shadow Isolation).
 *   • a failed apply records as applied → a double-apply on retry. Asserted: a thrown apply is
 *     captured as `failed` (never `applied`) and surfaced so the runner retries.
 *   • the runtime fuses plan+apply (executor.execute) → it loses control between the pure plan and
 *     the effect. Asserted: the source composes plan→apply itself and NEVER calls executor.execute.
 *
 * The Approval Engine is the one service the doorman hands off to, so we mock IT and inject a fake
 * events facet; the admin client + embeddings are stubbed only so the runner's module graph imports
 * cleanly (mirroring propose-actions.test.ts). Nothing real is reached for — the executor, the
 * application store, the shadow store and the tool boundary are all injected stand-ins.
 */

const { requestApprovalMock } = vi.hoisted(() => ({ requestApprovalMock: vi.fn() }));
vi.mock("@/server/services/hq-approvals", () => ({ requestApproval: requestApprovalMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai/embeddings", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));

import {
  createProposeActions,
  executorShadowEnabled,
  executorLiveEnabled,
  EMPTY_TOOL_BOUNDARY,
  EMPTY_CAPABILITIES,
  type ToolBoundaryResolver,
  type EmployeeIdentity,
} from "@/server/sdk/tasks";
import { REFERENCE_EXECUTOR } from "@/server/sdk/executor";

const CORR = "corr-boundary-1";
const TASK = "task-boundary-1";

/** A posture that PERMITS autonomy — so a plannable action reaches the boundary at all. */
const permits: EmploymentPosture = { canExecute: true, requiresApproval: false };

function makeEvents() {
  const emit = vi.fn().mockResolvedValue({ ok: true, id: 1 });
  const facet: BoundEvents = { identity: Object.freeze({ slug: "research-ai" }), emit };
  return { facet, emit };
}

const passing = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  type: "memory.write",
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: true,
  typedTarget: true,
  ...over,
});

/** A payload the reference `memory.write` tool accepts — so the executor produces a plan. */
const PLANNABLE = passing({ payload: { verdict: "qualified" } });

/**
 * A boundary tripwire: `plan` delegates to the reference executor (so shadow/live can PLAN), but
 * `apply` and `execute` THROW the instant they are reached. If a shadow ever crossed the boundary,
 * or a live apply crossed it when it must not, the run throws here and the test fails loudly — the
 * boundary is proven shut BY CONSTRUCTION, not by inspection. When live is ON and a real tool is
 * bound, `apply` IS reached — proving the tripwire is not vacuous (§5).
 */
function tripwireExecutor(): Executor & { planCalls: () => number } {
  let planned = 0;
  const exec: Executor = {
    plan: (action: ProposedAction, verdict: GateVerdict): ExecutionPlanResult => {
      planned += 1;
      return REFERENCE_EXECUTOR.plan(action, verdict);
    },
    apply: () => {
      throw new Error("BOUNDARY CROSSED: executor.apply was reached unexpectedly");
    },
    execute: () => {
      throw new Error("BOUNDARY CROSSED: executor.execute was reached unexpectedly");
    },
  };
  return Object.assign(exec, { planCalls: () => planned });
}

/** A counting application store — records what `applyOnce` would read/write, without persistence. */
function countingAppStore() {
  const get = vi.fn().mockResolvedValue(undefined);
  const put = vi.fn().mockResolvedValue(undefined);
  return { store: { get, put } as unknown as ApplicationStore, get, put };
}

/** A counting shadow store — records what the runner would persist as a shadow observation. */
function countingShadowStore() {
  const record = vi.fn().mockResolvedValue({ ok: true, id: 1 });
  return { store: { record } as unknown as ShadowObservationStore, record };
}

/** A tool boundary that BINDS every label to a working implementation (the R5-shaped seam). */
const boundBoundary: ToolBoundaryResolver = () =>
  (async () => ({ ok: true })) as ToolImplementation;

/** A tool boundary bound to an implementation that THROWS — a cleared tool that then fails. */
const throwingBoundary: ToolBoundaryResolver = () =>
  (async () => {
    throw new Error("tool implementation exploded");
  }) as ToolImplementation;

beforeEach(() => {
  requestApprovalMock.mockReset();
  requestApprovalMock.mockResolvedValue({ ok: true, approval: { id: "appr-1" } });
});

/** Assemble doorman deps with a tripwire executor; overrides layer on the shadow/live seams. */
function deps(over: Record<string, unknown> = {}) {
  const { facet, emit } = makeEvents();
  const executor = tripwireExecutor();
  const built = {
    identity: { employeeId: "emp-1", slug: "research-ai" } as EmployeeIdentity,
    posture: permits,
    capabilities: EMPTY_CAPABILITIES,
    budget: 1_000,
    correlationId: CORR,
    events: facet,
    taskId: TASK,
    executor,
    ...over,
  };
  return { built, emit, executor };
}

// =====================================================================
// 1. Both kill-switches are default-OFF and strict.
// =====================================================================

describe("executor boundary — both kill-switches are default-OFF and strict", () => {
  it("the SHADOW switch is false without the flag, on ONLY for the exact string \"on\"", () => {
    expect(executorShadowEnabled({})).toBe(false);
    expect(executorShadowEnabled({ CREWFLOW_EXECUTOR_SHADOW: "on" })).toBe(true);
    for (const v of ["true", "1", "ON", "On", "yes", "off", ""]) {
      expect(executorShadowEnabled({ CREWFLOW_EXECUTOR_SHADOW: v })).toBe(false);
    }
  });

  it("the LIVE switch is false without the flag, on ONLY for the exact string \"on\"", () => {
    expect(executorLiveEnabled({})).toBe(false);
    expect(executorLiveEnabled({ CREWFLOW_EXECUTOR_LIVE: "on" })).toBe(true);
    for (const v of ["true", "1", "ON", "On", "yes", "off", ""]) {
      expect(executorLiveEnabled({ CREWFLOW_EXECUTOR_LIVE: v })).toBe(false);
    }
  });

  it("the two switches are INDEPENDENT — neither reads the other's variable", () => {
    expect(executorLiveEnabled({ CREWFLOW_EXECUTOR_SHADOW: "on" })).toBe(false);
    expect(executorShadowEnabled({ CREWFLOW_EXECUTOR_LIVE: "on" })).toBe(false);
  });
});

// =====================================================================
// 2. The SHADOW path OBSERVES — it never crosses the boundary (R1/R2 retained).
// =====================================================================

describe("executor boundary — the SHADOW path observes, it never crosses", () => {
  it("a plannable autonomous action plans but NEVER applies/executes", async () => {
    const { built, executor } = deps({ shadow: true });
    await createProposeActions(built)([PLANNABLE]);
    // Reaching this line proves apply/execute were not reached — they throw if they are.
    expect(executor.planCalls()).toBe(1);
  });

  it("a batch (autonomous + needs-approval + refusable) crosses no boundary; only autonomous plans", async () => {
    const { built, executor, emit } = deps({ shadow: true });
    const verdicts = await createProposeActions(built)([
      PLANNABLE, //                    autonomous → shadow PLANS
      passing({ reversible: false }), // needs_approval → NOT shadowed
      passing(), //                    autonomous but invalid_args → plan REFUSES (no cross)
    ]);
    expect(verdicts.map((v) => v.decision)).toEqual(["autonomous", "needs_approval", "autonomous"]);
    expect(executor.planCalls()).toBe(2); // only the two autonomous actions were planned
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2); // one audit per autonomous action, no tool-call
  });
});

// =====================================================================
// 3. LIVE is default-off — the kill-switch is the gate, even with a real store + bound tool present.
// =====================================================================

describe("executor boundary — LIVE is default-off; the kill-switch is the gate", () => {
  it("live OFF crosses nothing even when a durable store AND a bound tool are wired", async () => {
    const { store, put } = countingAppStore();
    // Everything a live apply needs is present EXCEPT the `live` flag (defaults off).
    const { built, executor, emit } = deps({ applicationStore: store, resolveTool: boundBoundary });
    const verdicts = await createProposeActions(built)([PLANNABLE]);
    expect(verdicts[0]?.decision).toBe("autonomous");
    expect(executor.planCalls()).toBe(0); // shadow off + live off ⇒ the executor is never touched
    expect(put).not.toHaveBeenCalled(); // no application record written
    expect(emit).toHaveBeenCalledTimes(1); // only ai.action_permitted; no tool-call
  });
});

// =====================================================================
// 4. LIVE on, but the tool boundary is EMPTY — the R3 production posture crosses nothing.
// =====================================================================

describe("executor boundary — LIVE on but the tool boundary is EMPTY (R3 production posture)", () => {
  it("EMPTY_TOOL_BOUNDARY resolves every apply to `unbound`, so the boundary is never crossed", async () => {
    const { store, get, put } = countingAppStore();
    const { built, executor, emit } = deps({
      live: true,
      applicationStore: store,
      resolveTool: EMPTY_TOOL_BOUNDARY,
    });
    const verdicts = await createProposeActions(built)([PLANNABLE]);
    expect(verdicts[0]?.decision).toBe("autonomous");
    expect(executor.planCalls()).toBe(1); // live re-planned (pure) …
    expect(get).not.toHaveBeenCalled(); //   … but short-circuited BEFORE applyOnce (unbound)
    expect(put).not.toHaveBeenCalled(); //   … so nothing was applied or recorded
    expect(emit).toHaveBeenCalledTimes(1); // only ai.action_permitted; no tool-call for `unbound`
  });
});

// =====================================================================
// 5. LIVE on AND a tool bound — the boundary IS genuinely crossed (the tripwire is not vacuous),
//    and a thrown apply is captured as `failed`, never `applied`.
// =====================================================================

describe("executor boundary — LIVE on AND bound genuinely crosses the boundary", () => {
  it("with a bound tool the tripwire's apply IS reached (the boundary is genuinely crossable)", async () => {
    const { store, get, put } = countingAppStore();
    const { built, executor } = deps({
      live: true,
      applicationStore: store,
      resolveTool: boundBoundary,
    });
    // The tripwire's apply throws the instant it is reached — proving the earlier "never reached"
    // assertions are NOT vacuous: with the kill-switch on AND a tool bound, the runtime genuinely
    // crosses to executor.apply.
    await expect(createProposeActions(built)([PLANNABLE])).rejects.toThrow(/BOUNDARY CROSSED/);
    expect(executor.planCalls()).toBe(1); // it planned …
    expect(get).toHaveBeenCalledTimes(1); // … and consulted the store BEFORE crossing …
    // … then reached executor.apply, which faulted. A raw fault in the crossing MECHANISM (not a
    // tool failure) is surfaced loudly and NOTHING is recorded — a malformed boundary is a bug.
    expect(put).not.toHaveBeenCalled();
  });

  it("a cleared tool that THROWS is captured as `failed`, never `applied`, and surfaced for retry", async () => {
    const { store, get, put } = countingAppStore();
    // A REAL executor (so executePlan captures the tool's throw as a `failed` OUTCOME rather than
    // propagating) bound to an implementation that explodes.
    const { built } = deps({
      executor: REFERENCE_EXECUTOR,
      live: true,
      applicationStore: store,
      resolveTool: throwingBoundary,
    });
    await expect(createProposeActions(built)([PLANNABLE])).rejects.toThrow(/live apply failed/);
    expect(get).toHaveBeenCalledTimes(1); // consulted the store BEFORE crossing …
    expect(put).toHaveBeenCalledTimes(1); // … and filed the outcome after
    const filed = put.mock.calls[0]?.[0] as ApplicationRecord;
    expect(filed.status).toBe("failed"); // a failed tool is NEVER recorded as applied …
    expect(filed).not.toHaveProperty("result"); // … it has no applied result (the Atomicity Rule)
  });
});

// =====================================================================
// 6. Only the AUTONOMOUS branch can cross; the executor never re-classifies the gate's verdict.
// =====================================================================

describe("executor boundary — only the autonomous branch can cross", () => {
  it("a needs_approval action is routed to approval and never reaches the boundary", async () => {
    const { store, put } = countingAppStore();
    const { built, executor } = deps({
      live: true,
      applicationStore: store,
      resolveTool: boundBoundary,
    });
    await createProposeActions(built)([passing({ reversible: false })]);
    expect(executor.planCalls()).toBe(0); // needs_approval never plans or applies
    expect(put).not.toHaveBeenCalled(); // no application record for a queued action
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });

  it("the executor's own refusal does NOT re-classify the gate verdict, and applies nothing", async () => {
    const { store, get, put } = countingAppStore();
    const { built, executor } = deps({
      live: true,
      applicationStore: store,
      resolveTool: boundBoundary,
    });
    // `passing()` is autonomous by the gate, but the executor REFUSES it (invalid_args) — the
    // verdict stays the gate's, the boundary stays shut, nothing is applied.
    const verdicts = await createProposeActions(built)([passing()]);
    expect(verdicts[0]?.decision).toBe("autonomous"); // the gate's decision is untouched
    expect(executor.planCalls()).toBe(1); // it planned (and refused) …
    expect(get).not.toHaveBeenCalled(); //   … but never reached applyOnce
    expect(put).not.toHaveBeenCalled(); //   … and recorded nothing
  });
});

// =====================================================================
// 7. The shadow store and the application store are STRUCTURALLY ISOLATED (the Shadow Isolation
//    Rule): live-on retains the shadow beside the apply — one key, two distinct records, two stores.
// =====================================================================

describe("executor boundary — the shadow and application stores are structurally isolated", () => {
  it("live-on retains the shadow: same key, distinct records, each in its OWN store", async () => {
    const app = countingAppStore();
    const shadow = countingShadowStore();
    const { facet, emit } = makeEvents();
    // A REAL executor + a bound tool so the apply SUCCEEDS — the shadow and the apply run side by
    // side for one action, exactly as R3 production would but for the empty boundary.
    const built = {
      identity: { employeeId: "emp-1", slug: "research-ai" } as EmployeeIdentity,
      posture: permits,
      capabilities: EMPTY_CAPABILITIES,
      budget: 1_000,
      correlationId: CORR,
      events: facet,
      taskId: TASK,
      executor: REFERENCE_EXECUTOR,
      shadow: true,
      shadowStore: shadow.store,
      live: true,
      applicationStore: app.store,
      resolveTool: boundBoundary,
    };
    await createProposeActions(built)([PLANNABLE]);

    // The shadow landed in the SHADOW store — a shadow-labelled observation, never an apply.
    expect(shadow.record).toHaveBeenCalledTimes(1);
    const shadowRec = shadow.record.mock.calls[0]?.[0] as { kind: string; idempotencyKey?: string };
    expect(shadowRec.kind).toBe("executor_shadow");

    // The apply landed in the APPLICATION store — an `applied` record, never a shadow row.
    expect(app.put).toHaveBeenCalledTimes(1);
    const appliedRec = app.put.mock.calls[0]?.[0] as ApplicationRecord;
    expect(appliedRec.status).toBe("applied");

    // ONE idempotency key ties the two together, yet the shapes are DISJOINT (a shadow row can
    // never be read as an applied one): the whole point of the Shadow Isolation Rule.
    expect(shadowRec.idempotencyKey).toBe(appliedRec.key);
    expect(shadowRec).not.toHaveProperty("status");
    expect(appliedRec).not.toHaveProperty("kind");

    // Both audit events fired, in order (§8 pins the ordering at source): action_permitted + tool.
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

// =====================================================================
// 8. Source-level — the runner composes plan→apply UNDER ITS OWN CONTROL, gates the live apply
//    behind the kill-switch, wires the EMPTY boundary in production, and keeps the shadow and
//    application stores as two distinct durable stores. Comments are stripped first so the prose
//    that DOCUMENTS the boundary (which names apply/execute to explain the contract) cannot trip a
//    match.
// =====================================================================

describe("executor boundary — the source composes plan→apply under runtime control", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const code = readFileSync(resolve(ROOT, "server/sdk/tasks.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://`)

  it("composes plan→apply itself and NEVER uses the fused executor.execute (keeps control between)", () => {
    expect(code).toContain("executor.plan(");
    expect(code).toContain("executor.apply(");
    // The runtime composes the two steps so it can consult the durable store BETWEEN plan and apply
    // (applyOnce) — it never hands control to the fused convenience.
    expect(code).not.toContain("executor.execute(");
    expect(code).toContain("applyOnce(");
    expect(code).toContain("deriveIdempotencyKey(");
  });

  it("gates the live apply behind the kill-switch and wires the EMPTY tool boundary in production", () => {
    // The switch is read once, and the durable application store + tool boundary are wired ONLY when
    // it is on (default-off protection made source).
    expect(code).toContain("executorLiveEnabled()");
    expect(code).toContain("live: liveOn");
    expect(code).toContain("applicationStore: liveOn ? createDurableApplicationStore() : undefined");
    // R3 binds NO real tool — production resolves through the EMPTY boundary, the second safety layer.
    expect(code).toContain("resolveTool: liveOn ? EMPTY_TOOL_BOUNDARY : undefined");
  });

  it("keeps the shadow and application stores structurally isolated — two distinct durable stores", () => {
    // The shadow persists through the SHADOW store, gated by its OWN switch (retained beside live).
    expect(code).toContain("executorShadowEnabled()");
    expect(code).toContain("shadowStore: shadowOn ? createDurableShadowObservationStore() : undefined");
    expect(code).toContain("shadowStore.record(");
    expect(code).toContain("shadowObservationRecord(");
    // The apply persists through the APPLICATION store — a different factory, a different write path.
    expect(code).toContain("createDurableApplicationStore");
    // The in-memory reference store is a TEST seam only — it is never wired into the runner.
    expect(code).not.toContain("createInMemoryApplicationStore");
  });

  it("audits a boundary crossing AFTER the permit decision, keyed identically (ADR 0009 Decision 10)", () => {
    const permitAt = code.indexOf('"ai.action_permitted"');
    const toolAt = code.indexOf('"ai.tool_called"');
    expect(permitAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(permitAt); // tool_called is emitted after action_permitted
    // The tool-call event carries the SAME idempotency key as the application record + the shadow
    // observation, so a reviewer can correlate all three.
    expect(code).toContain("idempotencyKey: applied.key");
  });
});
