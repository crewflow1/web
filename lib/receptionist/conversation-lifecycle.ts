// =====================================================================
// THE CONVERSATION LIFECYCLE ENGINE — PURE CORE (CEO Directive #018; R34: CONVERSATION LIFECYCLE ENGINE).
//
// R17–R25 built the DERIVING stack; R26 RESOLVES an outcome, R27 PREPARES an action, R28 DECIDES an execution's
// eligibility, R29 DETERMINES whether that decided execution requires APPROVAL, R30 PERFORMS the approved internal
// business operation (booking fulfilment), R31 VERIFIES that performed operation — reconciling the decision against
// the record and reporting an INTEGRITY verdict — R32 DETERMINES the RECOVERY that verdict warrants (none / reinstate
// / reconcile), and R33 DETERMINES the RESOLUTION that recovery implies — classifying the conversation into a TERMINAL,
// RECOVERABLE or UNRESOLVED completion state. R34 is the NEXT — and, in this stack, the FOURTH engine that does not
// perform: the single, canonical authority over a FIFTEENTH question, one derived from the Resolution Decision above it
// — "given a resolution the stack DETERMINED, what LIFECYCLE TRANSITION does the conversation now undergo, and what
// lifecycle STATE does it come to rest in?" — the LIFECYCLE DECISION. Resolution-lifecycle governance is the FIRST
// lifecycle type expressed here — `govern_resolution_lifecycle`, the governance of a determined resolution into the
// lifecycle transition + state it implies — but it is one member of the lifecycle vocabulary, not the engine's purpose.
//
// IT GOVERNS THE LIFECYCLE — IT NEVER EXECUTES BUSINESS ACTIONS. Unlike R30 (whose decision is the GO-AHEAD to carry
// out an approved operation), the Lifecycle Engine's decision performs NO business action: it GOVERNS a resolution
// disposition into a conversation {@link LifecycleState} (closed / retained / escalated) via a {@link LifecycleTransition}
// (close / retain / escalate) and reports WHETHER the conversation is closed and WHETHER it remains ongoing. It closes
// nothing, retains nothing, escalates nothing, re-books nothing, retries nothing, reconciles nothing, schedules nothing
// and reaches no provider. It is the layer that turns R33's actionable RESOLUTION disposition into an auditable,
// single-authority CONVERSATION-LIFECYCLE verdict — the transition a future, explicitly-authorised operational
// capability reads to know what becomes of a conversation. Recovery execution, automatic retries and automatic
// scheduling are EXPLICIT R34 non-goals: this engine says WHAT LIFECYCLE TRANSITION the conversation undergoes, never
// ACTS to carry it out.
//
// THE RESOLUTION ENGINE REMAINS AUTHORITATIVE — THE LIFECYCLE ENGINE CONSUMES ITS DECISION, IT NEVER RE-DERIVES IT.
// {@link resolveConversationLifecycle} takes the R33 {@link ResolutionDecision} as its ONLY input, and its FIRST gate
// DEFERS: when the Resolution Engine rendered NO decision (an abstention — nothing was recovered, so nothing was
// resolved, so there is no lifecycle to govern), the Lifecycle Engine stands down (`no_resolution_decision`). Because a
// decided resolution only exists when R33 classified a DECIDED recovery (which only exists when R32 classified a DECIDED
// verification, which only exists when R31 reconciled a DECIDED fulfilment, which needs the approved R30 go-ahead, the
// approved R29 authorisation, the R28 execution, the R27 action and the R26 outcome), deferring to the Resolution
// Engine here TRANSITIVELY preserves the Recovery, Verification, Fulfilment, Authorisation, Execution, Action and
// Outcome Engines' authority too. The resolution STATE is NEVER recomputed here: it is the resolution decision's own
// finding, handed in — this engine READS the disposition, it never re-resolves. No duplicate resolution logic; no
// duplicate lifecycle logic.
//
// HUMAN REVIEW & POLICY STAY MANDATORY — TRANSITIVELY, THROUGH THE RESOLUTION IT CONSUMES. A decided resolution exists
// ONLY for a DECIDED recovery, which exists ONLY for a DECIDED verification, which exists ONLY for an APPROVED
// authorisation (R33's inherited gate, R32's inherited gate, R31's inherited gate, R30's keystone), which arises ONLY
// from the EXISTING Human Review architecture (R14's `receptionist_review_resolutions`, a `sent` resolution, folded to
// `approved` by R29) and can NEVER exist for a policy-blocked booking (foreclosed at R29, never revivable). So the
// Lifecycle Engine governs the lifecycle ONLY for human-approved, policy-cleared, verified, recovered, resolved
// operations — by construction, without importing a policy module or recording a grant. This engine imports NO policy
// surface and names NO guardrail decision function.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND GOVERNS NOTHING ITSELF. Like R26–R33, the lifecycle DECISION
// is a TOTAL, DETERMINISTIC function of an already-computed input — the R33 resolution decision. The pure core adds NO
// column and NO migration, reaches NO provider, NO ledger, NO DB, NO clock, NO RNG, NO org lookup, NO env read and —
// the cardinal rule shared with the whole stack — NO MODEL: the same resolution decision always yields the same
// lifecycle decision. WHETHER a lifecycle is governed (the resolution read and the record filed) and IDEMPOTENTLY
// recorded is the server runtime's job, behind its own append-only, service-role-only, idempotent ledger. The pure
// core names the transition and stops.
//
// EXPLICIT R34 NON-GOALS no layer here performs: recovery execution, automatic retries, scheduling, quote fulfilment,
// customer promotion, memory retrieval, customer-portal conversations, and voice / WhatsApp / email. The "governance"
// R34 performs is the INTERNAL determination — the durable, auditable governance of a determined resolution into the
// lifecycle transition + state it implies (close→closed / retain→retained / escalate→escalated) — which is the
// disposition future, explicitly-authorised operational capabilities read to know what lifecycle transition a
// conversation has undergone.
// =====================================================================

