import type { GateVerdict, ProposedAction } from "./gate";
import {
  executeVerified,
  featureHqAutonomousApplyEnabled,
  planExecution,
  type ApplyAuditStep,
  type ApplyStage,
  type BoundToolImplementation,
  type ToolImplementation,
} from "./executor";
import { isReversibleTool, REFERENCE_TOOL_REGISTRY, type ToolRegistry } from "./tools";

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
 * Pure + I/O-free (deliberately NO `server-only`): the only imports are the sibling PURE
 * contracts {@link import("./gate")}, {@link import("./executor")} and {@link import("./tools")}
 * — types plus their pure, I/O-free functions ({@link import("./executor").executeVerified},
 * {@link import("./executor").planExecution}, {@link import("./executor").featureHqAutonomousApplyEnabled},
 * {@link import("./tools").isReversibleTool}). Every effect the bound authority performs — the
 * SECURITY DEFINER boundary and the durable audit sink — is INJECTED by the caller, so this module
 * still reaches for no server module, no admin client, and no facet. The durable audit sink binding
 * lives in `server/services`, exactly as the apply-on-approval authority's durable store does.
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

// =====================================================================
// The immutable apply audit — every attempt, whatever its fate
// =====================================================================

/**
 * One immutable audit entry for a single apply attempt — recorded regardless of the attempt's fate
 * (approved · executed · verified · rolled_back · refused · failed). This is the permanent record the
 * capability owes: with real execution locked, NOTHING is ever recorded in production; behind the
 * flag it is the ground truth of what the machinery did. The `steps` carry the ordered stage trail
 * from {@link import("./executor").executeVerified}; `stage` is the attempt's TERMINAL stage.
 */
export interface ApplyAuditEntry {
  /** Which apply path produced the attempt — the inline autonomous branch or the approval sweep. */
  readonly path: "autonomous" | "approval";
  /** The registered tool the attempt applied (or would have). */
  readonly toolLabel: string;
  /** The action's stable identity within the run (`subjectType:subjectId:type` / the approval action). */
  readonly actionId: string;
  /** The run's spine trace id — threads the attempt into its originating run. */
  readonly correlationId: string;
  /** The attempt's terminal stage — the single word that says how it ended. */
  readonly stage: ApplyStage;
  /** The ordered stage trail of the attempt (empty for a pre-boundary refusal). */
  readonly steps: readonly ApplyAuditStep[];
  /** A human-readable summary of the terminal stage. */
  readonly detail: string;
}

/**
 * The apply audit's persistence — an INJECTED seam, exactly like the apply-once
 * {@link import("./application").ApplicationStore}. The production binding is a durable append-only
 * table (migration 20261199000000, bound in server/services/hq-apply-audit.ts); the pure reference
 * ({@link createInMemoryApplyAuditSink}) lets the machinery be proven end-to-end without a DB. It is
 * the one place an audit write happens, and it belongs to the caller — this module only CALLS it.
 */
export interface ApplyAuditSink {
  record(entry: ApplyAuditEntry): Promise<void>;
}

/**
 * An in-memory {@link ApplyAuditSink} — the reference implementation (no DB, no I/O), the sibling of
 * {@link import("./application").createInMemoryApplicationStore}. The array is exposed so a test can
 * assert the exact stage trail every attempt recorded; production uses the durable table instead.
 */
export function createInMemoryApplyAuditSink(): ApplyAuditSink & {
  readonly entries: ApplyAuditEntry[];
} {
  const entries: ApplyAuditEntry[] = [];
  return {
    entries,
    async record(entry: ApplyAuditEntry): Promise<void> {
      entries.push(entry);
    },
  };
}

/** Derive the terminal stage of an attempt from the last step of its trail (defaults to `refused`). */
export function terminalStage(steps: readonly ApplyAuditStep[]): ApplyStage {
  return steps.length > 0 ? steps[steps.length - 1]!.stage : "refused";
}

/**
 * A no-op {@link ApplyAuditSink}. The default when no sink is injected: recording is best-effort at
 * the call sites, so a missing sink simply records nothing (it never fabricates an effect). Frozen.
 */
export function createNullApplyAuditSink(): ApplyAuditSink {
  return Object.freeze({ async record(): Promise<void> {} });
}

// =====================================================================
// The bound tool registry — per-tool deterministic implementations
// =====================================================================

/**
 * A per-tool catalogue of {@link BoundToolImplementation}s, keyed by tool label — the concrete,
 * sanctioned boundaries the authority resolves an APPROVED, DETERMINISTIC action to. It is INJECTED
 * by the runtime/test; the production default is EMPTY (see {@link GatedAutonomousApplyDeps}), so the
 * authority is dark by an empty map even before the flag is consulted. A live binding populates it
 * with implementations whose `apply` routes through each tool's SECURITY DEFINER entry point.
 */
export type BoundToolRegistry = ReadonlyMap<string, BoundToolImplementation>;

