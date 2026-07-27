// =====================================================================
// THE CONVERSATION EXECUTION ENGINE — PURE CORE (CEO Directive #018; R28: CONVERSATION EXECUTION ENGINE).
//
// R17–R25 built the DERIVING stack (State → Intent → Goal → Information → Gap → Strategy → Prompt → Response
// → Generation): every layer OBSERVES, DERIVES or WORDS. R26 added the OUTCOME ENGINE — the first layer that
// ACTS on a satisfied objective, RESOLVING an internal outcome (a `callback`). R27 added the ACTION ENGINE —
// the layer that PREPARES an internal business action (a `prepare_booking` proposal). R28 is the NEXT layer:
// the single, canonical authority over a NINTH question, one derived from the Action above it — "given a
// prepared ACTION, the reply's policy verdict, and the organisation's controls, MAY this action actually
// EXECUTE, and under what authority?" — the EXECUTION DECISION. Booking execution is the FIRST execution type
// expressed here — `execute_booking`, the decision that governs whether a prepared booking may proceed — but
// it is one member of the execution vocabulary, not the engine's purpose.
//
// IT DECIDES ELIGIBILITY — IT DOES NOT EXECUTE. Determining whether a prepared action MAY execute is a pure
// CHOICE over the already-prepared action, the already-computed policy verdict and the organisation's
// controls — an eligibility DECISION a human/CRM (or a future, explicitly-authorised increment) later acts
// on. Actually placing the booking, writing a calendar, generating a quote, promoting a customer, scheduling,
// retrying, reconciling a receipt, or reaching any comms provider are EXPLICIT R28 NON-GOALS no layer here
// performs. This pure core names the decision and stops. The Execution Engine DETERMINES WHETHER work may
// execute; it does not broaden execution authority beyond the approved scope, and it EXECUTES nothing.
//
// THE ACTION ENGINE REMAINS AUTHORITATIVE — THE EXECUTION ENGINE CONVERTS ITS RESULT, IT NEVER RE-DERIVES IT.
// {@link resolveExecution} takes the R27 {@link ActionResolution} as its FIRST input and its FIRST gate
// DEFERS: when the Action Engine prepared NO action (an abstention), the Execution Engine stands down
// (`no_action_prepared`) — there is nothing to decide. Because an actionable action only exists when the R26
// Outcome Engine ABSTAINED (the Action Engine's own first gate defers to the Outcome Engine), deferring to the
// Action Engine here TRANSITIVELY preserves the Outcome Engine's authority too. The Execution Engine CONSUMES
// the action; it NEVER calls `resolveAction`, `resolveOutcome`, re-derives the strategy/goal/gap, re-extracts
// information or re-classifies intent.
//
// IT NEVER RE-RUNS POLICY — IT CONSUMES THE VERDICT. The reply's fate was ALREADY decided by the R3 guardrail
// ({@link import("@/lib/receptionist/policy")}) during dispatch; this engine takes that {@link GuardrailVerdict}
// as an input and folds it into eligibility. It re-implements NONE of the guardrail's rules and calls NONE of
// its decision functions (`evaluateReply` / `isAutoSendable` / `redactReply`): Policy stays the single arbiter
// of a reply's fate, and this engine merely READS its verdict. Policy therefore remains MANDATORY — a `block`
// verdict forces `blocked_by_policy`, and the guardrail is never bypassed.
//
// THE STRONGEST ELIGIBILITY IS `requires_human_review` — THERE IS DELIBERATELY NO AUTONOMOUS-EXECUTE VALUE.
// A booking is a §9 A4 CUSTOMER COMMITMENT ("Voice / WhatsApp / Email / Scheduler never commit; the human
// does"), so even when the organisation has enabled live execution AND the policy verdict is clean, the
// STRONGEST eligibility a booking can reach is `requires_human_review` — never "execute now". The eligibility
// vocabulary structurally OMITS any autonomous-execute member: this is the parallel to R26's status
// 'recorded' and R27's status 'prepared' — the model is structurally incapable of authorising autonomous
// execution. Human Review therefore stays MANDATORY for every executable booking, by construction.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. Like the R26 outcome and the R27 action, the execution
// DECISION is a TOTAL, DETERMINISTIC function of already-computed inputs — the R27 action (the deferral gate
// and the payload), the R3 policy verdict (the policy constraint) and the organisation's execution controls
// (the org constraint). The pure core adds NO column and NO migration; whether a decision is PERSISTED (and
// where) is the server runtime's job, behind its own append-only ledger.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-prepared action, an ALREADY-computed policy verdict
// and the org's controls; it NEVER re-assembles context, re-classifies intent, re-resolves goal, re-extracts
// information, re-detects the gap, re-derives the strategy, re-resolves the outcome, RE-PREPARES THE ACTION or
// RE-RUNS POLICY — it names none of those resolvers. Its only imports are the R27 action PREDICATE + TYPES and
// the R3 policy VERDICT TYPE (type-only). It reaches NO provider, NO ledger, NO DB, NO clock, NO RNG, NO org
// lookup and — the cardinal rule shared with the whole stack — NO MODEL: the decision is resolved by a named,
// total, deterministic fold, so the same (action, verdict, org) always yields the same decision. The layering
// stays a clean, linear stack: Context → … → Generation → Outcome → Action → Execution.
// =====================================================================