import {
  isResolutionDecided,
  type ResolutionDecision,
  type ResolveBookingRecoveryDecision,
  type ResolutionState,
  type ConversationResolutionType,
} from "@/lib/receptionist/conversation-resolution";

// ---------------------------------------------------------------------
// The LIFECYCLE vocabulary — the closed set of lifecycle types, governed outcomes, transitions and states.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of LIFECYCLE TYPES — the kinds of determined resolution this engine can govern into a
 * conversation-lifecycle transition. R34 ships exactly ONE:
 *   • govern_resolution_lifecycle — the governance of a determined `resolve_booking_recovery` resolution into the
 *                                   lifecycle transition + state it implies. It GOVERNS the lifecycle; it never
 *                                   closes, retains, escalates, re-books, retries, reconciles, schedules or reaches a
 *                                   comms provider (all EXPLICIT R34 non-goals).
 * Quote-resolution lifecycle, scheduling-resolution lifecycle and every future lifecycle type are EXPLICIT R34
 * non-goals, so their lifecycle types are deliberately ABSENT — a future increment ADDS them here (and to the ledger's
 * CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ConversationLifecycleType} is exactly these
 * members and a consumer can switch exhaustively.
 */
export const LIFECYCLE_TYPES = ["govern_resolution_lifecycle"] as const;

/** One lifecycle type the engine can govern. */
export type ConversationLifecycleType = (typeof LIFECYCLE_TYPES)[number];

/**
 * The closed vocabulary of LIFECYCLE OUTCOMES — the GOVERNED result of running a lifecycle governance. R34 ships
 * exactly ONE:
 *   • conversation_lifecycle_governed — a lifecycle transition was governed for the resolved conversation. This is the
 *                                       INTERNAL operation R34 performs: the durable record that a lifecycle governance
 *                                       was carried out. WHICH transition (and the state it comes to rest in, and
 *                                       whether the conversation is closed / ongoing) is the separate
 *                                       {@link LifecycleTransition} + {@link LifecycleState} + coherent projections. The
 *                                       outcome says "a lifecycle was governed"; the transition says "how it moved".
 * A closed union so a consumer can switch exhaustively over every governed result.
 */
export type LifecycleOutcome = "conversation_lifecycle_governed";

