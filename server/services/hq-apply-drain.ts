import "server-only";
import {
  executeVerified,
  featureHqAutonomousApplyEnabled,
  planExecution,
  verifiedToOutcome,
  type BoundToolImplementation,
  type ExecutionOutcome,
} from "@/server/sdk/executor";
import {
  applyOnce,
  type ApplicationStore,
  type ApproverAttribution,
  type ExecutionIdentity,
} from "@/server/sdk/application";
import {
  createNullApplyAuditSink,
  terminalStage,
  type ApplyAuditSink,
  type BoundToolRegistry,
} from "@/server/sdk/autonomous-apply";
import type { GateVerdict, ProposedAction } from "@/server/sdk/gate";
import { isReversibleTool, REFERENCE_TOOL_REGISTRY, type ToolRegistry } from "@/server/sdk/tools";
import { createDurableApplicationStore } from "@/server/services/hq-application";
import { listApprovedApprovals } from "@/server/services/hq-approvals";
import { listDecisions } from "@/server/services/hq-decisions";

/**
 * CrewFlow HQ — the apply-on-approval runtime (the out-of-band sweep)
 * (CEO Directive #014 / D-04, Phase C, increment C3 rollout; ADR 0009 Decisions 4, 5, 6, 9;
 * Directive #016 Live Executor Rollout).
 *
 * This completes the approve → act loop. The Approval Engine and the Decision Centre mark an item
 * `approved`; something must then apply that granted item EXACTLY ONCE, record that it was applied,
 * and never apply it twice — even though the sweep re-runs on every tick. This module is that sweep,
 * composed from three EXISTING contracts and adding NO new authority of its own:
 *
 *   • `applyOnce` (server/sdk/application.ts) — the apply-once centrepiece: derive the deterministic
 *     idempotency key, consult the durable store BEFORE crossing the boundary, apply through an
 *     INJECTED closure, record the outcome. A prior `applied` is a no-op success; a prior
 *     `escalated` failure is left for the human who owns it.
 *   • the durable {@link ApplicationStore} (server/services/hq-application.ts) — the idempotency
 *     ground truth (migration 20261106000000).
 *   • the sanctioned {@link ApplyAuthority} — the ONLY thing that crosses into a real effect, and it
 *     is INJECTED, never reached through here. The drain performs NO write of its own; it only calls
 *     the authority the caller supplies.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * DEFAULT-DARK, BY TWO INDEPENDENT GATES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *   1. THE KILL-SWITCH (this module). {@link hqApplyOnApprovalEnabled} is `false` unless
 *      `CREWFLOW_HQ_APPLY_ON_APPROVAL` is exactly `"on"` — mirroring the executor shadow's
 *      `CREWFLOW_EXECUTOR_SHADOW` posture. OFF (the default, and prod today), {@link
 *      runApplyOnApprovalDrain} returns IMMEDIATELY: it reads no approved rows, resolves no
 *      authority, and applies nothing — a total no-op.
 *   2. THE AUTHORITY. Even with the kill-switch ON, this sweep still applies NOTHING, because the
 *      production authority is {@link createUnboundApplyAuthority} — it resolves EVERY item to
 *      `null`, so every item is SKIPPED (nothing applied, nothing recorded). A `null` authority is
 *      NEVER a bare write — it is the sweep declining to act.
 *
 *      Binding a real authority is ENGINEERING, not merely a config/wiring flip. Going live requires:
 *        (a) a production `ApplyAuthority.resolve()` that maps each approved descriptor to a boundary
 *            closure routed through the sanctioned executor (`executePlan` bound to a real
 *            {@link import("@/server/sdk/executor").ToolImplementation} at each tool's SECURITY
 *            DEFINER entry point), with per-action-type coverage and refuse-before-effect for any
 *            unmapped type;
 *        (b) wiring the executor off `REFERENCE_EXECUTOR` (server/sdk/tasks.ts ~L684, still the
 *            reference tool registry — no real effect) to real tool implementations; and
 *        (c) the ADR 0009 CEO live cut-over authority — a product/authority decision, never a silent
 *            flip.
 *      What IS built and verified is the apply SUBSTRATE this authority would plug into: the durable
 *      append-only store, the exactly-once partial unique index, the idempotency key, the
 *      kill-switch, the approved-only reader, and the service-role-only write RPC. The bound
 *      authority in (a)/(b) is the remaining, deliberately-unbuilt work.
 *
 * APPROVED-ONLY. The sweep reads ONLY `approved` hq_decisions (status='approved') and `approved`
 * hq_approvals (state='approved'); a pending/rejected/delayed/delegated/escalated/expired item is
 * never even loaded, let alone applied.
 *
 * NEVER A BARE TENANT WRITE. The drain touches only HQ tables (reads approved items, records apply
 * markers). The single path to a tenant effect is `authority.resolve(item)()`, whose closure MUST
 * route through an existing sanctioned authority. This module imports no tenant service and no
 * tenant table.
 */

