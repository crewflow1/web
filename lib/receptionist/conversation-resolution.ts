// =====================================================================
// THE CONVERSATION RESOLUTION ENGINE — PURE CORE (CEO Directive #018; R33: CONVERSATION RESOLUTION ENGINE).
//
// R17–R25 built the DERIVING stack; R26 RESOLVES an outcome, R27 PREPARES an action, R28 DECIDES an execution's
// eligibility, R29 DETERMINES whether that decided execution requires APPROVAL, R30 PERFORMS the approved internal
// business operation (booking fulfilment), R31 VERIFIES that performed operation — reconciling the decision against
// the record and reporting an INTEGRITY verdict — and R32 DETERMINES the RECOVERY that verdict warrants (none /
// reinstate / reconcile). R33 is the NEXT — and, in this stack, the THIRD engine that does not perform: the single,
// canonical authority over a FOURTEENTH question, one derived from the Recovery Decision above it — "given a recovery
// the stack DETERMINED, has the conversation reached a TERMINAL, RECOVERABLE or UNRESOLVED state, and does it require
// further intervention?" — the RESOLUTION DECISION. Booking-recovery resolution is the FIRST resolution type expressed
// here — `resolve_booking_recovery`, the classification of a determined booking-fulfilment recovery into the
// conversation-completion state it implies — but it is one member of the resolution vocabulary, not the engine's
// purpose.
//
// IT DETERMINES COMPLETION — IT NEVER EXECUTES RECOVERY OR BUSINESS ACTIONS. Unlike R30 (whose decision is the
// GO-AHEAD to carry out an approved operation), the Resolution Engine's decision performs NO business action: it
// CLASSIFIES a recovery disposition into a conversation {@link ResolutionState} and reports WHETHER the conversation
// is terminal and WHETHER further intervention is required. It re-books nothing, retries nothing, reconciles nothing,
// schedules nothing and reaches no provider. It is the layer that turns R32's actionable RECOVERY disposition into an
// auditable, single-authority CONVERSATION-COMPLETION verdict — the determination a future, explicitly-authorised
// operational capability reads to know whether a conversation is done. Recovery execution, automatic retries and
// automatic scheduling are EXPLICIT R33 non-goals: this engine says WHETHER the conversation is resolved, never ACTS
// to resolve it.
//
// THE RECOVERY ENGINE REMAINS AUTHORITATIVE — THE RESOLUTION ENGINE CONSUMES ITS DECISION, IT NEVER RE-DERIVES IT.
// {@link resolveConversationResolution} takes the R32 {@link RecoveryDecision} as its ONLY input, and its FIRST gate
// DEFERS: when the Recovery Engine rendered NO decision (an abstention — nothing was verified, so nothing was
// recovered, so there is nothing to resolve), the Resolution Engine stands down (`no_recovery_decision`). Because a
// decided recovery only exists when R32 classified a DECIDED verification (which only exists when R31 reconciled a
// DECIDED fulfilment, which needs the approved R30 go-ahead, the approved R29 authorisation, the R28 execution, the
// R27 action and the R26 outcome), deferring to the Recovery Engine here TRANSITIVELY preserves the Verification,
// Fulfilment, Authorisation, Execution, Action and Outcome Engines' authority too. The recovery CLASSIFICATION is
// NEVER recomputed here: it is the recovery decision's own finding, handed in — this engine READS the disposition, it
// never re-recovers. No duplicate recovery logic; no duplicate resolution logic.
//
// HUMAN REVIEW & POLICY STAY MANDATORY — TRANSITIVELY, THROUGH THE RECOVERY IT CONSUMES. A decided recovery exists
// ONLY for a DECIDED verification, which exists ONLY for an APPROVED authorisation (R32's inherited gate, R31's
// inherited gate, R30's keystone), which arises ONLY from the EXISTING Human Review architecture (R14's
// `receptionist_review_resolutions`, a `sent` resolution, folded to `approved` by R29) and can NEVER exist for a
// policy-blocked booking (foreclosed at R29, never revivable). So the Resolution Engine determines completion ONLY for
// human-approved, policy-cleared, verified, recovery-classified operations — by construction, without importing a
// policy module or recording a grant. This engine imports NO policy surface and names NO guardrail decision function.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND RESOLVES NOTHING ITSELF. Like R26–R32, the resolution
// DECISION is a TOTAL, DETERMINISTIC function of an already-computed input — the R32 recovery decision. The pure core
// adds NO column and NO migration, reaches NO provider, NO ledger, NO DB, NO clock, NO RNG, NO org lookup, NO env read
// and — the cardinal rule shared with the whole stack — NO MODEL: the same recovery decision always yields the same
// resolution decision. WHETHER a resolution is determined (the recovery read and the record filed) and IDEMPOTENTLY
// recorded is the server runtime's job, behind its own append-only, service-role-only, idempotent ledger. The pure
// core names the resolution and stops.
//
// EXPLICIT R33 NON-GOALS no layer here performs: recovery execution, automatic retries, scheduling, quote fulfilment,
// customer promotion, memory retrieval, customer-portal conversations, and voice / WhatsApp / email. The "resolution"
// R33 performs is the INTERNAL determination — the durable, auditable classification of a determined recovery into the
// conversation-completion state it implies (terminal / recoverable / unresolved) — which is the disposition future,
// explicitly-authorised operational capabilities read to know whether a conversation is complete.
// =====================================================================