import {
  isActionableAction,
  type ActionResolution,
  type PrepareBookingAction,
  type ConversationActionType,
} from "@/lib/receptionist/conversation-action";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

// ---------------------------------------------------------------------
// The EXECUTION vocabulary — the closed set of execution types.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of EXECUTION TYPES — the kinds of prepared action this engine can render an execution
 * DECISION over. R28 ships exactly ONE:
 *   • execute_booking — the execution decision for a prepared `prepare_booking` action: MAY the booking the
 *                       Action Engine prepared actually proceed, and under what authority? It DECIDES the
 *                       booking's eligibility; it never PLACES the booking (calendar writes, scheduling and
 *                       every external business action are EXPLICIT R28 non-goals).
 * Quote execution, customer promotion, AI scheduling, retry and receipt reconciliation are EXPLICIT R28
 * non-goals, so their execution types are deliberately ABSENT — a future increment ADDS them here (and to the
 * ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ConversationExecutionType}
 * is exactly these members and a consumer can switch exhaustively.
 */
export const EXECUTION_TYPES = ["execute_booking"] as const;

/** One execution type the engine can render a decision over. */
export type ConversationExecutionType = (typeof EXECUTION_TYPES)[number];

/**
 * The closed vocabulary of ELIGIBILITY verdicts — the terminal answer to "may this prepared action execute,
 * and under what authority?". EVERY member gates execution; there is DELIBERATELY NO autonomous-execute value:
 *   • requires_human_review — the STRONGEST eligibility. The action is well-formed, the organisation has
 *                             enabled live execution, and Policy did not refuse — yet a booking is a §9 A4
 *                             customer commitment, so it may proceed ONLY under a human's authority. This is
 *                             the terminal state for an executable booking: never autonomous.
 *   • blocked_by_policy     — the R3 guardrail returned `block` for the confirmation reply (an absolute §12
 *                             prohibition). Execution is refused on policy grounds — Policy stays mandatory.
 *   • blocked_by_org        — the organisation has NOT enabled controlled live booking execution. Execution is
 *                             refused on organisational grounds. This is the DEFAULT posture (the feature flag
 *                             is off until deliberately enabled), so it is the common eligibility in practice.
 * A closed union — the model is STRUCTURALLY incapable of expressing "execute autonomously", which is how
 * Human Review, Policy and organisational control remain mandatory by construction rather than by convention.
 */
export type ExecutionEligibility =
  | "requires_human_review"
  | "blocked_by_policy"
  | "blocked_by_org";

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine rendered NO execution decision on a turn. An
 * abstention is not an error; it is the honest "nothing to decide here" for the vast majority of turns:
 *   • no_action_prepared — the R27 Action Engine prepared NO action this turn (an abstention). There is
 *                          nothing to execute, so the Execution Engine defers. This is the FIRST gate — the
 *                          Action Engine (and transitively the Outcome Engine) stays authoritative.
 *   • unsupported_action — an action WAS prepared, but its type maps to no R28 execution type (defence in
 *                          depth: R27 ships only `prepare_booking`, which maps to `execute_booking`, so this
 *                          is unreachable today; it becomes live only if a future action type is added to R27
 *                          without a matching execution type here).
 * A closed union so {@link ExecutionDecision}'s abstention arm is exhaustive.
 */
