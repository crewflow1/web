import {
  parseToolArgs,
  REFERENCE_TOOL_REGISTRY,
  type RegisteredTool,
  type ToolArgs,
  type ToolRegistry,
} from "./tools";
import type { GateVerdict, ProposedAction } from "./gate";

/**
 * CrewFlow HQ — the executor contract
 * (CEO Directive #014 / D-04, Phase C, increment C2; ADR 0009 Decisions 1, 3, 8, 9; Bible
 * Volume XIII §12).
 *
 * The executor is the runtime mechanism that APPLIES an action the doorman has already CLEARED:
 * resolve the registered tool → re-assert the action at the execution boundary → invoke the
 * tool's implementation → capture a typed outcome. Phase B classified and routed; Phase C applies
 * (ADR 0008 Decision 8's deferred third act). This module is the TYPED CONTRACT for that
 * mechanism — its shapes and its pure boundary logic — and nothing more.
 *
 * MECHANISM ONLY; IT APPLIES, IT NEVER DECIDES (the Executor Boundary Rule — Kernel Contract Map
 * §2; ADR 0009 Decision 3). The executor runs only on an already-cleared {@link GateVerdict}; it
 * never re-classifies, never requests approval, never touches the Task Engine, and never widens a
 * capability set. Policy stays with the gate ({@link import("./gate")}), approval with the
 * Approval Engine, lifecycle with the Task Engine. The executor's whole job is to carry a cleared
 * decision across the line into an audited effect — and to REFUSE to cross that line for anything
 * the gate did not clear.
 *
 * IT CONSUMES THE REGISTRY; IT NEVER MUTATES IT (the Registry Immutability Rule — Kernel Contract
 * Map §2; set on the C1 review). A tool is immutable platform metadata, registered once at
 * initialisation ({@link import("./tools")}); the executor RESOLVES from the registry read-only
 * ({@link ToolRegistry.resolve}) and treats every {@link RegisteredTool} as the frozen data it is.
 * Resolution tells the executor what a capability LOOKS like — its permission, its arg shape; it
 * grants nothing and changes nothing.
 *
 * THE EXECUTION BOUNDARY IS INJECTED, NEVER REACHED THROUGH HERE. The actual side effect — the
 * call that writes memory or sends a communication — is a {@link ToolImplementation} the RUNTIME
 * supplies (bound to the tool's `SECURITY DEFINER` entry point, where the subsystem-level
 * re-assertion lives — ADR 0009 Decision 8). This contract TYPES that seam and routes through it;
 * it provides no implementation, makes no external call, and performs no I/O of its own. Pass a
 * different boundary in a test, a real one in the runner — the contract is identical.
 *
 * WHAT THIS INCREMENT IS NOT (the CEO's C2 scope, 2026-06-28). No apply-on-approval runtime — the
 * approved-row sweep, the application/idempotency record, and `edited_payload` are increment C3
 * (ADR 0009 Decisions 4–6); here a non-`autonomous` verdict is simply REFUSED. No API Gateway and
 * no live cost metering — Phase D (ADR 0009 Decision 12). No Capability Registry and no
 * registry-keyed "does the employee still hold this?" re-check — Directive #015 (ADR 0009 Decision
 * 8). No runner wiring and no employee migration — the autonomous branch keeps emitting
 * audit-only until a later increment composes this contract into the runner. This file changes no
 * existing code.
 *
 * Pure + I/O-free (deliberately NO `server-only`): the only imports are the sibling pure contracts
 * {@link import("./tools")} and {@link import("./gate")} (types + the total `parseToolArgs`). Like
 * the registry, the gate, and {@link import("./output")}, the timeline / Boardroom UI may import
 * these types to render what an application would be. It reaches for no server module, no admin
 * client, no facet, and no approval or task surface — the only thing that ever touches the outside
 * world is the injected {@link ToolImplementation}, and that belongs to the caller.
 */

// ---------------------------------------------------------------------
// The execution boundary — an injected seam, supplied by the runtime
// ---------------------------------------------------------------------

/**
 * A tool's side-effecting implementation — the execution boundary itself, INJECTED by the runtime
 * and never provided here (ADR 0009 Decisions 1, 3, 8). Given the validated arguments, it carries
 * out the effect and resolves with its result. In the runner this is bound to the tool's
 * `SECURITY DEFINER` entry point, where the subsystem re-asserts permission at the point of
 * application (Decision 8 — "inherited re-checking at the execution boundary"); in a test it is a
 * pure stand-in. The contract only ever CALLS it — it is the one place an effect can happen, and
 * it lives with the caller, not in this pure module.
 */
