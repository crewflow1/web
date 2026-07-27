import { describe, it, expect } from "vitest";
import {
  ORCHESTRATION_TYPES,
  LIFECYCLE_ORCHESTRATION,
  resolveConversationOrchestration,
  isOrchestrationDecided,
  orchestrationTypeOf,
  orchestrationOutcomeOf,
  orchestrationRouteOf,
  orchestrationTargetOf,
  orchestrationConcludedOf,
  orchestrationActiveOf,
  orchestrationLifecycleStateOf,
  type ConversationOrchestrationType,
  type OrchestrationOutcome,
  type OrchestrationRoute,
  type OrchestrationTarget,
  type OrchestrationDecision,
  type OrchestrateLifecycleResponseDecision,
  type OrchestrationAbstention,
} from "@/lib/receptionist/conversation-orchestration";
import {
  LIFECYCLE_TYPES,
  resolveConversationLifecycle,
  isLifecycleDecided,
  type ConversationLifecycleType,
  type LifecycleState,
  type LifecycleDecision,
  type GovernResolutionLifecycleDecision,
} from "@/lib/receptionist/conversation-lifecycle";
import {
  resolveConversationResolution,
  isResolutionDecided,
  type ResolveBookingRecoveryDecision,
} from "@/lib/receptionist/conversation-resolution";
import {
  resolveRecovery,
  isRecoveryDecided,
  type RecoverBookingDecision,
} from "@/lib/receptionist/conversation-recovery";
import {
  resolveVerification,
  isVerificationDecided,
  type VerifyBookingDecision,
  type RecordedFulfilmentSnapshot,
} from "@/lib/receptionist/conversation-verification";
import {
  resolveFulfilment,
  isFulfilmentDecided,
  type FulfilmentDecision,
  type FulfilBookingDecision,
} from "@/lib/receptionist/conversation-fulfilment";
import {
  resolveAuthorisation,
  deriveAuthorisationState,
  isAuthorisationDecided,
  type ApproveBookingAuthorisation,
  type AuthorisationOpeningState,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import {
  resolveAction,
  type ActionResolution,
  type PrepareBookingAction,
} from "@/lib/receptionist/conversation-action";
import { resolveOutcome } from "@/lib/receptionist/conversation-outcome";
import { CONVERSATION_GOALS, type ConversationGoal } from "@/lib/receptionist/conversation-goal";
import {
  STRATEGY_PRIORITY,
  resolveStrategy,
  type ConversationStrategy,
} from "@/lib/receptionist/conversation-strategy";
import { detectGap } from "@/lib/receptionist/conversation-gap";
import type { ConversationInformation } from "@/lib/receptionist/conversation-information";
import { GUARDRAIL_VERDICTS } from "@/lib/receptionist/policy";

/**
 * THE CONVERSATION ORCHESTRATION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R35 — CONVERSATION ORCHESTRATION ENGINE).
 *
 * lib/receptionist/conversation-orchestration.ts is the deterministic, leaf authority over the FIFTH layer that does not
 * perform: "given a lifecycle the stack GOVERNED, WHICH platform capability should RESPOND to the conversation now, and
 * by WHAT ROUTE?". It is a TOTAL, DETERMINISTIC function of ONE already-computed input — the R34 lifecycle decision (the
 * DEFERRAL gate) — so it is exhaustively unit-testable in isolation. Every lifecycle fed in is the REAL
 * {@link resolveConversationLifecycle} over the REAL R33 {@link resolveConversationResolution} / R32
 * {@link resolveRecovery} / R31 {@link resolveVerification} / R30 {@link resolveFulfilment} / R29
 * {@link resolveAuthorisation} / R28 {@link resolveExecution} stack with the grant folded by R29's OWN
 * {@link deriveAuthorisationState} — so the engine is proven against genuine composition, never a hand-built decision.
 * These tests pin, EXHAUSTIVELY:
 *   • ORCHESTRATION_TYPES is the closed orchestration vocabulary — exactly `orchestrate_lifecycle_response` in R35, no
 *     dupes;
 *   • LIFECYCLE_ORCHESTRATION is TOTAL over the R34 lifecycle vocabulary and maps govern_resolution_lifecycle →
 *     orchestrate_lifecycle_response (so a future lifecycle type cannot silently reach the engine unrouted);
 *   • resolveConversationOrchestration DEFERS `no_lifecycle_decision` whenever the Lifecycle Engine abstained — the FIRST
 *     gate, so the Lifecycle Engine (and transitively Resolution, Recovery, Verification, Fulfilment, Authorisation,
 *     Execution, Action and Outcome) stays authoritative;
 *   • THE TWO-STAGE FOLD — a decided lifecycle folds to a `conclude` route when `closed`, `recover` when `retained`, and
 *     `escalate` when `escalated`; the route folds to `conversation_conclusion` / `recovery_handling` / `human_attention`
 *     respectively — and a decision is PRODUCED for all three (`conclude` is an orchestration that routes the conversation
 *     to conclusion, NOT an abstention);
 *   • THE KEYSTONE — `concluded` is TRUE iff the route is `conclude`, and `active` is TRUE iff it is NOT, on every decided
 *     orchestration (Directive #018 R35's two distinct questions, made coherent);
 *   • the orchestrate_lifecycle_response fold — a decided lifecycle ⇒ (conversation_response_orchestrated, the route, the
 *     target, the concluded + active flags, the source lifecycle state, the EXPECTED prepare_booking payload the lifecycle
 *     carried), self-describing and non-drifting;
 *   • the projections isOrchestrationDecided / orchestrationTypeOf / orchestrationOutcomeOf / orchestrationRouteOf /
 *     orchestrationTargetOf / orchestrationConcludedOf / orchestrationActiveOf / orchestrationLifecycleStateOf agree with
 *     the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it ROUTES nothing itself — it names the route and
 *     the target and stops.
 */

// The canonical field values a customer provides — the exact prepare_booking payload the whole stack decides over.
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";
const PHONE = "+447700900123";
const EMAIL = "jo@brightspark.co.uk";
const FULL: ConversationInformation = {
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
  email_address: EMAIL,
};
const BOOKING_INFO: ConversationInformation = { job_type: JOB, postcode: POSTCODE, phone_number: PHONE };
const CALLBACK_INFO: ConversationInformation = { phone_number: PHONE };
const EMPTY: ConversationInformation = {};

// The concrete prepare_booking action the lifecycle carries (equal to the one the REAL composition yields).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed orchestration vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not read
// their own answer from ORCHESTRATION_TYPES (the surface under test).
const ALL_ORCHESTRATION_TYPES: readonly ConversationOrchestrationType[] = ["orchestrate_lifecycle_response"];
// The whole orchestration-route vocabulary, as an INDEPENDENT reference set.
const ALL_ROUTES: readonly OrchestrationRoute[] = ["conclude", "recover", "escalate"];
// The whole orchestration-target vocabulary, as an INDEPENDENT reference set.
const ALL_TARGETS: readonly OrchestrationTarget[] = [
  "conversation_conclusion",
  "recovery_handling",
  "human_attention",
];
// The whole lifecycle-state vocabulary the engine folds over, as an INDEPENDENT reference set.
const ALL_LIFECYCLE_STATES: readonly LifecycleState[] = ["closed", "retained", "escalated"];

// The RECORDED snapshot that MATCHES a decided fulfilment over BOOKING_ACTION — reconciles to `consistent`, recovers
// to `none`, resolves to `terminal`, governs to `close`/`closed`, orchestrates to `conclude`/`conversation_conclusion`.
const CONSISTENT_SNAPSHOT: RecordedFulfilmentSnapshot = {
  fulfilment_type: "fulfil_booking",
  fulfilment_outcome: "booking_recorded",
  approval_state: "approved",
  status: "fulfilled",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// A recorded snapshot with a single field overridden — every one reconciles to `inconsistent`, recovers to
// `reconcile`, resolves to `unresolved`, governs to `escalate`/`escalated`, orchestrates to `escalate`/`human_attention`.
const withField = (over: Partial<RecordedFulfilmentSnapshot>): RecordedFulfilmentSnapshot => ({
  ...CONSISTENT_SNAPSHOT,
  ...over,
});
const DIVERGENT_SNAPSHOTS: readonly RecordedFulfilmentSnapshot[] = [
  withField({ fulfilment_type: "fulfil_quote" }),
  withField({ fulfilment_outcome: "booking_scheduled" }),
  withField({ approval_state: "pending" }),
  withField({ approval_state: "rejected" }),
  withField({ status: "reversed" }),
  withField({ job_type: "electrical" }),
  withField({ postcode: "M1 1AE" }),
  withField({ phone_number: "+447700900999" }),
];

// Every record shape — the matching one (terminal ⇒ close ⇒ closed ⇒ conclude), the absence (missing ⇒ reinstate ⇒
// recoverable ⇒ retain ⇒ retained ⇒ recover), and each single-field divergence (inconsistent ⇒ reconcile ⇒ unresolved ⇒
// escalate ⇒ escalated ⇒ escalate).
const ALL_RECORDS: readonly (RecordedFulfilmentSnapshot | null)[] = [
  CONSISTENT_SNAPSHOT,
  null,
  ...DIVERGENT_SNAPSHOTS,
];

// The REAL progression trigger for a genuinely satisfied goal — derived through the R21 gap and the R22 strategy.
const strategyFor = (goal: ConversationGoal, info: ConversationInformation): ConversationStrategy =>
  resolveStrategy(detectGap(goal, info)).strategy;
const actionFor = (
  strategy: ConversationStrategy,
  goal: ConversationGoal,
  info: ConversationInformation,
): ActionResolution => resolveAction(resolveOutcome(strategy, goal, info), strategy, goal, info);
const realBookingAction = (): ActionResolution =>
  actionFor(strategyFor("arrange_booking", BOOKING_INFO), "arrange_booking", BOOKING_INFO);

// The REAL, DECIDED authorisation for a genuinely satisfied booking at a chosen policy verdict + org gate.
const realBookingAuthorisation = (
  verdict: (typeof GUARDRAIL_VERDICTS)[number],
  liveExecutionEnabled: boolean,
): ApproveBookingAuthorisation => {
  const execution = resolveExecution(realBookingAction(), verdict, { liveExecutionEnabled });
  const authorisation = resolveAuthorisation(execution);
  if (!isAuthorisationDecided(authorisation)) {
    throw new Error(`expected a decided booking authorisation, got abstention: ${authorisation.reason}`);
  }
  return authorisation;
};

// The REAL R30 fulfilment decision for a genuinely satisfied booking, with the human's `sent` resolution folded to the
// grant through R29's OWN bridge — the exact (authorisation, grant) pair the runtime hands to resolveFulfilment.
const realBookingFulfilment = (
  verdict: (typeof GUARDRAIL_VERDICTS)[number],
  liveExecutionEnabled: boolean,
): FulfilmentDecision => {
  const authorisation = realBookingAuthorisation(verdict, liveExecutionEnabled);
  const approval = deriveAuthorisationState(authorisation.state, "sent");
  return resolveFulfilment(authorisation, approval);
};

// The REAL, DECIDED booking fulfilment (an approved booking). A satisfied, approved arrange_booking always fulfils, so
// an abstention here is a broken fixture: fail loudly.
const decidedBookingFulfilment = (): FulfilBookingDecision => {
  const decision = realBookingFulfilment("review", true);
  if (!isFulfilmentDecided(decision)) {
    throw new Error(`expected a decided booking fulfilment, got abstention: ${decision.reason}`);
  }
  return decision;
};

// The REAL, DECIDED verification (over a chosen record). A decided fulfilment always verifies, so an abstention here is
// a broken fixture: fail loudly.
const decidedBookingVerification = (recorded: RecordedFulfilmentSnapshot | null): VerifyBookingDecision => {
  const decision = resolveVerification(decidedBookingFulfilment(), recorded);
  if (!isVerificationDecided(decision)) {
    throw new Error(`expected a decided verification, got abstention: ${decision.reason}`);
  }
  return decision;
};

// The REAL, DECIDED recovery (over a chosen record). A decided verification always recovers, so an abstention here is a
// broken fixture: fail loudly.
const decidedBookingRecovery = (recorded: RecordedFulfilmentSnapshot | null): RecoverBookingDecision => {
  const decision = resolveRecovery(decidedBookingVerification(recorded));
  if (!isRecoveryDecided(decision)) {
    throw new Error(`expected a decided recovery, got abstention: ${decision.reason}`);
  }
  return decision;
};

// The REAL, DECIDED resolution (over a chosen record). A decided recovery always resolves, so an abstention here is a
// broken fixture: fail loudly.
const decidedBookingResolution = (recorded: RecordedFulfilmentSnapshot | null): ResolveBookingRecoveryDecision => {
  const decision = resolveConversationResolution(decidedBookingRecovery(recorded));
  if (!isResolutionDecided(decision)) {
    throw new Error(`expected a decided resolution, got abstention: ${decision.reason}`);
  }
  return decision;
};

// The REAL, DECIDED lifecycle (over a chosen record) — the input the Orchestration Engine routes. A decided resolution
// always governs, so an abstention here is a broken fixture: fail loudly.
const decidedBookingLifecycle = (recorded: RecordedFulfilmentSnapshot | null): GovernResolutionLifecycleDecision => {
  const decision = resolveConversationLifecycle(decidedBookingResolution(recorded));
  if (!isLifecycleDecided(decision)) {
    throw new Error(`expected a decided lifecycle, got abstention: ${decision.reason}`);
  }
  return decision;
};

describe("R35 orchestration engine — ORCHESTRATION_TYPES: the closed orchestration vocabulary", () => {
  it("is EXACTLY `orchestrate_lifecycle_response` in R35 (quote/promotion orchestration types are future work)", () => {
    expect(ORCHESTRATION_TYPES).toEqual(["orchestrate_lifecycle_response"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(ORCHESTRATION_TYPES).size).toBe(ORCHESTRATION_TYPES.length);
    expect([...ORCHESTRATION_TYPES].sort()).toEqual([...ALL_ORCHESTRATION_TYPES].sort());
  });
});

describe("R35 orchestration engine — LIFECYCLE_ORCHESTRATION: the total lifecycle → orchestration-type map", () => {
  it("is TOTAL over the whole R34 lifecycle vocabulary (every lifecycle type has an entry)", () => {
    expect(Object.keys(LIFECYCLE_ORCHESTRATION).sort()).toEqual([...LIFECYCLE_TYPES].sort());
  });

  it("maps govern_resolution_lifecycle → orchestrate_lifecycle_response", () => {
    expect(LIFECYCLE_ORCHESTRATION.govern_resolution_lifecycle).toBe<ConversationOrchestrationType>(
      "orchestrate_lifecycle_response",
    );
  });

  it("every non-null orchestration type is in the ORCHESTRATION_TYPES vocabulary (no orphan mapping today)", () => {
    for (const lifecycleType of LIFECYCLE_TYPES) {
      const type = LIFECYCLE_ORCHESTRATION[lifecycleType];
      if (type !== null) expect(ORCHESTRATION_TYPES).toContain(type);
    }
  });

  it("has NO null entries today — so `unsupported_lifecycle` is dormant defence-in-depth (unreachable via a real lifecycle)", () => {
    for (const lifecycleType of LIFECYCLE_TYPES) {
      expect(LIFECYCLE_ORCHESTRATION[lifecycleType]).not.toBeNull();
    }
  });
});

describe("R35 orchestration engine — resolveConversationOrchestration: the Lifecycle Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R34 engine can return — the Orchestration Engine must defer on each.
  const lifecycleAbstentions = ["no_resolution_decision", "unsupported_resolution"] as const;

  for (const reason of lifecycleAbstentions) {
    it(`lifecycle abstention (${reason}) → no_lifecycle_decision`, () => {
      expect(resolveConversationOrchestration({ kind: "none", reason })).toEqual<OrchestrationDecision>({
        kind: "none",
        reason: "no_lifecycle_decision",
      });
    });
  }

  it("a REAL abstained lifecycle (the resolution was never decided) → no_lifecycle_decision", () => {
    // Drive a genuine deferral: a dismissed booking never fulfils, so R31 defers, so R32 defers, so R33 defers, so R34
    // defers, so R35 defers.
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    const lifecycle = resolveConversationLifecycle(
      resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, CONSISTENT_SNAPSHOT))),
    );
    expect(isLifecycleDecided(lifecycle)).toBe(false);
    expect(resolveConversationOrchestration(lifecycle)).toEqual<OrchestrationDecision>({
      kind: "none",
      reason: "no_lifecycle_decision",
    });
  });
});

