import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_TYPES,
  RESOLUTION_LIFECYCLE,
  resolveConversationLifecycle,
  isLifecycleDecided,
  lifecycleTypeOf,
  lifecycleOutcomeOf,
  lifecycleTransitionOf,
  lifecycleStateOf,
  lifecycleClosedOf,
  lifecycleOngoingOf,
  lifecycleResolutionStateOf,
  type ConversationLifecycleType,
  type LifecycleOutcome,
  type LifecycleState,
  type LifecycleTransition,
  type LifecycleDecision,
  type GovernResolutionLifecycleDecision,
  type LifecycleAbstention,
} from "@/lib/receptionist/conversation-lifecycle";
import {
  RESOLUTION_TYPES,
  resolveConversationResolution,
  isResolutionDecided,
  type ConversationResolutionType,
  type ResolutionState,
  type ResolutionDecision,
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
 * THE CONVERSATION LIFECYCLE ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R34 — CONVERSATION LIFECYCLE ENGINE).
 *
 * lib/receptionist/conversation-lifecycle.ts is the deterministic, leaf authority over the FOURTH layer that does not
 * perform: "given a resolution the stack DETERMINED, what LIFECYCLE TRANSITION does the conversation now undergo, and
 * what lifecycle STATE does it come to rest in?". It is a TOTAL, DETERMINISTIC function of ONE already-computed input —
 * the R33 resolution decision (the DEFERRAL gate) — so it is exhaustively unit-testable in isolation. Every resolution
 * fed in is the REAL {@link resolveConversationResolution} over the REAL R32 {@link resolveRecovery} / R31
 * {@link resolveVerification} / R30 {@link resolveFulfilment} / R29 {@link resolveAuthorisation} / R28
 * {@link resolveExecution} stack with the grant folded by R29's OWN {@link deriveAuthorisationState} — so the engine is
 * proven against genuine composition, never a hand-built decision. These tests pin, EXHAUSTIVELY:
 *   • LIFECYCLE_TYPES is the closed lifecycle vocabulary — exactly `govern_resolution_lifecycle` in R34, no dupes;
 *   • RESOLUTION_LIFECYCLE is TOTAL over the R33 resolution vocabulary and maps resolve_booking_recovery →
 *     govern_resolution_lifecycle (so a future resolution type cannot silently reach the engine ungoverned);
 *   • resolveConversationLifecycle DEFERS `no_resolution_decision` whenever the Resolution Engine abstained — the FIRST
 *     gate, so the Resolution Engine (and transitively Recovery, Verification, Fulfilment, Authorisation, Execution,
 *     Action and Outcome) stays authoritative;
 *   • THE TWO-STAGE FOLD — a decided resolution folds to a `close` transition when `terminal`, `retain` when
 *     `recoverable`, and `escalate` when `unresolved`; the transition folds to `closed` / `retained` / `escalated`
 *     respectively — and a decision is PRODUCED for all three (`closed` is a governance that the conversation's
 *     lifecycle is complete, NOT an abstention);
 *   • THE KEYSTONE — `closed` is TRUE iff the state is `closed`, and `ongoing` is TRUE iff it is NOT, on every decided
 *     lifecycle (Directive #018 R34's two distinct questions, made coherent);
 *   • the govern_resolution_lifecycle fold — a decided resolution ⇒ (conversation_lifecycle_governed, the transition,
 *     the state, the closed + ongoing flags, the source resolution state, the EXPECTED prepare_booking payload the
 *     resolution carried), self-describing and non-drifting;
 *   • the projections isLifecycleDecided / lifecycleTypeOf / lifecycleOutcomeOf / lifecycleTransitionOf /
 *     lifecycleStateOf / lifecycleClosedOf / lifecycleOngoingOf / lifecycleResolutionStateOf agree with the
 *     discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it GOVERNS nothing itself — it names the
 *     transition and stops.
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

// The concrete prepare_booking action the resolution carries (equal to the one the REAL composition yields).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed lifecycle vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not read
// their own answer from LIFECYCLE_TYPES (the surface under test).
const ALL_LIFECYCLE_TYPES: readonly ConversationLifecycleType[] = ["govern_resolution_lifecycle"];
// The whole lifecycle-state vocabulary, as an INDEPENDENT reference set.
const ALL_LIFECYCLE_STATES: readonly LifecycleState[] = ["closed", "retained", "escalated"];
// The whole lifecycle-transition vocabulary, as an INDEPENDENT reference set.
const ALL_TRANSITIONS: readonly LifecycleTransition[] = ["close", "retain", "escalate"];
// The whole resolution-state vocabulary the engine folds over, as an INDEPENDENT reference set.
const ALL_RESOLUTION_STATES: readonly ResolutionState[] = ["terminal", "recoverable", "unresolved"];

// The RECORDED snapshot that MATCHES a decided fulfilment over BOOKING_ACTION — reconciles to `consistent`, recovers
// to `none`, resolves to `terminal`, governs to `close`/`closed`.
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
// `reconcile`, resolves to `unresolved`, governs to `escalate`/`escalated`.
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

// Every record shape — the matching one (terminal ⇒ close ⇒ closed), the absence (missing ⇒ reinstate ⇒ recoverable ⇒
// retain ⇒ retained), and each single-field divergence (inconsistent ⇒ reconcile ⇒ unresolved ⇒ escalate ⇒ escalated).
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

// The REAL, DECIDED resolution (over a chosen record) — the input the Lifecycle Engine governs. A decided recovery
// always resolves, so an abstention here is a broken fixture: fail loudly.
const decidedBookingResolution = (recorded: RecordedFulfilmentSnapshot | null): ResolveBookingRecoveryDecision => {
  const decision = resolveConversationResolution(decidedBookingRecovery(recorded));
  if (!isResolutionDecided(decision)) {
    throw new Error(`expected a decided resolution, got abstention: ${decision.reason}`);
  }
  return decision;
};

describe("R34 lifecycle engine — LIFECYCLE_TYPES: the closed lifecycle vocabulary", () => {
  it("is EXACTLY `govern_resolution_lifecycle` in R34 (quote/scheduling lifecycle types are future work)", () => {
    expect(LIFECYCLE_TYPES).toEqual(["govern_resolution_lifecycle"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(LIFECYCLE_TYPES).size).toBe(LIFECYCLE_TYPES.length);
    expect([...LIFECYCLE_TYPES].sort()).toEqual([...ALL_LIFECYCLE_TYPES].sort());
  });
});

describe("R34 lifecycle engine — RESOLUTION_LIFECYCLE: the total resolution → lifecycle-type map", () => {
  it("is TOTAL over the whole R33 resolution vocabulary (every resolution type has an entry)", () => {
    expect(Object.keys(RESOLUTION_LIFECYCLE).sort()).toEqual([...RESOLUTION_TYPES].sort());
  });

  it("maps resolve_booking_recovery → govern_resolution_lifecycle", () => {
    expect(RESOLUTION_LIFECYCLE.resolve_booking_recovery).toBe<ConversationLifecycleType>(
      "govern_resolution_lifecycle",
    );
  });

  it("every non-null lifecycle type is in the LIFECYCLE_TYPES vocabulary (no orphan mapping today)", () => {
    for (const resolutionType of RESOLUTION_TYPES) {
      const type = RESOLUTION_LIFECYCLE[resolutionType];
      if (type !== null) expect(LIFECYCLE_TYPES).toContain(type);
    }
  });

  it("has NO null entries today — so `unsupported_resolution` is dormant defence-in-depth (unreachable via a real resolution)", () => {
    for (const resolutionType of RESOLUTION_TYPES) {
      expect(RESOLUTION_LIFECYCLE[resolutionType]).not.toBeNull();
    }
  });
});

describe("R34 lifecycle engine — resolveConversationLifecycle: the Resolution Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R33 engine can return — the Lifecycle Engine must defer on each.
  const resolutionAbstentions = ["no_recovery_decision", "unsupported_recovery"] as const;

  for (const reason of resolutionAbstentions) {
    it(`resolution abstention (${reason}) → no_resolution_decision`, () => {
      expect(resolveConversationLifecycle({ kind: "none", reason })).toEqual<LifecycleDecision>({
        kind: "none",
        reason: "no_resolution_decision",
      });
    });
  }

  it("a REAL abstained resolution (the recovery was never decided) → no_resolution_decision", () => {
    // Drive a genuine deferral: a dismissed booking never fulfils, so R31 defers, so R32 defers, so R33 defers, so R34
    // defers.
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    const resolution = resolveConversationResolution(
      resolveRecovery(resolveVerification(fulfilment, CONSISTENT_SNAPSHOT)),
    );
    expect(isResolutionDecided(resolution)).toBe(false);
    expect(resolveConversationLifecycle(resolution)).toEqual<LifecycleDecision>({
      kind: "none",
      reason: "no_resolution_decision",
    });
  });
});

describe("R34 lifecycle engine — THE TWO-STAGE FOLD: state→transition→lifecycle-state", () => {
  it("a terminal resolution → close → closed (the conversation's lifecycle is complete)", () => {
    expect(resolveConversationLifecycle(decidedBookingResolution(CONSISTENT_SNAPSHOT))).toEqual<LifecycleDecision>({
      kind: "govern_resolution_lifecycle",
      outcome: "conversation_lifecycle_governed",
      transition: "close",
      state: "closed",
      closed: true,
      ongoing: false,
      resolution_state: "terminal",
      booking: BOOKING_ACTION,
    });
  });

  it("a recoverable resolution → retain → retained (a clear recovery path, held open, still ongoing)", () => {
    expect(resolveConversationLifecycle(decidedBookingResolution(null))).toEqual<LifecycleDecision>({
      kind: "govern_resolution_lifecycle",
      outcome: "conversation_lifecycle_governed",
      transition: "retain",
      state: "retained",
      closed: false,
      ongoing: true,
      resolution_state: "recoverable",
      booking: BOOKING_ACTION,
    });
  });

  it("an unresolved resolution (a record diverging in ANY field) → escalate → escalated", () => {
    for (const recorded of DIVERGENT_SNAPSHOTS) {
      expect(resolveConversationLifecycle(decidedBookingResolution(recorded))).toEqual<LifecycleDecision>({
        kind: "govern_resolution_lifecycle",
        outcome: "conversation_lifecycle_governed",
        transition: "escalate",
        state: "escalated",
        closed: false,
        ongoing: true,
        resolution_state: "unresolved",
        booking: BOOKING_ACTION,
      });
    }
  });

  it("the transition is the deterministic fold of the resolution state (a total mapping)", () => {
    const fold: Record<ResolutionState, LifecycleTransition> = {
      terminal: "close",
      recoverable: "retain",
      unresolved: "escalate",
    };
    for (const recorded of ALL_RECORDS) {
      const resolution = decidedBookingResolution(recorded);
      expect(lifecycleTransitionOf(resolveConversationLifecycle(resolution))).toBe(fold[resolution.state]);
    }
  });

  it("the lifecycle state is the deterministic fold of the transition (close→closed, retain→retained, escalate→escalated)", () => {
    const fold: Record<LifecycleTransition, LifecycleState> = {
      close: "closed",
      retain: "retained",
      escalate: "escalated",
    };
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationLifecycle(decidedBookingResolution(recorded));
      const transition = lifecycleTransitionOf(decision);
      const state = lifecycleStateOf(decision);
      if (transition !== null) expect(state).toBe(fold[transition]);
    }
  });

  it("state → lifecycle-state is the composed fold (terminal→closed, recoverable→retained, unresolved→escalated)", () => {
    const fold: Record<ResolutionState, LifecycleState> = {
      terminal: "closed",
      recoverable: "retained",
      unresolved: "escalated",
    };
    for (const recorded of ALL_RECORDS) {
      const resolution = decidedBookingResolution(recorded);
      expect(lifecycleStateOf(resolveConversationLifecycle(resolution))).toBe(fold[resolution.state]);
    }
  });

  it("a DECISION is produced for ALL three states — closed/retained/escalated are NOT abstentions", () => {
    // The whole point of the engine is to GOVERN the lifecycle; a real (decided) governance is produced for each
    // disposition, carrying the transition + state. isLifecycleDecided is TRUE for all three (including the closed case).
    for (const recorded of ALL_RECORDS) {
      expect(isLifecycleDecided(resolveConversationLifecycle(decidedBookingResolution(recorded)))).toBe(true);
    }
  });

  it("the three lifecycle states are reachable and distinct over the SAME decided resolution path", () => {
    const seenStates = new Set<LifecycleState>();
    const seenTransitions = new Set<LifecycleTransition>();
    const seenResolutionStates = new Set<ResolutionState>();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, withField({ job_type: "electrical" })]) {
      const decision = resolveConversationLifecycle(decidedBookingResolution(recorded));
      const state = lifecycleStateOf(decision);
      const transition = lifecycleTransitionOf(decision);
      const resolutionState = lifecycleResolutionStateOf(decision);
      if (state !== null) seenStates.add(state);
      if (transition !== null) seenTransitions.add(transition);
      if (resolutionState !== null) seenResolutionStates.add(resolutionState);
    }
    expect([...seenStates].sort()).toEqual([...ALL_LIFECYCLE_STATES].sort());
    expect([...seenTransitions].sort()).toEqual([...ALL_TRANSITIONS].sort());
    // The three source resolution states the engine folds over are ALL reachable across the same path.
    expect([...seenResolutionStates].sort()).toEqual([...ALL_RESOLUTION_STATES].sort());
  });
});