import {
  isRecoveryDecided,
  type RecoveryDecision,
  type RecoverBookingDecision,
  type RecoveryClassification,
  type ConversationRecoveryType,
} from "@/lib/receptionist/conversation-recovery";

// ---------------------------------------------------------------------
// The RESOLUTION vocabulary — the closed set of resolution types, determined outcomes and resolution states.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of RESOLUTION TYPES — the kinds of determined recovery this engine can resolve to a
 * conversation-completion state. R33 ships exactly ONE:
 *   • resolve_booking_recovery — the classification of a determined `recover_booking_fulfilment` recovery into the
 *                                conversation-completion state it implies. It DETERMINES completion; it never
 *                                re-books, retries, reconciles, schedules or reaches a comms provider (all EXPLICIT
 *                                R33 non-goals).
 * Quote-recovery resolution, scheduling-recovery resolution and every future resolution type are EXPLICIT R33
 * non-goals, so their resolution types are deliberately ABSENT — a future increment ADDS them here (and to the
 * ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ConversationResolutionType} is
 * exactly these members and a consumer can switch exhaustively.
 */
export const RESOLUTION_TYPES = ["resolve_booking_recovery"] as const;

/** One resolution type the engine can determine. */
export type ConversationResolutionType = (typeof RESOLUTION_TYPES)[number];

/**
 * The closed vocabulary of RESOLUTION OUTCOMES — the DETERMINED result of running a resolution. R33 ships exactly ONE:
 *   • conversation_resolution_determined — a completion state was determined for the recovered conversation. This is
 *                                          the INTERNAL operation R33 performs: the durable record that a completion
 *                                          determination was carried out. WHAT completion state (and whether the
 *                                          conversation is terminal / requires intervention) is the separate
 *                                          {@link ResolutionState} + coherent projections. The outcome says "a
 *                                          resolution was determined"; the state says "what it resolved to".
 * A closed union so a consumer can switch exhaustively over every determined result.
 */
export type ResolutionOutcome = "conversation_resolution_determined";

/**
 * The closed vocabulary of RESOLUTION STATES — the conversation-completion state a determined recovery implies. This
 * is the canonical classification Directive #018 R33 makes the engine the single authority over:
 *   • terminal    — the recovery was `none` (the verification was `consistent`; the approved operation completed
 *                   correctly). The conversation has reached a TERMINAL state: fully resolved, no further intervention
 *                   required. A determination is still filed (completion was considered and found reached).
 *   • recoverable — the recovery was `reinstate` (the verification was `missing`; an approved operation with no
 *                   record). There is a CLEAR recovery path — the operation warrants reinstatement — so the
 *                   conversation is RECOVERABLE: not terminal, further intervention required, but a known path exists.
 *                   R33 only CLASSIFIES it as recoverable; it reinstates nothing.
 *   • unresolved  — the recovery was `reconcile` (the verification was `inconsistent`; a record exists but diverges).
 *                   The truth is AMBIGUOUS — the record warrants reconciliation before completion can be known — so
 *                   the conversation is UNRESOLVED: not terminal, further intervention required, path unclear. R33
 *                   only CLASSIFIES it as unresolved; it reconciles nothing.
 * A closed union so the resolution state is exhaustive. It is a TOTAL, DETERMINISTIC fold of the R32
 * {@link RecoveryClassification} — this is the determination, NOT an abstention: a resolution record is produced for
 * ALL three states (`terminal` is the determination "the conversation is complete", not "nothing to determine").
 */