describe("R35 orchestration engine — THE TWO-STAGE FOLD: lifecycle-state→route→target", () => {
  it("a closed lifecycle → conclude → conversation_conclusion (the conversation is routed to conclusion)", () => {
    expect(resolveConversationOrchestration(decidedBookingLifecycle(CONSISTENT_SNAPSHOT))).toEqual<OrchestrationDecision>({
      kind: "orchestrate_lifecycle_response",
      outcome: "conversation_response_orchestrated",
      route: "conclude",
      target: "conversation_conclusion",
      concluded: true,
      active: false,
      lifecycle_state: "closed",
      booking: BOOKING_ACTION,
    });
  });

  it("a retained lifecycle → recover → recovery_handling (a clear recovery path, routed to recovery, still active)", () => {
    expect(resolveConversationOrchestration(decidedBookingLifecycle(null))).toEqual<OrchestrationDecision>({
      kind: "orchestrate_lifecycle_response",
      outcome: "conversation_response_orchestrated",
      route: "recover",
      target: "recovery_handling",
      concluded: false,
      active: true,
      lifecycle_state: "retained",
      booking: BOOKING_ACTION,
    });
  });

  it("an escalated lifecycle (a record diverging in ANY field) → escalate → human_attention", () => {
    for (const recorded of DIVERGENT_SNAPSHOTS) {
      expect(resolveConversationOrchestration(decidedBookingLifecycle(recorded))).toEqual<OrchestrationDecision>({
        kind: "orchestrate_lifecycle_response",
        outcome: "conversation_response_orchestrated",
        route: "escalate",
        target: "human_attention",
        concluded: false,
        active: true,
        lifecycle_state: "escalated",
        booking: BOOKING_ACTION,
      });
    }
  });

  it("the route is the deterministic fold of the lifecycle state (a total mapping)", () => {
    const fold: Record<LifecycleState, OrchestrationRoute> = {
      closed: "conclude",
      retained: "recover",
      escalated: "escalate",
    };
    for (const recorded of ALL_RECORDS) {
      const lifecycle = decidedBookingLifecycle(recorded);
      expect(orchestrationRouteOf(resolveConversationOrchestration(lifecycle))).toBe(fold[lifecycle.state]);
    }
  });

  it("the target is the deterministic fold of the route (conclude→conversation_conclusion, recover→recovery_handling, escalate→human_attention)", () => {
    const fold: Record<OrchestrationRoute, OrchestrationTarget> = {
      conclude: "conversation_conclusion",
      recover: "recovery_handling",
      escalate: "human_attention",
    };
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationOrchestration(decidedBookingLifecycle(recorded));
      const route = orchestrationRouteOf(decision);
      const target = orchestrationTargetOf(decision);
      if (route !== null) expect(target).toBe(fold[route]);
    }
  });

  it("lifecycle-state → target is the composed fold (closed→conversation_conclusion, retained→recovery_handling, escalated→human_attention)", () => {
    const fold: Record<LifecycleState, OrchestrationTarget> = {
      closed: "conversation_conclusion",
      retained: "recovery_handling",
      escalated: "human_attention",
    };
    for (const recorded of ALL_RECORDS) {
      const lifecycle = decidedBookingLifecycle(recorded);
      expect(orchestrationTargetOf(resolveConversationOrchestration(lifecycle))).toBe(fold[lifecycle.state]);
    }
  });

  it("a DECISION is produced for ALL three routes — conclude/recover/escalate are NOT abstentions", () => {
    // The whole point of the engine is to ROUTE the response; a real (decided) orchestration is produced for each route,
    // carrying the route + target. isOrchestrationDecided is TRUE for all three (including the conclude case).
    for (const recorded of ALL_RECORDS) {
      expect(isOrchestrationDecided(resolveConversationOrchestration(decidedBookingLifecycle(recorded)))).toBe(true);
    }
  });

  it("the three routes/targets are reachable and distinct over the SAME decided lifecycle path", () => {
    const seenRoutes = new Set<OrchestrationRoute>();
    const seenTargets = new Set<OrchestrationTarget>();
    const seenLifecycleStates = new Set<LifecycleState>();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, withField({ job_type: "electrical" })]) {
      const decision = resolveConversationOrchestration(decidedBookingLifecycle(recorded));
      const route = orchestrationRouteOf(decision);
      const target = orchestrationTargetOf(decision);
      const lifecycleState = orchestrationLifecycleStateOf(decision);
      if (route !== null) seenRoutes.add(route);
      if (target !== null) seenTargets.add(target);
      if (lifecycleState !== null) seenLifecycleStates.add(lifecycleState);
    }
    expect([...seenRoutes].sort()).toEqual([...ALL_ROUTES].sort());
    expect([...seenTargets].sort()).toEqual([...ALL_TARGETS].sort());
    // The three source lifecycle states the engine folds over are ALL reachable across the same path.
    expect([...seenLifecycleStates].sort()).toEqual([...ALL_LIFECYCLE_STATES].sort());
  });
});

