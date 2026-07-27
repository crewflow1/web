/**
 * CrewFlow HQ — The Communication Layer delivery state machine (Directive 010, Phase 4).
 *
 * The deterministic, shared state machine for ONE delivery attempt. It is the
 * single source of WHICH delivery transitions are legal, mirrored by the database
 * trigger that ENFORCES them (supabase/migrations/20260801000000_hq_communications.sql)
 * and by the service that DRIVES them. The migration is the enforcer; this module is
 * the mirror; __tests__/security/comms-invariants.test.ts pins that they agree.
 *
 * Pure by construction — NO `server-only`, NO I/O. Each action's `verb` is typed
 * against the frozen event registry's `Verb` union, so an action can only ever map
 * to a REGISTERED `comm.*` verb — the "one source of event names" rule, enforced by
 * the compiler. It mirrors `lib/approvals/state.ts` exactly: the legal moves are
 * enumerated here, once, and nowhere is a transition allowed that this map omits.
 *
 * Unlike an approval (always born `pending`), a delivery attempt is born in one of
 * THREE states — `sent` (a provider accepted it), `failed` (no provider, or the
 * provider rejected it), or `suppressed` (the address was on the do-not-contact
 * list and was never handed to a provider). Only a `sent` row can still move; the
 * asynchronous provider outcome carries it to a terminal `delivered`/`bounced`/
 * `complained`. Retry is NOT a transition: a terminal row is immutable, so a retry
 * is a fresh attempt that supersedes the old row (see the service's retryDelivery).
 */

import type { Verb } from "@/lib/events/registry";

// ---------------------------------------------------------------------
// States. The single ACTIVE state (`sent`) still awaits a provider outcome;
// TERMINAL states are frozen forever (the permanent record of the attempt —
// immutable at the row level via the trigger, and at the event level via the
// append-only spine).
// ---------------------------------------------------------------------

export const COMM_STATES = [
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const;
export type CommState = (typeof COMM_STATES)[number];

export const ACTIVE_STATES = ["sent"] as const satisfies readonly CommState[];
export const TERMINAL_STATES = [
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const satisfies readonly CommState[];

const ACTIVE_SET: ReadonlySet<CommState> = new Set(ACTIVE_STATES);
const TERMINAL_SET: ReadonlySet<CommState> = new Set(TERMINAL_STATES);

/** A terminal state is frozen — no transition may leave it. */
export function isTerminal(state: CommState): boolean {
  return TERMINAL_SET.has(state);
}
/** An active state still awaits a provider outcome. */
export function isActive(state: CommState): boolean {
  return ACTIVE_SET.has(state);
}

// ---------------------------------------------------------------------
// Actions. The SIX actions are exactly the six reserved comm.* verbs — the layer
// mints no vocabulary beyond what the registry already froze. Three are INSERTs
// (they BORN the row in a state); three are transitions from `sent`.
//   send      — a provider accepted the message (INSERT, born `sent`)
//   fail      — delivery failed at the transport (INSERT, born `failed`; system)
//   suppress  — blocked by the do-not-contact list (INSERT, born `suppressed`)
//   deliver   — the recipient's server confirmed receipt (sent → delivered)
//   bounce    — the message bounced (sent → bounced)
//   complain  — the recipient marked it as spam (sent → complained)
// ---------------------------------------------------------------------

export const COMM_ACTIONS = [
  "send",
  "fail",
  "suppress",
  "deliver",
  "bounce",
  "complain",
] as const;
export type CommAction = (typeof COMM_ACTIONS)[number];

/** Who legitimately performs each action (mirrors the emitter's actor mapping). */
export type CommActor = "ai_employee" | "system";

export type TransitionSpec = {
  /** Active states the action may be applied from. INSERT actions have `from: null`. */
  from: readonly CommState[] | null;
  /** The state the row holds after the action (the born state for an INSERT). */
  to: CommState;
  /** The reserved registry verb this action emits — compile-checked. */
  verb: Verb;
  /** The honest actor for the emitted event. */
  actor: CommActor;
};

/**
 * THE transition table. The database trigger encodes the same legal moves; the
 * security suite asserts this map and that SQL never diverge.
 *
 * The honest actor: the AI employee performs exactly ONE deliberate act — `send`
 * (delivering its own approved draft). Every other state is a fact reported back by
 * the world — a transport `fail`, a policy `suppress`, or a provider-reported
 * `deliver`/`bounce`/`complain` — so the system is the actor, mirroring how the
 * Approval Engine attributes `expire` to the system.
 */
export const TRANSITIONS: Record<CommAction, TransitionSpec> = {
  send: {
    from: null,
    to: "sent",
    verb: "comm.sent",
    actor: "ai_employee",
  },
  fail: {
    from: null,
    to: "failed",
    verb: "comm.failed",
    actor: "system",
  },
  suppress: {
    from: null,
    to: "suppressed",
    verb: "comm.suppressed",
    actor: "system",
  },
  deliver: {
    from: ACTIVE_STATES,
    to: "delivered",
    verb: "comm.delivered",
    actor: "system",
  },
  bounce: {
    from: ACTIVE_STATES,
    to: "bounced",
    verb: "comm.bounced",
    actor: "system",
  },
  complain: {
    from: ACTIVE_STATES,
    to: "complained",
    verb: "comm.complained",
    actor: "system",
  },
};

/** The reserved verb an action emits. */
export function verbFor(action: CommAction): Verb {
  return TRANSITIONS[action].verb;
}

/** True iff `action` is an INSERT (it BORNs a row) rather than a transition. */
export function isInsertAction(action: CommAction): boolean {
  return TRANSITIONS[action].from === null;
}

/** The state a row is BORN in by an INSERT action, or `null` for a transition action. */
export function bornState(action: CommAction): CommState | null {
  const spec = TRANSITIONS[action];
  return spec.from === null ? spec.to : null;
}

/**
 * Can `action` be applied to a row currently in `from`? Deterministic and total:
 * every (action, state) pair has a definite yes/no. INSERT actions (`send`/`fail`/
 * `suppress`) are never legal on an existing row.
 */
export function canApply(action: CommAction, from: CommState): boolean {
  const spec = TRANSITIONS[action];
  if (spec.from === null) return false; // an insert, not a transition
  return spec.from.includes(from);
}

/**
 * The state a row holds after `action` is applied from `from`, or `null` if the
 * action is illegal from that state. The mirror of the trigger's transition check.
 */
export function nextState(action: CommAction, from: CommState): CommState | null {
  if (!canApply(action, from)) return null;
  return TRANSITIONS[action].to;
}

/** Every transition action legal from `from` — empty for terminal states. */
export function legalActions(from: CommState): CommAction[] {
  return COMM_ACTIONS.filter((a) => canApply(a, from));
}
