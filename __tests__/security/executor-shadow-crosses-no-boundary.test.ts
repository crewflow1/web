import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BoundEvents } from "@/server/sdk/events";
import type { EmploymentPosture, ProposedAction, GateVerdict } from "@/server/sdk/gate";
import type { Executor, ExecutionPlanResult } from "@/server/sdk/executor";

/**
 * CrewFlow HQ — the executor-shadow trust boundary (increments R1 + R2)
 * (CEO Directive #016 / D-06; ADR 0011; the Executor Boundary Rule + the Runtime Composition Rule +
 * the Shadow Truthfulness Rule — Kernel Contract Map §2).
 *
 * R1 wired the proven `plan → key` composition into the runner's autonomous branch SHADOW-FIRST:
 * default-off, and even ON it only OBSERVES — it must never cross the execution boundary (no
 * `apply`, no `execute`, no real effect). R2 gives that observation a durable home, but ONLY as an
 * EXPLICIT shadow-labelled record through a store structurally separate from the application store
 * (the Shadow Truthfulness Rule) — never an `applied` marker a real execution is indistinguishable
 * from. This file proves both as a matter of BEHAVIOUR and of SOURCE, so a future edit that quietly
 * turns the shadow into a live apply — flips the kill-switch default, or persists an application
 * record — fails here.
 *
 * What breaks if a fact silently flips:
 *   • the kill-switch default flips on → the shadow would run in production unbidden. Asserted off.
 *   • the shadow calls executor.apply/execute → an autonomous decision becomes an APPLIED effect
 *     with no approval flow and no cut-over decision (the very thing the shadow excludes). Never.
 *   • the shadow rides the needs-approval branch → it would observe an action a human must see
 *     before any mechanism runs. Asserted: only the autonomous branch shadows.
 *   • the shadow writes an APPLICATION record → it would poison the idempotency guarantee a later
 *     real apply depends on. Asserted: the runner persists ONLY through the shadow store
 *     (`kind: "executor_shadow"`), never the application / apply-once path.
 *
 * The Approval Engine is the one service the doorman hands off to, so we mock IT and inject a fake
 * events facet; the admin client + embeddings are stubbed only so the runner's module graph imports
 * cleanly (mirroring propose-actions.test.ts). Nothing real is reached for.
 */

