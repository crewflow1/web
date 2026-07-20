// =====================================================================
// THE CONVERSATION COORDINATION ENGINE — PURE CORE (CEO Directive #018; R36: CONVERSATION COORDINATION ENGINE).
//
// R17–R25 built the DERIVING stack; R26 RESOLVES an outcome, R27 PREPARES an action, R28 DECIDES an execution's
// eligibility, R29 DETERMINES whether that decided execution requires APPROVAL, R30 PERFORMS the approved internal
// business operation (booking fulfilment), R31 VERIFIES that performed operation, R32 DETERMINES the RECOVERY that
// verdict warrants, R33 DETERMINES the RESOLUTION that recovery implies, R34 GOVERNS the LIFECYCLE that resolution
// comes to rest in, and R35 ORCHESTRATES that governed lifecycle — routing it to the platform capability that should
// respond. R36 is the NEXT — and, in this stack, the SIXTH engine that does not perform: the single, canonical
// authority over a SEVENTEENTH question, one derived from the Orchestration Decision above it — "given an orchestration
// the stack ROUTED, HOW should the platform's capabilities be COORDINATED to respond, and WHICH should PARTICIPATE?" —
// the COORDINATION DECISION. Lifecycle-response coordination is the FIRST coordination type expressed here —
// `coordinate_lifecycle_response`, the coordination of an orchestrated lifecycle response across the capabilities that
// should participate in it — but it is one member of the coordination vocabulary, not the engine's purpose.
//
// IT COORDINATES WORK — IT NEVER EXECUTES WORK. Unlike R30 (whose decision is the GO-AHEAD to carry out an approved
// operation), the Coordination Engine's decision performs NO work: it determines a {@link CoordinationMode} (finalising
// / remediating / escalating) and the {@link CoordinationParticipant}s that should participate (led by a
// {@link CoordinationParticipant} lead), and reports WHETHER the coordinated response requires a human and WHETHER it is
// autonomous. It concludes nothing, recovers nothing, escalates nothing, enqueues nothing, notifies no one, re-books
// nothing, retries nothing, schedules nothing and reaches no provider. It is the layer that turns R35's ROUTED
// orchestration into an auditable, single-authority COORDINATION plan — the coordination a future, explicitly-authorised
// operational capability (a queue, a dashboard, an automation) reads to know how the platform's capabilities should be
// coordinated to respond to a conversation. Operational work queues, dashboard UI, notification delivery, automatic
// retries and automatic scheduling are EXPLICIT R36 non-goals: this engine says HOW capabilities should be coordinated
// and WHICH should participate, never ACTS to carry it out.
//
// THE ORCHESTRATION ENGINE REMAINS AUTHORITATIVE — THE COORDINATION ENGINE CONSUMES ITS DECISION, IT NEVER RE-DERIVES IT.
// {@link resolveConversationCoordination} takes the R35 {@link OrchestrationDecision} as its ONLY input, and its FIRST
// gate DEFERS: when the Orchestration Engine rendered NO decision (an abstention — nothing was governed, so no lifecycle
// was routed, so there is nothing to coordinate), the Coordination Engine stands down (`no_orchestration_decision`). The
// lead participant is R35's OWN routed {@link OrchestrationTarget}, CONSUMED (never recomputed) — the Coordination Engine
// reads the routing and builds the participation plan around it, it never re-routes. Because a decided orchestration only
// exists when R35 routed a DECIDED lifecycle (which only exists when R34 governed a DECIDED resolution, which only exists
// when R33 classified a DECIDED recovery, which only exists when R32 classified a DECIDED verification, which only exists
// when R31 reconciled a DECIDED fulfilment, which needs the approved R30 go-ahead, the approved R29 authorisation, the
// R28 execution, the R27 action and the R26 outcome), deferring to the Orchestration Engine here TRANSITIVELY preserves
// the Lifecycle, Resolution, Recovery, Verification, Fulfilment, Authorisation, Execution, Action and Outcome Engines'
// authority too. The orchestration ROUTE and TARGET are NEVER recomputed here: they are the orchestration decision's own
// findings, handed in — this engine READS the routing, it never re-orchestrates. No duplicate orchestration logic; no
// duplicate coordination logic.
//
// HUMAN REVIEW & POLICY STAY MANDATORY — TRANSITIVELY, THROUGH THE ORCHESTRATION IT CONSUMES. A decided orchestration
// exists ONLY for a DECIDED lifecycle, which exists ONLY for a DECIDED resolution, which exists ONLY for a DECIDED
// recovery, which exists ONLY for a DECIDED verification, which exists ONLY for an APPROVED authorisation (R35's
// inherited gate, R34's, R33's, R32's, R31's, R30's keystone), which arises ONLY from the EXISTING Human Review
// architecture (R14's `receptionist_review_resolutions`, a `sent` resolution, folded to `approved` by R29) and can NEVER
// exist for a policy-blocked booking (foreclosed at R29, never revivable). So the Coordination Engine coordinates ONLY
// for human-approved, policy-cleared, verified, recovered, resolved, governed, orchestrated operations — by construction,
// without importing a policy module or recording a grant. This engine imports NO policy surface and names NO guardrail
// decision function.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND COORDINATES NOTHING ITSELF. Like R26–R35, the coordination
// DECISION is a TOTAL, DETERMINISTIC function of an already-computed input — the R35 orchestration decision. The pure
// core adds NO column and NO migration, reaches NO provider, NO ledger, NO DB, NO clock, NO RNG, NO org lookup, NO env
// read and — the cardinal rule shared with the whole stack — NO MODEL: the same orchestration decision always yields the
// same coordination decision. WHETHER a coordination is recorded (the orchestration read and the record filed) and
// IDEMPOTENTLY recorded is the server runtime's job, behind its own append-only, service-role-only, idempotent ledger.
// The pure core names the mode and the participants and stops.
//
// EXPLICIT R36 NON-GOALS no layer here performs: operational work queues, dashboard UI, notification delivery, automatic
// retries, scheduling, quote fulfilment, customer promotion, memory retrieval, customer-portal conversations, and voice
// / WhatsApp / email. The "coordination" R36 performs is the INTERNAL determination — the durable, auditable plan for
// how a routed orchestration's response should be coordinated across the capabilities that should participate
// (finalising→conversation_conclusion / remediating→recovery_handling / escalating→human_attention) — which is the
// coordination future, explicitly-authorised operational capabilities read to know how to coordinate a response.
// =====================================================================

