// =====================================================================
// THE CONVERSATION ORCHESTRATION ENGINE — PURE CORE (CEO Directive #018; R35: CONVERSATION ORCHESTRATION ENGINE).
//
// R17–R25 built the DERIVING stack; R26 RESOLVES an outcome, R27 PREPARES an action, R28 DECIDES an execution's
// eligibility, R29 DETERMINES whether that decided execution requires APPROVAL, R30 PERFORMS the approved internal
// business operation (booking fulfilment), R31 VERIFIES that performed operation, R32 DETERMINES the RECOVERY that
// verdict warrants, R33 DETERMINES the RESOLUTION that recovery implies, and R34 GOVERNS the LIFECYCLE that resolution
// comes to rest in — closing, retaining or escalating the conversation. R35 is the NEXT — and, in this stack, the FIFTH
// engine that does not perform: the single, canonical authority over a SIXTEENTH question, one derived from the
// Lifecycle Decision above it — "given a lifecycle the stack GOVERNED, WHICH platform capability should RESPOND to the
// conversation now, and by WHAT ROUTE?" — the ORCHESTRATION DECISION. Lifecycle-response orchestration is the FIRST
// orchestration type expressed here — `orchestrate_lifecycle_response`, the routing of a governed lifecycle to the
// platform capability that should respond to it — but it is one member of the orchestration vocabulary, not the
// engine's purpose.
//
// IT ROUTES WORK — IT NEVER EXECUTES WORK. Unlike R30 (whose decision is the GO-AHEAD to carry out an approved
// operation), the Orchestration Engine's decision performs NO work: it ROUTES a lifecycle disposition to an
// {@link OrchestrationTarget} (conversation_conclusion / recovery_handling / human_attention) via an
// {@link OrchestrationRoute} (conclude / recover / escalate) and reports WHETHER the conversation's orchestration is
// concluded and WHETHER an active capability response is still routed. It concludes nothing, recovers nothing,
// escalates nothing, enqueues nothing, notifies no one, re-books nothing, retries nothing, schedules nothing and
// reaches no provider. It is the layer that turns R34's governed LIFECYCLE state into an auditable, single-authority
// ROUTING verdict — the routing a future, explicitly-authorised operational capability (a queue, a dashboard, an
// automation) reads to know which capability should respond to a conversation. Human work queues, dashboard UI,
// notification sending, automatic retries and automatic scheduling are EXPLICIT R35 non-goals: this engine says WHICH
// CAPABILITY should respond and by WHAT ROUTE, never ACTS to carry it out.
//
// THE LIFECYCLE ENGINE REMAINS AUTHORITATIVE — THE ORCHESTRATION ENGINE CONSUMES ITS DECISION, IT NEVER RE-DERIVES IT.
// {@link resolveConversationOrchestration} takes the R34 {@link LifecycleDecision} as its ONLY input, and its FIRST gate
// DEFERS: when the Lifecycle Engine rendered NO decision (an abstention — nothing was resolved, so no lifecycle was
// governed, so there is nothing to orchestrate), the Orchestration Engine stands down (`no_lifecycle_decision`). Because
// a decided lifecycle only exists when R34 governed a DECIDED resolution (which only exists when R33 classified a DECIDED
// recovery, which only exists when R32 classified a DECIDED verification, which only exists when R31 reconciled a DECIDED
// fulfilment, which needs the approved R30 go-ahead, the approved R29 authorisation, the R28 execution, the R27 action
// and the R26 outcome), deferring to the Lifecycle Engine here TRANSITIVELY preserves the Resolution, Recovery,
// Verification, Fulfilment, Authorisation, Execution, Action and Outcome Engines' authority too. The lifecycle STATE is
// NEVER recomputed here: it is the lifecycle decision's own finding, handed in — this engine READS the disposition, it
// never re-governs. No duplicate lifecycle logic; no duplicate orchestration logic.
//
// HUMAN REVIEW & POLICY STAY MANDATORY — TRANSITIVELY, THROUGH THE LIFECYCLE IT CONSUMES. A decided lifecycle exists ONLY
// for a DECIDED resolution, which exists ONLY for a DECIDED recovery, which exists ONLY for a DECIDED verification, which
// exists ONLY for an APPROVED authorisation (R34's inherited gate, R33's, R32's, R31's, R30's keystone), which arises
// ONLY from the EXISTING Human Review architecture (R14's `receptionist_review_resolutions`, a `sent` resolution, folded
// to `approved` by R29) and can NEVER exist for a policy-blocked booking (foreclosed at R29, never revivable). So the
// Orchestration Engine routes ONLY for human-approved, policy-cleared, verified, recovered, resolved, governed
// operations — by construction, without importing a policy module or recording a grant. This engine imports NO policy
// surface and names NO guardrail decision function.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND ROUTES NOTHING ITSELF. Like R26–R34, the orchestration
// DECISION is a TOTAL, DETERMINISTIC function of an already-computed input — the R34 lifecycle decision. The pure core
// adds NO column and NO migration, reaches NO provider, NO ledger, NO DB, NO clock, NO RNG, NO org lookup, NO env read
// and — the cardinal rule shared with the whole stack — NO MODEL: the same lifecycle decision always yields the same
// orchestration decision. WHETHER an orchestration is recorded (the lifecycle read and the record filed) and IDEMPOTENTLY
// recorded is the server runtime's job, behind its own append-only, service-role-only, idempotent ledger. The pure core
// names the route and the target and stops.
//
// EXPLICIT R35 NON-GOALS no layer here performs: human work queues, dashboard UI, notification sending, automatic
// retries, scheduling, quote fulfilment, customer promotion, memory retrieval, customer-portal conversations, and voice
// / WhatsApp / email. The "orchestration" R35 performs is the INTERNAL determination — the durable, auditable routing of
// a governed lifecycle to the capability that should respond (conclude→conversation_conclusion /
// recover→recovery_handling / escalate→human_attention) — which is the routing future, explicitly-authorised
// operational capabilities read to know which capability should respond to a conversation.
// =====================================================================