describe("R34 lifecycle engine — THE KEYSTONE: closed = (state === 'closed'), ongoing = (state !== 'closed')", () => {
  it("closed/ongoing flags are coherent with the lifecycle state, over every real disposition", () => {
    const cases: readonly [RecordedFulfilmentSnapshot | null, LifecycleState, boolean, boolean][] = [
      [CONSISTENT_SNAPSHOT, "closed", true, false],
      [null, "retained", false, true],
      [withField({ job_type: "electrical" }), "escalated", false, true],
    ];
    for (const [recorded, state, closed, ongoing] of cases) {
      const decision = resolveConversationLifecycle(decidedBookingResolution(recorded));
      expect(isLifecycleDecided(decision)).toBe(true);
      if (isLifecycleDecided(decision)) {
        expect(decision.state).toBe(state);
        expect(decision.closed).toBe(closed);
        expect(decision.ongoing).toBe(ongoing);
      }
    }
  });

  it("the keystone holds on EVERY decided lifecycle produced over every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationLifecycle(decidedBookingResolution(recorded));
      if (isLifecycleDecided(decision)) {
        expect(decision.closed).toBe(decision.state === "closed");
        expect(decision.ongoing).toBe(decision.state !== "closed");
        // The two flags are exact complements — a conversation is closed XOR it remains ongoing.
        expect(decision.closed).toBe(!decision.ongoing);
      }
    }
  });
});

