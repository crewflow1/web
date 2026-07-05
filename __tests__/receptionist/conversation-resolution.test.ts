import { describe, it, expect } from "vitest";
import {
  RESOLUTION_TYPES,
  RECOVERY_RESOLUTION,
  resolveConversationResolution,
  isResolutionDecided,
  resolutionTypeOf,
  resolutionOutcomeOf,
  resolutionStateOf,
  resolutionTerminalOf,
  resolutionInterventionRequiredOf,
  resolutionClassificationOf,
  type ConversationResolutionType,
  type ResolutionOutcome,
  type ResolutionState,
  type ResolutionDecision,
  type ResolveBookingRecoveryDecision,
  type ResolutionAbstention,
} from "@/lib/receptionist/conversation-resolution";
import {
  RECOVERY_TYPES,
  resolveRecovery,
  isRecoveryDecided,
  type ConversationRecoveryType,
  type RecoveryClassification,
  type RecoveryDecision,
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
 * THE CONVERSATION RESOLUTION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R33 — CONVERSATION RESOLUTION ENGINE).
 *
 * lib/receptionist/conversation-resolution.ts is the deterministic, leaf authority over the THIRD layer that does not
 * perform: "given a recovery the stack DETERMINED, has the conversation reached a TERMINAL, RECOVERABLE or UNRESOLVED
 * state, and does it require further intervention?". It is a TOTAL, DETERMINISTIC function of ONE already-computed
 * input — the R32 recovery decision (the DEFERRAL gate) — so it is exhaustively unit-testable in isolation. Every
 * recovery fed in is the REAL {@link resolveRecovery} over the REAL R31 {@link resolveVerification} / R30
 * {@link resolveFulfilment} / R29 {@link resolveAuthorisation} / R28 {@link resolveExecution} stack with the grant
 * folded by R29's OWN {@link deriveAuthorisationState} — so the engine is proven against genuine composition, never a
 * hand-built decision. These tests pin, EXHAUSTIVELY:
 *   • RESOLUTION_TYPES is the closed resolution vocabulary — exactly `resolve_booking_recovery` in R33, no dupes;
 *   • RECOVERY_RESOLUTION is TOTAL over the R32 recovery vocabulary and maps recover_booking_fulfilment →
 *     resolve_booking_recovery (so a future recovery type cannot silently reach the engine unresolved);
 *   • resolveConversationResolution DEFERS `no_recovery_decision` whenever the Recovery Engine abstained — the FIRST
 *     gate, so the Recovery Engine (and transitively Verification, Fulfilment, Authorisation, Execution, Action and
 *     Outcome) stays authoritative;
 *   • THE STATE FOLD — a decided recovery classifies to `terminal` when `none`, `recoverable` when `reinstate`, and
 *     `unresolved` when `reconcile` — and a decision is PRODUCED for all three (`terminal` is a determination that the
 *     conversation is complete, NOT an abstention);
 *   • THE KEYSTONE — `terminal` is TRUE iff the state is `terminal`, and `intervention_required` is TRUE iff it is
 *     NOT, on every decided resolution (Directive #018 R33's two distinct questions, made coherent);
 *   • the resolve_booking_recovery fold — a decided recovery ⇒ (conversation_resolution_determined, the state, the
 *     terminal + intervention flags, the source recovery classification, the EXPECTED prepare_booking payload the
 *     recovery carried), self-describing and non-drifting;
 *   • the projections isResolutionDecided / resolutionTypeOf / resolutionOutcomeOf / resolutionStateOf /
 *     resolutionTerminalOf / resolutionInterventionRequiredOf / resolutionClassificationOf agree with the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it RESOLVES nothing itself — it names the
 *     resolution and stops.
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

// The concrete prepare_booking action the recovery carries (equal to the one the REAL composition yields).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed resolution vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not read
// their own answer from RESOLUTION_TYPES (the surface under test).
const ALL_RESOLUTION_TYPES: readonly ConversationResolutionType[] = ["resolve_booking_recovery"];
// The whole resolution-state vocabulary, as an INDEPENDENT reference set.
const ALL_STATES: readonly ResolutionState[] = ["terminal", "recoverable", "unresolved"];

// The RECORDED snapshot that MATCHES a decided fulfilment over BOOKING_ACTION — reconciles to `consistent`, recovers
// to `none`, resolves to `terminal`.
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
// `reconcile`, resolves to `unresolved`.
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

// Every record shape — the matching one, the absence (missing ⇒ reinstate ⇒ recoverable), and each single-field
// divergence (inconsistent ⇒ reconcile ⇒ unresolved).
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

// The REAL, DECIDED recovery (over a chosen record) — the input the Resolution Engine classifies. A decided
// verification always recovers, so an abstention here is a broken fixture: fail loudly.
const decidedBookingRecovery = (recorded: RecordedFulfilmentSnapshot | null): RecoverBookingDecision => {
  const decision = resolveRecovery(decidedBookingVerification(recorded));
  if (!isRecoveryDecided(decision)) {
    throw new Error(`expected a decided recovery, got abstention: ${decision.reason}`);
  }
  return decision;
};

describe("R33 resolution engine — RESOLUTION_TYPES: the closed resolution vocabulary", () => {
  it("is EXACTLY `resolve_booking_recovery` in R33 (quote/scheduling resolution types are future work)", () => {
    expect(RESOLUTION_TYPES).toEqual(["resolve_booking_recovery"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(RESOLUTION_TYPES).size).toBe(RESOLUTION_TYPES.length);
    expect([...RESOLUTION_TYPES].sort()).toEqual([...ALL_RESOLUTION_TYPES].sort());
  });
});

describe("R33 resolution engine — RECOVERY_RESOLUTION: the total recovery → resolution-type map", () => {
  it("is TOTAL over the whole R32 recovery vocabulary (every recovery type has an entry)", () => {
    expect(Object.keys(RECOVERY_RESOLUTION).sort()).toEqual([...RECOVERY_TYPES].sort());
  });

  it("maps recover_booking_fulfilment → resolve_booking_recovery", () => {
    expect(RECOVERY_RESOLUTION.recover_booking_fulfilment).toBe<ConversationResolutionType>(
      "resolve_booking_recovery",
    );
  });

  it("every non-null resolution type is in the RESOLUTION_TYPES vocabulary (no orphan mapping today)", () => {
    for (const recoveryType of RECOVERY_TYPES) {
      const type = RECOVERY_RESOLUTION[recoveryType];
      if (type !== null) expect(RESOLUTION_TYPES).toContain(type);
    }
  });

  it("has NO null entries today — so `unsupported_recovery` is dormant defence-in-depth (unreachable via a real recovery)", () => {
    for (const recoveryType of RECOVERY_TYPES) {
      expect(RECOVERY_RESOLUTION[recoveryType]).not.toBeNull();
    }
  });
});

describe("R33 resolution engine — resolveConversationResolution: the Recovery Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R32 engine can return — the Resolution Engine must defer on each.
  const recoveryAbstentions = ["no_verification_decision", "unsupported_verification"] as const;

  for (const reason of recoveryAbstentions) {
    it(`recovery abstention (${reason}) → no_recovery_decision`, () => {
      expect(resolveConversationResolution({ kind: "none", reason })).toEqual<ResolutionDecision>({
        kind: "none",
        reason: "no_recovery_decision",
      });
    });
  }

  it("a REAL abstained recovery (the verification was never decided) → no_recovery_decision", () => {
    // Drive a genuine deferral: a dismissed booking never fulfils, so R31 defers, so R32 defers, so R33 defers.
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    const verification = resolveVerification(fulfilment, CONSISTENT_SNAPSHOT);
    const recovery = resolveRecovery(verification);
    expect(isRecoveryDecided(recovery)).toBe(false);
    expect(resolveConversationResolution(recovery)).toEqual<ResolutionDecision>({
      kind: "none",
      reason: "no_recovery_decision",
    });
  });
});

describe("R33 resolution engine — THE STATE FOLD: none→terminal, reinstate→recoverable, reconcile→unresolved", () => {
  it("a none recovery → terminal (the conversation is fully resolved, no further intervention)", () => {
    expect(resolveConversationResolution(decidedBookingRecovery(CONSISTENT_SNAPSHOT))).toEqual<ResolutionDecision>({
      kind: "resolve_booking_recovery",
      outcome: "conversation_resolution_determined",
      state: "terminal",
      terminal: true,
      intervention_required: false,
      classification: "none",
      booking: BOOKING_ACTION,
    });
  });

  it("a reinstate recovery → recoverable (a clear recovery path exists, further intervention required)", () => {
    expect(resolveConversationResolution(decidedBookingRecovery(null))).toEqual<ResolutionDecision>({
      kind: "resolve_booking_recovery",
      outcome: "conversation_resolution_determined",
      state: "recoverable",
      terminal: false,
      intervention_required: true,
      classification: "reinstate",
      booking: BOOKING_ACTION,
    });
  });

  it("a reconcile recovery (a record diverging in ANY field) → unresolved", () => {
    for (const recorded of DIVERGENT_SNAPSHOTS) {
      expect(resolveConversationResolution(decidedBookingRecovery(recorded))).toEqual<ResolutionDecision>({
        kind: "resolve_booking_recovery",
        outcome: "conversation_resolution_determined",
        state: "unresolved",
        terminal: false,
        intervention_required: true,
        classification: "reconcile",
        booking: BOOKING_ACTION,
      });
    }
  });

  it("the state is the deterministic fold of the recovery classification (a total mapping)", () => {
    const fold: Record<RecoveryClassification, ResolutionState> = {
      none: "terminal",
      reinstate: "recoverable",
      reconcile: "unresolved",
    };
    for (const recorded of ALL_RECORDS) {
      const recovery = decidedBookingRecovery(recorded);
      expect(resolutionStateOf(resolveConversationResolution(recovery))).toBe(fold[recovery.classification]);
    }
  });

  it("a DECISION is produced for ALL three states — terminal/recoverable/unresolved are NOT abstentions", () => {
    // The whole point of the engine is to CLASSIFY completion; a real (decided) resolution is produced for each
    // disposition, carrying the state. isResolutionDecided is TRUE for all three (including the terminal/none case).
    for (const recorded of ALL_RECORDS) {
      expect(isResolutionDecided(resolveConversationResolution(decidedBookingRecovery(recorded)))).toBe(true);
    }
  });

  it("the three states are reachable and distinct over the SAME decided fulfilment", () => {
    const seen = new Set<ResolutionState>();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, withField({ job_type: "electrical" })]) {
      const state = resolutionStateOf(resolveConversationResolution(decidedBookingRecovery(recorded)));
      if (state !== null) seen.add(state);
    }
    expect([...seen].sort()).toEqual([...ALL_STATES].sort());
  });
});