// ---------------------------------------------------------------------
// The kill-switch — default OFF (dark), mirroring the executor shadow
// ---------------------------------------------------------------------

/**
 * The apply-on-approval kill-switch. DEFAULT-OFF: the sweep applies anything only when
 * `CREWFLOW_HQ_APPLY_ON_APPROVAL` is exactly `"on"`. Off, {@link runApplyOnApprovalDrain} is a total
 * no-op. Exported so the cron route and the test suite read the SAME switch (the sibling of
 * `executorShadowEnabled`, server/sdk/tasks.ts).
 */
export function hqApplyOnApprovalEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CREWFLOW_HQ_APPLY_ON_APPROVAL === "on";
}

// ---------------------------------------------------------------------
// The approved item — what the sweep loads (approved-only) and applies
// ---------------------------------------------------------------------

/**
 * One approved item the sweep may apply — a decision or an approval, already reduced to the pure
 * apply inputs. It carries the {@link ExecutionIdentity} the idempotency key derives from (source
 * `approval` — the out-of-band apply-on-approval path), the human approver to attribute, and a
 * `descriptor` the {@link ApplyAuthority} uses to route the apply through a sanctioned authority.
 * The descriptor is DATA the authority reads; this module never acts on it directly.
 */
export interface ApprovedItem {
  /** Which HQ engine the item came from — `decision` (hq_decisions) or `approval` (hq_approvals). */
  readonly kind: "decision" | "approval";
  /** The item's id (also the identity's `approvalId`). */
  readonly id: string;
  /** The stable execution identity the idempotency key derives from (source `approval`). */
  readonly identity: ExecutionIdentity;
  /** The human approver attributed to the apply, or `null`. */
  readonly approver: ApproverAttribution | null;
  /** What is to be applied — the sanctioned authority reads this to route the apply. */
  readonly descriptor: {
    /** The action type (an approval's `action`, or `hq.decision` for a strategic decision). */
    readonly type: string;
    /** The approval's subject (approvals only). */
    readonly subjectType?: string;
    readonly subjectId?: string;
    /** The payload to apply — `edited_payload ?? proposed_payload` for approvals. */
    readonly payload: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------
// The sanctioned authority — the ONLY thing that crosses into an effect
// ---------------------------------------------------------------------

/**
 * The sanctioned authority the sweep applies THROUGH — the injected boundary, never reached through
 * this module. {@link resolve} maps one approved item to the boundary-crossing `apply` closure
 * `applyOnce` will call, or `null` when this authority is NOT bound to apply the item (no declared
 * handler, or the live boundary is the CEO cut-over per ADR 0009). A `null` resolution means the
 * sweep applies NOTHING and records NOTHING for that item — never a bare write.
 *
 * A non-null closure MUST route through an EXISTING sanctioned authority (the executor's
 * SECURITY DEFINER entry point / the task engine), never a direct tenant write, and never a bypass
 * of the domain's triggers/guards. This interface is the seam that keeps that promise structural:
 * the drain owns the sweep, the authority owns the effect.
 */
export interface ApplyAuthority {
  resolve(item: ApprovedItem): (() => Promise<ExecutionOutcome>) | null;
}

/**
 * The production authority — UNBOUND, so the sweep is dark even with the kill-switch on. Every item
 * resolves to `null`: NO live sanctioned boundary is bound, so on every real approval the sweep
 * skips the item, applies nothing, and records nothing. This is the honest default posture, not a
 * stub to be filled with a bare write.
 *
 * Replacing it with a real authority is ENGINEERING, not a config flip (see the module header,
 * gate 2): it needs a `resolve()` that maps each approved descriptor to a boundary closure routed
 * through the sanctioned executor with per-action-type coverage and refuse-before-effect, the
 * executor wired off `REFERENCE_EXECUTOR` to real tool implementations, and the ADR 0009 CEO live
 * cut-over. Until all three land, this default keeps the drain a safe, provable no-op.
 */
export function createUnboundApplyAuthority(): ApplyAuthority {
  return Object.freeze({ resolve: () => null });
}

// ---------------------------------------------------------------------
// The gated production authority — complete engineering, LOCKED by default
// ---------------------------------------------------------------------

/** The dependencies of {@link createGatedApplyAuthority} — all injected, all with dark defaults. */
export interface GatedApplyDeps {
  /** The build-flag env (defaults to `process.env`). Off (the default) ⇒ resolve returns null. */
  readonly env?: Record<string, string | undefined>;
  /** The per-tool bound implementations (defaults to EMPTY ⇒ every item unmapped ⇒ null). */
  readonly bound?: BoundToolRegistry;
  /** The tool registry used to plan/validate + classify reversibility (defaults to the reference). */
  readonly registry?: ToolRegistry;
  /** The immutable audit sink (defaults to no-op). Behind the flag it records every attempt. */
  readonly audit?: ApplyAuditSink;
}

/** The cleared verdict used to re-assert an APPROVED item at the execution boundary. */
const CLEARED_VERDICT: GateVerdict = { decision: "autonomous", reasons: [] };

/**
 * THE PRODUCTION APPLY-ON-APPROVAL AUTHORITY — complete engineering, LOCKED by default.
 *
 * The counterpart of {@link createUnboundApplyAuthority} (the safe production default the cron route
 * still wires) that a CEO activation would switch to. It maps ONE approved item — already through the
 * full approval ladder (the sweep reads `approved`-only) — to the boundary-crossing closure the sweep
 * applies exactly once, but only after a strict, layered gate, DECLINING (`null`) at the first
 * failing layer so an unmapped/ill-formed/irreversible item is simply skipped (nothing applied,
 * nothing recorded):
 *
 *   1. THE LOCK. `FEATURE_HQ_AUTONOMOUS_APPLY !== "on"` ⇒ null. The production default TODAY, so this
 *      authority resolves nothing today — the sweep skips every item. On TOP of the sweep's own
 *      default-off kill-switch and the deny-by-default posture floor.
 *   2. MAPPED. No {@link BoundToolImplementation} for the descriptor's `type` ⇒ null (e.g. a strategic
 *      `hq.decision`, which has no tool to apply, always declines here).
 *   3. PLANNABLE. {@link planExecution} refuses (unknown tool / payload fails the tool's argSchema) ⇒
 *      null — refuse-BEFORE-effect, re-asserting the typed target at the boundary.
 *   4. DETERMINISTIC-ONLY. The resolved tool is irreversible ⇒ null — an irreversible effect has no
 *      rollback, so it stays on the human path; only a reversible tool earns a boundary.
 *
 * Only when all four pass does it return the closure the sweep hands to `applyOnce`. That closure runs
 * the COMPLETE lifecycle through {@link executeVerified} (execute → verify → rollback), records the
 * immutable audit entry, and returns the {@link ExecutionOutcome} `applyOnce` records under its
 * idempotency key — `applied` only on a verified success, `failed` (never a stuck marker) on a
 * boundary throw, a failed verification, or a rolled-back apply.
 */
export function createGatedApplyAuthority(deps: GatedApplyDeps = {}): ApplyAuthority {
  const env = deps.env;
  const bound = deps.bound ?? new Map<string, BoundToolImplementation>();
  const registry = deps.registry ?? REFERENCE_TOOL_REGISTRY;
  const audit = deps.audit ?? createNullApplyAuditSink();

  return Object.freeze({
    resolve(item: ApprovedItem): (() => Promise<ExecutionOutcome>) | null {
      const refuse = (detail: string): null => {
        void audit
          .record({
            path: "approval",
            toolLabel: item.descriptor.type,
            actionId: item.identity.actionId,
            correlationId: item.identity.correlationId,
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
      // 2. MAPPED — a bound implementation must exist for the item's tool.
      const impl = bound.get(item.descriptor.type);
      if (!impl) return refuse(`unmapped: no bound implementation for "${item.descriptor.type}"`);
      // 3. PLANNABLE — re-assert the tool + typed payload at the boundary (refuse-before-effect).
      const action: ProposedAction = {
        type: item.descriptor.type,
        subjectType: item.descriptor.subjectType ?? "hq",
        subjectId: item.descriptor.subjectId ?? item.id,
        reversible: true,
        typedTarget: true,
        payload: item.descriptor.payload,
      };
      const planned = planExecution(registry, action, CLEARED_VERDICT);
      if (!planned.ok) return refuse(`unplannable: ${planned.refusal.reason}`);
      // 4. DETERMINISTIC-ONLY — only a reversible tool may be applied.
      if (!isReversibleTool(planned.plan.tool)) {
        return refuse(`non-deterministic: "${item.descriptor.type}" is irreversible`);
      }

      return async (): Promise<ExecutionOutcome> => {
        const outcome = await executeVerified(planned.plan, impl);
        await audit
          .record({
            path: "approval",
            toolLabel: planned.plan.tool.label,
            actionId: item.identity.actionId,
            correlationId: item.identity.correlationId,
            stage: terminalStage(outcome.steps),
            steps: outcome.steps,
            detail:
              outcome.status === "applied"
                ? "applied and verified"
                : `not applied: ${outcome.error}${outcome.rolledBack ? " (rolled back)" : ""}`,
          })
          .catch(() => {});
        return verifiedToOutcome(outcome);
      };
    },
  });
}

// ---------------------------------------------------------------------
// Reading approved items — approved-only, from the HQ engines
// ---------------------------------------------------------------------

/** The reader the sweep uses to load approved items — injectable so tests drive a fixed set. */
export type ApprovedItemReader = (limit: number) => Promise<ApprovedItem[]>;

/**
 * The production reader: APPROVED items only, from both HQ engines, THROUGH THEIR OWN SERVICE
 * ACCESSORS — `listApprovedApprovals` (hq-approvals) and `listDecisions({ status: "approved" })`
 * (hq-decisions). The drain never touches hq_approvals / hq_decisions directly (the single-writer
 * encapsulation ratchets); each table stays behind its service. Approvals carry a real
 * (subject_type, subject_id, action, payload) to apply; decisions are strategic and carry the
 * `hq.decision` type — the sanctioned authority decides whether either is applicable. Every field of
 * the identity is stable across sweeps: an approval's own `correlation_id`, its id, its action, and
 * the derived `subject:subject:action` action id; a decision keys `correlationId`/`approvalId` to its
 * stable row id.
 */
async function readApprovedItems(limit: number): Promise<ApprovedItem[]> {
  const items: ApprovedItem[] = [];

  for (const row of await listApprovedApprovals(limit)) {
    const payload = (row.edited_payload ?? row.proposed_payload) ?? {};
    items.push({
      kind: "approval",
      id: row.id,
      identity: {
        source: "approval",
        correlationId: row.correlation_id || row.id,
        approvalId: row.id,
        toolLabel: row.action,
        actionId: `${row.subject_type}:${row.subject_id}:${row.action}`,
      },
      approver:
        row.reviewer_id || row.reviewer_email
          ? { approverId: row.reviewer_id, approverEmail: row.reviewer_email }
          : null,
      descriptor: {
        type: row.action,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        payload,
      },
    });
  }

  for (const row of await listDecisions({ status: "approved", limit })) {
    items.push({
      kind: "decision",
      id: row.id,
      identity: {
        source: "approval",
        correlationId: row.id,
        approvalId: row.id,
        toolLabel: "hq.decision",
        actionId: `decision:${row.id}`,
      },
      approver: row.decided_by ? { approverId: row.decided_by, approverEmail: null } : null,
      descriptor: { type: "hq.decision", payload: {} },
    });
  }

  return items;
}

// ---------------------------------------------------------------------
// The drain — the out-of-band sweep, composed over the injected seams
// ---------------------------------------------------------------------

/** The dependencies of {@link runApplyOnApprovalDrain} — all injectable, all with dark defaults. */
export interface ApplyDrainDeps {
  /** The kill-switch env (defaults to `process.env`). */
  readonly env?: Record<string, string | undefined>;
  /** The idempotency ground truth (defaults to the durable table store). */
  readonly store?: ApplicationStore;
  /** The sanctioned authority (defaults to UNBOUND — dark; live apply is the CEO cut-over). */
  readonly authority?: ApplyAuthority;
  /** The approved-item reader (defaults to the service-role HQ reader). */
  readonly readApproved?: ApprovedItemReader;
  /** Injected clock for determinism (the store stamps the durable `applied_at`; this is for reporting). */
  readonly now?: () => Date;
  /** How many items of each engine to sweep per tick. */
  readonly limit?: number;
}

/** The sweep's total, JSON-safe summary — the cron run's golden signal. */
export interface ApplyDrainSummary {
  readonly ok: boolean;
  /** Whether the kill-switch was ON. `false` ⇒ a total no-op (nothing read, nothing applied). */
  readonly enabled: boolean;
  /** ISO stamp of the sweep, from the injected clock. */
  readonly at: string;
  /** How many approved items were swept (0 when disabled). */
  readonly swept: number;
  /** Applied for the first time this sweep. */
  readonly applied: number;
  /** A prior application already succeeded — a no-op success (idempotency in action). */
  readonly alreadyApplied: number;
  /** An attempt failed but is below the ceiling — safe to re-attempt next sweep. */
  readonly failed: number;
  /** The ceiling was reached — a human owns it; the sweep will not auto-retry. */
  readonly escalated: number;
  /** No bound sanctioned authority for the item — applied nothing, recorded nothing (dark). */
  readonly skipped: number;
}

const DEFAULT_LIMIT = 100;

/**
 * Run one apply-on-approval sweep. The whole safety posture in one function:
 *
 *   1. KILL-SWITCH FIRST. If {@link hqApplyOnApprovalEnabled} is false (the default), return
 *      immediately — no read, no authority, no apply. This is the darkness guarantee: the very first
 *      statement short-circuits before any I/O.
 *   2. Read APPROVED items only.
 *   3. For each, ask the sanctioned {@link ApplyAuthority} for a boundary-crossing closure. `null`
 *      (the production default) ⇒ SKIP: apply nothing, record nothing. Non-null ⇒ hand it to {@link
 *      applyOnce}, which derives the key, consults the store, applies through the closure EXACTLY
 *      ONCE, and records the outcome. The drain itself performs no effect.
 */
export async function runApplyOnApprovalDrain(
  deps: ApplyDrainDeps = {},
): Promise<ApplyDrainSummary> {
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();

  // 1. Kill-switch first — a total no-op when OFF (the default, and prod today).
  if (!hqApplyOnApprovalEnabled(deps.env)) {
    return {
      ok: true,
      enabled: false,
      at,
      swept: 0,
      applied: 0,
      alreadyApplied: 0,
      failed: 0,
      escalated: 0,
      skipped: 0,
    };
  }

  const store = deps.store ?? createDurableApplicationStore();
  const authority = deps.authority ?? createUnboundApplyAuthority();
  const limit = Math.min(Math.max(deps.limit ?? DEFAULT_LIMIT, 1), 500);
  const readApproved = deps.readApproved ?? readApprovedItems;

  const items = await readApproved(limit);

  let applied = 0;
  let alreadyApplied = 0;
  let failed = 0;
  let escalated = 0;
  let skipped = 0;

  for (const item of items) {
    // 3. The sanctioned authority is the ONLY path to an effect — and it is injected.
    const apply = authority.resolve(item);
    if (!apply) {
      skipped += 1; // no bound authority — applied nothing, recorded nothing (dark).
      continue;
    }

    const result = await applyOnce({
      store,
      identity: item.identity,
      apply,
      approver: item.approver,
    });

    switch (result.status) {
      case "applied":
        applied += 1;
        break;
      case "already_applied":
        alreadyApplied += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "escalated":
        escalated += 1;
        break;
    }
  }

  // Honesty signal: with the PRODUCTION default (createUnboundApplyAuthority) every item resolves to
  // null, so a non-empty sweep applies nothing and skips everything. Make that no-op unmistakable in
  // the logs rather than leaving it implicit in the summary counts. This changes NO behaviour — the
  // sweep already applied nothing; it only names why (no bound authority — see the module header).
  if (items.length > 0 && skipped === items.length && applied === 0 && alreadyApplied === 0) {
    console.info(
      "[hq-apply-drain] unbound authority: swept approved items but applied none (no bound ApplyAuthority; live apply is unbuilt engineering + the ADR 0009 CEO cut-over)",
      { swept: items.length, skipped },
    );
  }

  return {
    ok: true,
    enabled: true,
    at,
    swept: items.length,
    applied,
    alreadyApplied,
    failed,
    escalated,
    skipped,
  };
}