/**
 * The closed vocabulary of LIFECYCLE STATES — the conversation-lifecycle state a determined resolution comes to rest
 * in. This is one half of the canonical governance Directive #018 R34 makes the engine the single authority over:
 *   • closed    — the resolution was `terminal` (the recovery was `none`; the verification was `consistent`; the
 *                 approved operation completed correctly). The conversation's lifecycle is COMPLETE: it is CLOSED, no
 *                 further lifecycle attention required. A governance is still filed (the lifecycle was considered and
 *                 found complete).
 *   • retained  — the resolution was `recoverable` (the recovery was `reinstate`; an approved operation with no record).
 *                 There is a CLEAR recovery path, so the conversation is RETAINED — held open in its lifecycle pending
 *                 that known path: not closed, remains ongoing, but a defined next step exists. R34 only GOVERNS it as
 *                 retained; it reinstates nothing.
 *   • escalated — the resolution was `unresolved` (the recovery was `reconcile`; a record exists but diverges). The
 *                 truth is AMBIGUOUS, so the conversation is ESCALATED — raised for operational attention because the
 *                 lifecycle cannot close and the path is unclear: not closed, remains ongoing, path unclear. R34 only
 *                 GOVERNS it as escalated; it reconciles nothing and pages no one.
 * A closed union so the lifecycle state is exhaustive. It is a TOTAL, DETERMINISTIC fold of the {@link LifecycleTransition}
 * (which is itself the fold of the R33 {@link ResolutionState}) — this is the governance, NOT an abstention: a lifecycle
 * record is produced for ALL three states (`closed` is the governance "the conversation's lifecycle is complete", not
 * "nothing to govern").
 */
export type LifecycleState = "closed" | "retained" | "escalated";

/**
 * The closed vocabulary of LIFECYCLE TRANSITIONS — the transition the conversation UNDERGOES as it moves from a live,
 * resolved conversation into its resting lifecycle state. This is the other (and operative) half of the governance —
 * the "verb" a future operational capability reads to know WHAT to do with the conversation, though R34 itself does
 * none of it:
 *   • close    — CLOSE the conversation (from a `terminal` resolution). The lifecycle is complete; the transition is to
 *                close. R34 records the transition; it closes nothing.
 *   • retain   — RETAIN the conversation (from a `recoverable` resolution). A clear recovery path exists; the transition
 *                is to hold the conversation open pending it. R34 records the transition; it retains nothing.
 *   • escalate — ESCALATE the conversation (from an `unresolved` resolution). The record is ambiguous; the transition is
 *                to raise it for operational attention. R34 records the transition; it escalates nothing and pages no
 *                one.
 * A closed union so the transition is exhaustive, and a TOTAL, DETERMINISTIC fold of the R33 {@link ResolutionState}.
 * The transition and the state are 1:1 (close⇒closed, retain⇒retained, escalate⇒escalated); both are first-class so
 * the decision records BOTH the movement and where it rests.
 */
export type LifecycleTransition = "close" | "retain" | "escalate";

/**
 * The resolution-type → lifecycle-type mapping — which LIFECYCLE TYPE each decided {@link ConversationResolutionType} is
 * governed as, or `null` when the resolution type has no R34 lifecycle. TOTAL over the whole resolution vocabulary — the
 * `Record` type makes the exhaustiveness a COMPILE-TIME guarantee, so this map and the R33 resolution vocabulary can
 * never drift (a new resolution type cannot be added without deciding its lifecycle here). R33 ships
 * `resolve_booking_recovery`, which maps to `govern_resolution_lifecycle`; a future resolution type maps to its own
 * lifecycle type (or `null` until one is added) as an explicit, reviewable act.
 */
export const RESOLUTION_LIFECYCLE: Readonly<
  Record<ConversationResolutionType, ConversationLifecycleType | null>
> = {
  resolve_booking_recovery: "govern_resolution_lifecycle",
};

// ---------------------------------------------------------------------
// The LIFECYCLE model — the governed lifecycle decision for a resolution.
// ---------------------------------------------------------------------

/**
 * The EXPECTED booking a lifecycle is governed for — carried through, BY REFERENCE, from the R33 resolution decision
 * (which itself carried it from the R32 recovery decision, from the R31 verification decision, from the R30 fulfilment
 * decision). Referenced via indexed access so this core's ONLY import stays the resolution surface it consumes — the
 * booking type is the resolution decision's own, never re-modelled here.
 */
