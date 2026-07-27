import { describe, it, expect } from "vitest";
import {
  COORDINATION_TYPES,
  ORCHESTRATION_COORDINATION,
  resolveConversationCoordination,
  isCoordinationDecided,
  coordinationTypeOf,
  coordinationOutcomeOf,
  coordinationModeOf,
  coordinationLeadParticipantOf,
  coordinationParticipantsOf,
  coordinationParticipantCountOf,
  coordinationRequiresHumanOf,
  coordinationAutonomousOf,
  coordinationLifecycleStateOf,
  type ConversationCoordinationType,
  type CoordinationOutcome,
  type CoordinationMode,
  type CoordinationParticipant,
  type CoordinationDecision,
  type CoordinateLifecycleResponseDecision,
  type CoordinationAbstention,
} from "@/lib/receptionist/conversation-coordination";
import {
  ORCHESTRATION_TYPES,
  resolveConversationOrchestration,
  isOrchestrationDecided,
  type ConversationOrchestrationType,
  type OrchestrationRoute,
  type OrchestrationTarget,
  type OrchestrationDecision,
  type OrchestrateLifecycleResponseDecision,
} from "@/lib/receptionist/conversation-orchestration";
import {
  resolveConversationLifecycle,
  isLifecycleDecided,
  type LifecycleState,
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
 * THE CONVERSATION COORDINATION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R36 — CONVERSATION COORDINATION ENGINE).
 *
 * lib/receptionist/conversation-coordination.ts is the deterministic, leaf authority over the SIXTH layer that does not
 * perform: "given an orchestration the stack ROUTED, HOW should the platform's capabilities be COORDINATED to respond,
 * and WHICH should PARTICIPATE?". It is a TOTAL, DETERMINISTIC function of ONE already-computed input — the R35
 * orchestration decision (the DEFERRAL gate) — so it is exhaustively unit-testable in isolation. Every orchestration fed
 * in is the REAL {@link resolveConversationOrchestration} over the REAL R34 {@link resolveConversationLifecycle} / R33
 * {@link resolveConversationResolution} / R32 {@link resolveRecovery} / R31 {@link resolveVerification} / R30
 * {@link resolveFulfilment} / R29 {@link resolveAuthorisation} / R28 {@link resolveExecution} stack with the grant folded
 * by R29's OWN {@link deriveAuthorisationState} — so the engine is proven against genuine composition, never a hand-built
 * decision. These tests pin, EXHAUSTIVELY:
 *   • COORDINATION_TYPES is the closed coordination vocabulary — exactly `coordinate_lifecycle_response` in R36, no dupes;
 *   • ORCHESTRATION_COORDINATION is TOTAL over the R35 orchestration vocabulary and maps orchestrate_lifecycle_response →
 *     coordinate_lifecycle_response (so a future orchestration type cannot silently reach the engine uncoordinated);
 *   • resolveConversationCoordination DEFERS `no_orchestration_decision` whenever the Orchestration Engine abstained — the
 *     FIRST gate, so the Orchestration Engine (and transitively Lifecycle, Resolution, Recovery, Verification, Fulfilment,
 *     Authorisation, Execution, Action and Outcome) stays authoritative;
 *   • THE MODE FOLD — a decided orchestration folds to a `finalising` mode when the route is `conclude`, `remediating`
 *     when `recover`, and `escalating` when `escalate` — and a decision is PRODUCED for all three (`finalising` is a
 *     coordination that finalises the conversation, NOT an abstention);
 *   • THE LEAD — the lead participant is CONSUMED from R35's routed target (conversation_conclusion / recovery_handling /
 *     human_attention), never recomputed; the mode and lead are 1:1;
 *   • THE KEYSTONE — `requires_human` is TRUE iff the lead is `human_attention`, and `autonomous` is TRUE iff it is NOT,
 *     on every decided coordination (Directive #018 R36's two distinct questions, made coherent);
 *   • THE SINGLE-CAPABILITY PLAN — `participants` is the singleton `[lead]` and `participant_count` is 1 on every decided
 *     coordination (the first, lifecycle implementation is honestly single-capability);
 *   • the coordinate_lifecycle_response fold — a decided orchestration ⇒ (conversation_response_coordinated, the mode, the
 *     lead + plan, the requires_human + autonomous flags, the SOURCE route + target, the source lifecycle state, the
 *     EXPECTED prepare_booking payload the orchestration carried), self-describing and non-drifting;
 *   • the projections isCoordinationDecided / coordinationTypeOf / coordinationOutcomeOf / coordinationModeOf /
 *     coordinationLeadParticipantOf / coordinationParticipantsOf / coordinationParticipantCountOf /
 *     coordinationRequiresHumanOf / coordinationAutonomousOf / coordinationLifecycleStateOf agree with the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it COORDINATES nothing itself — it names the mode
 *     and the participants and stops.
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

// The concrete prepare_booking action the orchestration carries (equal to the one the REAL composition yields).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed coordination vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not read
// their own answer from COORDINATION_TYPES (the surface under test).
const ALL_COORDINATION_TYPES: readonly ConversationCoordinationType[] = ["coordinate_lifecycle_response"];
// The whole coordination-mode vocabulary, as an INDEPENDENT reference set.
const ALL_MODES: readonly CoordinationMode[] = ["finalising", "remediating", "escalating"];
// The whole coordination-participant vocabulary, as an INDEPENDENT reference set.
const ALL_PARTICIPANTS: readonly CoordinationParticipant[] = [
  "conversation_conclusion",
  "recovery_handling",
  "human_attention",
];
// The whole lifecycle-state vocabulary the engine carries through, as an INDEPENDENT reference set.
const ALL_LIFECYCLE_STATES: readonly LifecycleState[] = ["closed", "retained", "escalated"];

// The RECORDED snapshot that MATCHES a decided fulfilment over BOOKING_ACTION — reconciles to `consistent`, recovers to
// `none`, resolves to `terminal`, governs to `close`/`closed`, orchestrates to `conclude`/`conversation_conclusion`,
// coordinates to `finalising`/`conversation_conclusion` (autonomous).
const CONSISTENT_SNAPSHOT: RecordedFulfilmentSnapshot = {
  fulfilment_type: "fulfil_booking",
  fulfilment_outcome: "booking_recorded",
  approval_state: "approved",
  status: "fulfilled",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// A recorded snapshot with a single field overridden — every one reconciles to `inconsistent`, recovers to `reconcile`,
// resolves to `unresolved`, governs to `escalate`/`escalated`, orchestrates to `escalate`/`human_attention`, coordinates
// to `escalating`/`human_attention` (requires_human).
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

// Every record shape — the matching one (terminal ⇒ close ⇒ closed ⇒ conclude ⇒ finalising), the absence (missing ⇒
// reinstate ⇒ recoverable ⇒ retain ⇒ retained ⇒ recover ⇒ remediating), and each single-field divergence (inconsistent
// ⇒ reconcile ⇒ unresolved ⇒ escalate ⇒ escalated ⇒ escalate ⇒ escalating).
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

// The REAL, DECIDED lifecycle (over a chosen record). A decided resolution always governs, so an abstention here is a
// broken fixture: fail loudly.
const decidedBookingLifecycle = (recorded: RecordedFulfilmentSnapshot | null): GovernResolutionLifecycleDecision => {
  const decision = resolveConversationLifecycle(decidedBookingResolution(recorded));
  if (!isLifecycleDecided(decision)) {
    throw new Error(`expected a decided lifecycle, got abstention: ${decision.reason}`);
  }
  return decision;
};

// The REAL, DECIDED orchestration (over a chosen record) — the input the Coordination Engine coordinates. A decided
// lifecycle always orchestrates, so an abstention here is a broken fixture: fail loudly.
const decidedBookingOrchestration = (
  recorded: RecordedFulfilmentSnapshot | null,
): OrchestrateLifecycleResponseDecision => {
  const decision = resolveConversationOrchestration(decidedBookingLifecycle(recorded));
  if (!isOrchestrationDecided(decision)) {
    throw new Error(`expected a decided orchestration, got abstention: ${decision.reason}`);
  }
  return decision;
};

describe("R36 coordination engine — COORDINATION_TYPES: the closed coordination vocabulary", () => {
  it("is EXACTLY `coordinate_lifecycle_response` in R36 (quote/promotion coordination types are future work)", () => {
    expect(COORDINATION_TYPES).toEqual(["coordinate_lifecycle_response"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(COORDINATION_TYPES).size).toBe(COORDINATION_TYPES.length);
    expect([...COORDINATION_TYPES].sort()).toEqual([...ALL_COORDINATION_TYPES].sort());
  });
});

describe("R36 coordination engine — ORCHESTRATION_COORDINATION: the total orchestration → coordination-type map", () => {
  it("is TOTAL over the whole R35 orchestration vocabulary (every orchestration type has an entry)", () => {
    expect(Object.keys(ORCHESTRATION_COORDINATION).sort()).toEqual([...ORCHESTRATION_TYPES].sort());
  });

  it("maps orchestrate_lifecycle_response → coordinate_lifecycle_response", () => {
    expect(ORCHESTRATION_COORDINATION.orchestrate_lifecycle_response).toBe<ConversationCoordinationType>(
      "coordinate_lifecycle_response",
    );
  });

  it("every non-null coordination type is in the COORDINATION_TYPES vocabulary (no orphan mapping today)", () => {
    for (const orchestrationType of ORCHESTRATION_TYPES) {
      const type = ORCHESTRATION_COORDINATION[orchestrationType];
      if (type !== null) expect(COORDINATION_TYPES).toContain(type);
    }
  });

  it("has NO null entries today — so `unsupported_orchestration` is dormant defence-in-depth (unreachable via a real orchestration)", () => {
    for (const orchestrationType of ORCHESTRATION_TYPES) {
      expect(ORCHESTRATION_COORDINATION[orchestrationType]).not.toBeNull();
    }
  });
});

describe("R36 coordination engine — resolveConversationCoordination: the Orchestration Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R35 engine can return — the Coordination Engine must defer on each.
  const orchestrationAbstentions = ["no_lifecycle_decision", "unsupported_lifecycle"] as const;

  for (const reason of orchestrationAbstentions) {
    it(`orchestration abstention (${reason}) → no_orchestration_decision`, () => {
      expect(resolveConversationCoordination({ kind: "none", reason })).toEqual<CoordinationDecision>({
        kind: "none",
        reason: "no_orchestration_decision",
      });
    });
  }

  it("a REAL abstained orchestration (the lifecycle was never decided) → no_orchestration_decision", () => {
    // Drive a genuine deferral: a dismissed booking never fulfils, so R31 defers, so R32 defers, so R33 defers, so R34
    // defers, so R35 defers, so R36 defers.
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    const orchestration = resolveConversationOrchestration(
      resolveConversationLifecycle(
        resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, CONSISTENT_SNAPSHOT))),
      ),
    );
    expect(isOrchestrationDecided(orchestration)).toBe(false);
    expect(resolveConversationCoordination(orchestration)).toEqual<CoordinationDecision>({
      kind: "none",
      reason: "no_orchestration_decision",
    });
  });
});