/** The dependencies of {@link createGatedAutonomousApplyAuthority} — all injected, all with dark defaults. */
export interface GatedAutonomousApplyDeps {
  /** The build-flag env (defaults to `process.env`). Off (the default) ⇒ resolve returns null. */
  readonly env?: Record<string, string | undefined>;
  /** The per-tool bound implementations (defaults to EMPTY ⇒ every action unmapped ⇒ null). */
  readonly bound?: BoundToolRegistry;
  /** The tool registry used to plan/validate + classify reversibility (defaults to the reference). */
  readonly registry?: ToolRegistry;
  /** The immutable audit sink (defaults to no-op). Behind the flag it records every attempt. */
  readonly audit?: ApplyAuditSink;
  /** The run's correlation id, threaded into every audit entry. */
  readonly correlationId?: string;
}

/** The cleared verdict used to re-assert an approved/autonomous action at the execution boundary. */
const CLEARED_VERDICT: GateVerdict = { decision: "autonomous", reasons: [] };

/**
 * THE PRODUCTION AUTONOMOUS-APPLY AUTHORITY — complete engineering, LOCKED by default.
 *
 * Unlike {@link createUnboundAutonomousApplyAuthority} (which resolves EVERYTHING to null and is the
 * safe production default the runner still wires), this authority is the fully-built resolver a CEO
 * activation would switch to. Its {@link AutonomousApplyAuthority.resolve} maps ONE cleared,
 * deterministic action to a boundary closure that applies → verifies → rolls-back → audits — but only
 * after passing a strict, layered gate, and it DECLINES (`null`) at the first failing layer:
 *
 *   1. THE LOCK. `FEATURE_HQ_AUTONOMOUS_APPLY !== "on"` ⇒ null, recording a `refused` audit entry.
 *      This is the default in production TODAY, so today this authority resolves nothing. No env, no
 *      caller, no descriptor can move past this layer while the flag is off.
 *   2. MAPPED. No {@link BoundToolImplementation} is registered for `action.type` ⇒ null (unmapped).
 *   3. PLANNABLE. {@link planExecution} refuses the action (unknown tool / arg-schema mismatch /
 *      capability mismatch) ⇒ null — refuse-BEFORE-effect at the boundary.
 *   4. DETERMINISTIC-ONLY. The resolved tool is irreversible ⇒ null. A generative/irreversible action
 *      is never bound for autonomous apply — the governor is dark, and an irreversible effect has no
 *      rollback. Only a reversible tool earns a boundary here.
 *
 * Only when all four pass does it return a {@link ToolImplementation} closure. That closure runs the
 * COMPLETE apply lifecycle through {@link executeVerified} (execute → verify → rollback), records the
 * immutable audit entry, and — on a non-applied outcome — THROWS, so the executor captures `failed`
 * and the apply-once store never files an `applied` marker for a rolled-back/failed attempt.
 */
export function createGatedAutonomousApplyAuthority(
  deps: GatedAutonomousApplyDeps = {},
): AutonomousApplyAuthority {
  const env = deps.env;
  const bound = deps.bound ?? new Map<string, BoundToolImplementation>();
  const registry = deps.registry ?? REFERENCE_TOOL_REGISTRY;
  const audit = deps.audit ?? createNullApplyAuditSink();
  const correlationId = deps.correlationId ?? "";

  return Object.freeze({
    resolve(action: ProposedAction): ToolImplementation | null {
      const actionId = `${action.subjectType}:${action.subjectId}:${action.type}`;
      const refuse = (detail: string): null => {
        // Best-effort audit of the refusal — a pre-boundary decline is still an attempt worth
        // recording. A failing sink can never turn a decline into an effect, so swallow its error.
        void audit
          .record({
            path: "autonomous",
            toolLabel: action.type,
            actionId,
            correlationId,
            stage: "refused",
            steps: [],
            detail,
          })
          .catch(() => {});
        return null;
      };

      // 1. THE LOCK — production execution stays off unless FEATURE_HQ_AUTONOMOUS_APPLY === "on".
      if (!featureHqAutonomousApplyEnabled(env)) {
        return refuse("locked: FEATURE_HQ_AUTONOMOUS_APPLY is off (deny-by-default)");
      }
      // 2. MAPPED — a bound implementation must exist for the action's tool.
      const impl = bound.get(action.type);
      if (!impl) return refuse(`unmapped: no bound implementation for "${action.type}"`);
      // 3. PLANNABLE — re-assert the tool + typed args at the boundary (refuse-before-effect).
      const planned = planExecution(registry, action, CLEARED_VERDICT);
      if (!planned.ok) return refuse(`unplannable: ${planned.refusal.reason}`);
      // 4. DETERMINISTIC-ONLY — only a reversible tool may be applied autonomously.
      if (!isReversibleTool(planned.plan.tool)) {
        return refuse(`non-deterministic: "${action.type}" is irreversible`);
      }

      return async (args) => {
        const plan = Object.freeze({ tool: planned.plan.tool, action, args }) as typeof planned.plan;
        const outcome = await executeVerified(plan, impl);
        await audit
          .record({
            path: "autonomous",
            toolLabel: plan.tool.label,
            actionId,
            correlationId,
            stage: terminalStage(outcome.steps),
            steps: outcome.steps,
            detail:
              outcome.status === "applied"
                ? "applied and verified"
                : `not applied: ${outcome.error}${outcome.rolledBack ? " (rolled back)" : ""}`,
          })
          .catch(() => {});
        if (outcome.status === "failed") {
          // Surface as a throw so the executor captures `failed` and no `applied` marker is filed.
          throw new Error(outcome.error);
        }
        return outcome.result;
      };
    },
  });
}