export type ExecutionAbstention = "no_action_prepared" | "unsupported_action";

// ---------------------------------------------------------------------
// The EXECUTION model — the resolved execution decision for a turn.
// ---------------------------------------------------------------------

/**
 * The EXECUTE-BOOKING decision — the first (and only R28) execution decision. It carries the resolved
 * {@link ExecutionEligibility} (may the booking proceed, and under what authority) and the exact
 * {@link PrepareBookingAction} it decides over (so the decision is self-describing for the audit ledger). It
 * DECIDES the booking's eligibility; it carries NO placed booking, NO calendar slot and NO receipt — execution
 * itself is an EXPLICIT R28 non-goal. There is no field that could express "executed": the model records a
 * DECISION about eligibility, never a performed action.
 */
export type ExecuteBookingDecision = {
  readonly kind: "execute_booking";
  readonly eligibility: ExecutionEligibility;
  readonly action: PrepareBookingAction;
};

/**
 * The conversational EXECUTION DECISION for one turn — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link ExecuteBookingDecision}, and future execution types) — a concrete eligibility
 *     verdict over a prepared action. Its `kind` IS its {@link ConversationExecutionType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no decision this turn, tagged with WHY
 *     ({@link ExecutionAbstention}). The overwhelmingly common case (every turn on which the Action Engine
 *     prepared no action, which is every turn that is not a satisfied booking).
 * Every field is a total, deterministic function of (action, policyVerdict, org); the whole object is derived,
 * never persisted by this core.
 */
export type ExecutionDecision =
  | ExecuteBookingDecision
  | { readonly kind: "none"; readonly reason: ExecutionAbstention };

/**
 * The organisation's EXECUTION CONTROLS — the org-level constraints the engine validates. R28 carries exactly
 * one: whether the organisation has enabled CONTROLLED LIVE BOOKING EXECUTION. It is a plain boolean the
 * SERVER RUNTIME resolves (from the deliberate feature gate) and passes IN — the pure core performs NO lookup,
 * exactly as it reaches no DB, clock or model. Default posture is DISABLED: absent an explicit enable, a
 * prepared booking is `blocked_by_org`.
 */
export type ExecutionOrgConstraints = {
  readonly liveExecutionEnabled: boolean;
};

/**
 * The action-type → execution-type mapping — which EXECUTION TYPE each prepared {@link ConversationActionType}
 * is decided under, or `null` when the action type has no R28 execution. TOTAL over the whole action
 * vocabulary — the `Record` type makes the exhaustiveness a COMPILE-TIME guarantee, so this map and the R27
 * action vocabulary can never drift (a new action type cannot be added without deciding its execution here).
 * R27 ships `prepare_booking`, which maps to `execute_booking`; a future action type maps to its own execution
 * type (or `null` until one is added) as an explicit, reviewable act.
 */
export const ACTION_EXECUTION: Readonly<
  Record<ConversationActionType, ConversationExecutionType | null>
> = {
  prepare_booking: "execute_booking",
};

// ---------------------------------------------------------------------
// RESOLUTION — the single derived execution decision. The three validations are folded in fixed order.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no decision this turn". */
function abstain(reason: ExecutionAbstention): ExecutionDecision {
  return { kind: "none", reason };
}

/**
 * Resolve the EXECUTION DECISION for a turn — THE single entry point the runtime reads. Consumes the three
 * already-computed inputs it decides over: the R27 `action` (the DEFERRAL gate and the payload — when the
 * Action Engine prepared no action, the Execution Engine stands down), the R3 `policyVerdict` (the POLICY
 * constraint — the guardrail's ALREADY-computed verdict over the confirmation reply, never re-run here), and
 * the `org` controls (the ORGANISATIONAL constraint — whether controlled live execution is enabled).
 *
 * Pure, TOTAL over any (action, policyVerdict, org), and DETERMINISTIC — the same inputs always yield the same
 * decision. The Action Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to the
 * Outcome Engine, since an actionable action exists only when the outcome abstained). Policy stays MANDATORY:
 * a `block` verdict forces refusal, and the guardrail is never re-run — this engine only READS its verdict.
 * Human Review stays MANDATORY: the strongest eligibility a booking can reach is `requires_human_review` —
 * there is no autonomous-execute value to return. The three validations are folded in a FIXED priority order
 * (org → policy → human-review), matching the directive's own ordering, so the eligibility names exactly the
 * FIRST binding constraint. Persists NOTHING — the runtime decides whether and where to record the decision.
 * THE single source of truth for execution eligibility — every consumer resolves it through this function and
 * no other way; no feature implements independent execution-eligibility logic.
 */