describe("R36 coordination engine — THE MODE FOLD: route→mode, and THE LEAD: target→lead (consumed)", () => {
  it("a conclude orchestration → finalising / conversation_conclusion (the conversation is finalised, autonomous)", () => {
    expect(resolveConversationCoordination(decidedBookingOrchestration(CONSISTENT_SNAPSHOT))).toEqual<CoordinationDecision>({
      kind: "coordinate_lifecycle_response",
      outcome: "conversation_response_coordinated",
      mode: "finalising",
      lead_participant: "conversation_conclusion",
      participants: ["conversation_conclusion"],
      participant_count: 1,
      requires_human: false,
      autonomous: true,
      orchestration_route: "conclude",
      orchestration_target: "conversation_conclusion",
      lifecycle_state: "closed",
      booking: BOOKING_ACTION,
    });
  });

  it("a recover orchestration → remediating / recovery_handling (a clear recovery path, remediated, still autonomous)", () => {
    expect(resolveConversationCoordination(decidedBookingOrchestration(null))).toEqual<CoordinationDecision>({
      kind: "coordinate_lifecycle_response",
      outcome: "conversation_response_coordinated",
      mode: "remediating",
      lead_participant: "recovery_handling",
      participants: ["recovery_handling"],
      participant_count: 1,
      requires_human: false,
      autonomous: true,
      orchestration_route: "recover",
      orchestration_target: "recovery_handling",
      lifecycle_state: "retained",
      booking: BOOKING_ACTION,
    });
  });

  it("an escalate orchestration (a record diverging in ANY field) → escalating / human_attention (requires a human)", () => {
    for (const recorded of DIVERGENT_SNAPSHOTS) {
      expect(resolveConversationCoordination(decidedBookingOrchestration(recorded))).toEqual<CoordinationDecision>({
        kind: "coordinate_lifecycle_response",
        outcome: "conversation_response_coordinated",
        mode: "escalating",
        lead_participant: "human_attention",
        participants: ["human_attention"],
        participant_count: 1,
        requires_human: true,
        autonomous: false,
        orchestration_route: "escalate",
        orchestration_target: "human_attention",
        lifecycle_state: "escalated",
        booking: BOOKING_ACTION,
      });
    }
  });

  it("the mode is the deterministic fold of the orchestration route (a total mapping)", () => {
    const fold: Record<OrchestrationRoute, CoordinationMode> = {
      conclude: "finalising",
      recover: "remediating",
      escalate: "escalating",
    };
    for (const recorded of ALL_RECORDS) {
      const orchestration = decidedBookingOrchestration(recorded);
      expect(coordinationModeOf(resolveConversationCoordination(orchestration))).toBe(fold[orchestration.route]);
    }
  });

  it("the lead participant is CONSUMED from R35's routed target (identity — never recomputed)", () => {
    for (const recorded of ALL_RECORDS) {
      const orchestration = decidedBookingOrchestration(recorded);
      expect(coordinationLeadParticipantOf(resolveConversationCoordination(orchestration))).toBe(
        orchestration.target,
      );
    }
  });

  it("mode → lead is the composed 1:1 fold (finalising→conversation_conclusion, remediating→recovery_handling, escalating→human_attention)", () => {
    const fold: Record<CoordinationMode, CoordinationParticipant> = {
      finalising: "conversation_conclusion",
      remediating: "recovery_handling",
      escalating: "human_attention",
    };
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationCoordination(decidedBookingOrchestration(recorded));
      const mode = coordinationModeOf(decision);
      const lead = coordinationLeadParticipantOf(decision);
      if (mode !== null) expect(lead).toBe(fold[mode]);
    }
  });

  it("a DECISION is produced for ALL three modes — finalising/remediating/escalating are NOT abstentions", () => {
    // The whole point of the engine is to COORDINATE the response; a real (decided) coordination is produced for each
    // mode, carrying the mode + lead. isCoordinationDecided is TRUE for all three (including the finalising case).
    for (const recorded of ALL_RECORDS) {
      expect(isCoordinationDecided(resolveConversationCoordination(decidedBookingOrchestration(recorded)))).toBe(true);
    }
  });

  it("the three modes/leads are reachable and distinct over the SAME decided orchestration path", () => {
    const seenModes = new Set<CoordinationMode>();
    const seenLeads = new Set<CoordinationParticipant>();
    const seenLifecycleStates = new Set<LifecycleState>();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, withField({ job_type: "electrical" })]) {
      const decision = resolveConversationCoordination(decidedBookingOrchestration(recorded));
      const mode = coordinationModeOf(decision);
      const lead = coordinationLeadParticipantOf(decision);
      const lifecycleState = coordinationLifecycleStateOf(decision);
      if (mode !== null) seenModes.add(mode);
      if (lead !== null) seenLeads.add(lead);
      if (lifecycleState !== null) seenLifecycleStates.add(lifecycleState);
    }
    expect([...seenModes].sort()).toEqual([...ALL_MODES].sort());
    expect([...seenLeads].sort()).toEqual([...ALL_PARTICIPANTS].sort());
    // The three source lifecycle states the engine carries through are ALL reachable across the same path.
    expect([...seenLifecycleStates].sort()).toEqual([...ALL_LIFECYCLE_STATES].sort());
  });
});