export type ToolImplementation = (args: ToolArgs) => Promise<unknown>;

// ---------------------------------------------------------------------
// The plan — a validated, read-only description of what WILL be applied
// ---------------------------------------------------------------------

/**
 * A validated, read-only description of one application the executor is willing to perform — the
 * product of {@link planExecution} for a CLEARED action. It pairs the resolved {@link
 * RegisteredTool} (read from the registry, never copied or mutated) with the cleared {@link
 * ProposedAction} and the arguments already validated against the tool's `argSchema`. A plan is a
 * DESCRIPTION, not an effect: holding one applies nothing — {@link executePlan} applies it through
 * an injected boundary. The plan is frozen; like a tool, it is immutable once produced.
 */
export interface ExecutionPlan {
  /** The tool resolved from the registry by the action's `type` — read-only metadata. */
  readonly tool: RegisteredTool;
  /** The cleared action this plan applies — carried through for audit and attribution. */
  readonly action: ProposedAction;
  /** The arguments, already validated against `tool.argSchema` (the typed target, P4 atom 3). */
  readonly args: ToolArgs;
}

// ---------------------------------------------------------------------
// Refusal — the boundary saying "no" (not a denial, not a failure)
// ---------------------------------------------------------------------

/**
 * Why the executor REFUSES to cross the execution boundary. A refusal is neither the doorman's
 * DENIAL (a `needs_approval` verdict — that is the gate's, Phase B) nor a tool FAILURE (a cleared
 * tool that then throws — see {@link ExecutionOutcome}); it is the executor declining to apply
 * because its own boundary preconditions are not met (ADR 0009 Decision 3). Refusing is always
 * safe — the executor grants nothing and applies nothing.
 */
export type ExecutionRefusalReason =
  /** The gate did not clear the action (the verdict is not `autonomous`) — the Executor Boundary
   *  Rule's first line. The approved-row path that would clear it is increment C3. */
  | "not_cleared"
  /** No registered tool answers the action's `type` — there is nothing to apply. */
  | "unknown_tool"
  /** The action's declared capability disagrees with the resolved tool's permission — a boundary
   *  integrity check (a confused-deputy guard), NOT a capability-holding authorisation (#015). */
  | "permission_mismatch"
  /** The action's payload fails the tool's `argSchema` — an untyped target may not be applied. */
  | "invalid_args";

/**
 * The executor's refusal to apply — a declarative reason plus a human-readable detail, mirroring
 * the gate's explainable {@link GateVerdict}. It records WHY the boundary stayed shut, so a refusal
 * is as auditable as a denial.
 */
export interface ExecutionRefusal {
  /** The boundary precondition that was not met. */
  readonly reason: ExecutionRefusalReason;
  /** A human-readable explanation — for the audit trail and for tests. */
  readonly detail: string;
}

/**
 * The result of {@link planExecution} — a total, discriminated outcome. `ok: true` carries a
 * validated {@link ExecutionPlan}; `ok: false` carries the {@link ExecutionRefusal} that explains
 * why no plan was produced. Planning never throws and never applies anything.
 */
export type ExecutionPlanResult =
  | { readonly ok: true; readonly plan: ExecutionPlan }
  | { readonly ok: false; readonly refusal: ExecutionRefusal };

// ---------------------------------------------------------------------
// Outcome — what happened once the boundary was crossed
// ---------------------------------------------------------------------

/**
 * What happened when a plan was applied through the injected boundary — a total, discriminated
 * outcome captured as DATA (ADR 0009 Decision 9, "a typed per-action result available"). `applied`
 * carries the implementation's result; `failed` carries the error message of a cleared tool whose
 * invocation then threw. {@link executePlan} returns this rather than throwing, exactly as the
 * gate returns a {@link GateVerdict} rather than acting — the RUNNER then chooses the mechanism
 * (the throw-by-default ABI that records `hq_ai_task_fail`, or partial-progress that reads the
 * typed result). The executor itself never decides the task's fate (Decision 3).
 */
export type ExecutionOutcome =
  | { readonly status: "applied"; readonly label: string; readonly result: unknown }
  | { readonly status: "failed"; readonly label: string; readonly error: string };