describe("R33 resolution engine — THE KEYSTONE: terminal = (state === 'terminal'), intervention = (state !== 'terminal')", () => {
  it("terminal/intervention flags are coherent with the state, over every real disposition", () => {
    const cases: readonly [RecordedFulfilmentSnapshot | null, ResolutionState, boolean, boolean][] = [
      [CONSISTENT_SNAPSHOT, "terminal", true, false],
      [null, "recoverable", false, true],
      [withField({ job_type: "electrical" }), "unresolved", false, true],
    ];
    for (const [recorded, state, terminal, intervention] of cases) {
      const decision = resolveConversationResolution(decidedBookingRecovery(recorded));
      expect(isResolutionDecided(decision)).toBe(true);
      if (isResolutionDecided(decision)) {
        expect(decision.state).toBe(state);
        expect(decision.terminal).toBe(terminal);
        expect(decision.intervention_required).toBe(intervention);
      }
    }
  });

  it("the keystone holds on EVERY decided resolution produced over every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const decision = resolveConversationResolution(decidedBookingRecovery(recorded));
      if (isResolutionDecided(decision)) {
        expect(decision.terminal).toBe(decision.state === "terminal");
        expect(decision.intervention_required).toBe(decision.state !== "terminal");
        // The two flags are exact complements — a conversation is terminal XOR it needs intervention.
        expect(decision.terminal).toBe(!decision.intervention_required);
      }
    }
  });
});