describe("R36 coordination engine — THE KEYSTONE: requires_human = (lead === 'human_attention'), autonomous = (lead !== 'human_attention')", () => {
  it("requires_human/autonomous flags are coherent with the lead, over every real disposition", () => {
    const cases: readonly [RecordedFulfilmentSnapshot | null, CoordinationParticipant, boolean, boolean][] = [
      [CONSISTENT_SNAPSHOT, "conversation_conclusion", false, true],
      [null, "recovery_handling", false, true],
      [withField({ job_type: "electrical" }), "human_attention", true, false],
    ];
    for (const [recorded, lead, requiresHuman, autonomous] of cases) {
      const decision = resolveConversationCoordination(decidedBookingOrchestration(recorded));
      expect(isCoordinationDecided(decision)).toBe(true);
      if (isCoordinationDecided(decision)) {
        expect(decision.lead_participant).toBe(lead);
        expect(decision.requires_human).toBe(requiresHuman);
        expect(decision.autonomous).toBe(autonomous);
      }
    }
  });

  it("the keystone holds on EVERY decided coordination produced over every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationCoordination(decidedBookingOrchestration(recorded));
      if (isCoordinationDecided(decision)) {
        expect(decision.requires_human).toBe(decision.lead_participant === "human_attention");
        expect(decision.autonomous).toBe(decision.lead_participant !== "human_attention");
        // The two flags are exact complements — a coordinated response requires a human XOR it is autonomous.
        expect(decision.requires_human).toBe(!decision.autonomous);
      }
    }
  });
});