describe("R34 lifecycle engine — the govern_resolution_lifecycle fold (outcome + source resolution state + payload)", () => {
  it("a decided resolution ⇒ conversation_lifecycle_governed, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      expect(
        lifecycleOutcomeOf(resolveConversationLifecycle(decidedBookingResolution(recorded))),
      ).toBe<LifecycleOutcome>("conversation_lifecycle_governed");
    }
  });

  it("carries the SOURCE resolution state it governed, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const resolution = decidedBookingResolution(recorded);
      expect(lifecycleResolutionStateOf(resolveConversationLifecycle(resolution))).toBe(resolution.state);
    }
  });

  it("carries the EXACT expected prepare_booking payload the resolution carried (self-describing, no drift)", () => {
    const resolution = decidedBookingResolution(null);
    const decision = resolveConversationLifecycle(resolution);
    expect(isLifecycleDecided(decision)).toBe(true);
    if (isLifecycleDecided(decision)) {
      // The expected booking is the resolution's own payload, carried through by reference — it can never drift.
      expect(decision.booking).toBe(resolution.booking);
      expect(decision.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });
});

describe("R34 lifecycle engine — proven against the REAL R30/R31/R32/R33 stack + Human Review bridge (genuine composition)", () => {
  // Govern straight through the whole stack from a real fulfilment + a chosen record.
  const lifecycleThroughStack = (
    fulfilment: FulfilmentDecision,
    recorded: RecordedFulfilmentSnapshot | null,
  ): LifecycleDecision =>
    resolveConversationLifecycle(
      resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, recorded))),
    );

  it("real booking → fulfil → verify(matching) → recover(none) → resolve(terminal) → govern ⇒ close/closed", () => {
    expect(
      lifecycleThroughStack(realBookingFulfilment("review", true), CONSISTENT_SNAPSHOT),
    ).toEqual<LifecycleDecision>({
      kind: "govern_resolution_lifecycle",
      outcome: "conversation_lifecycle_governed",
      transition: "close",
      state: "closed",
      closed: true,
      ongoing: false,
      resolution_state: "terminal",
      booking: BOOKING_ACTION,
    });
  });

  it("real booking → fulfil → verify(no record) → recover(reinstate) → resolve(recoverable) → govern ⇒ retain/retained", () => {
    const decision = lifecycleThroughStack(realBookingFulfilment("review", true), null);
    expect(lifecycleTransitionOf(decision)).toBe<LifecycleTransition>("retain");
    expect(lifecycleStateOf(decision)).toBe<LifecycleState>("retained");
    expect(lifecycleClosedOf(decision)).toBe(false);
    expect(lifecycleOngoingOf(decision)).toBe(true);
  });

  it("real booking → fulfil → verify(divergent) → recover(reconcile) → resolve(unresolved) → govern ⇒ escalate/escalated", () => {
    const decision = lifecycleThroughStack(realBookingFulfilment("review", true), withField({ status: "reversed" }));
    expect(lifecycleTransitionOf(decision)).toBe<LifecycleTransition>("escalate");
    expect(lifecycleStateOf(decision)).toBe<LifecycleState>("escalated");
    expect(lifecycleClosedOf(decision)).toBe(false);
    expect(lifecycleOngoingOf(decision)).toBe(true);
  });

  it("the SAME real booking, but the human DISMISSED ⇒ rejected → nothing resolves → NOTHING to govern", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    expect(lifecycleThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<LifecycleDecision>({
      kind: "none",
      reason: "no_resolution_decision",
    });
  });

  it("the SAME real booking, but NO human resolution yet ⇒ pending → nothing resolves → NOTHING to govern", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, null));
    expect(lifecycleThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<LifecycleDecision>({
      kind: "none",
      reason: "no_resolution_decision",
    });
  });

  it("a policy-blocked booking foreclosed at R29 never resolves → NOTHING to govern (policy propagates)", () => {
    const authorisation = realBookingAuthorisation("block", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(lifecycleThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<LifecycleDecision>({
      kind: "none",
      reason: "no_resolution_decision",
    });
  });

  it("the org-OFF production default (foreclosed) is likewise nothing to govern even on a human SENT", () => {
    const authorisation = realBookingAuthorisation("allow", false);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(lifecycleThroughStack(fulfilment, null)).toEqual<LifecycleDecision>({
      kind: "none",
      reason: "no_resolution_decision",
    });
  });
});