export function resolveExecution(
  action: ActionResolution,
  policyVerdict: GuardrailVerdict,
  org: ExecutionOrgConstraints,
): ExecutionDecision {
  // THE ACTION ENGINE IS AUTHORITATIVE. If R27 prepared NO action (an abstention), there is nothing to
  // execute and the Execution Engine defers. This is the first thing the engine checks — it CONVERTS the
  // action (consumes it), it never overrides it. Because an actionable action exists ONLY when the R26
  // Outcome Engine abstained (the Action Engine's own first gate), deferring here transitively preserves the
  // Outcome Engine's authority too.
  if (!isActionableAction(action)) return abstain("no_action_prepared");

  // The prepared action selects its execution type. R27 ships only `prepare_booking` (→ `execute_booking`);
  // a null here would mean a future action type reached this engine before its execution type was added —
  // defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const executionType = ACTION_EXECUTION[action.kind];
  if (executionType === null) return abstain("unsupported_action");

  // Render the eligibility for the execution type. A closed switch keeps this exhaustive as the vocabulary
  // grows: adding an EXECUTION_TYPE without a case here fails `tsc`. Each arm folds the three validations —
  // organisational, policy, then human-review — in a FIXED priority order.
  switch (executionType) {
    case "execute_booking": {
      // The three constraints, folded in fixed order (org → policy → human-review):
      //  1. ORGANISATIONAL — has the org enabled controlled live booking execution? If not, the booking is
      //     `blocked_by_org` regardless of anything else (the default, deny-by-default posture).
      //  2. POLICY — did the R3 guardrail `block` the confirmation reply (an absolute §12 prohibition)? Then
      //     the booking is `blocked_by_policy`. Policy stays mandatory; its verdict is consumed, never re-run.
      //  3. HUMAN REVIEW — otherwise the booking is well-formed, org-enabled and not policy-blocked, yet a
      //     booking is a §9 A4 customer commitment: the STRONGEST it can reach is `requires_human_review`.
      //     There is deliberately no "execute now" — a booking never executes autonomously.
      let eligibility: ExecutionEligibility;
      if (!org.liveExecutionEnabled) {
        eligibility = "blocked_by_org";
      } else if (policyVerdict === "block") {
        eligibility = "blocked_by_policy";
      } else {
        eligibility = "requires_human_review";
      }
      return { kind: "execute_booking", eligibility, action };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a concrete eligibility verdict over a prepared action), as opposed to an
 * abstention. A type guard: it narrows an {@link ExecutionDecision} to its decided arms, so the runtime
 * records ONLY a real decision and an abstention is a total no-op. THE predicate the runtime gates persistence
 * on — there is no other "did we decide?" rule.
 */
export function isExecutionDecided(
  decision: ExecutionDecision,
): decision is ExecuteBookingDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationExecutionType} of a decision (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the decided arm's `kind` IS its execution type, so the mapping is the identity
 * on the decided arms and `null` on the abstention.
 */
export function executionTypeOf(
  decision: ExecutionDecision,
): ConversationExecutionType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link ExecutionEligibility} of a decision (for audit/persistence keying), or `null` for an abstention.
 * Pure and total — a projection the runtime folds onto the ledger row alongside the execution type. NEVER a
 * value that authorises autonomous execution: the eligibility vocabulary omits any such member by
 * construction.
 */
export function eligibilityOf(
  decision: ExecutionDecision,
): ExecutionEligibility | null {
  return decision.kind === "none" ? null : decision.eligibility;
}