import {
  isOrchestrationDecided,
  type OrchestrationDecision,
  type OrchestrateLifecycleResponseDecision,
  type OrchestrationRoute,
  type OrchestrationTarget,
  type ConversationOrchestrationType,
} from "@/lib/receptionist/conversation-orchestration";

// ---------------------------------------------------------------------
// The COORDINATION vocabulary — the closed set of coordination types, outcomes, modes and participants.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of COORDINATION TYPES — the kinds of routed orchestration this engine can coordinate into a
 * participation plan. R36 ships exactly ONE:
 *   • coordinate_lifecycle_response — the coordination of an `orchestrate_lifecycle_response` orchestration into the
 *                                     participation plan for the capabilities that should respond. It COORDINATES the
 *                                     response; it never concludes, recovers, escalates, enqueues, notifies, re-books,
 *                                     retries, schedules or reaches a comms provider (all EXPLICIT R36 non-goals).
 * Quote-response coordination, promotion coordination and every future coordination type are EXPLICIT R36 non-goals, so
 * their coordination types are deliberately ABSENT — a future increment ADDS them here (and to the ledger's CHECK) as an
 * explicit, reviewable act. A closed const tuple, so {@link ConversationCoordinationType} is exactly these members and a
 * consumer can switch exhaustively.
 */
export const COORDINATION_TYPES = ["coordinate_lifecycle_response"] as const;

/** One coordination type the engine can coordinate. */
export type ConversationCoordinationType = (typeof COORDINATION_TYPES)[number];

/**
 * The closed vocabulary of COORDINATION OUTCOMES — the COORDINATED result of running a coordination. R36 ships exactly
 * ONE:
 *   • conversation_response_coordinated — a participation plan was coordinated for the orchestrated conversation. This is
 *                                         the INTERNAL operation R36 performs: the durable record that a coordination was
 *                                         carried out. HOW the response is coordinated (the mode) and WHICH capabilities
 *                                         participate (the lead + count, and whether a human is required / it is
 *                                         autonomous) is the separate {@link CoordinationMode} +
 *                                         {@link CoordinationParticipant} + coherent projections. The outcome says "a
 *                                         response was coordinated"; the mode says "how"; the participants say "by which
 *                                         capabilities".
 * A closed union so a consumer can switch exhaustively over every coordinated result.
 */
export type CoordinationOutcome = "conversation_response_coordinated";

/**
 * The closed vocabulary of COORDINATION PARTICIPANTS — the platform capability that should PARTICIPATE in the coordinated
 * response to a conversation. This is a primary answer to the canonical question Directive #018 R36 makes the engine the
 * single authority over — "which platform capabilities should be coordinated?":
 *   • conversation_conclusion — the orchestration routed to `conversation_conclusion` (a `conclude` route; the lifecycle
 *                               was `closed`). The capability that should participate is CONCLUSION: the conversation is
 *                               done, so the conclusion capability leads the coordinated response. R36 only COORDINATES
 *                               here; it concludes nothing.
 *   • recovery_handling       — the orchestration routed to `recovery_handling` (a `recover` route; the lifecycle was
 *                               `retained`). The capability that should participate is RECOVERY HANDLING: a clear recovery
 *                               path exists, so the recovery-handling capability leads the coordinated response. R36 only
 *                               COORDINATES here; it recovers nothing, retries nothing, schedules nothing.
 *   • human_attention         — the orchestration routed to `human_attention` (an `escalate` route; the lifecycle was
 *                               `escalated`). The capability that should participate is HUMAN ATTENTION: the record is
 *                               ambiguous, so a human leads the coordinated response. R36 only COORDINATES here; it
 *                               enqueues nothing, notifies no one, pages no one (operational work queues and notification
 *                               delivery are EXPLICIT R36 non-goals).
 * A closed union so the participant is exhaustive. The lead participant is CONSUMED from R35's routed
 * {@link OrchestrationTarget} — never recomputed here. Naming a capability is NOT invoking it — the participant is the
 * identifier of who should participate, read by a future consumer, never called here.
 */
export type CoordinationParticipant =
  | "conversation_conclusion"
  | "recovery_handling"
  | "human_attention";

/**
 * The closed vocabulary of COORDINATION MODES — the MANNER in which the platform's capabilities are coordinated to
 * respond. This is R36's OWN contribution — the "how" a future operational capability reads to know the nature of the
 * coordinated interaction, though R36 itself does none of it:
 *   • finalising  — the response is coordinated to FINALISE the conversation (from a `conclude` route). The conversation
 *                   is complete; the coordination finalises it. R36 records the mode; it finalises nothing.
 *   • remediating — the response is coordinated to REMEDIATE (from a `recover` route). A clear recovery path exists; the
 *                   coordination remediates it. R36 records the mode; it remediates nothing.
 *   • escalating  — the response is coordinated to ESCALATE (from an `escalate` route). The record is ambiguous; the
 *                   coordination escalates it to a human. R36 records the mode; it escalates nothing and pages no one.
 * A closed union so the mode is exhaustive, and a TOTAL, DETERMINISTIC fold of the R35 {@link OrchestrationRoute}. The
 * mode and the lead participant are 1:1 (finalising⇒conversation_conclusion, remediating⇒recovery_handling,
 * escalating⇒human_attention); both are first-class so the decision records BOTH the coordination manner and the
 * capability it centres on.
 */
export type CoordinationMode = "finalising" | "remediating" | "escalating";

/**
 * The orchestration-type → coordination-type mapping — which COORDINATION TYPE each decided
 * {@link ConversationOrchestrationType} is coordinated as, or `null` when the orchestration type has no R36 coordination.
 * TOTAL over the whole orchestration vocabulary — the `Record` type makes the exhaustiveness a COMPILE-TIME guarantee, so
 * this map and the R35 orchestration vocabulary can never drift (a new orchestration type cannot be added without
 * deciding its coordination here). R35 ships `orchestrate_lifecycle_response`, which maps to
 * `coordinate_lifecycle_response`; a future orchestration type maps to its own coordination type (or `null` until one is
 * added) as an explicit, reviewable act.
 */
export const ORCHESTRATION_COORDINATION: Readonly<
  Record<ConversationOrchestrationType, ConversationCoordinationType | null>
> = {
  orchestrate_lifecycle_response: "coordinate_lifecycle_response",
};

// ---------------------------------------------------------------------
// The COORDINATION model — the coordinated coordination decision for an orchestration.
// ---------------------------------------------------------------------

/**
 * The EXPECTED booking a coordination is planned for — carried through, BY REFERENCE, from the R35 orchestration decision
 * (which itself carried it from the R34 lifecycle decision, from the R33 resolution decision, from the R32 recovery
 * decision, from the R31 verification decision, from the R30 fulfilment decision). Referenced via indexed access so this
 * core's ONLY import stays the orchestration surface it consumes — the booking type is the orchestration decision's own,
 * never re-modelled here.
 */
export type CoordinationBooking = OrchestrateLifecycleResponseDecision["booking"];

/**
 * The SOURCE lifecycle state a coordination is planned for — carried through, BY REFERENCE, from the R35 orchestration
 * decision. Referenced via indexed access so this core's ONLY import stays the orchestration surface it consumes — the
 * lifecycle-state type is the orchestration decision's own, never re-modelled here.
 */
export type CoordinationLifecycleState = OrchestrateLifecycleResponseDecision["lifecycle_state"];

/**
 * The COORDINATE-LIFECYCLE-RESPONSE decision — the first (and only R36) coordination decision. It is the auditable
 * determination of coordinating an orchestrated lifecycle response, carrying the coordinated {@link CoordinationOutcome}
 * (`conversation_response_coordinated`), the {@link CoordinationMode} by which the response is coordinated (`finalising`
 * / `remediating` / `escalating`), the `lead_participant` {@link CoordinationParticipant} that leads it (CONSUMED from
 * R35's routed target: `conversation_conclusion` / `recovery_handling` / `human_attention`), the `participants` list and
 * its `participant_count` (the participation plan — a single-capability plan for the first, lifecycle implementation),
 * the `requires_human` flag (true iff the lead is `human_attention`), the `autonomous` flag (true iff it is NOT), the
 * SOURCE {@link OrchestrationRoute} and {@link OrchestrationTarget} it coordinates (for audit + coherence), the SOURCE
 * {@link CoordinationLifecycleState} (for the full-chain record) and the EXPECTED {@link CoordinationBooking} payload
 * (what the coordination concerns), so the decision is self-describing for the coordination ledger. It is emitted ONLY
 * for a DECIDED `orchestrate_lifecycle_response` orchestration — it can carry no other orchestration, and it cannot exist
 * without a routed orchestration to coordinate.
 */
export type CoordinateLifecycleResponseDecision = {
  readonly kind: "coordinate_lifecycle_response";
  readonly outcome: CoordinationOutcome;
  readonly mode: CoordinationMode;
  readonly lead_participant: CoordinationParticipant;
  readonly participants: readonly CoordinationParticipant[];
  readonly participant_count: number;
  readonly requires_human: boolean;
  readonly autonomous: boolean;
  readonly orchestration_route: OrchestrationRoute;
  readonly orchestration_target: OrchestrationTarget;
  readonly lifecycle_state: CoordinationLifecycleState;
  readonly booking: CoordinationBooking;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine coordinated NO response. An abstention is not an error;
 * it is the honest "no coordination to plan here" for the overwhelming majority of turns:
 *   • no_orchestration_decision — the R35 Orchestration Engine rendered NO decision (an abstention — nothing was governed,
 *                                 so no lifecycle was routed). There is nothing to coordinate, so the Coordination Engine
 *                                 defers. This is the FIRST gate — the Orchestration Engine (and transitively Lifecycle,
 *                                 Resolution, Recovery, Verification, Fulfilment, Authorisation, Execution, Action and
 *                                 Outcome) stays authoritative.
 *   • unsupported_orchestration — an orchestration WAS decided, but its type maps to no R36 coordination type (defence in
 *                                 depth: R35 ships only `orchestrate_lifecycle_response`, which maps to
 *                                 `coordinate_lifecycle_response`, so this is unreachable today; it becomes live only if a
 *                                 future orchestration type is added to R35 without a matching coordination type here).
 * A closed union so {@link CoordinationDecision}'s abstention arm is exhaustive. NOTE: an `escalating` coordination is NOT
 * an abstention — it is a `requires_human = true` coordinated plan on a produced coordination decision (an ambiguous
 * conversation warrants a human-led coordinated response, and the coordination is still filed).
 */
export type CoordinationAbstention = "no_orchestration_decision" | "unsupported_orchestration";

/**
 * The conversational COORDINATION DECISION — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link CoordinateLifecycleResponseDecision}, and future coordination types) — the auditable
 *     determination of a coordination, carrying the {@link CoordinationMode}, the lead {@link CoordinationParticipant},
 *     the participation plan and the `requires_human` / `autonomous` flags. Its `kind` IS its
 *     {@link ConversationCoordinationType}. A decided arm is produced for a `finalising`, a `remediating` and an
 *     `escalating` mode alike — the mode differs, not the presence of a coordination.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no coordination, tagged with WHY
 *     ({@link CoordinationAbstention}). The overwhelmingly common case (every turn that was not a decided orchestration).
 *     NOTE the distinct uses: the abstention arm's `kind: "none"` means "no coordination"; a decided arm's
 *     `mode: "escalating"` means "a coordination that escalates the response to a human".
 * Every field is a total, deterministic function of the orchestration decision; the whole object is derived, never
 * persisted or executed by this core.
 */
export type CoordinationDecision =
  | CoordinateLifecycleResponseDecision
  | { readonly kind: "none"; readonly reason: CoordinationAbstention };

// ---------------------------------------------------------------------
// COORDINATION — the single derived coordination decision. Defers to the orchestration; total over the input.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no coordination". */
function abstain(reason: CoordinationAbstention): CoordinationDecision {
  return { kind: "none", reason };
}

/**
 * The COORDINATION MODE for an orchestration route — the deterministic fold at the heart of the engine. A `conclude`
 * route means the conversation is complete, so the response is coordinated to FINALISE (`finalising`); a `recover` route
 * means a clear recovery path exists, so the response is coordinated to REMEDIATE (`remediating`); an `escalate` route
 * means the record is ambiguous, so the response is coordinated to ESCALATE (`escalating`). A closed switch, so adding an
 * {@link OrchestrationRoute} member without folding it here fails `tsc`.
 */
function modeOf(route: OrchestrationRoute): CoordinationMode {
  switch (route) {
    case "conclude":
      return "finalising";
    case "recover":
      return "remediating";
    case "escalate":
      return "escalating";
  }
}

/**
 * Resolve the COORDINATION DECISION for an orchestration — THE single entry point the runtime reads. Consumes the one
 * already-computed input it coordinates over: the R35 `orchestration` decision (the DEFERRAL gate — when the
 * Orchestration Engine rendered no decision, the Coordination Engine stands down).
 *
 * Pure, TOTAL over any orchestration decision, and DETERMINISTIC — the same orchestration always yields the same
 * coordination decision. The Orchestration Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to
 * Lifecycle, Resolution, Recovery, Verification, Fulfilment, Authorisation, Execution, Action and Outcome), and the lead
 * participant is R35's OWN routed target, CONSUMED not recomputed. Human Review and Policy stay MANDATORY: a decided
 * orchestration only exists for a human-approved, policy-cleared, verified, recovered, resolved, governed, routed
 * operation, so this engine coordinates for nothing else — without importing a policy module or recording a grant.
 * Persists NOTHING and coordinates NOTHING itself — the runtime reads the orchestration and IDEMPOTENTLY records the
 * coordination. THE single source of truth for how a conversation's response should be coordinated and by which
 * capabilities — every consumer routes it through this function and no other way; no feature implements independent
 * coordination logic.
 */
export function resolveConversationCoordination(orchestration: OrchestrationDecision): CoordinationDecision {
  // THE ORCHESTRATION ENGINE IS AUTHORITATIVE. If R35 rendered NO decision (an abstention — nothing was governed, so no
  // lifecycle was routed, so nothing to coordinate), the Coordination Engine defers. This is the first thing the engine
  // checks — it CONSUMES the orchestration decision, it never overrides it. Because a decided orchestration exists ONLY
  // when R35 routed a decided lifecycle (which needs a decided R34 lifecycle, a decided R33 resolution, a decided R32
  // recovery, a decided R31 verification, the decided R30 go-ahead, the approved R29 authorisation, the R28 execution,
  // the R27 action and the R26 outcome), deferring here transitively preserves the whole stack's authority.
  if (!isOrchestrationDecided(orchestration)) return abstain("no_orchestration_decision");

  // The decided orchestration selects its coordination type. R35 ships only `orchestrate_lifecycle_response` (→
  // `coordinate_lifecycle_response`); a null here would mean a future orchestration type reached this engine before its
  // coordination type was added — defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const coordinationType = ORCHESTRATION_COORDINATION[orchestration.kind];
  if (coordinationType === null) return abstain("unsupported_orchestration");

  // Render the coordination — the WORK this engine performs. A closed switch keeps this exhaustive as the vocabulary
  // grows: adding a COORDINATION_TYPE without a case here fails `tsc`. The mode (`finalising` / `remediating` /
  // `escalating`) is the fold of the orchestration route; the lead participant (`conversation_conclusion` /
  // `recovery_handling` / `human_attention`) is CONSUMED from R35's routed target; the decision is produced for ALL three
  // modes — coordinating that a `remediating` conversation centres on recovery handling and an `escalating` one on human
  // attention (and that a `finalising` one centres on conclusion) is the whole purpose of the engine.
  switch (coordinationType) {
    case "coordinate_lifecycle_response": {
      // The mode is the deterministic fold of R35's OWN orchestration route; the lead participant is R35's OWN routed
      // target, CONSUMED not recomputed (the Orchestration Engine stays authoritative over WHICH capability the response
      // centres on — the Coordination Engine only builds the participation plan around it). For the first, lifecycle
      // implementation the plan is single-capability (exactly the lead participates), so `participants` is the singleton
      // `[lead]` and `participant_count` is 1 — the model supports a larger plan for future coordination types, but the
      // lifecycle plan is honestly one. `requires_human` and `autonomous` are the coherent companions of the lead (a
      // human is required iff the lead is `human_attention`; it is autonomous iff it is NOT). These answer Directive #018
      // R36's questions — "how should the response be coordinated?" and "which capabilities should participate?" and
      // "does it require a human / is it autonomous?" — so all are first-class, coherence-pinned fields, not one derived
      // silently from another. The orchestration route + target and the expected booking are carried through by reference
      // — so the coordination record is self-describing about the routing it coordinates, and can never drift from the
      // orchestration (or the lifecycle, or the resolution, or the recovery, or the verification, or the fulfilment) it
      // coordinates.
      const mode = modeOf(orchestration.route);
      const lead = orchestration.target;
      return {
        kind: "coordinate_lifecycle_response",
        outcome: "conversation_response_coordinated",
        mode,
        lead_participant: lead,
        participants: [lead],
        participant_count: 1,
        requires_human: lead === "human_attention",
        autonomous: lead !== "human_attention",
        orchestration_route: orchestration.route,
        orchestration_target: orchestration.target,
        lifecycle_state: orchestration.lifecycle_state,
        booking: orchestration.booking,
      };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a produced coordination), as opposed to an abstention. A type guard: it narrows a
 * {@link CoordinationDecision} to its decided arms, so the runtime records ONLY a real coordination and an abstention is
 * a total no-op. THE predicate the runtime gates the record on — there is no other "should we coordinate?" rule. NOTE: a
 * decided coordination may carry ANY mode (including `escalating`); "decided" means "a coordination was made", not "the
 * response is autonomous".
 */
export function isCoordinationDecided(
  decision: CoordinationDecision,
): decision is CoordinateLifecycleResponseDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationCoordinationType} of a decision (for audit/persistence keying), or `null` for an abstention.
 * Pure and total — the decided arm's `kind` IS its coordination type, so the mapping is the identity on the decided arms
 * and `null` on the abstention.
 */
export function coordinationTypeOf(
  decision: CoordinationDecision,
): ConversationCoordinationType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link CoordinationOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and
 * total — the coordinated result the runtime folds onto the ledger row alongside the coordination type.
 */
export function coordinationOutcomeOf(decision: CoordinationDecision): CoordinationOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}

/**
 * The {@link CoordinationMode} of a decision (for audit/persistence keying and coordination reporting), or `null` for an
 * abstention. Pure and total — the fold the runtime folds onto the ledger row, and the "how" future operational
 * capabilities read to know the manner of the coordinated response (finalising / remediating / escalating).
 */
export function coordinationModeOf(decision: CoordinationDecision): CoordinationMode | null {
  return decision.kind === "none" ? null : decision.mode;
}

/**
 * The lead {@link CoordinationParticipant} of a decision (for audit/persistence keying and coordination reporting), or
 * `null` for an abstention. Pure and total — the capability the runtime folds onto the ledger row, CONSUMED from R35's
 * routed target, and the capability future operational capabilities read to know which capability leads the coordinated
 * response.
 */
export function coordinationLeadParticipantOf(decision: CoordinationDecision): CoordinationParticipant | null {
  return decision.kind === "none" ? null : decision.lead_participant;
}

/**
 * The {@link CoordinationParticipant} list of a decision (for audit/persistence keying and coordination reporting), or
 * `null` for an abstention. Pure and total — the participation plan future operational capabilities read to know which
 * capabilities participate in the coordinated response (a singleton `[lead]` for the first, lifecycle implementation).
 */
export function coordinationParticipantsOf(
  decision: CoordinationDecision,
): readonly CoordinationParticipant[] | null {
  return decision.kind === "none" ? null : decision.participants;
}

/**
 * The participant COUNT of a decision (for audit/persistence keying), or `null` for an abstention. Pure and total — the
 * cardinality of the participation plan (1 for the first, lifecycle implementation), coherent with the participants list.
 */
export function coordinationParticipantCountOf(decision: CoordinationDecision): number | null {
  return decision.kind === "none" ? null : decision.participant_count;
}

/**
 * Whether a decision's coordinated response REQUIRES A HUMAN (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the coherent companion of the lead (true iff the lead is `human_attention`). This answers
 * Directive #018 R36's question "does the coordinated response require a human?" — the flag a future operational
 * capability reads to decide whether a human must participate.
 */
export function coordinationRequiresHumanOf(decision: CoordinationDecision): boolean | null {
  return decision.kind === "none" ? null : decision.requires_human;
}

/**
 * Whether a decision's coordinated response is AUTONOMOUS (for audit/persistence keying), or `null` for an abstention.
 * Pure and total — the coherent companion of the lead (true iff the lead is NOT `human_attention`). This answers
 * Directive #018 R36's question "is the coordinated response autonomous?" — the flag a future operational capability
 * reads to decide whether a capability can respond without a human.
 */
export function coordinationAutonomousOf(decision: CoordinationDecision): boolean | null {
  return decision.kind === "none" ? null : decision.autonomous;
}

/**
 * The SOURCE {@link CoordinationLifecycleState} a coordination decision coordinated (for audit/persistence keying), or
 * `null` for an abstention. Pure and total — the lifecycle state the runtime folds onto the ledger row so the
 * coordination is self-describing about the full chain (lifecycle → route → mode → participant) it coordinates.
 */
export function coordinationLifecycleStateOf(decision: CoordinationDecision): CoordinationLifecycleState | null {
  return decision.kind === "none" ? null : decision.lifecycle_state;
}
