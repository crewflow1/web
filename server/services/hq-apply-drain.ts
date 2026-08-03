import "server-only";
import type { ExecutionOutcome } from "@/server/sdk/executor";
import {
  applyOnce,
  type ApplicationStore,
  type ApproverAttribution,
  type ExecutionIdentity,
} from "@/server/sdk/application";
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
 *   2. THE AUTHORITY (ADR 0009). Even with the kill-switch ON, live apply to real tenant data
 *      requires the CEO authority per ADR 0009. The production authority is {@link
 *      createUnboundApplyAuthority} — it resolves EVERY item to `null`, so the sweep applies nothing
 *      and records nothing until a CEO cut-over binds a real sanctioned authority (the executor's
 *      SECURITY DEFINER boundary / the task engine). Binding it is a config/wiring flip, not a
 *      change to this sweep. A `null` authority is NEVER a bare write — it is the sweep declining to
 *      act.
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
 * resolves to `null`: no live sanctioned boundary is bound in this train, because binding one is the
 * CEO cut-over (ADR 0009). This is not a stub to be filled in with a bare write — it is the honest
 * default posture: apply-on-approval has a durable record store and a running (dark) sweep, and
 * turning it live means binding a real sanctioned authority here, a config/wiring flip.
 */
export function createUnboundApplyAuthority(): ApplyAuthority {
  return Object.freeze({ resolve: () => null });
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