export type ResolutionState = "terminal" | "recoverable" | "unresolved";

/**
 * The recovery-type → resolution-type mapping — which RESOLUTION TYPE each decided {@link ConversationRecoveryType} is
 * resolved as, or `null` when the recovery type has no R33 resolution. TOTAL over the whole recovery vocabulary — the
 * `Record` type makes the exhaustiveness a COMPILE-TIME guarantee, so this map and the R32 recovery vocabulary can
 * never drift (a new recovery type cannot be added without deciding its resolution here). R32 ships
 * `recover_booking_fulfilment`, which maps to `resolve_booking_recovery`; a future recovery type maps to its own
 * resolution type (or `null` until one is added) as an explicit, reviewable act.
 */
export const RECOVERY_RESOLUTION: Readonly<
  Record<ConversationRecoveryType, ConversationResolutionType | null>
> = {
  recover_booking_fulfilment: "resolve_booking_recovery",
};

// ---------------------------------------------------------------------
// The RESOLUTION model — the resolved completion decision for a recovery.
// ---------------------------------------------------------------------

/**
 * The EXPECTED booking a resolution is determined for — carried through, BY REFERENCE, from the R32 recovery decision
 * (which itself carried it from the R31 verification decision, which carried it from the R30 fulfilment decision).
 * Referenced via indexed access so this core's ONLY import stays the recovery surface it consumes — the booking type
 * is the recovery decision's own, never re-modelled here.
 */
export type ResolutionBooking = RecoverBookingDecision["booking"];

/**
 * The RESOLVE-BOOKING-RECOVERY decision — the first (and only R33) resolution decision. It is the auditable
 * determination of classifying a determined booking-fulfilment recovery into the conversation-completion state it
 * implies, carrying the determined {@link ResolutionOutcome} (`conversation_resolution_determined`), the
 * {@link ResolutionState} it folded to (`terminal` / `recoverable` / `unresolved`), the `terminal` flag (true iff the
 * state is `terminal`), the `intervention_required` flag (true iff the state is NOT `terminal`), the SOURCE
 * {@link RecoveryClassification} it resolved (for audit + coherence) and the EXPECTED {@link ResolutionBooking}
 * payload (what the recovery concerns), so the decision is self-describing for the resolution ledger. It is emitted
 * ONLY for a DECIDED `recover_booking_fulfilment` recovery — it can carry no other recovery, and it cannot exist
 * without a determined recovery to resolve.
 */
