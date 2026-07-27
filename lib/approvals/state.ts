/**
 * CrewFlow HQ — The Approval Engine state machine (CEO Directive 010, Phase 2).
 *
 * The deterministic, shared state machine every AI employee inherits. It is the
 * single source of WHICH transitions are legal, mirrored by the database trigger
 * that ENFORCES them (supabase/migrations/20260730000000_hq_approvals.sql) and by
 * the service and UI that READ them. The migration is the enforcer; this module is
 * the mirror; __tests__/security/approvals-invariants.test.ts pins that they agree.
 *
 * Pure by construction — NO `server-only`, NO I/O. The reviewer UI imports the
 * `legalActions`/`isTerminal` helpers to decide which buttons to show, and the
 * service imports them to fail fast with a clean error before the DB does. Each
 * action's `verb` is typed against the frozen event registry's `Verb` union, so an
 * action can only ever map to a REGISTERED `approval.*` verb — the "one source of
 * event names" rule, enforced by the compiler (an unregistered verb won't build).
 *
 * Why a state machine and not a status column: an approval gates a customer-facing
 * (or money-moving, or record-changing) act. The path from proposal to decision
 * must be reconstructable from named rules — deterministic, not ad hoc — and the
 * security boundaries must be impossible to bypass. So the legal moves are
 * enumerated here, once, and nowhere is a transition allowed that this map omits.
 */

import type { Verb } from "@/lib/events/registry";

// ---------------------------------------------------------------------
// States. ACTIVE states await human judgement; TERMINAL states are frozen
// forever (the permanent record of the decision — immutable at the row level
// via the trigger, and at the event level via the append-only spine).
// ---------------------------------------------------------------------

export const APPROVAL_STATES = [
  "pending",
  "escalated",
  "approved",
  "rejected",
  "expired",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const ACTIVE_STATES = ["pending", "escalated"] as const satisfies readonly ApprovalState[];
export const TERMINAL_STATES = [
  "approved",
  "rejected",
  "expired",
] as const satisfies readonly ApprovalState[];

const ACTIVE_SET: ReadonlySet<ApprovalState> = new Set(ACTIVE_STATES);
const TERMINAL_SET: ReadonlySet<ApprovalState> = new Set(TERMINAL_STATES);

/** A terminal state is frozen — no transition may leave it. */
export function isTerminal(state: ApprovalState): boolean {
  return TERMINAL_SET.has(state);
}
/** An active state still awaits human judgement. */
export function isActive(state: ApprovalState): boolean {
  return ACTIVE_SET.has(state);
}

// ---------------------------------------------------------------------
// Actions. The SIX actions are exactly the six reserved approval.* verbs — the
// engine mints no vocabulary beyond what the registry already froze.
//   request  — an employee proposes an action (INSERT, born pending)
//   edit     — a reviewer revises the proposal (no state move; tracked)
//   escalate — flag for higher attention (pending → escalated)
//   approve  — a reviewer grants it (→ approved; reviewer required)
//   reject   — a reviewer turns it down (→ rejected; reviewer + reason required)
//   expire   — the deadline passed without a decision (→ expired; system)
// Recovery is NOT an action here: a terminal row is immutable, so recovery is a
// fresh `request` that supersedes the old row (see the service's recoverApproval).
// ---------------------------------------------------------------------

export const APPROVAL_ACTIONS = [
  "request",
  "edit",
  "escalate",
  "approve",
  "reject",
  "expire",
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** Who legitimately performs each action (mirrors the emitter's actor mapping). */
export type ApprovalActor = "ai_employee" | "human" | "system";

export type TransitionSpec = {
  /** Active states the action may be applied from. `request` is an INSERT (no from). */
  from: readonly ApprovalState[] | null;
  /** The state the row holds after the action. `edit` does not move state (null). */
  to: ApprovalState | null;
  /** The reserved registry verb this action emits — compile-checked. */
  verb: Verb;
  /** The honest actor for the emitted event. */
  actor: ApprovalActor;
  /** A reviewer identity is required (approve/reject/edit are human acts). */
  requiresReviewer: boolean;
  /** A decision reason is required (reject only). */
  requiresReason: boolean;
};

/**
 * THE transition table. The database trigger encodes the same legal moves; the
 * security suite asserts this map and that SQL never diverge.
 */
export const TRANSITIONS: Record<ApprovalAction, TransitionSpec> = {
  request: {
    from: null,
    to: "pending",
    verb: "approval.requested",
    actor: "ai_employee",
    requiresReviewer: false,
    requiresReason: false,
  },
  edit: {
    from: ACTIVE_STATES,
    to: null, // stays in its current active state; records the edit
    verb: "approval.edited",
    actor: "human",
    requiresReviewer: true,
    requiresReason: false,
  },
  escalate: {
    from: ["pending"],
    to: "escalated",
    verb: "approval.escalated",
    actor: "human",
    requiresReviewer: false,
    requiresReason: false,
  },
  approve: {
    from: ACTIVE_STATES,
    to: "approved",
    verb: "approval.granted",
    actor: "human",
    requiresReviewer: true,
    requiresReason: false,
  },
  reject: {
    from: ACTIVE_STATES,
    to: "rejected",
    verb: "approval.rejected",
    actor: "human",
    requiresReviewer: true,
    requiresReason: true,
  },
  expire: {
    from: ACTIVE_STATES,
    to: "expired",
    verb: "approval.expired",
    actor: "system",
    requiresReviewer: false,
    requiresReason: false,
  },
};

/** The reserved verb an action emits. */
export function verbFor(action: ApprovalAction): Verb {
  return TRANSITIONS[action].verb;
}

/**
 * Can `action` be applied to a row currently in `from`? Deterministic and total:
 * every (action, state) pair has a definite yes/no. `request` is an INSERT and is
 * never legal on an existing row.
 */
export function canApply(action: ApprovalAction, from: ApprovalState): boolean {
  const spec = TRANSITIONS[action];
  if (spec.from === null) return false; // request is an insert, not a transition
  return spec.from.includes(from);
}

/**
 * The state a row holds after `action` is applied from `from`, or `null` if the
 * action is illegal from that state. `edit` returns the SAME state (it records a
 * revision without moving). The mirror of the trigger's transition check.
 */
export function nextState(action: ApprovalAction, from: ApprovalState): ApprovalState | null {
  if (!canApply(action, from)) return null;
  const spec = TRANSITIONS[action];
  return spec.to ?? from; // edit keeps the current state
}

/** Every action legal from `from` — what the reviewer UI may offer. Empty for terminal states. */
export function legalActions(from: ApprovalState): ApprovalAction[] {
  return APPROVAL_ACTIONS.filter((a) => canApply(a, from));
}