import {
  isLifecycleDecided,
  type LifecycleDecision,
  type GovernResolutionLifecycleDecision,
  type LifecycleState,
  type ConversationLifecycleType,
} from "@/lib/receptionist/conversation-lifecycle";

// ---------------------------------------------------------------------
// The ORCHESTRATION vocabulary — the closed set of orchestration types, outcomes, routes and targets.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of ORCHESTRATION TYPES — the kinds of governed lifecycle this engine can route to a responding
 * capability. R35 ships exactly ONE:
 *   • orchestrate_lifecycle_response — the routing of a governed `govern_resolution_lifecycle` lifecycle to the platform
 *                                      capability that should respond to it. It ROUTES the response; it never concludes,
 *                                      recovers, escalates, enqueues, notifies, re-books, retries, schedules or reaches a
 *                                      comms provider (all EXPLICIT R35 non-goals).
 * Quote-response orchestration, promotion orchestration and every future orchestration type are EXPLICIT R35 non-goals,
 * so their orchestration types are deliberately ABSENT — a future increment ADDS them here (and to the ledger's CHECK)
 * as an explicit, reviewable act. A closed const tuple, so {@link ConversationOrchestrationType} is exactly these members
 * and a consumer can switch exhaustively.
 */
export const ORCHESTRATION_TYPES = ["orchestrate_lifecycle_response"] as const;

/** One orchestration type the engine can route. */
export type ConversationOrchestrationType = (typeof ORCHESTRATION_TYPES)[number];

/**
 * The closed vocabulary of ORCHESTRATION OUTCOMES — the ROUTED result of running an orchestration. R35 ships exactly
 * ONE:
 *   • conversation_response_orchestrated — a responding capability was routed for the governed conversation. This is the
 *                                          INTERNAL operation R35 performs: the durable record that an orchestration was
 *                                          carried out. WHICH capability (and by what route, and whether the conversation
 *                                          is concluded / active) is the separate {@link OrchestrationRoute} +
 *                                          {@link OrchestrationTarget} + coherent projections. The outcome says "a
 *                                          response was orchestrated"; the route says "to which capability".
 * A closed union so a consumer can switch exhaustively over every orchestrated result.
 */
export type OrchestrationOutcome = "conversation_response_orchestrated";

/**
 * The closed vocabulary of ORCHESTRATION TARGETS — the platform capability that should RESPOND to a governed
 * conversation. This is the primary answer to the canonical question Directive #018 R35 makes the engine the single
 * authority over — "which platform capability should respond?":
 *   • conversation_conclusion — the lifecycle was `closed` (a `terminal` resolution; the operation completed correctly).
 *                               The capability that should respond is CONCLUSION: the conversation is done, so the
 *                               conclusion capability records it complete. An orchestration is still filed (a response
 *                               was considered and routed to conclusion). R35 only ROUTES here; it concludes nothing.
 *   • recovery_handling       — the lifecycle was `retained` (a `recoverable` resolution; an approved operation with no
 *                               record). The capability that should respond is RECOVERY HANDLING: a clear recovery path
 *                               exists, so the recovery-handling capability should act on it. R35 only ROUTES here; it
 *                               recovers nothing, retries nothing, schedules nothing.
 *   • human_attention         — the lifecycle was `escalated` (an `unresolved` resolution; a divergent record). The
 *                               capability that should respond is HUMAN ATTENTION: the truth is ambiguous, so a human
 *                               should attend to it. R35 only ROUTES here; it enqueues nothing, notifies no one, pages no
 *                               one (human work queues and notification sending are EXPLICIT R35 non-goals).
 * A closed union so the target is exhaustive. It is a TOTAL, DETERMINISTIC fold of the {@link OrchestrationRoute} (which
 * is itself the fold of the R34 {@link LifecycleState}). Naming a capability is NOT invoking it — the target is the
 * identifier of who should respond, read by a future consumer, never called here.
 */
export type OrchestrationTarget =
  | "conversation_conclusion"
  | "recovery_handling"
  | "human_attention";

/**
 * The closed vocabulary of ORCHESTRATION ROUTES — the routing VERB by which the conversation is directed to the
 * capability that should respond. This is the operative half of the routing — the "verb" a future operational capability
 * reads to know HOW the conversation is routed, though R35 itself does none of it:
 *   • conclude — CONCLUDE the conversation (from a `closed` lifecycle). The lifecycle is complete; the route is to
 *                conclusion. R35 records the route; it concludes nothing.
 *   • recover  — route to RECOVERY (from a `retained` lifecycle). A clear recovery path exists; the route is to recovery
 *                handling. R35 records the route; it recovers nothing.
 *   • escalate — ESCALATE the conversation (from an `escalated` lifecycle). The record is ambiguous; the route is to
 *                human attention. R35 records the route; it escalates nothing and pages no one.
 * A closed union so the route is exhaustive, and a TOTAL, DETERMINISTIC fold of the R34 {@link LifecycleState}. The route
 * and the target are 1:1 (conclude⇒conversation_conclusion, recover⇒recovery_handling, escalate⇒human_attention); both
 * are first-class so the decision records BOTH the routing verb and the capability it routes to.
 */
export type OrchestrationRoute = "conclude" | "recover" | "escalate";

/**
 * The lifecycle-type → orchestration-type mapping — which ORCHESTRATION TYPE each decided
 * {@link ConversationLifecycleType} is routed as, or `null` when the lifecycle type has no R35 orchestration. TOTAL over
 * the whole lifecycle vocabulary — the `Record` type makes the exhaustiveness a COMPILE-TIME guarantee, so this map and
 * the R34 lifecycle vocabulary can never drift (a new lifecycle type cannot be added without deciding its orchestration
 * here). R34 ships `govern_resolution_lifecycle`, which maps to `orchestrate_lifecycle_response`; a future lifecycle type
 * maps to its own orchestration type (or `null` until one is added) as an explicit, reviewable act.
 */
export const LIFECYCLE_ORCHESTRATION: Readonly<
  Record<ConversationLifecycleType, ConversationOrchestrationType | null>
> = {
  govern_resolution_lifecycle: "orchestrate_lifecycle_response",
};

// ---------------------------------------------------------------------
// The ORCHESTRATION model — the routed orchestration decision for a lifecycle.
// ---------------------------------------------------------------------

/**
 * The EXPECTED booking an orchestration is routed for — carried through, BY REFERENCE, from the R34 lifecycle decision
 * (which itself carried it from the R33 resolution decision, from the R32 recovery decision, from the R31 verification
 * decision, from the R30 fulfilment decision). Referenced via indexed access so this core's ONLY import stays the
 * lifecycle surface it consumes — the booking type is the lifecycle decision's own, never re-modelled here.
 */
export type OrchestrationBooking = GovernResolutionLifecycleDecision["booking"];

/**
 * The ORCHESTRATE-LIFECYCLE-RESPONSE decision — the first (and only R35) orchestration decision. It is the auditable
 * determination of routing a governed lifecycle to the capability that should respond, carrying the orchestrated
 * {@link OrchestrationOutcome} (`conversation_response_orchestrated`), the {@link OrchestrationRoute} by which it is
 * routed (`conclude` / `recover` / `escalate`), the {@link OrchestrationTarget} capability it routes to
 * (`conversation_conclusion` / `recovery_handling` / `human_attention`), the `concluded` flag (true iff the route is
 * `conclude`), the `active` flag (true iff the route is NOT `conclude` — an active capability response is routed), the
 * SOURCE {@link LifecycleState} it routed (for audit + coherence) and the EXPECTED {@link OrchestrationBooking} payload
 * (what the lifecycle concerns), so the decision is self-describing for the orchestration ledger. It is emitted ONLY for
 * a DECIDED `govern_resolution_lifecycle` lifecycle — it can carry no other lifecycle, and it cannot exist without a
 * governed lifecycle to route.
 */
export type OrchestrateLifecycleResponseDecision = {
  readonly kind: "orchestrate_lifecycle_response";
  readonly outcome: OrchestrationOutcome;
  readonly route: OrchestrationRoute;
  readonly target: OrchestrationTarget;
  readonly concluded: boolean;
  readonly active: boolean;
  readonly lifecycle_state: LifecycleState;
  readonly booking: OrchestrationBooking;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine routed NO orchestration. An abstention is not an error;
 * it is the honest "no orchestration to route here" for the overwhelming majority of turns:
 *   • no_lifecycle_decision — the R34 Lifecycle Engine rendered NO decision (an abstention — nothing was resolved, so no
 *                             lifecycle was governed). There is nothing to orchestrate, so the Orchestration Engine
 *                             defers. This is the FIRST gate — the Lifecycle Engine (and transitively Resolution,
 *                             Recovery, Verification, Fulfilment, Authorisation, Execution, Action and Outcome) stays
 *                             authoritative.
 *   • unsupported_lifecycle — a lifecycle WAS decided, but its type maps to no R35 orchestration type (defence in depth:
 *                             R34 ships only `govern_resolution_lifecycle`, which maps to `orchestrate_lifecycle_response`,
 *                             so this is unreachable today; it becomes live only if a future lifecycle type is added to
 *                             R34 without a matching orchestration type here).
 * A closed union so {@link OrchestrationDecision}'s abstention arm is exhaustive. NOTE: `conclude` is NOT an abstention —
 * it is an `active = false` ROUTE on a produced orchestration decision (a terminal, concluded conversation warrants no
 * active capability response, but the orchestration is still filed).
 */
export type OrchestrationAbstention = "no_lifecycle_decision" | "unsupported_lifecycle";

/**
 * The conversational ORCHESTRATION DECISION — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link OrchestrateLifecycleResponseDecision}, and future orchestration types) — the auditable
 *     determination of an orchestration, carrying the {@link OrchestrationRoute}, the {@link OrchestrationTarget} and the
 *     `concluded` / `active` flags. Its `kind` IS its {@link ConversationOrchestrationType}. A decided arm is produced
 *     for a `conclude`, a `recover` and an `escalate` route alike — the route differs, not the presence of an
 *     orchestration.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no orchestration, tagged with WHY
 *     ({@link OrchestrationAbstention}). The overwhelmingly common case (every turn that was not a decided lifecycle).
 *     NOTE the distinct uses: the abstention arm's `kind: "none"` means "no orchestration"; a decided arm's
 *     `route: "conclude"` means "an orchestration that routes the conversation to conclusion".
 * Every field is a total, deterministic function of the lifecycle decision; the whole object is derived, never persisted
 * or executed by this core.
 */
export type OrchestrationDecision =
  | OrchestrateLifecycleResponseDecision
  | { readonly kind: "none"; readonly reason: OrchestrationAbstention };

// ---------------------------------------------------------------------
// ORCHESTRATION — the single derived routing decision. Defers to the lifecycle; total over the input.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no orchestration". */
function abstain(reason: OrchestrationAbstention): OrchestrationDecision {
  return { kind: "none", reason };
}

/**
 * The ORCHESTRATION ROUTE for a lifecycle state — the first half of the deterministic fold at the heart of the engine. A
 * `closed` lifecycle means the conversation is complete, so it is routed to CONCLUDE (`conclude`); a `retained` lifecycle
 * means a clear recovery path exists, so it is routed to RECOVER (`recover`); an `escalated` lifecycle means the record
 * is ambiguous, so it is routed to ESCALATE (`escalate`). A closed switch, so adding a {@link LifecycleState} member
 * without folding it here fails `tsc`.
 */
function routeOf(state: LifecycleState): OrchestrationRoute {
  switch (state) {
    case "closed":
      return "conclude";
    case "retained":
      return "recover";
    case "escalated":
      return "escalate";
  }
}

/**
 * The ORCHESTRATION TARGET for a route — the second half of the deterministic fold. A `conclude` route routes to
 * `conversation_conclusion`, a `recover` route routes to `recovery_handling`, an `escalate` route routes to
 * `human_attention`. The route and the target are 1:1 by construction. A closed switch, so adding an
 * {@link OrchestrationRoute} member without folding it here fails `tsc`.
 */
function targetOf(route: OrchestrationRoute): OrchestrationTarget {
  switch (route) {
    case "conclude":
      return "conversation_conclusion";
    case "recover":
      return "recovery_handling";
    case "escalate":
      return "human_attention";
  }
}

/**
 * Route the ORCHESTRATION DECISION for a lifecycle — THE single entry point the runtime reads. Consumes the one
 * already-computed input it orchestrates over: the R34 `lifecycle` decision (the DEFERRAL gate — when the Lifecycle
 * Engine rendered no decision, the Orchestration Engine stands down).
 *
 * Pure, TOTAL over any lifecycle decision, and DETERMINISTIC — the same lifecycle always yields the same orchestration
 * decision. The Lifecycle Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to Resolution,
 * Recovery, Verification, Fulfilment, Authorisation, Execution, Action and Outcome). Human Review and Policy stay
 * MANDATORY: a decided lifecycle only exists for a human-approved, policy-cleared, verified, recovered, resolved,
 * governed operation, so this engine routes for nothing else — without importing a policy module or recording a grant.
 * Persists NOTHING and routes NOTHING itself — the runtime reads the lifecycle and IDEMPOTENTLY records the
 * orchestration. THE single source of truth for which capability should respond to a conversation and by what route —
 * every consumer routes it through this function and no other way; no feature implements independent orchestration logic.
 */
export function resolveConversationOrchestration(lifecycle: LifecycleDecision): OrchestrationDecision {
  // THE LIFECYCLE ENGINE IS AUTHORITATIVE. If R34 rendered NO decision (an abstention — nothing was resolved, so no
  // lifecycle was governed, so nothing to orchestrate), the Orchestration Engine defers. This is the first thing the
  // engine checks — it CONSUMES the lifecycle decision, it never overrides it. Because a decided lifecycle exists ONLY
  // when R34 governed a decided resolution (which needs a decided R33 resolution, a decided R32 recovery, a decided R31
  // verification, the decided R30 go-ahead, the approved R29 authorisation, the R28 execution, the R27 action and the
  // R26 outcome), deferring here transitively preserves the whole stack's authority.
  if (!isLifecycleDecided(lifecycle)) return abstain("no_lifecycle_decision");

  // The decided lifecycle selects its orchestration type. R34 ships only `govern_resolution_lifecycle` (→
  // `orchestrate_lifecycle_response`); a null here would mean a future lifecycle type reached this engine before its
  // orchestration type was added — defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const orchestrationType = LIFECYCLE_ORCHESTRATION[lifecycle.kind];
  if (orchestrationType === null) return abstain("unsupported_lifecycle");

  // Render the orchestration — the WORK this engine performs. A closed switch keeps this exhaustive as the vocabulary
  // grows: adding an ORCHESTRATION_TYPE without a case here fails `tsc`. The route (`conclude` / `recover` / `escalate`)
  // is the fold of the lifecycle state; the target (`conversation_conclusion` / `recovery_handling` / `human_attention`)
  // is the fold of the route; the decision is produced for ALL three — routing that a `retained` conversation goes to
  // recovery handling and an `escalated` one to human attention (and that a `closed` one goes to conclusion) is the whole
  // purpose of the engine.
  switch (orchestrationType) {
    case "orchestrate_lifecycle_response": {
      // The route is the deterministic fold of the lifecycle's OWN state; the target is the deterministic fold of the
      // route; `concluded` and `active` are their coherent companions (concluded iff the route is `conclude`; active iff
      // it is NOT). These answer Directive #018 R35's questions — "which capability should respond?" and "by what
      // route?" and "is the orchestration concluded / is an active response routed?" — so all are first-class,
      // coherence-pinned fields, not one derived silently from another. The EXPECTED booking is carried through by
      // reference — so the orchestration record is self-describing about what the lifecycle concerns, and can never drift
      // from the lifecycle (or the resolution, or the recovery, or the verification, or the fulfilment) it routes.
      const route = routeOf(lifecycle.state);
      const target = targetOf(route);
      return {
        kind: "orchestrate_lifecycle_response",
        outcome: "conversation_response_orchestrated",
        route,
        target,
        concluded: route === "conclude",
        active: route !== "conclude",
        lifecycle_state: lifecycle.state,
        booking: lifecycle.booking,
      };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a produced orchestration), as opposed to an abstention. A type guard: it narrows an
 * {@link OrchestrationDecision} to its decided arms, so the runtime records ONLY a real orchestration and an abstention
 * is a total no-op. THE predicate the runtime gates the record on — there is no other "should we orchestrate?" rule.
 * NOTE: a decided orchestration may carry ANY route (including `conclude`); "decided" means "an orchestration was made",
 * not "the conversation is concluded".
 */
export function isOrchestrationDecided(
  decision: OrchestrationDecision,
): decision is OrchestrateLifecycleResponseDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationOrchestrationType} of a decision (for audit/persistence keying), or `null` for an abstention.
 * Pure and total — the decided arm's `kind` IS its orchestration type, so the mapping is the identity on the decided
 * arms and `null` on the abstention.
 */
export function orchestrationTypeOf(
  decision: OrchestrationDecision,
): ConversationOrchestrationType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link OrchestrationOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and
 * total — the orchestrated result the runtime folds onto the ledger row alongside the orchestration type.
 */
export function orchestrationOutcomeOf(decision: OrchestrationDecision): OrchestrationOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}

/**
 * The {@link OrchestrationRoute} of a decision (for audit/persistence keying and orchestration reporting), or `null` for
 * an abstention. Pure and total — the fold the runtime folds onto the ledger row, and the operative "verb" future
 * operational capabilities read to know how a conversation is routed (conclude / recover / escalate).
 */
export function orchestrationRouteOf(decision: OrchestrationDecision): OrchestrationRoute | null {
  return decision.kind === "none" ? null : decision.route;
}

/**
 * The {@link OrchestrationTarget} of a decision (for audit/persistence keying and orchestration reporting), or `null` for
 * an abstention. Pure and total — the capability the runtime folds onto the ledger row, and the disposition future
 * operational capabilities read to know which capability should respond to a conversation.
 */
export function orchestrationTargetOf(decision: OrchestrationDecision): OrchestrationTarget | null {
  return decision.kind === "none" ? null : decision.target;
}

/**
 * Whether a decision orchestrated the conversation CONCLUDED (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the coherent companion of the route (true iff the route is `conclude`). This answers
 * Directive #018 R35's question "has the conversation's orchestration concluded?".
 */
export function orchestrationConcludedOf(decision: OrchestrationDecision): boolean | null {
  return decision.kind === "none" ? null : decision.concluded;
}

/**
 * Whether a decision orchestrated an ACTIVE capability response (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the coherent companion of the route (true iff the route is NOT `conclude`). This answers
 * Directive #018 R35's question "does an active capability response remain routed?" — the flag a future operational
 * capability reads to decide whether a capability still needs to respond.
 */
export function orchestrationActiveOf(decision: OrchestrationDecision): boolean | null {
  return decision.kind === "none" ? null : decision.active;
}

/**
 * The SOURCE {@link LifecycleState} an orchestration decision routed (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the lifecycle state the runtime folds onto the ledger row so the orchestration is
 * self-describing about the lifecycle disposition it routes.
 */
export function orchestrationLifecycleStateOf(decision: OrchestrationDecision): LifecycleState | null {
  return decision.kind === "none" ? null : decision.lifecycle_state;
}