/**
 * The end-to-end result of {@link execute} — plan-then-apply in one total value. `ok: false` is a
 * boundary {@link ExecutionRefusal} (the action was never applied); `ok: true` carries the {@link
 * ExecutionOutcome} of an attempt that DID cross the boundary (then `applied` or `failed`). This
 * split is ADR 0009 Decision 9's distinction made structural: a refusal (the boundary) and a
 * failure (the invocation) are different things, with different owners.
 */
export type ExecutionResult =
  | { readonly ok: false; readonly refusal: ExecutionRefusal }
  | { readonly ok: true; readonly outcome: ExecutionOutcome };

// ---------------------------------------------------------------------
// Internal helpers — pure
// ---------------------------------------------------------------------

/** Build a refusal result — the single shape every boundary "no" takes. */
function refuse(reason: ExecutionRefusalReason, detail: string): ExecutionPlanResult {
  return { ok: false, refusal: { reason, detail } };
}

/** Normalise a thrown value into a message, without assuming it is an `Error`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return "tool implementation failed";
}

// ---------------------------------------------------------------------
// planExecution — the pure execution boundary (registry consumption)
// ---------------------------------------------------------------------

/**
 * Plan the application of ONE action against the registry — the executor's pure boundary. It
 * APPLIES nothing; it decides whether an application is permissible and, if so, prepares it. PURE
 * and TOTAL: same inputs → same result, no I/O, no mutation (it reads the registry read-only — the
 * Registry Immutability Rule — and never alters the action, the verdict, or any tool).
 *
 * The checks, in order, each a reason the boundary stays shut (deny-by-default):
 *   1. the gate must have CLEARED the action — `verdict.decision === "autonomous"` — or it is
 *      `not_cleared` (the Executor Boundary Rule: apply only what passed the gate; the
 *      approved-row path is increment C3, deliberately out of scope here);
 *   2. a tool must RESOLVE for `action.type` (the C1 label convention) — or it is `unknown_tool`;
 *   3. when the action declares a `capability`, it must MATCH the resolved tool's `permission` — a
 *      boundary integrity check (the resolved tool is the capability the gate cleared), or it is
 *      `permission_mismatch`. This is NOT capability-holding authorisation — whether the employee
 *      HOLDS the token is the gate's (Phase B) and #015's, never the executor's;
 *   4. the action's `payload` must VALIDATE against the tool's `argSchema` (P4 atom 3, re-checked
 *      at the boundary) — or it is `invalid_args`.
 *
 * Only when all four hold does it return a frozen {@link ExecutionPlan}. Note what it does NOT
 * do: it does not re-run P4, re-check posture, or re-evaluate the verdict — re-deciding policy is
 * the gate's job, and the executor must not (Decision 3). It trusts the verdict's clearance and
 * adds only the boundary's own integrity guards.
 */
export function planExecution(
  registry: ToolRegistry,
  action: ProposedAction,
  verdict: GateVerdict,
): ExecutionPlanResult {
  // 1. Executor Boundary Rule — apply only an action the gate has cleared.
  if (verdict.decision !== "autonomous") {
    return refuse(
      "not_cleared",
      `the gate returned "${verdict.decision}"; the executor applies only cleared actions`,
    );
  }

  // 2. Registry consumption — resolve the tool read-only, by the action's type (the C1 label).
  const tool = registry.resolve(action.type);
  if (!tool) {
    return refuse("unknown_tool", `no registered tool answers "${action.type}"`);
  }

  // 3. Execution-boundary integrity — the resolved tool must be the capability the gate cleared.
  //    (A confused-deputy guard, not authorisation: token POSSESSION is the gate's / #015's.)
  if (action.capability !== undefined && action.capability !== tool.permission) {
    return refuse(
      "permission_mismatch",
      `action capability "${action.capability}" does not match tool permission "${tool.permission}"`,
    );
  }

  // 4. Typed target (P4 atom 3) — the payload must validate against the tool's schema.
  const parsed = parseToolArgs(tool, action.payload ?? {});
  if (!parsed.ok) {
    return refuse("invalid_args", parsed.error);
  }

  const plan = Object.freeze({ tool, action, args: parsed.args }) as ExecutionPlan;
  return { ok: true, plan };
}

// ---------------------------------------------------------------------
// executePlan — cross the boundary via the injected implementation
// ---------------------------------------------------------------------