describe("R36 coordination engine — THE SINGLE-CAPABILITY PLAN: participants = [lead], participant_count = 1", () => {
  it("the participation plan is the singleton [lead] with count 1, on every decided coordination", () => {
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationCoordination(decidedBookingOrchestration(recorded));
      if (isCoordinationDecided(decision)) {
        expect(decision.participants).toEqual([decision.lead_participant]);
        expect(decision.participant_count).toBe(1);
        // The count is coherent with the list length.
        expect(decision.participant_count).toBe(decision.participants.length);
      }
    }
  });

  it("the projections agree — coordinationParticipantsOf is [lead] and coordinationParticipantCountOf is 1", () => {
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationCoordination(decidedBookingOrchestration(recorded));
      const lead = coordinationLeadParticipantOf(decision);
      if (lead !== null) {
        expect(coordinationParticipantsOf(decision)).toEqual([lead]);
        expect(coordinationParticipantCountOf(decision)).toBe(1);
      }
    }
  });
});

describe("R36 coordination engine — the coordinate_lifecycle_response fold (outcome + source route/target + payload)", () => {
  it("a decided orchestration ⇒ conversation_response_coordinated, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      expect(
        coordinationOutcomeOf(resolveConversationCoordination(decidedBookingOrchestration(recorded))),
      ).toBe<CoordinationOutcome>("conversation_response_coordinated");
    }
  });

  it("carries the SOURCE orchestration route + target it coordinated, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const orchestration = decidedBookingOrchestration(recorded);
      const decision = resolveConversationCoordination(orchestration);
      if (isCoordinationDecided(decision)) {
        expect(decision.orchestration_route).toBe<OrchestrationRoute>(orchestration.route);
        expect(decision.orchestration_target).toBe<OrchestrationTarget>(orchestration.target);
      }
    }
  });

  it("carries the SOURCE lifecycle state it coordinated, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const orchestration = decidedBookingOrchestration(recorded);
      expect(coordinationLifecycleStateOf(resolveConversationCoordination(orchestration))).toBe(
        orchestration.lifecycle_state,
      );
    }
  });

  it("carries the EXACT expected prepare_booking payload the orchestration carried (self-describing, no drift)", () => {
    const orchestration = decidedBookingOrchestration(null);
    const decision = resolveConversationCoordination(orchestration);
    expect(isCoordinationDecided(decision)).toBe(true);
    if (isCoordinationDecided(decision)) {
      // The expected booking is the orchestration's own payload, carried through by reference — it can never drift.
      expect(decision.booking).toBe(orchestration.booking);
      expect(decision.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });
});