export type LifecycleBooking = ResolveBookingRecoveryDecision["booking"];

/**
 * The GOVERN-RESOLUTION-LIFECYCLE decision — the first (and only R34) lifecycle decision. It is the auditable
 * determination of governing a determined booking-recovery resolution into the lifecycle transition + state it implies,
 * carrying the governed {@link LifecycleOutcome} (`conversation_lifecycle_governed`), the {@link LifecycleTransition} the
 * conversation undergoes (`close` / `retain` / `escalate`), the {@link LifecycleState} it comes to rest in (`closed` /
 * `retained` / `escalated`), the `closed` flag (true iff the state is `closed`), the `ongoing` flag (true iff the state
 * is NOT `closed`), the SOURCE {@link ResolutionState} it governed (for audit + coherence) and the EXPECTED
 * {@link LifecycleBooking} payload (what the resolution concerns), so the decision is self-describing for the lifecycle
 * ledger. It is emitted ONLY for a DECIDED `resolve_booking_recovery` resolution — it can carry no other resolution, and
 * it cannot exist without a determined resolution to govern.
 */
export type GovernResolutionLifecycleDecision = {
  readonly kind: "govern_resolution_lifecycle";
  readonly outcome: LifecycleOutcome;
  readonly transition: LifecycleTransition;
  readonly state: LifecycleState;
  readonly closed: boolean;
  readonly ongoing: boolean;
  readonly resolution_state: ResolutionState;
  readonly booking: LifecycleBooking;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine governed NO lifecycle. An abstention is not an error; it
 * is the honest "no lifecycle to govern here" for the overwhelming majority of turns:
 *   • no_resolution_decision  — the R33 Resolution Engine rendered NO decision (an abstention — nothing was recovered,
 *                               so nothing was resolved). There is no lifecycle to govern, so the Lifecycle Engine
 *                               defers. This is the FIRST gate — the Resolution Engine (and transitively Recovery,
 *                               Verification, Fulfilment, Authorisation, Execution, Action and Outcome) stays
 *                               authoritative.
 *   • unsupported_resolution  — a resolution WAS decided, but its type maps to no R34 lifecycle type (defence in depth:
 *                               R33 ships only `resolve_booking_recovery`, which maps to `govern_resolution_lifecycle`,
 *                               so this is unreachable today; it becomes live only if a future resolution type is added
 *                               to R33 without a matching lifecycle type here).
 * A closed union so {@link LifecycleDecision}'s abstention arm is exhaustive. NOTE: `closed` is NOT an abstention — it is
 * an `ongoing = false` STATE on a produced lifecycle decision (a terminal, fully-resolved conversation warrants no
 * further lifecycle attention, but the governance is still filed).
 */
export type LifecycleAbstention = "no_resolution_decision" | "unsupported_resolution";

/**
 * The conversational LIFECYCLE DECISION — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link GovernResolutionLifecycleDecision}, and future lifecycle types) — the auditable determination
 *     of a lifecycle governance, carrying the {@link LifecycleTransition}, the {@link LifecycleState} and the `closed` /
 *     `ongoing` flags. Its `kind` IS its {@link ConversationLifecycleType}. A decided arm is produced for a `closed`, a
 *     `retained` and an `escalated` state alike — the transition differs, not the presence of a governance.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no lifecycle, tagged with WHY ({@link LifecycleAbstention}). The
 *     overwhelmingly common case (every turn that was not a decided resolution). NOTE the distinct uses: the abstention
 *     arm's `kind: "none"` means "no governance"; a decided arm's `state: "closed"` means "a governance that the
 *     conversation's lifecycle is complete".
 * Every field is a total, deterministic function of the resolution decision; the whole object is derived, never
 * persisted or executed by this core.
 */
export type LifecycleDecision =
  | GovernResolutionLifecycleDecision
  | { readonly kind: "none"; readonly reason: LifecycleAbstention };

// ---------------------------------------------------------------------
// LIFECYCLE — the single derived governance decision. Defers to the resolution; total over the input.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no lifecycle". */
function abstain(reason: LifecycleAbstention): LifecycleDecision {
  return { kind: "none", reason };
}

/**
 * The LIFECYCLE TRANSITION for a resolution state — the first half of the deterministic fold at the heart of the
 * engine. A `terminal` resolution means the operation completed correctly, so the conversation is CLOSED (`close`); a
 * `recoverable` resolution means a clear recovery path exists, so the conversation is RETAINED (`retain`); an
 * `unresolved` resolution means the record is ambiguous, so the conversation is ESCALATED (`escalate`). A closed
 * switch, so adding a {@link ResolutionState} member without folding it here fails `tsc`.
 */
function transitionOf(state: ResolutionState): LifecycleTransition {
  switch (state) {
    case "terminal":
      return "close";
    case "recoverable":
      return "retain";
    case "unresolved":
      return "escalate";
  }
}

/**
 * The LIFECYCLE STATE for a transition — the second half of the deterministic fold. A `close` transition rests in
 * `closed`, a `retain` transition rests in `retained`, an `escalate` transition rests in `escalated`. The transition
 * and the state are 1:1 by construction. A closed switch, so adding a {@link LifecycleTransition} member without folding
 * it here fails `tsc`.
 */
function stateOf(transition: LifecycleTransition): LifecycleState {
  switch (transition) {
    case "close":
      return "closed";
    case "retain":
      return "retained";
    case "escalate":
      return "escalated";
  }
}

/**
 * Govern the LIFECYCLE DECISION for a resolution — THE single entry point the runtime reads. Consumes the one
 * already-computed input it governs the lifecycle over: the R33 `resolution` decision (the DEFERRAL gate — when the
 * Resolution Engine rendered no decision, the Lifecycle Engine stands down).
 *
 * Pure, TOTAL over any resolution decision, and DETERMINISTIC — the same resolution always yields the same lifecycle
 * decision. The Resolution Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to Recovery,
 * Verification, Fulfilment, Authorisation, Execution, Action and Outcome). Human Review and Policy stay MANDATORY: a
 * decided resolution only exists for a human-approved, policy-cleared, verified, recovered operation, so this engine
 * governs the lifecycle for nothing else — without importing a policy module or recording a grant. Persists NOTHING and
 * governs NOTHING itself — the runtime reads the resolution and IDEMPOTENTLY records the governance. THE single source
 * of truth for what lifecycle transition a conversation undergoes and where it comes to rest — every consumer governs it
 * through this function and no other way; no feature implements independent lifecycle logic.
 */
export function resolveConversationLifecycle(resolution: ResolutionDecision): LifecycleDecision {
  // THE RESOLUTION ENGINE IS AUTHORITATIVE. If R33 rendered NO decision (an abstention — nothing was recovered, so
  // nothing was resolved, so no lifecycle to govern), the Lifecycle Engine defers. This is the first thing the engine
  // checks — it CONSUMES the resolution decision, it never overrides it. Because a decided resolution exists ONLY when
  // R33 classified a decided recovery (which needs a decided R32 recovery, a decided R31 verification, the decided R30
  // go-ahead, the approved R29 authorisation, the R28 execution, the R27 action and the R26 outcome), deferring here
  // transitively preserves the whole stack's authority.
  if (!isResolutionDecided(resolution)) return abstain("no_resolution_decision");

  // The decided resolution selects its lifecycle type. R33 ships only `resolve_booking_recovery` (→
  // `govern_resolution_lifecycle`); a null here would mean a future resolution type reached this engine before its
  // lifecycle type was added — defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const lifecycleType = RESOLUTION_LIFECYCLE[resolution.kind];
  if (lifecycleType === null) return abstain("unsupported_resolution");

  // Render the governance — the WORK this engine performs. A closed switch keeps this exhaustive as the vocabulary
  // grows: adding a LIFECYCLE_TYPE without a case here fails `tsc`. The transition (`close` / `retain` / `escalate`) is
  // the fold of the resolution state; the state (`closed` / `retained` / `escalated`) is the fold of the transition;
  // the decision is produced for ALL three — governing that a `recoverable` conversation is retained and an
  // `unresolved` one escalated (and that a `terminal` one is closed) is the whole purpose of the engine.
  switch (lifecycleType) {
    case "govern_resolution_lifecycle": {
      // The transition is the deterministic fold of the resolution's OWN state; the state is the deterministic fold of
      // the transition; `closed` and `ongoing` are their coherent companions (closed iff the state is `closed`; ongoing
      // iff it is NOT). These answer Directive #018 R34's questions — "what lifecycle transition?" and "where does it
      // rest?" and "is the conversation closed / does it remain ongoing?" — so all are first-class, coherence-pinned
      // fields, not one derived silently from another. The EXPECTED booking is carried through by reference — so the
      // lifecycle record is self-describing about what the resolution concerns, and can never drift from the resolution
      // (or the recovery, or the verification, or the fulfilment) it governs.
      const transition = transitionOf(resolution.state);
      const state = stateOf(transition);
      return {
        kind: "govern_resolution_lifecycle",
        outcome: "conversation_lifecycle_governed",
        transition,
        state,
        closed: state === "closed",
        ongoing: state !== "closed",
        resolution_state: resolution.state,
        booking: resolution.booking,
      };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a produced lifecycle governance), as opposed to an abstention. A type guard: it
 * narrows a {@link LifecycleDecision} to its decided arms, so the runtime records ONLY a real governance and an
 * abstention is a total no-op. THE predicate the runtime gates the record on — there is no other "should we govern the
 * lifecycle?" rule. NOTE: a decided lifecycle may carry ANY state (including `closed`); "decided" means "a governance
 * was made", not "the conversation is closed".
 */
export function isLifecycleDecided(
  decision: LifecycleDecision,
): decision is GovernResolutionLifecycleDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationLifecycleType} of a decision (for audit/persistence keying), or `null` for an abstention. Pure
 * and total — the decided arm's `kind` IS its lifecycle type, so the mapping is the identity on the decided arms and
 * `null` on the abstention.
 */
export function lifecycleTypeOf(decision: LifecycleDecision): ConversationLifecycleType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link LifecycleOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and
 * total — the governed result the runtime folds onto the ledger row alongside the lifecycle type.
 */
export function lifecycleOutcomeOf(decision: LifecycleDecision): LifecycleOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}

/**
 * The {@link LifecycleTransition} of a decision (for audit/persistence keying and lifecycle reporting), or `null` for an
 * abstention. Pure and total — the fold the runtime folds onto the ledger row, and the operative "verb" future
 * operational capabilities read to know what lifecycle transition a conversation has undergone (close / retain /
 * escalate).
 */
export function lifecycleTransitionOf(decision: LifecycleDecision): LifecycleTransition | null {
  return decision.kind === "none" ? null : decision.transition;
}

/**
 * The {@link LifecycleState} of a decision (for audit/persistence keying and lifecycle reporting), or `null` for an
 * abstention. Pure and total — the resting state the runtime folds onto the ledger row, and the disposition future
 * operational capabilities read to know where a conversation's lifecycle has come to rest (and, if not closed, why).
 */
export function lifecycleStateOf(decision: LifecycleDecision): LifecycleState | null {
  return decision.kind === "none" ? null : decision.state;
}

/**
 * Whether a decision governed the conversation CLOSED (for audit/persistence keying), or `null` for an abstention. Pure
 * and total — the coherent companion of the state (true iff the state is `closed`). This answers Directive #018 R34's
 * question "has the conversation's lifecycle closed?".
 */
export function lifecycleClosedOf(decision: LifecycleDecision): boolean | null {
  return decision.kind === "none" ? null : decision.closed;
}

/**
 * Whether a decision governed the conversation ONGOING (for audit/persistence keying), or `null` for an abstention.
 * Pure and total — the coherent companion of the state (true iff the state is NOT `closed`). This answers Directive
 * #018 R34's question "does the conversation remain ongoing?" — the flag a future operational capability reads to decide
 * whether the lifecycle still needs attention.
 */
export function lifecycleOngoingOf(decision: LifecycleDecision): boolean | null {
  return decision.kind === "none" ? null : decision.ongoing;
}

/**
 * The SOURCE {@link ResolutionState} a lifecycle decision governed (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the resolution state the runtime folds onto the ledger row so the lifecycle is
 * self-describing about the resolution disposition it governs.
 */
export function lifecycleResolutionStateOf(decision: LifecycleDecision): ResolutionState | null {
  return decision.kind === "none" ? null : decision.resolution_state;
}