/**
 * Apply a planned action through the injected boundary and capture a typed {@link
 * ExecutionOutcome}. This is the only async function in the contract, and its ONLY effect is the
 * call to `invoke` — the implementation supplied by the caller; the executor performs no I/O of
 * its own. A successful call yields `applied` (with the implementation's result); a throw is
 * CAPTURED as `failed` (with its message) rather than propagated, so the outcome is a total value
 * the runner can act on (Decision 9 — "a typed per-action result available"). Capturing the
 * failure here does not decide the task's fate: the runner reads the outcome and chooses to throw
 * (the default `hq_ai_task_fail` ABI) or to continue (partial progress). The executor never calls
 * `failTask` / `hq_ai_task_complete` (Decision 3, runner rule 3).
 */
export async function executePlan(
  plan: ExecutionPlan,
  invoke: ToolImplementation,
): Promise<ExecutionOutcome> {
  try {
    const result = await invoke(plan.args);
    return { status: "applied", label: plan.tool.label, result };
  } catch (err) {
    return { status: "failed", label: plan.tool.label, error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------
// execute — plan then apply (the end-to-end shape the runner composes)
// ---------------------------------------------------------------------

/**
 * Plan then apply, in one call — the end-to-end shape the runner composes. It {@link
 * planExecution}s the action and, only if the boundary opens, {@link executePlan}s it through the
 * injected `invoke`. A refusal short-circuits before any call to `invoke`, so a non-cleared or
 * ill-formed action never reaches the boundary. The whole effect is still the caller's injected
 * implementation; this function adds composition, not I/O.
 */
export async function execute(
  registry: ToolRegistry,
  action: ProposedAction,
  verdict: GateVerdict,
  invoke: ToolImplementation,
): Promise<ExecutionResult> {
  const planned = planExecution(registry, action, verdict);
  if (!planned.ok) return { ok: false, refusal: planned.refusal };
  const outcome = await executePlan(planned.plan, invoke);
  return { ok: true, outcome };
}

// ---------------------------------------------------------------------
// The executor — a registry-bound facade over the pure functions
// ---------------------------------------------------------------------

/**
 * An executor bound to one {@link ToolRegistry} — the ergonomic facade over the pure functions
 * above, mirroring how {@link createToolRegistry} returns a {@link ToolRegistry}. It CONSUMES the
 * registry (closing over it, read-only — the Registry Immutability Rule) and exposes the three
 * acts: {@link Executor.plan} (the pure boundary), {@link Executor.apply} (cross it via an injected
 * implementation), and {@link Executor.execute} (both). It still owns no policy, no approval, and
 * no lifecycle — it is the apply mechanism and nothing else.
 */
export interface Executor {
  /** Plan an application: refuse an uncleared/ill-formed action, prepare a cleared one. Pure. */
  plan(action: ProposedAction, verdict: GateVerdict): ExecutionPlanResult;
  /** Apply a prepared plan through the injected boundary, capturing a typed outcome. */
  apply(plan: ExecutionPlan, invoke: ToolImplementation): Promise<ExecutionOutcome>;
  /** Plan then apply — the end-to-end shape the runner composes over an injected boundary. */
  execute(
    action: ProposedAction,
    verdict: GateVerdict,
    invoke: ToolImplementation,
  ): Promise<ExecutionResult>;
}

/**
 * Build an {@link Executor} bound to the given registry. The registry is consumed read-only and
 * never mutated; the facade is frozen, like the registry it wraps. This composes the pure
 * functions over one catalogue — it wires no runner, no facet, and no real effect.
 */
export function createExecutor(registry: ToolRegistry): Executor {
  return Object.freeze({
    plan: (action: ProposedAction, verdict: GateVerdict) =>
      planExecution(registry, action, verdict),
    apply: (plan: ExecutionPlan, invoke: ToolImplementation) => executePlan(plan, invoke),
    execute: (action: ProposedAction, verdict: GateVerdict, invoke: ToolImplementation) =>
      execute(registry, action, verdict, invoke),
  });
}

// ---------------------------------------------------------------------
// Reference executor — bound to the C1 reference registry (no behaviour)
// ---------------------------------------------------------------------

/**
 * The reference executor — bound to C1's {@link REFERENCE_TOOL_REGISTRY}, the worked catalogue of
 * `memory.write` (reversible) and `comm.send` (irreversible). It carries no implementations: like
 * every executor it applies only through an INJECTED {@link ToolImplementation}, so this handle
 * plans and refuses purely, and applies only what a caller's boundary supplies. It exists so the
 * contract has a ready executor to test, and so the Reference Path execution test (increment C4 —
 * the Reference Path Rule's first deliverable use) has the same catalogue to drive end-to-end.
 */
export const REFERENCE_EXECUTOR: Executor = createExecutor(REFERENCE_TOOL_REGISTRY);