describe("R36 coordination engine — proven against the REAL R30/R31/R32/R33/R34/R35 stack + Human Review bridge (genuine composition)", () => {
  // Coordinate straight through the whole stack from a real fulfilment + a chosen record.
  const coordinationThroughStack = (
    fulfilment: FulfilmentDecision,
    recorded: RecordedFulfilmentSnapshot | null,
  ): CoordinationDecision =>
    resolveConversationCoordination(
      resolveConversationOrchestration(
        resolveConversationLifecycle(
          resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, recorded))),
        ),
      ),
    );

  it("real booking → … → govern(closed) → orchestrate(conclude) → coordinate ⇒ finalising/conversation_conclusion (autonomous)", () => {
    expect(
      coordinationThroughStack(realBookingFulfilment("review", true), CONSISTENT_SNAPSHOT),
    ).toEqual<CoordinationDecision>({
      kind: "coordinate_lifecycle_response",
      outcome: "conversation_response_coordinated",
      mode: "finalising",
      lead_participant: "conversation_conclusion",
      participants: ["conversation_conclusion"],
      participant_count: 1,
      requires_human: false,
      autonomous: true,
      orchestration_route: "conclude",
      orchestration_target: "conversation_conclusion",
      lifecycle_state: "closed",
      booking: BOOKING_ACTION,
    });
  });

  it("real booking → … → govern(retained) → orchestrate(recover) → coordinate ⇒ remediating/recovery_handling (autonomous)", () => {
    const decision = coordinationThroughStack(realBookingFulfilment("review", true), null);
    expect(coordinationModeOf(decision)).toBe<CoordinationMode>("remediating");
    expect(coordinationLeadParticipantOf(decision)).toBe<CoordinationParticipant>("recovery_handling");
    expect(coordinationRequiresHumanOf(decision)).toBe(false);
    expect(coordinationAutonomousOf(decision)).toBe(true);
  });

  it("real booking → … → govern(escalated) → orchestrate(escalate) → coordinate ⇒ escalating/human_attention (requires_human)", () => {
    const decision = coordinationThroughStack(
      realBookingFulfilment("review", true),
      withField({ status: "reversed" }),
    );
    expect(coordinationModeOf(decision)).toBe<CoordinationMode>("escalating");
    expect(coordinationLeadParticipantOf(decision)).toBe<CoordinationParticipant>("human_attention");
    expect(coordinationRequiresHumanOf(decision)).toBe(true);
    expect(coordinationAutonomousOf(decision)).toBe(false);
  });

  it("the SAME real booking, but the human DISMISSED ⇒ rejected → nothing orchestrates → NOTHING to coordinate", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    expect(coordinationThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<CoordinationDecision>({
      kind: "none",
      reason: "no_orchestration_decision",
    });
  });

  it("the SAME real booking, but NO human resolution yet ⇒ pending → nothing orchestrates → NOTHING to coordinate", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, null));
    expect(coordinationThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<CoordinationDecision>({
      kind: "none",
      reason: "no_orchestration_decision",
    });
  });

  it("a policy-blocked booking foreclosed at R29 never orchestrates → NOTHING to coordinate (policy propagates)", () => {
    const authorisation = realBookingAuthorisation("block", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(coordinationThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<CoordinationDecision>({
      kind: "none",
      reason: "no_orchestration_decision",
    });
  });

  it("the org-OFF production default (foreclosed) is likewise nothing to coordinate even on a human SENT", () => {
    const authorisation = realBookingAuthorisation("allow", false);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(coordinationThroughStack(fulfilment, null)).toEqual<CoordinationDecision>({
      kind: "none",
      reason: "no_orchestration_decision",
    });
  });
});