describe("R35 orchestration engine — THE KEYSTONE: concluded = (route === 'conclude'), active = (route !== 'conclude')", () => {
  it("concluded/active flags are coherent with the route, over every real disposition", () => {
    const cases: readonly [RecordedFulfilmentSnapshot | null, OrchestrationRoute, boolean, boolean][] = [
      [CONSISTENT_SNAPSHOT, "conclude", true, false],
      [null, "recover", false, true],
      [withField({ job_type: "electrical" }), "escalate", false, true],
    ];
    for (const [recorded, route, concluded, active] of cases) {
      const decision = resolveConversationOrchestration(decidedBookingLifecycle(recorded));
      expect(isOrchestrationDecided(decision)).toBe(true);
      if (isOrchestrationDecided(decision)) {
        expect(decision.route).toBe(route);
        expect(decision.concluded).toBe(concluded);
        expect(decision.active).toBe(active);
      }
    }
  });

  it("the keystone holds on EVERY decided orchestration produced over every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationOrchestration(decidedBookingLifecycle(recorded));
      if (isOrchestrationDecided(decision)) {
        expect(decision.concluded).toBe(decision.route === "conclude");
        expect(decision.active).toBe(decision.route !== "conclude");
        // The two flags are exact complements — a conversation's orchestration is concluded XOR an active response is routed.
        expect(decision.concluded).toBe(!decision.active);
      }
    }
  });
});