export type ResolveBookingRecoveryDecision = {
  readonly kind: "resolve_booking_recovery";
  readonly outcome: ResolutionOutcome;
  readonly state: ResolutionState;
  readonly terminal: boolean;
  readonly intervention_required: boolean;
  readonly classification: RecoveryClassification;
  readonly booking: ResolutionBooking;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine determined NO resolution. An abstention is not an
 * error; it is the honest "nothing to resolve here" for the overwhelming majority of turns:
 *   • no_recovery_decision  — the R32 Recovery Engine rendered NO decision (an abstention — nothing was verified, so
 *                             nothing was recovered). There is nothing to resolve, so the Resolution Engine defers.
 *                             This is the FIRST gate — the Recovery Engine (and transitively Verification, Fulfilment,
 *                             Authorisation, Execution, Action and Outcome) stays authoritative.
 *   • unsupported_recovery  — a recovery WAS decided, but its type maps to no R33 resolution type (defence in depth:
 *                             R32 ships only `recover_booking_fulfilment`, which maps to `resolve_booking_recovery`,
 *                             so this is unreachable today; it becomes live only if a future recovery type is added to
 *                             R32 without a matching resolution type here).
 * A closed union so {@link ResolutionDecision}'s abstention arm is exhaustive. NOTE: `terminal` is NOT an abstention —
 * it is an `intervention_required = false` STATE on a produced resolution decision (a consistent, fully-recovered
 * conversation warrants no further intervention, but the determination is still filed).
 */
export type ResolutionAbstention = "no_recovery_decision" | "unsupported_recovery";

/**
 * The conversational RESOLUTION DECISION — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link ResolveBookingRecoveryDecision}, and future resolution types) — the auditable
 *     determination of a resolution, carrying the {@link ResolutionState} and the `terminal` / `intervention_required`
 *     flags. Its `kind` IS its {@link ConversationResolutionType}. A decided arm is produced for a `terminal`, a
 *     `recoverable` and an `unresolved` state alike — the state differs, not the presence of a determination.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no resolution, tagged with WHY ({@link ResolutionAbstention}).
 *     The overwhelmingly common case (every turn that was not a decided recovery). NOTE the distinct uses: the
 *     abstention arm's `kind: "none"` means "no determination"; a decided arm's `state: "terminal"` means "a
 *     determination that the conversation is complete".
 * Every field is a total, deterministic function of the recovery decision; the whole object is derived, never
 * persisted or executed by this core.
 */
export type ResolutionDecision =
  | ResolveBookingRecoveryDecision
  | { readonly kind: "none"; readonly reason: ResolutionAbstention };

// ---------------------------------------------------------------------
// RESOLUTION — the single derived completion decision. Defers to the recovery; total over the input.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no resolution". */
function abstain(reason: ResolutionAbstention): ResolutionDecision {
  return { kind: "none", reason };
}

/**
 * The RESOLUTION STATE for a recovery classification — the deterministic fold at the heart of the engine. A `none`
 * classification means the operation completed correctly, so the conversation is TERMINAL (`terminal`); a `reinstate`
 * classification means the operation warrants reinstatement along a clear path, so the conversation is RECOVERABLE
 * (`recoverable`); a `reconcile` classification means the record is ambiguous and warrants reconciliation, so the
 * conversation is UNRESOLVED (`unresolved`). A closed switch, so adding a {@link RecoveryClassification} member
 * without folding it here fails `tsc`.
 */
function stateOf(classification: RecoveryClassification): ResolutionState {
  switch (classification) {
    case "none":
      return "terminal";
    case "reinstate":
      return "recoverable";
    case "reconcile":
      return "unresolved";
  }
}

/**
 * Resolve the RESOLUTION DECISION for a recovery — THE single entry point the runtime reads. Consumes the one
 * already-computed input it determines completion over: the R32 `recovery` decision (the DEFERRAL gate — when the
 * Recovery Engine rendered no decision, the Resolution Engine stands down).
 *
 * Pure, TOTAL over any recovery decision, and DETERMINISTIC — the same recovery always yields the same resolution
 * decision. The Recovery Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to Verification,
 * Fulfilment, Authorisation, Execution, Action and Outcome). Human Review and Policy stay MANDATORY: a decided
 * recovery only exists for a human-approved, policy-cleared, verified operation, so this engine determines completion
 * for nothing else — without importing a policy module or recording a grant. Persists NOTHING and resolves NOTHING
 * itself — the runtime reads the recovery and IDEMPOTENTLY records the determination. THE single source of truth for
 * whether a conversation has reached a terminal, recoverable or unresolved state — every consumer resolves it through
 * this function and no other way; no feature implements independent resolution logic.
 */
export function resolveConversationResolution(recovery: RecoveryDecision): ResolutionDecision {
  // THE RECOVERY ENGINE IS AUTHORITATIVE. If R32 rendered NO decision (an abstention — nothing was verified, so
  // nothing was recovered, so nothing to resolve), the Resolution Engine defers. This is the first thing the engine
  // checks — it CONSUMES the recovery decision, it never overrides it. Because a decided recovery exists ONLY when R32
  // classified a decided verification (which needs a decided R31 fulfilment verification, the decided R30 go-ahead,
  // the approved R29 authorisation, the R28 execution, the R27 action and the R26 outcome), deferring here
  // transitively preserves the whole stack's authority.
  if (!isRecoveryDecided(recovery)) return abstain("no_recovery_decision");

  // The decided recovery selects its resolution type. R32 ships only `recover_booking_fulfilment` (→
  // `resolve_booking_recovery`); a null here would mean a future recovery type reached this engine before its
  // resolution type was added — defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const resolutionType = RECOVERY_RESOLUTION[recovery.kind];
  if (resolutionType === null) return abstain("unsupported_recovery");

  // Render the determination — the WORK this engine performs. A closed switch keeps this exhaustive as the vocabulary
  // grows: adding a RESOLUTION_TYPE without a case here fails `tsc`. The state (`terminal` / `recoverable` /
  // `unresolved`) is the fold of the recovery classification; the decision is produced for ALL three — determining
  // that a `reinstate` conversation is recoverable and a `reconcile` one unresolved (and that a `none` one is
  // terminal) is the whole purpose of the engine.
  switch (resolutionType) {
    case "resolve_booking_recovery": {
      // The state is the deterministic fold of the recovery's OWN classification; `terminal` and
      // `intervention_required` are its coherent companions (terminal iff the state is `terminal`; intervention
      // required iff it is NOT). These answer Directive #018 R33's two distinct questions — "is the conversation
      // terminal?" and "is further intervention required?" — so both are first-class, coherence-pinned fields, not
      // one derived silently from the other. The EXPECTED booking is carried through by reference — so the resolution
      // record is self-describing about what the recovery concerns, and can never drift from the recovery (or the
      // verification, or the fulfilment) it resolves.
      const state = stateOf(recovery.classification);
      return {
        kind: "resolve_booking_recovery",
        outcome: "conversation_resolution_determined",
        state,
        terminal: state === "terminal",
        intervention_required: state !== "terminal",
        classification: recovery.classification,
        booking: recovery.booking,
      };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a produced resolution determination), as opposed to an abstention. A type guard: it
 * narrows a {@link ResolutionDecision} to its decided arms, so the runtime records ONLY a real determination and an
 * abstention is a total no-op. THE predicate the runtime gates the record on — there is no other "should we determine
 * resolution?" rule. NOTE: a decided resolution may carry ANY state (including `terminal`); "decided" means "a
 * determination was made", not "the conversation is terminal".
 */
export function isResolutionDecided(
  decision: ResolutionDecision,
): decision is ResolveBookingRecoveryDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationResolutionType} of a decision (for audit/persistence keying), or `null` for an abstention.
 * Pure and total — the decided arm's `kind` IS its resolution type, so the mapping is the identity on the decided arms
 * and `null` on the abstention.
 */
export function resolutionTypeOf(decision: ResolutionDecision): ConversationResolutionType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link ResolutionOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and
 * total — the determined result the runtime folds onto the ledger row alongside the resolution type.
 */
export function resolutionOutcomeOf(decision: ResolutionDecision): ResolutionOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}

/**
 * The {@link ResolutionState} of a decision (for audit/persistence keying and completion reporting), or `null` for an
 * abstention. Pure and total — the fold the runtime folds onto the ledger row, and the disposition future operational
 * capabilities read to determine whether a conversation is complete (and, if not, along which path).
 */
export function resolutionStateOf(decision: ResolutionDecision): ResolutionState | null {
  return decision.kind === "none" ? null : decision.state;
}

/**
 * Whether a decision determined the conversation TERMINAL (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the coherent companion of the state (true iff the state is `terminal`). This answers
 * Directive #018 R33's question "has the conversation reached a terminal state?".
 */
export function resolutionTerminalOf(decision: ResolutionDecision): boolean | null {
  return decision.kind === "none" ? null : decision.terminal;
}

/**
 * Whether a decision determined FURTHER INTERVENTION is required (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the coherent companion of the state (true iff the state is NOT `terminal`). This
 * answers Directive #018 R33's question "is further intervention required?" — the flag a future operational capability
 * reads to decide whether to act at all.
 */
export function resolutionInterventionRequiredOf(decision: ResolutionDecision): boolean | null {
  return decision.kind === "none" ? null : decision.intervention_required;
}

/**
 * The SOURCE {@link RecoveryClassification} a resolution decision resolved (for audit/persistence keying), or `null`
 * for an abstention. Pure and total — the classification the runtime folds onto the ledger row so the resolution is
 * self-describing about the recovery disposition it resolves.
 */
export function resolutionClassificationOf(
  decision: ResolutionDecision,
): RecoveryClassification | null {
  return decision.kind === "none" ? null : decision.classification;
}