describe("R36 coordination engine — isCoordinationDecided / projections agree with the discriminant", () => {
  const decidedCoordination: CoordinateLifecycleResponseDecision = {
    kind: "coordinate_lifecycle_response",
    outcome: "conversation_response_coordinated",
    mode: "remediating",
    lead_participant: "recovery_handling",
    participants: ["recovery_handling"],
    participant_count: 1,
    requires_human: false,
    autonomous: true,
    orchestration_route: "recover",
    orchestration_target: "recovery_handling",
    lifecycle_state: "retained",
    booking: BOOKING_ACTION,
  };
  // Each mode with its coherent lead + route + target + requires_human + autonomous + lifecycle-state companions.
  const decidedCombos: readonly [
    CoordinationMode,
    CoordinationParticipant,
    OrchestrationRoute,
    OrchestrationTarget,
    LifecycleState,
    boolean,
    boolean,
  ][] = [
    ["finalising", "conversation_conclusion", "conclude", "conversation_conclusion", "closed", false, true],
    ["remediating", "recovery_handling", "recover", "recovery_handling", "retained", false, true],
    ["escalating", "human_attention", "escalate", "human_attention", "escalated", true, false],
  ];
  const abstentions: readonly CoordinationAbstention[] = ["no_orchestration_decision", "unsupported_orchestration"];

  const withCombo = (
    mode: CoordinationMode,
    lead: CoordinationParticipant,
    route: OrchestrationRoute,
    target: OrchestrationTarget,
    lifecycleState: LifecycleState,
    requiresHuman: boolean,
    autonomous: boolean,
  ): CoordinateLifecycleResponseDecision => ({
    ...decidedCoordination,
    mode,
    lead_participant: lead,
    participants: [lead],
    orchestration_route: route,
    orchestration_target: target,
    lifecycle_state: lifecycleState,
    requires_human: requiresHuman,
    autonomous,
  });

  it("isCoordinationDecided is TRUE for a decided coordination and narrows it", () => {
    const dec: CoordinationDecision = decidedCoordination;
    expect(isCoordinationDecided(dec)).toBe(true);
    if (isCoordinationDecided(dec)) {
      // Narrowed to CoordinateLifecycleResponseDecision — outcome, mode, lead, plan, flags and booking are reachable.
      expect(dec.outcome).toBe<CoordinationOutcome>("conversation_response_coordinated");
      expect(dec.mode).toBe<CoordinationMode>("remediating");
      expect(dec.lead_participant).toBe<CoordinationParticipant>("recovery_handling");
      expect(dec.participants).toEqual<CoordinationParticipant[]>(["recovery_handling"]);
      expect(dec.participant_count).toBe(1);
      expect(dec.requires_human).toBe(false);
      expect(dec.autonomous).toBe(true);
      expect(dec.orchestration_route).toBe<OrchestrationRoute>("recover");
      expect(dec.orchestration_target).toBe<OrchestrationTarget>("recovery_handling");
      expect(dec.lifecycle_state).toBe<LifecycleState>("retained");
      expect(dec.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });

  it("isCoordinationDecided is TRUE for a decided coordination of EVERY mode (finalising included)", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        isCoordinationDecided(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toBe(true);
    }
  });

  it("isCoordinationDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isCoordinationDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("coordinationTypeOf is coordinate_lifecycle_response for a decided arm and null for every abstention", () => {
    expect(coordinationTypeOf(decidedCoordination)).toBe<ConversationCoordinationType>("coordinate_lifecycle_response");
    for (const reason of abstentions) {
      expect(coordinationTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationOutcomeOf is conversation_response_coordinated for a decided arm and null for every abstention", () => {
    expect(coordinationOutcomeOf(decidedCoordination)).toBe<CoordinationOutcome>("conversation_response_coordinated");
    for (const reason of abstentions) {
      expect(coordinationOutcomeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationModeOf is the mode for a decided arm and null for every abstention", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        coordinationModeOf(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toBe<CoordinationMode>(mode);
    }
    for (const reason of abstentions) {
      expect(coordinationModeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationLeadParticipantOf is the lead for a decided arm and null for every abstention", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        coordinationLeadParticipantOf(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toBe<CoordinationParticipant>(lead);
    }
    for (const reason of abstentions) {
      expect(coordinationLeadParticipantOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationParticipantsOf is [lead] for a decided arm and null for every abstention", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        coordinationParticipantsOf(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toEqual<CoordinationParticipant[]>([lead]);
    }
    for (const reason of abstentions) {
      expect(coordinationParticipantsOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationParticipantCountOf is 1 for a decided arm and null for every abstention", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        coordinationParticipantCountOf(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toBe(1);
    }
    for (const reason of abstentions) {
      expect(coordinationParticipantCountOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationRequiresHumanOf is the requires_human flag for a decided arm and null for every abstention", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        coordinationRequiresHumanOf(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toBe(requiresHuman);
    }
    for (const reason of abstentions) {
      expect(coordinationRequiresHumanOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationAutonomousOf is the autonomous flag for a decided arm and null for every abstention", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        coordinationAutonomousOf(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toBe(autonomous);
    }
    for (const reason of abstentions) {
      expect(coordinationAutonomousOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationLifecycleStateOf is the source lifecycle state for a decided arm and null for every abstention", () => {
    for (const [mode, lead, route, target, lifecycleState, requiresHuman, autonomous] of decidedCombos) {
      expect(
        coordinationLifecycleStateOf(withCombo(mode, lead, route, target, lifecycleState, requiresHuman, autonomous)),
      ).toBe<LifecycleState>(lifecycleState);
    }
    for (const reason of abstentions) {
      expect(coordinationLifecycleStateOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("coordinationTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(coordinationTypeOf(decidedCoordination)).toBe(decidedCoordination.kind);
  });
});

describe("R36 coordination engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveConversationCoordination returns a coherent decision for EVERY (real orchestration × every record)", () => {
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
                  const orchestration = resolveConversationOrchestration(
                    resolveConversationLifecycle(
                      resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, recorded))),
                    ),
                  );
                  const coordination = resolveConversationCoordination(orchestration);
                  expect(
                    coordination.kind === "coordinate_lifecycle_response" || coordination.kind === "none",
                  ).toBe(true);
                  // The keystone AND the mode fold AND the single-capability plan hold on EVERY decided coordination.
                  if (isCoordinationDecided(coordination)) {
                    expect(coordination.requires_human).toBe(coordination.lead_participant === "human_attention");
                    expect(coordination.autonomous).toBe(coordination.lead_participant !== "human_attention");
                    const expectedMode: CoordinationMode =
                      coordination.orchestration_route === "conclude"
                        ? "finalising"
                        : coordination.orchestration_route === "recover"
                          ? "remediating"
                          : "escalating";
                    expect(coordination.mode).toBe(expectedMode);
                    // The lead is R35's routed target, and the plan is the singleton [lead].
                    expect(coordination.lead_participant).toBe(coordination.orchestration_target);
                    expect(coordination.participants).toEqual([coordination.lead_participant]);
                    expect(coordination.participant_count).toBe(1);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("a coordination is DECIDED iff the orchestration was decided (the mode never opens or closes the gate)", () => {
    const orchestrationAbstained: OrchestrationDecision = { kind: "none", reason: "no_lifecycle_decision" };
    expect(isCoordinationDecided(resolveConversationCoordination(orchestrationAbstained))).toBe(false);
    // A decided orchestration ALWAYS yields a decided coordination (whatever the mode); the mode only chooses the lead +
    // requires_human/autonomous flags, never whether a coordination exists.
    for (const recorded of ALL_RECORDS) {
      expect(isCoordinationDecided(resolveConversationCoordination(decidedBookingOrchestration(recorded)))).toBe(true);
    }
  });

  it("is DETERMINISTIC — the same orchestration always yields an equal coordination", () => {
    for (const recorded of ALL_RECORDS) {
      const orchestration = decidedBookingOrchestration(recorded);
      expect(resolveConversationCoordination(orchestration)).toEqual(resolveConversationCoordination(orchestration));
    }
  });

  it("does NOT mutate the orchestration decision it reads", () => {
    const orchestration = decidedBookingOrchestration(CONSISTENT_SNAPSHOT);
    const snap = JSON.stringify(orchestration);
    resolveConversationCoordination(orchestration);
    expect(JSON.stringify(orchestration)).toBe(snap);
  });
});

// A compile-time proof that `ConversationOrchestrationType` is exhaustively mapped by ORCHESTRATION_COORDINATION — if R35
// adds an orchestration type without a matching ORCHESTRATION_COORDINATION entry, this reference fails to type-check.
const _exhaustiveOrchestrationMap: Readonly<
  Record<ConversationOrchestrationType, ConversationCoordinationType | null>
> = ORCHESTRATION_COORDINATION;
void _exhaustiveOrchestrationMap;
