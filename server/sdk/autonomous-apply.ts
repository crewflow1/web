import type { ProposedAction } from "./gate";
import type { ToolImplementation } from "./executor";

/**
 * CrewFlow HQ — the autonomous-apply authority (P2 HQ AI Operating System; the
 * autonomous sibling of the apply-on-approval authority, server/services/hq-apply-drain.ts).
 *
 * The executor (server/sdk/executor.ts) has always been able to APPLY a cleared action
 * through an injected {@link ToolImplementation}, but the runner's autonomous branch
 * (server/sdk/tasks.ts, createProposeActions) only ever AUDITED and, behind a default-off
 * kill-switch, SHADOWED (planned, never applied). This module is the seam that lets the
 * runner finally compose the executor's apply into the autonomous path — for the
 * DETERMINISTIC path only, and DARK by default.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * DARK BY THREE INDEPENDENT GATES
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *   1. THE POSTURE FLOOR (structural, and the strongest). Every AI employee's grant sits
 *      at the default-deny floor (can_execute=false), so the pure gate
 *      (server/sdk/gate.ts) returns `needs_approval` for EVERY proposed action and the
 *      autonomous branch is never even reached. No env var and no authority can change
 *      this — only a Capability-Registry grant edit can, which is a product decision.
 *   2. THE KILL-SWITCH. {@link executorAutonomousApplyEnabled} is false unless
 *      `CREWFLOW_EXECUTOR_APPLY` is exactly `"on"` — mirroring the executor shadow's
 *      `CREWFLOW_EXECUTOR_SHADOW` and the apply-on-approval `CREWFLOW_HQ_APPLY_ON_APPROVAL`.
 *      Off (the default), the runner composes no apply at all.
 *   3. THE AUTHORITY. Even with the kill-switch on, the production authority is
 *      {@link createUnboundAutonomousApplyAuthority} — it resolves EVERY action to `null`,
 *      so nothing is applied. A `null` resolution is the authority DECLINING to act; it is
 *      never a bare write.
 *
 * DETERMINISTIC ONLY; GENERATIVE DEGRADES TO NULL. A bound authority may resolve a
 * {@link ToolImplementation} ONLY for a deterministic tool — one whose effect is computed,
 * reversible, and reaches no model. A GENERATIVE action (one that would need a model tier
 * bound in the governor, lib/ai/governor) MUST resolve to `null` here: the governor is
 * dark (every tier maps to no model), so a generative apply would have nothing to call.
 * Degrading to `null` is the honest posture — the action is left for the approval path, and
 * nothing is fabricated. This is the "deterministic/draft execution paths only" rule made a
 * matter of type: the authority is the ONE place that decides an action is deterministic
 * enough to apply, and it decides by RESOLVING or DECLINING, never by generating.
 *
 * A non-null implementation MUST route through an EXISTING sanctioned boundary (a tool's
 * SECURITY DEFINER entry point), never a direct tenant write. This interface keeps that
 * promise structural: the runner composes the executor over the authority's implementation;
 * the authority owns the effect.
 *
 * Pure + I/O-free (deliberately NO `server-only`): the only imports are the sibling pure
 * contracts {@link import("./gate")} and {@link import("./executor")}, TYPES only — so at
 * runtime this module imports nothing. The real, bound authority (if one is ever built) and
 * the durable application store live in `server/services`, exactly as the apply-on-approval
 * authority does.
 */

// ---------------------------------------------------------------------
// The kill-switch — default OFF (dark), mirroring the executor shadow
// ---------------------------------------------------------------------

/**
 * The autonomous-apply kill-switch. DEFAULT-OFF: the runner composes an autonomous apply
 * only when `CREWFLOW_EXECUTOR_APPLY` is exactly `"on"`. Off, the autonomous branch behaves
 * exactly as before (audit + optional shadow, never an apply). Exported so the runner and
 * the test suite read the SAME switch — the sibling of `executorShadowEnabled`
 * (server/sdk/tasks.ts) and `hqApplyOnApprovalEnabled` (server/services/hq-apply-drain.ts).
 */
export function executorAutonomousApplyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CREWFLOW_EXECUTOR_APPLY === "on";
}

// ---------------------------------------------------------------------
// The authority — the ONLY thing that supplies an effect boundary
// ---------------------------------------------------------------------

/**
 * The sanctioned authority the runner applies THROUGH on the autonomous path. {@link
 * resolve} maps ONE cleared, deterministic action to the injected {@link ToolImplementation}
 * the executor will invoke, or `null` when this authority is NOT bound to apply the action
 * — because it is generative, irreversible, or simply unmapped. A `null` resolution means
 * the runner applies NOTHING and records NOTHING for that action (the action's audit +
 * shadow still happen exactly as before); it is the authority declining, never a bare write.
 */
export interface AutonomousApplyAuthority {
  /**
   * The tool implementation to apply this cleared action through, or `null` to decline.
   * A non-null result MUST be a deterministic tool's SECURITY DEFINER boundary; a
   * generative action MUST return `null` (the governor is dark — there is nothing to call).
   */
  resolve(action: ProposedAction): ToolImplementation | null;
}

/**
 * The production authority — UNBOUND, so the autonomous apply is dark even with the
 * kill-switch on. Every action resolves to `null`: no sanctioned boundary is bound, so the
 * runner applies nothing and records nothing. This is the honest default posture, not a stub
 * to be filled with a bare write.
 *
 * Binding a real authority is ENGINEERING, not a config flip: it needs a `resolve()` that
 * maps each deterministic action type to a boundary closure routed through the sanctioned
 * executor with per-action-type coverage and refuse-before-effect, AND the execution lock
 * lifted from the employee's grant. Until both land, this default keeps the autonomous apply
 * a safe, provable no-op.
 */
export function createUnboundAutonomousApplyAuthority(): AutonomousApplyAuthority {
  return Object.freeze({ resolve: () => null });
}