const { requestApprovalMock } = vi.hoisted(() => ({ requestApprovalMock: vi.fn() }));
vi.mock("@/server/services/hq-approvals", () => ({ requestApproval: requestApprovalMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai/embeddings", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));

import {
  createProposeActions,
  executorShadowEnabled,
  EMPTY_CAPABILITIES,
  type EmployeeIdentity,
} from "@/server/sdk/tasks";
import { REFERENCE_EXECUTOR } from "@/server/sdk/executor";

const CORR = "corr-boundary-1";

/** A posture that PERMITS autonomy — so a plannable action reaches the shadow at all. */
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

/**
 * A boundary tripwire: `plan` delegates to the reference executor (so the shadow can observe), but
 * `apply` and `execute` THROW the instant they are reached. If the R1 shadow ever crossed the
 * boundary, the run would throw here and the test would fail loudly — the boundary is proven shut
 * by construction, not by inspection.
 */
function tripwireExecutor(): Executor & { planCalls: () => number } {
  let planned = 0;
  const exec: Executor = {
    plan: (action: ProposedAction, verdict: GateVerdict): ExecutionPlanResult => {
      planned += 1;
      return REFERENCE_EXECUTOR.plan(action, verdict);
    },
    apply: () => {
      throw new Error("BOUNDARY CROSSED: executor.apply was reached from the R1 shadow");
    },
    execute: () => {
      throw new Error("BOUNDARY CROSSED: executor.execute was reached from the R1 shadow");
    },
  };
  return Object.assign(exec, { planCalls: () => planned });
}

beforeEach(() => {
  requestApprovalMock.mockReset();
  requestApprovalMock.mockResolvedValue({ ok: true, approval: { id: "appr-1" } });
});

// =====================================================================
// 1. The kill-switch is default-OFF and strict.
// =====================================================================

describe("R1 executor shadow — the kill-switch is default-OFF", () => {
  it("is false for an env without the flag", () => {
    expect(executorShadowEnabled({})).toBe(false);
  });

  it('is on ONLY for the exact string "on" — never "true"/"1"/"ON"/empty', () => {
    expect(executorShadowEnabled({ CREWFLOW_EXECUTOR_SHADOW: "on" })).toBe(true);
    for (const v of ["true", "1", "ON", "On", "yes", "off", ""]) {
      expect(executorShadowEnabled({ CREWFLOW_EXECUTOR_SHADOW: v })).toBe(false);
    }
  });
});

// =====================================================================
// 2. ON, the shadow OBSERVES — it never crosses the execution boundary.
// =====================================================================

describe("R1 executor shadow — ON, it observes without crossing the execution boundary", () => {
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
      taskId: "task-boundary-1",
      executor,
      shadow: true,
      ...over,
    };
    return { built, emit, executor };
  }

  it("a plannable autonomous action plans but NEVER applies/executes", async () => {
    const { built, executor } = deps();
    await createProposeActions(built)([passing({ payload: { verdict: "qualified" } })]);
    // Reaching this line proves apply/execute were not reached — they throw if they are.
    expect(executor.planCalls()).toBe(1);
  });

  it("a batch (autonomous + needs-approval + refusable) crosses no boundary; only autonomous plans", async () => {
    const { built, executor, emit } = deps();
    const verdicts = await createProposeActions(built)([
      passing({ payload: { verdict: "qualified" } }), // autonomous → shadow PLANS
      passing({ reversible: false }), //                  needs_approval → NOT shadowed
      passing(), //                                       autonomous but invalid_args → plan REFUSES
    ]);
    expect(verdicts.map((v) => v.decision)).toEqual(["autonomous", "needs_approval", "autonomous"]);
    expect(executor.planCalls()).toBe(2); // only the two autonomous actions were planned
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2); // one audit per autonomous action
  });

  it("an irreversible action is never shadowed — it is never autonomous (the gate routes it to approval first)", async () => {
    const { built, executor } = deps();
    await createProposeActions(built)([
      passing({ type: "comm.send", reversible: false, payload: { channel: "email", body: "hi" } }),
    ]);
    expect(executor.planCalls()).toBe(0); // the shadow was never reached
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// 3. Source-level — the runner observes and persists ONLY a shadow-labelled
//    record; it never applies, and never writes an application record.
//    Comments are stripped first so the prose that DOCUMENTS the boundary
//    (which names apply/execute/application to explain what it does NOT do)
//    cannot trip a match.
// =====================================================================

describe("R1+R2 executor shadow — the source observes and persists ONLY a shadow-labelled record", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const code = readFileSync(resolve(ROOT, "server/sdk/tasks.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://`)

  it("calls executor.plan but never executor.apply / executor.execute", () => {
    expect(code).toContain("executor.plan(");
    expect(code).not.toContain("executor.apply(");
    expect(code).not.toContain("executor.execute(");
  });

  it("persists durably ONLY through the SHADOW store — never an application / apply-once record", () => {
    // It derives the key the real apply WOULD use…
    expect(code).toContain("deriveIdempotencyKey(");
    // …and in R2 it DOES persist — but ONLY as an explicit shadow-labelled record, through the
    // durable shadow store (the Shadow Truthfulness Rule made source).
    expect(code).toContain("shadowObservationRecord(");
    expect(code).toContain("shadowStore.record(");
    expect(code).toContain("createDurableShadowObservationStore");
    // …NEVER through the application store or the apply-once path: writing an `applied` marker in
    // shadow would be indistinguishable from a real execution, the exact thing the rule forbids.
    expect(code).not.toContain("createInMemoryApplicationStore");
    expect(code).not.toContain("createApplicationStore");
    expect(code).not.toContain("applyOnce");
    expect(code).not.toContain("appliedRecord");
    expect(code).not.toContain(".put(");
  });
});

// =====================================================================
// 4. Source-level — the DURABLE store (server/services/executor-shadow.ts) is
//    OBSERVATION-ONLY and IDEMPOTENT: it writes ONLY the shadow table through the
//    shadow RPC, never an application / apply-once record, and de-duplicates a
//    re-run by a natural key (so the Task Engine's whole-task retry cannot
//    accumulate duplicate observations). Comments are stripped first so the prose
//    that documents what the store does NOT do cannot trip a match.
// =====================================================================

describe("R2 durable shadow store — observation-only, idempotent, never an application record", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const storeCode = readFileSync(resolve(ROOT, "server/services/executor-shadow.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://`)

  it("writes ONLY through the shadow RPC and ONLY to the shadow table — no apply/tenant write", () => {
    // The one write verb is the SECURITY DEFINER shadow RPC…
    expect(storeCode).toContain("hq_record_executor_shadow");
    // …landing ONLY in the shadow table. No apply-once RPC, no application store, no live apply.
    expect(storeCode).toContain("hq_ai_executor_shadow_observations");
    expect(storeCode).not.toContain("applyOnce");
    expect(storeCode).not.toContain("appliedRecord");
    expect(storeCode).not.toContain("ApplicationStore");
    expect(storeCode).not.toContain("hq_apply"); // no apply-on-approval / apply-once RPC
    // The store MUTATES nothing — it only reads (idempotency guard) and calls the append RPC.
    expect(storeCode).not.toContain(".update(");
    expect(storeCode).not.toContain(".delete(");
    expect(storeCode).not.toContain(".upsert(");
  });

  it("is IDEMPOTENT by a natural key — a re-run is deduped before the insert", () => {
    // The guard reads the shadow table by the run+action natural key and short-circuits a re-run.
    expect(storeCode).toContain("findExistingObservationId");
    expect(storeCode).toContain('.eq("correlation_id"');
    expect(storeCode).toContain('.eq("task_id"');
    expect(storeCode).toContain('.eq("action_id"');
  });
});