describe("R33 resolution engine — the resolve_booking_recovery fold (outcome + source classification + payload)", () => {
  it("a decided recovery ⇒ conversation_resolution_determined, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      expect(
        resolutionOutcomeOf(resolveConversationResolution(decidedBookingRecovery(recorded))),
      ).toBe<ResolutionOutcome>("conversation_resolution_determined");
    }
  });

  it("carries the SOURCE recovery classification it resolved, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const recovery = decidedBookingRecovery(recorded);
      expect(resolutionClassificationOf(resolveConversationResolution(recovery))).toBe(recovery.classification);
    }
  });

  it("carries the EXACT expected prepare_booking payload the recovery carried (self-describing, no drift)", () => {
    const recovery = decidedBookingRecovery(null);
    const decision = resolveConversationResolution(recovery);
    expect(isResolutionDecided(decision)).toBe(true);
    if (isResolutionDecided(decision)) {
      // The expected booking is the recovery's own payload, carried through by reference — it can never drift.
      expect(decision.booking).toBe(recovery.booking);
      expect(decision.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });
});

describe("R33 resolution engine — proven against the REAL R30/R31/R32 stack + Human Review bridge (genuine composition)", () => {
  // Resolve straight through the whole stack from a real fulfilment + a chosen record.
  const resolveThroughStack = (
    fulfilment: FulfilmentDecision,
    recorded: RecordedFulfilmentSnapshot | null,
  ): ResolutionDecision =>
    resolveConversationResolution(resolveRecovery(resolveVerification(fulfilment, recorded)));

  it("real booking → fulfil → verify(matching record) → recover(none) → resolve ⇒ terminal", () => {
    expect(resolveThroughStack(realBookingFulfilment("review", true), CONSISTENT_SNAPSHOT)).toEqual<ResolutionDecision>({
      kind: "resolve_booking_recovery",
      outcome: "conversation_resolution_determined",
      state: "terminal",
      terminal: true,
      intervention_required: false,
      classification: "none",
      booking: BOOKING_ACTION,
    });
  });

  it("real booking → fulfil → verify(no record) → recover(reinstate) → resolve ⇒ recoverable", () => {
    const decision = resolveThroughStack(realBookingFulfilment("review", true), null);
    expect(resolutionStateOf(decision)).toBe<ResolutionState>("recoverable");
    expect(resolutionTerminalOf(decision)).toBe(false);
    expect(resolutionInterventionRequiredOf(decision)).toBe(true);
  });

  it("real booking → fulfil → verify(divergent record) → recover(reconcile) → resolve ⇒ unresolved", () => {
    const decision = resolveThroughStack(realBookingFulfilment("review", true), withField({ status: "reversed" }));
    expect(resolutionStateOf(decision)).toBe<ResolutionState>("unresolved");
    expect(resolutionTerminalOf(decision)).toBe(false);
    expect(resolutionInterventionRequiredOf(decision)).toBe(true);
  });

  it("the SAME real booking, but the human DISMISSED ⇒ rejected → no fulfilment → nothing to recover → NOTHING to resolve", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    expect(resolveThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<ResolutionDecision>({
      kind: "none",
      reason: "no_recovery_decision",
    });
  });

  it("the SAME real booking, but NO human resolution yet ⇒ pending → no fulfilment → nothing to recover → NOTHING to resolve", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, null));
    expect(resolveThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<ResolutionDecision>({
      kind: "none",
      reason: "no_recovery_decision",
    });
  });

  it("a policy-blocked booking foreclosed at R29 never fulfils → never recovers → NOTHING to resolve (policy propagates)", () => {
    const authorisation = realBookingAuthorisation("block", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(resolveThroughStack(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<ResolutionDecision>({
      kind: "none",
      reason: "no_recovery_decision",
    });
  });

  it("the org-OFF production default (foreclosed) is likewise nothing to resolve even on a human SENT", () => {
    const authorisation = realBookingAuthorisation("allow", false);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(resolveThroughStack(fulfilment, null)).toEqual<ResolutionDecision>({
      kind: "none",
      reason: "no_recovery_decision",
    });
  });
});

describe("R33 resolution engine — isResolutionDecided / projections agree with the discriminant", () => {
  const decidedResolution: ResolveBookingRecoveryDecision = {
    kind: "resolve_booking_recovery",
    outcome: "conversation_resolution_determined",
    state: "recoverable",
    terminal: false,
    intervention_required: true,
    classification: "reinstate",
    booking: BOOKING_ACTION,
  };
  // Each state with its coherent classification + terminal + intervention companions.
  const decidedCombos: readonly [ResolutionState, RecoveryClassification, boolean, boolean][] = [
    ["terminal", "none", true, false],
    ["recoverable", "reinstate", false, true],
    ["unresolved", "reconcile", false, true],
  ];
  const abstentions: readonly ResolutionAbstention[] = ["no_recovery_decision", "unsupported_recovery"];

  const withCombo = (
    state: ResolutionState,
    classification: RecoveryClassification,
    terminal: boolean,
    intervention: boolean,
  ): ResolveBookingRecoveryDecision => ({
    ...decidedResolution,
    state,
    classification,
    terminal,
    intervention_required: intervention,
  });

  it("isResolutionDecided is TRUE for a decided resolution and narrows it", () => {
    const res: ResolutionDecision = decidedResolution;
    expect(isResolutionDecided(res)).toBe(true);
    if (isResolutionDecided(res)) {
      // Narrowed to ResolveBookingRecoveryDecision — outcome, state, flags, classification and booking are reachable.
      expect(res.outcome).toBe<ResolutionOutcome>("conversation_resolution_determined");
      expect(res.state).toBe<ResolutionState>("recoverable");
      expect(res.terminal).toBe(false);
      expect(res.intervention_required).toBe(true);
      expect(res.classification).toBe<RecoveryClassification>("reinstate");
      expect(res.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });

  it("isResolutionDecided is TRUE for a decided resolution of EVERY state (terminal included)", () => {
    for (const [state, classification, terminal, intervention] of decidedCombos) {
      expect(isResolutionDecided(withCombo(state, classification, terminal, intervention))).toBe(true);
    }
  });

  it("isResolutionDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isResolutionDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("resolutionTypeOf is resolve_booking_recovery for a decided arm and null for every abstention", () => {
    expect(resolutionTypeOf(decidedResolution)).toBe<ConversationResolutionType>("resolve_booking_recovery");
    for (const reason of abstentions) {
      expect(resolutionTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("resolutionOutcomeOf is conversation_resolution_determined for a decided arm and null for every abstention", () => {
    expect(resolutionOutcomeOf(decidedResolution)).toBe<ResolutionOutcome>("conversation_resolution_determined");
    for (const reason of abstentions) {
      expect(resolutionOutcomeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("resolutionStateOf is the state for a decided arm and null for every abstention", () => {
    for (const [state, classification, terminal, intervention] of decidedCombos) {
      expect(resolutionStateOf(withCombo(state, classification, terminal, intervention))).toBe<ResolutionState>(state);
    }
    for (const reason of abstentions) {
      expect(resolutionStateOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("resolutionTerminalOf is the terminal flag for a decided arm and null for every abstention", () => {
    for (const [state, classification, terminal, intervention] of decidedCombos) {
      expect(resolutionTerminalOf(withCombo(state, classification, terminal, intervention))).toBe(terminal);
    }
    for (const reason of abstentions) {
      expect(resolutionTerminalOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("resolutionInterventionRequiredOf is the intervention flag for a decided arm and null for every abstention", () => {
    for (const [state, classification, terminal, intervention] of decidedCombos) {
      expect(resolutionInterventionRequiredOf(withCombo(state, classification, terminal, intervention))).toBe(
        intervention,
      );
    }
    for (const reason of abstentions) {
      expect(resolutionInterventionRequiredOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("resolutionClassificationOf is the source classification for a decided arm and null for every abstention", () => {
    for (const [state, classification, terminal, intervention] of decidedCombos) {
      expect(resolutionClassificationOf(withCombo(state, classification, terminal, intervention))).toBe<
        RecoveryClassification
      >(classification);
    }
    for (const reason of abstentions) {
      expect(resolutionClassificationOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("resolutionTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(resolutionTypeOf(decidedResolution)).toBe(decidedResolution.kind);
  });
});

describe("R33 resolution engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveConversationResolution returns a coherent decision for EVERY (real recovery × every record)", () => {
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
                  const recovery = resolveRecovery(resolveVerification(fulfilment, recorded));
                  const resolution = resolveConversationResolution(recovery);
                  expect(
                    resolution.kind === "resolve_booking_recovery" || resolution.kind === "none",
                  ).toBe(true);
                  // The keystone holds on EVERY decided resolution produced anywhere in the sweep.
                  if (isResolutionDecided(resolution)) {
                    expect(resolution.terminal).toBe(resolution.state === "terminal");
                    expect(resolution.intervention_required).toBe(resolution.state !== "terminal");
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("a resolution is DECIDED iff the recovery was decided (the classification never opens or closes the gate)", () => {
    const recoveryAbstained: RecoveryDecision = { kind: "none", reason: "no_verification_decision" };
    expect(isResolutionDecided(resolveConversationResolution(recoveryAbstained))).toBe(false);
    // A decided recovery ALWAYS yields a decided resolution (whatever the classification); the classification only
    // chooses the state, never whether a resolution exists.
    for (const recorded of ALL_RECORDS) {
      expect(isResolutionDecided(resolveConversationResolution(decidedBookingRecovery(recorded)))).toBe(true);
    }
  });

  it("is DETERMINISTIC — the same recovery always yields an equal resolution", () => {
    for (const recorded of ALL_RECORDS) {
      const recovery = decidedBookingRecovery(recorded);
      expect(resolveConversationResolution(recovery)).toEqual(resolveConversationResolution(recovery));
    }
  });

  it("does NOT mutate the recovery decision it reads", () => {
    const recovery = decidedBookingRecovery(CONSISTENT_SNAPSHOT);
    const snap = JSON.stringify(recovery);
    resolveConversationResolution(recovery);
    expect(JSON.stringify(recovery)).toBe(snap);
  });
});

// A compile-time proof that `ConversationRecoveryType` is exhaustively mapped by RECOVERY_RESOLUTION — if R32 adds a
// recovery type without a matching RECOVERY_RESOLUTION entry, this reference fails to type-check.
const _exhaustiveRecoveryMap: Readonly<
  Record<ConversationRecoveryType, ConversationResolutionType | null>
> = RECOVERY_RESOLUTION;
void _exhaustiveRecoveryMap;