describe("R35 orchestration engine — the orchestrate_lifecycle_response fold (outcome + source lifecycle state + payload)", () => {
  it("a decided lifecycle ⇒ conversation_response_orchestrated, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      expect(
        orchestrationOutcomeOf(resolveConversationOrchestration(decidedBookingLifecycle(recorded))),
      ).toBe<OrchestrationOutcome>("conversation_response_orchestrated");
    }
  });

  it("carries the SOURCE lifecycle state it routed, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const lifecycle = decidedBookingLifecycle(recorded);
      expect(orchestrationLifecycleStateOf(resolveConversationOrchestration(lifecycle))).toBe(lifecycle.state);
    }
  });

  it("carries the EXACT expected prepare_booking payload the lifecycle carried (self-describing, no drift)", () => {
    const lifecycle = decidedBookingLifecycle(null);
    const decision = resolveConversationOrchestration(lifecycle);
    expect(isOrchestrationDecided(decision)).toBe(true);
    if (isOrchestrationDecided(decision)) {
      // The expected booking is the lifecycle's own payload, carried through by reference — it can never drift.
      expect(decision.booking).toBe(lifecycle.booking);
      expect(decision.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });
});

describe("R35 orchestration engine — proven against the REAL R30/R31/R32/R33/R34 stack + Human Review bridge (genuine composition)", () => {
  // Orchestrate straight through the whole stack from a real fulfilment + a chosen record.
  const orchestrationThroughStack = (
    fulfilment: FulfilmentDecision,
    recorded: RecordedFulfilmentSnapshot | null,
  ): OrchestrationDecision =>
    resolveConversationOrchestration(
      resolveConversationLifecycle(
        resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, recorded))),
      ),
    );

  it("real booking → fulfil → verify(matching) → recover(none) → resolve(terminal) → govern(closed) → orchestrate ⇒ conclude/conversation_conclusion", () => {
    expect(
      orchestrationThroughStack(realBookingFulfilment("review", true), CONSISTENT_SNAPSHOT),
    ).toEqual<OrchestrationDecision>({
      kind: "orchestrate_lifecycle_response",
      outcome: "conversation_response_orchestrated",
      route: "conclude",
      target: "conversation_conclusion",
      concluded: true,
      active: false,
      lifecycle_state: "closed",
      booking: BOOKING_ACTION,
    });
  });

  it("real booking → fulfil → verify(no record) → recover(reinstate) → resolve(recoverable) → govern(retained) → orchestrate ⇒ recover/recovery_handling", () => {
    const decision = orchestrationThroughStack(realBookingFulfilment("review", true), null);
    expect(orchestrationRouteOf(decision)).toBe<OrchestrationRoute>("recover");
    expect(orchestrationTargetOf(decision)).toBe<OrchestrationTarget>("recovery_handling");
    expect(orchestrationConcludedOf(decision)).toBe(false);
    expect(orchestrationActiveOf(decision)).toBe(true);
  });

  it("real booking → fulfil → verify(divergent) → recover(reconcile) → resolve(unresolved) → govern(escalated) → orchestrate ⇒ escalate/human_attention", () => {
    const decision = orchestrationThroughStack(
      realBookingFulfilment("review", true),
      withField({ status: "reversed" }),
    );
    expect(orchestrationRouteOf(decision)).toBe<OrchestrationRoute>("escalate");
    expect(orchestrationTargetOf(decision)).toBe<OrchestrationTarget>("human_attention");
    expect(orchestrationConcludedOf(decision)).toBe(false);
    expect(orchestrationActiveOf(decision)).toBe(true);
  });

  it("the SAME real booking, but the human DISMISSED ⇒ rejected → nothing resolves → nothing governs → NOTHING to orchestrate", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    expect(orchestrationThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<OrchestrationDecision>({
      kind: "none",
      reason: "no_lifecycle_decision",
    });
  });

  it("the SAME real booking, but NO human resolution yet ⇒ pending → nothing resolves → nothing governs → NOTHING to orchestrate", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, null));
    expect(orchestrationThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<OrchestrationDecision>({
      kind: "none",
      reason: "no_lifecycle_decision",
    });
  });

  it("a policy-blocked booking foreclosed at R29 never resolves → nothing governs → NOTHING to orchestrate (policy propagates)", () => {
    const authorisation = realBookingAuthorisation("block", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(orchestrationThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<OrchestrationDecision>({
      kind: "none",
      reason: "no_lifecycle_decision",
    });
  });

  it("the org-OFF production default (foreclosed) is likewise nothing to orchestrate even on a human SENT", () => {
    const authorisation = realBookingAuthorisation("allow", false);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(orchestrationThroughStack(fulfilment, null)).toEqual<OrchestrationDecision>({
      kind: "none",
      reason: "no_lifecycle_decision",
    });
  });
});