describe("R34 lifecycle engine — isLifecycleDecided / projections agree with the discriminant", () => {
  const decidedLifecycle: GovernResolutionLifecycleDecision = {
    kind: "govern_resolution_lifecycle",
    outcome: "conversation_lifecycle_governed",
    transition: "retain",
    state: "retained",
    closed: false,
    ongoing: true,
    resolution_state: "recoverable",
    booking: BOOKING_ACTION,
  };
  // Each resolution state with its coherent transition + state + closed + ongoing companions.
  const decidedCombos: readonly [ResolutionState, LifecycleTransition, LifecycleState, boolean, boolean][] = [
    ["terminal", "close", "closed", true, false],
    ["recoverable", "retain", "retained", false, true],
    ["unresolved", "escalate", "escalated", false, true],
  ];
  const abstentions: readonly LifecycleAbstention[] = ["no_resolution_decision", "unsupported_resolution"];

  const withCombo = (
    resolutionState: ResolutionState,
    transition: LifecycleTransition,
    state: LifecycleState,
    closed: boolean,
    ongoing: boolean,
  ): GovernResolutionLifecycleDecision => ({
    ...decidedLifecycle,
    resolution_state: resolutionState,
    transition,
    state,
    closed,
    ongoing,
  });

  it("isLifecycleDecided is TRUE for a decided lifecycle and narrows it", () => {
    const dec: LifecycleDecision = decidedLifecycle;
    expect(isLifecycleDecided(dec)).toBe(true);
    if (isLifecycleDecided(dec)) {
      // Narrowed to GovernResolutionLifecycleDecision — outcome, transition, state, flags and booking are reachable.
      expect(dec.outcome).toBe<LifecycleOutcome>("conversation_lifecycle_governed");
      expect(dec.transition).toBe<LifecycleTransition>("retain");
      expect(dec.state).toBe<LifecycleState>("retained");
      expect(dec.closed).toBe(false);
      expect(dec.ongoing).toBe(true);
      expect(dec.resolution_state).toBe<ResolutionState>("recoverable");
      expect(dec.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });

  it("isLifecycleDecided is TRUE for a decided lifecycle of EVERY state (closed included)", () => {
    for (const [resolutionState, transition, state, closed, ongoing] of decidedCombos) {
      expect(isLifecycleDecided(withCombo(resolutionState, transition, state, closed, ongoing))).toBe(true);
    }
  });

  it("isLifecycleDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isLifecycleDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("lifecycleTypeOf is govern_resolution_lifecycle for a decided arm and null for every abstention", () => {
    expect(lifecycleTypeOf(decidedLifecycle)).toBe<ConversationLifecycleType>("govern_resolution_lifecycle");
    for (const reason of abstentions) {
      expect(lifecycleTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("lifecycleOutcomeOf is conversation_lifecycle_governed for a decided arm and null for every abstention", () => {
    expect(lifecycleOutcomeOf(decidedLifecycle)).toBe<LifecycleOutcome>("conversation_lifecycle_governed");
    for (const reason of abstentions) {
      expect(lifecycleOutcomeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("lifecycleTransitionOf is the transition for a decided arm and null for every abstention", () => {
    for (const [resolutionState, transition, state, closed, ongoing] of decidedCombos) {
      expect(lifecycleTransitionOf(withCombo(resolutionState, transition, state, closed, ongoing))).toBe<
        LifecycleTransition
      >(transition);
    }
    for (const reason of abstentions) {
      expect(lifecycleTransitionOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("lifecycleStateOf is the state for a decided arm and null for every abstention", () => {
    for (const [resolutionState, transition, state, closed, ongoing] of decidedCombos) {
      expect(lifecycleStateOf(withCombo(resolutionState, transition, state, closed, ongoing))).toBe<LifecycleState>(
        state,
      );
    }
    for (const reason of abstentions) {
      expect(lifecycleStateOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("lifecycleClosedOf is the closed flag for a decided arm and null for every abstention", () => {
    for (const [resolutionState, transition, state, closed, ongoing] of decidedCombos) {
      expect(lifecycleClosedOf(withCombo(resolutionState, transition, state, closed, ongoing))).toBe(closed);
    }
    for (const reason of abstentions) {
      expect(lifecycleClosedOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("lifecycleOngoingOf is the ongoing flag for a decided arm and null for every abstention", () => {
    for (const [resolutionState, transition, state, closed, ongoing] of decidedCombos) {
      expect(lifecycleOngoingOf(withCombo(resolutionState, transition, state, closed, ongoing))).toBe(ongoing);
    }
    for (const reason of abstentions) {
      expect(lifecycleOngoingOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("lifecycleResolutionStateOf is the source resolution state for a decided arm and null for every abstention", () => {
    for (const [resolutionState, transition, state, closed, ongoing] of decidedCombos) {
      expect(lifecycleResolutionStateOf(withCombo(resolutionState, transition, state, closed, ongoing))).toBe<
        ResolutionState
      >(resolutionState);
    }
    for (const reason of abstentions) {
      expect(lifecycleResolutionStateOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("lifecycleTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(lifecycleTypeOf(decidedLifecycle)).toBe(decidedLifecycle.kind);
  });
});

describe("R34 lifecycle engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveConversationLifecycle returns a coherent decision for EVERY (real resolution × every record)", () => {
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
                  const resolution = resolveConversationResolution(
                    resolveRecovery(resolveVerification(fulfilment, recorded)),
                  );
                  const lifecycle = resolveConversationLifecycle(resolution);
                  expect(
                    lifecycle.kind === "govern_resolution_lifecycle" || lifecycle.kind === "none",
                  ).toBe(true);
                  // The keystone AND the two-stage fold hold on EVERY decided lifecycle produced anywhere in the sweep.
                  if (isLifecycleDecided(lifecycle)) {
                    expect(lifecycle.closed).toBe(lifecycle.state === "closed");
                    expect(lifecycle.ongoing).toBe(lifecycle.state !== "closed");
                    const expectedState: LifecycleState =
                      lifecycle.transition === "close"
                        ? "closed"
                        : lifecycle.transition === "retain"
                          ? "retained"
                          : "escalated";
                    expect(lifecycle.state).toBe(expectedState);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("a lifecycle is DECIDED iff the resolution was decided (the state never opens or closes the gate)", () => {
    const resolutionAbstained: ResolutionDecision = { kind: "none", reason: "no_recovery_decision" };
    expect(isLifecycleDecided(resolveConversationLifecycle(resolutionAbstained))).toBe(false);
    // A decided resolution ALWAYS yields a decided lifecycle (whatever the state); the state only chooses the transition
    // + resting state, never whether a lifecycle governance exists.
    for (const recorded of ALL_RECORDS) {
      expect(isLifecycleDecided(resolveConversationLifecycle(decidedBookingResolution(recorded)))).toBe(true);
    }
  });

  it("is DETERMINISTIC — the same resolution always yields an equal lifecycle", () => {
    for (const recorded of ALL_RECORDS) {
      const resolution = decidedBookingResolution(recorded);
      expect(resolveConversationLifecycle(resolution)).toEqual(resolveConversationLifecycle(resolution));
    }
  });

  it("does NOT mutate the resolution decision it reads", () => {
    const resolution = decidedBookingResolution(CONSISTENT_SNAPSHOT);
    const snap = JSON.stringify(resolution);
    resolveConversationLifecycle(resolution);
    expect(JSON.stringify(resolution)).toBe(snap);
  });
});

// A compile-time proof that `ConversationResolutionType` is exhaustively mapped by RESOLUTION_LIFECYCLE — if R33 adds a
// resolution type without a matching RESOLUTION_LIFECYCLE entry, this reference fails to type-check.
const _exhaustiveResolutionMap: Readonly<
  Record<ConversationResolutionType, ConversationLifecycleType | null>
> = RESOLUTION_LIFECYCLE;
void _exhaustiveResolutionMap;