describe("R35 orchestration engine — isOrchestrationDecided / projections agree with the discriminant", () => {
  const decidedOrchestration: OrchestrateLifecycleResponseDecision = {
    kind: "orchestrate_lifecycle_response",
    outcome: "conversation_response_orchestrated",
    route: "recover",
    target: "recovery_handling",
    concluded: false,
    active: true,
    lifecycle_state: "retained",
    booking: BOOKING_ACTION,
  };
  // Each lifecycle state with its coherent route + target + concluded + active companions.
  const decidedCombos: readonly [LifecycleState, OrchestrationRoute, OrchestrationTarget, boolean, boolean][] = [
    ["closed", "conclude", "conversation_conclusion", true, false],
    ["retained", "recover", "recovery_handling", false, true],
    ["escalated", "escalate", "human_attention", false, true],
  ];
  const abstentions: readonly OrchestrationAbstention[] = ["no_lifecycle_decision", "unsupported_lifecycle"];

  const withCombo = (
    lifecycleState: LifecycleState,
    route: OrchestrationRoute,
    target: OrchestrationTarget,
    concluded: boolean,
    active: boolean,
  ): OrchestrateLifecycleResponseDecision => ({
    ...decidedOrchestration,
    lifecycle_state: lifecycleState,
    route,
    target,
    concluded,
    active,
  });

  it("isOrchestrationDecided is TRUE for a decided orchestration and narrows it", () => {
    const dec: OrchestrationDecision = decidedOrchestration;
    expect(isOrchestrationDecided(dec)).toBe(true);
    if (isOrchestrationDecided(dec)) {
      // Narrowed to OrchestrateLifecycleResponseDecision — outcome, route, target, flags and booking are reachable.
      expect(dec.outcome).toBe<OrchestrationOutcome>("conversation_response_orchestrated");
      expect(dec.route).toBe<OrchestrationRoute>("recover");
      expect(dec.target).toBe<OrchestrationTarget>("recovery_handling");
      expect(dec.concluded).toBe(false);
      expect(dec.active).toBe(true);
      expect(dec.lifecycle_state).toBe<LifecycleState>("retained");
      expect(dec.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });

  it("isOrchestrationDecided is TRUE for a decided orchestration of EVERY route (conclude included)", () => {
    for (const [lifecycleState, route, target, concluded, active] of decidedCombos) {
      expect(isOrchestrationDecided(withCombo(lifecycleState, route, target, concluded, active))).toBe(true);
    }
  });

  it("isOrchestrationDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isOrchestrationDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("orchestrationTypeOf is orchestrate_lifecycle_response for a decided arm and null for every abstention", () => {
    expect(orchestrationTypeOf(decidedOrchestration)).toBe<ConversationOrchestrationType>(
      "orchestrate_lifecycle_response",
    );
    for (const reason of abstentions) {
      expect(orchestrationTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("orchestrationOutcomeOf is conversation_response_orchestrated for a decided arm and null for every abstention", () => {
    expect(orchestrationOutcomeOf(decidedOrchestration)).toBe<OrchestrationOutcome>(
      "conversation_response_orchestrated",
    );
    for (const reason of abstentions) {
      expect(orchestrationOutcomeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("orchestrationRouteOf is the route for a decided arm and null for every abstention", () => {
    for (const [lifecycleState, route, target, concluded, active] of decidedCombos) {
      expect(orchestrationRouteOf(withCombo(lifecycleState, route, target, concluded, active))).toBe<
        OrchestrationRoute
      >(route);
    }
    for (const reason of abstentions) {
      expect(orchestrationRouteOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("orchestrationTargetOf is the target for a decided arm and null for every abstention", () => {
    for (const [lifecycleState, route, target, concluded, active] of decidedCombos) {
      expect(orchestrationTargetOf(withCombo(lifecycleState, route, target, concluded, active))).toBe<
        OrchestrationTarget
      >(target);
    }
    for (const reason of abstentions) {
      expect(orchestrationTargetOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("orchestrationConcludedOf is the concluded flag for a decided arm and null for every abstention", () => {
    for (const [lifecycleState, route, target, concluded, active] of decidedCombos) {
      expect(orchestrationConcludedOf(withCombo(lifecycleState, route, target, concluded, active))).toBe(concluded);
    }
    for (const reason of abstentions) {
      expect(orchestrationConcludedOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("orchestrationActiveOf is the active flag for a decided arm and null for every abstention", () => {
    for (const [lifecycleState, route, target, concluded, active] of decidedCombos) {
      expect(orchestrationActiveOf(withCombo(lifecycleState, route, target, concluded, active))).toBe(active);
    }
    for (const reason of abstentions) {
      expect(orchestrationActiveOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("orchestrationLifecycleStateOf is the source lifecycle state for a decided arm and null for every abstention", () => {
    for (const [lifecycleState, route, target, concluded, active] of decidedCombos) {
      expect(orchestrationLifecycleStateOf(withCombo(lifecycleState, route, target, concluded, active))).toBe<
        LifecycleState
      >(lifecycleState);
    }
    for (const reason of abstentions) {
      expect(orchestrationLifecycleStateOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("orchestrationTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(orchestrationTypeOf(decidedOrchestration)).toBe(decidedOrchestration.kind);
  });
});

describe("R35 orchestration engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveConversationOrchestration returns a coherent decision for EVERY (real lifecycle × every record)", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY]) {
          const action = actionFor(strategy, goal, info);
          for (const verdict of GUARDRAIL_VERDICTS) {
            for (const live of [true, false]) {
              const authorisation = resolveAuthorisation(
                resolveExecution(action, verdict, { liveExecutionEnabled: live }),
              );
              for (const grant of ["pending", "approved", "rejected", "foreclosed"] as const) {
                const fulfilment = resolveFulfilment(authorisation, grant);
                for (const recorded of ALL_RECORDS) {
                  const lifecycle = resolveConversationLifecycle(
                    resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, recorded))),
                  );
                  const orchestration = resolveConversationOrchestration(lifecycle);
                  expect(
                    orchestration.kind === "orchestrate_lifecycle_response" || orchestration.kind === "none",
                  ).toBe(true);
                  // The keystone AND the two-stage fold hold on EVERY decided orchestration produced anywhere in the sweep.
                  if (isOrchestrationDecided(orchestration)) {
                    expect(orchestration.concluded).toBe(orchestration.route === "conclude");
                    expect(orchestration.active).toBe(orchestration.route !== "conclude");
                    const expectedRoute: OrchestrationRoute =
                      orchestration.lifecycle_state === "closed"
                        ? "conclude"
                        : orchestration.lifecycle_state === "retained"
                          ? "recover"
                          : "escalate";
                    expect(orchestration.route).toBe(expectedRoute);
                    const expectedTarget: OrchestrationTarget =
                      orchestration.route === "conclude"
                        ? "conversation_conclusion"
                        : orchestration.route === "recover"
                          ? "recovery_handling"
                          : "human_attention";
                    expect(orchestration.target).toBe(expectedTarget);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("an orchestration is DECIDED iff the lifecycle was decided (the route never opens or closes the gate)", () => {
    const lifecycleAbstained: LifecycleDecision = { kind: "none", reason: "no_resolution_decision" };
    expect(isOrchestrationDecided(resolveConversationOrchestration(lifecycleAbstained))).toBe(false);
    // A decided lifecycle ALWAYS yields a decided orchestration (whatever the route); the route only chooses the target
    // + concluded/active flags, never whether an orchestration exists.
    for (const recorded of ALL_RECORDS) {
      expect(isOrchestrationDecided(resolveConversationOrchestration(decidedBookingLifecycle(recorded)))).toBe(true);
    }
  });

  it("is DETERMINISTIC — the same lifecycle always yields an equal orchestration", () => {
    for (const recorded of ALL_RECORDS) {
      const lifecycle = decidedBookingLifecycle(recorded);
      expect(resolveConversationOrchestration(lifecycle)).toEqual(resolveConversationOrchestration(lifecycle));
    }
  });

  it("does NOT mutate the lifecycle decision it reads", () => {
    const lifecycle = decidedBookingLifecycle(CONSISTENT_SNAPSHOT);
    const snap = JSON.stringify(lifecycle);
    resolveConversationOrchestration(lifecycle);
    expect(JSON.stringify(lifecycle)).toBe(snap);
  });
});

// A compile-time proof that `ConversationLifecycleType` is exhaustively mapped by LIFECYCLE_ORCHESTRATION — if R34 adds a
// lifecycle type without a matching LIFECYCLE_ORCHESTRATION entry, this reference fails to type-check.
const _exhaustiveLifecycleMap: Readonly<
  Record<ConversationLifecycleType, ConversationOrchestrationType | null>
> = LIFECYCLE_ORCHESTRATION;
void _exhaustiveLifecycleMap;
