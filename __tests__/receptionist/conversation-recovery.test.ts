import { describe, it, expect } from "vitest";
import {
  RECOVERY_TYPES,
  VERIFICATION_RECOVERY,
  resolveRecovery,
  isRecoveryDecided,
  recoveryTypeOf,
  recoveryOutcomeOf,
  recoveryClassificationOf,
  recoveryRequiredOf,
  recoveryIntegrityOf,
  type ConversationRecoveryType,
  type RecoveryOutcome,
  type RecoveryClassification,
  type RecoveryDecision,
  type RecoverBookingDecision,
  type RecoveryAbstention,
} from "@/lib/receptionist/conversation-recovery";
import {
  VERIFICATION_TYPES,
  resolveVerification,
  isVerificationDecided,
  type ConversationVerificationType,
  type VerificationIntegrity,
  type VerificationDecision,
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
 * THE CONVERSATION RECOVERY ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R32 — CONVERSATION RECOVERY ENGINE).
 *
 * lib/receptionist/conversation-recovery.ts is the deterministic, leaf authority over the SECOND layer that does not
 * perform: "given a fulfilment the stack VERIFIED, does that verdict REQUIRE recovery, and if so, of what KIND?". It
 * is a TOTAL, DETERMINISTIC function of ONE already-computed input — the R31 verification decision (the DEFERRAL
 * gate) — so it is exhaustively unit-testable in isolation. Every verification fed in is the REAL
 * {@link resolveVerification} over the REAL R30 {@link resolveFulfilment} / R29 {@link resolveAuthorisation} /
 * R28 {@link resolveExecution} stack with the grant folded by R29's OWN {@link deriveAuthorisationState} — so the
 * engine is proven against genuine composition, never a hand-built decision. These tests pin, EXHAUSTIVELY:
 *   • RECOVERY_TYPES is the closed recovery vocabulary — exactly `recover_booking_fulfilment` in R32, no dupes;
 *   • VERIFICATION_RECOVERY is TOTAL over the R31 verification vocabulary and maps verify_booking_fulfilment →
 *     recover_booking_fulfilment (so a future verification type cannot silently reach the engine unrecovered);
 *   • resolveRecovery DEFERS `no_verification_decision` whenever the Verification Engine abstained — the FIRST gate,
 *     so the Verification Engine (and transitively Fulfilment, Authorisation, Execution, Action and Outcome) stays
 *     authoritative;
 *   • THE CLASSIFICATION FOLD — a decided verification classifies to `none` when `consistent` (no recovery required),
 *     `reinstate` when `missing`, and `reconcile` when `inconsistent` — and a decision is PRODUCED for all three
 *     (`none` is a determination that no recovery is required, NOT an abstention);
 *   • THE KEYSTONE — `recovery_required` is TRUE iff the classification is not `none`, on every decided recovery;
 *   • the recover_booking_fulfilment fold — a decided verification ⇒ (fulfilment_recovery_determined, the
 *     classification, the recovery_required flag, the source integrity verdict, the EXPECTED prepare_booking payload
 *     the verification carried), self-describing and non-drifting;
 *   • the projections isRecoveryDecided / recoveryTypeOf / recoveryOutcomeOf / recoveryClassificationOf /
 *     recoveryRequiredOf / recoveryIntegrityOf agree with the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it RECOVERS nothing itself — it names the
 *     recovery and stops.
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

// The concrete prepare_booking action the verification carries (equal to the one the REAL composition yields).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed recovery vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not read
// their own answer from RECOVERY_TYPES (the surface under test).
const ALL_RECOVERY_TYPES: readonly ConversationRecoveryType[] = ["recover_booking_fulfilment"];
// The whole classification vocabulary, as an INDEPENDENT reference set.
const ALL_CLASSIFICATIONS: readonly RecoveryClassification[] = ["none", "reinstate", "reconcile"];

// The RECORDED snapshot that MATCHES a decided fulfilment over BOOKING_ACTION — reconciles to `consistent`.
const CONSISTENT_SNAPSHOT: RecordedFulfilmentSnapshot = {
  fulfilment_type: "fulfil_booking",
  fulfilment_outcome: "booking_recorded",
  approval_state: "approved",
  status: "fulfilled",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// A recorded snapshot with a single field overridden — every one must reconcile to `inconsistent`.
const withField = (over: Partial<RecordedFulfilmentSnapshot>): RecordedFulfilmentSnapshot => ({
  ...CONSISTENT_SNAPSHOT,
  ...over,
});
// One divergence per field of the snapshot — the reconciliation catches a drift ANYWHERE, so recovery must classify
// EVERY one as `reconcile`.
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

// Every record shape — the matching one, the absence (missing), and each single-field divergence.
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

// The REAL R30 fulfilment decision for a genuinely satisfied booking, with the human's `sent` resolution folded to
// the grant through R29's OWN bridge — the exact (authorisation, grant) pair the runtime hands to resolveFulfilment.
const realBookingFulfilment = (
  verdict: (typeof GUARDRAIL_VERDICTS)[number],
  liveExecutionEnabled: boolean,
): FulfilmentDecision => {
  const authorisation = realBookingAuthorisation(verdict, liveExecutionEnabled);
  const approval = deriveAuthorisationState(authorisation.state, "sent");
  return resolveFulfilment(authorisation, approval);
};

// The REAL, DECIDED booking fulfilment (an approved booking) — the operation whose verification is recovered. A
// satisfied, approved arrange_booking always fulfils, so an abstention here is a broken fixture: fail loudly.
const decidedBookingFulfilment = (): FulfilBookingDecision => {
  const decision = realBookingFulfilment("review", true);
  if (!isFulfilmentDecided(decision)) {
    throw new Error(`expected a decided booking fulfilment, got abstention: ${decision.reason}`);
  }
  return decision;
};

// The REAL, DECIDED verification (over a chosen record) — the input the Recovery Engine classifies. A decided
// fulfilment always verifies (for any record), so an abstention here is a broken fixture: fail loudly.
const decidedBookingVerification = (
  recorded: RecordedFulfilmentSnapshot | null,
): VerifyBookingDecision => {
  const decision = resolveVerification(decidedBookingFulfilment(), recorded);
  if (!isVerificationDecided(decision)) {
    throw new Error(`expected a decided verification, got abstention: ${decision.reason}`);
  }
  return decision;
};

describe("R32 recovery engine — RECOVERY_TYPES: the closed recovery vocabulary", () => {
  it("is EXACTLY `recover_booking_fulfilment` in R32 (quote/scheduling recovery types are future work)", () => {
    expect(RECOVERY_TYPES).toEqual(["recover_booking_fulfilment"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(RECOVERY_TYPES).size).toBe(RECOVERY_TYPES.length);
    expect([...RECOVERY_TYPES].sort()).toEqual([...ALL_RECOVERY_TYPES].sort());
  });
});

describe("R32 recovery engine — VERIFICATION_RECOVERY: the total verification → recovery-type map", () => {
  it("is TOTAL over the whole R31 verification vocabulary (every verification type has an entry)", () => {
    expect(Object.keys(VERIFICATION_RECOVERY).sort()).toEqual([...VERIFICATION_TYPES].sort());
  });

  it("maps verify_booking_fulfilment → recover_booking_fulfilment", () => {
    expect(VERIFICATION_RECOVERY.verify_booking_fulfilment).toBe<ConversationRecoveryType>(
      "recover_booking_fulfilment",
    );
  });

  it("every non-null recovery type is in the RECOVERY_TYPES vocabulary (no orphan mapping today)", () => {
    for (const verificationType of VERIFICATION_TYPES) {
      const type = VERIFICATION_RECOVERY[verificationType];
      if (type !== null) expect(RECOVERY_TYPES).toContain(type);
    }
  });

  it("has NO null entries today — so `unsupported_verification` is dormant defence-in-depth (unreachable via a real verification)", () => {
    for (const verificationType of VERIFICATION_TYPES) {
      expect(VERIFICATION_RECOVERY[verificationType]).not.toBeNull();
    }
  });
});

describe("R32 recovery engine — resolveRecovery: the Verification Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R31 engine can return — the Recovery Engine must defer on each.
  const verificationAbstentions = ["no_fulfilment_decision", "unsupported_fulfilment"] as const;

  for (const reason of verificationAbstentions) {
    it(`verification abstention (${reason}) → no_verification_decision`, () => {
      expect(resolveRecovery({ kind: "none", reason })).toEqual<RecoveryDecision>({
        kind: "none",
        reason: "no_verification_decision",
      });
    });
  }

  it("a REAL abstained verification (the fulfilment was never decided) → no_verification_decision", () => {
    // Drive a genuine deferral: a dismissed booking never fulfils, so R31 defers, so R32 defers.
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    const verification = resolveVerification(fulfilment, CONSISTENT_SNAPSHOT);
    expect(isVerificationDecided(verification)).toBe(false);
    expect(resolveRecovery(verification)).toEqual<RecoveryDecision>({
      kind: "none",
      reason: "no_verification_decision",
    });
  });
});

describe("R32 recovery engine — THE CLASSIFICATION FOLD: consistent→none, missing→reinstate, inconsistent→reconcile", () => {
  it("a consistent verification → none (no recovery required)", () => {
    expect(resolveRecovery(decidedBookingVerification(CONSISTENT_SNAPSHOT))).toEqual<RecoveryDecision>({
      kind: "recover_booking_fulfilment",
      outcome: "fulfilment_recovery_determined",
      classification: "none",
      recovery_required: false,
      integrity: "consistent",
      booking: BOOKING_ACTION,
    });
  });

  it("a missing verification → reinstate (the unrecorded operation warrants reinstatement)", () => {
    expect(resolveRecovery(decidedBookingVerification(null))).toEqual<RecoveryDecision>({
      kind: "recover_booking_fulfilment",
      outcome: "fulfilment_recovery_determined",
      classification: "reinstate",
      recovery_required: true,
      integrity: "missing",
      booking: BOOKING_ACTION,
    });
  });

  it("an inconsistent verification (a record diverging in ANY field) → reconcile", () => {
    for (const recorded of DIVERGENT_SNAPSHOTS) {
      expect(resolveRecovery(decidedBookingVerification(recorded))).toEqual<RecoveryDecision>({
        kind: "recover_booking_fulfilment",
        outcome: "fulfilment_recovery_determined",
        classification: "reconcile",
        recovery_required: true,
        integrity: "inconsistent",
        booking: BOOKING_ACTION,
      });
    }
  });

  it("the classification is the deterministic fold of the integrity verdict (a total mapping)", () => {
    const fold: Record<VerificationIntegrity, RecoveryClassification> = {
      consistent: "none",
      missing: "reinstate",
      inconsistent: "reconcile",
    };
    for (const recorded of ALL_RECORDS) {
      const verification = decidedBookingVerification(recorded);
      expect(recoveryClassificationOf(resolveRecovery(verification))).toBe(fold[verification.integrity]);
    }
  });

  it("a DECISION is produced for ALL three classifications — none/reinstate/reconcile are NOT abstentions", () => {
    // The whole point of the engine is to CLASSIFY; a real (decided) recovery is produced for each verdict, carrying
    // the classification. isRecoveryDecided is TRUE for all three (including the `none`/consistent case).
    for (const recorded of ALL_RECORDS) {
      expect(isRecoveryDecided(resolveRecovery(decidedBookingVerification(recorded)))).toBe(true);
    }
  });

  it("the three classifications are reachable and distinct over the SAME decided fulfilment", () => {
    const seen = new Set<RecoveryClassification>();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, withField({ job_type: "electrical" })]) {
      const classification = recoveryClassificationOf(resolveRecovery(decidedBookingVerification(recorded)));
      if (classification !== null) seen.add(classification);
    }
    expect([...seen].sort()).toEqual([...ALL_CLASSIFICATIONS].sort());
  });
});

describe("R32 recovery engine — THE KEYSTONE: recovery_required = (classification !== 'none')", () => {
  it("recovery_required is FALSE for `none` and TRUE for `reinstate`/`reconcile`, over every real verdict", () => {
    const cases: readonly [RecordedFulfilmentSnapshot | null, RecoveryClassification, boolean][] = [
      [CONSISTENT_SNAPSHOT, "none", false],
      [null, "reinstate", true],
      [withField({ job_type: "electrical" }), "reconcile", true],
    ];
    for (const [recorded, classification, required] of cases) {
      const decision = resolveRecovery(decidedBookingVerification(recorded));
      expect(isRecoveryDecided(decision)).toBe(true);
      if (isRecoveryDecided(decision)) {
        expect(decision.classification).toBe(classification);
        expect(decision.recovery_required).toBe(required);
      }
    }
  });

  it("the keystone holds on EVERY decided recovery produced over every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const decision = resolveRecovery(decidedBookingVerification(recorded));
      if (isRecoveryDecided(decision)) {
        expect(decision.recovery_required).toBe(decision.classification !== "none");
      }
    }
  });
});

describe("R32 recovery engine — the recover_booking_fulfilment fold (outcome + expected payload)", () => {
  it("a decided verification ⇒ fulfilment_recovery_determined, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      expect(recoveryOutcomeOf(resolveRecovery(decidedBookingVerification(recorded)))).toBe<RecoveryOutcome>(
        "fulfilment_recovery_determined",
      );
    }
  });

  it("carries the SOURCE integrity verdict it classified, for every record shape", () => {
    for (const recorded of ALL_RECORDS) {
      const verification = decidedBookingVerification(recorded);
      expect(recoveryIntegrityOf(resolveRecovery(verification))).toBe(verification.integrity);
    }
  });

  it("carries the EXACT expected prepare_booking payload the verification carried (self-describing, no drift)", () => {
    const verification = decidedBookingVerification(null);
    const decision = resolveRecovery(verification);
    expect(isRecoveryDecided(decision)).toBe(true);
    if (isRecoveryDecided(decision)) {
      // The expected booking is the verification's own payload, carried through by reference — it can never drift.
      expect(decision.booking).toBe(verification.booking);
      expect(decision.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });
});

describe("R32 recovery engine — proven against the REAL R30/R31 stack + Human Review bridge (genuine composition)", () => {
  it("real booking → fulfil → verify(matching record) → recover ⇒ none", () => {
    const verification = resolveVerification(realBookingFulfilment("review", true), CONSISTENT_SNAPSHOT);
    expect(resolveRecovery(verification)).toEqual<RecoveryDecision>({
      kind: "recover_booking_fulfilment",
      outcome: "fulfilment_recovery_determined",
      classification: "none",
      recovery_required: false,
      integrity: "consistent",
      booking: BOOKING_ACTION,
    });
  });

  it("real booking → fulfil → verify(no record) → recover ⇒ reinstate", () => {
    const decision = resolveRecovery(resolveVerification(realBookingFulfilment("review", true), null));
    expect(recoveryClassificationOf(decision)).toBe<RecoveryClassification>("reinstate");
    expect(recoveryRequiredOf(decision)).toBe(true);
  });

  it("real booking → fulfil → verify(divergent record) → recover ⇒ reconcile", () => {
    const verification = resolveVerification(realBookingFulfilment("review", true), withField({ status: "reversed" }));
    const decision = resolveRecovery(verification);
    expect(recoveryClassificationOf(decision)).toBe<RecoveryClassification>("reconcile");
    expect(recoveryRequiredOf(decision)).toBe(true);
  });

  it("the SAME real booking, but the human DISMISSED ⇒ rejected → no fulfilment → no verification → NOTHING to recover", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "dismissed"));
    const verification = resolveVerification(fulfilment, CONSISTENT_SNAPSHOT);
    expect(resolveRecovery(verification)).toEqual<RecoveryDecision>({
      kind: "none",
      reason: "no_verification_decision",
    });
  });

  it("the SAME real booking, but NO human resolution yet ⇒ pending → no fulfilment → no verification → NOTHING to recover", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, null));
    const verification = resolveVerification(fulfilment, CONSISTENT_SNAPSHOT);
    expect(resolveRecovery(verification)).toEqual<RecoveryDecision>({
      kind: "none",
      reason: "no_verification_decision",
    });
  });

  it("a policy-blocked booking foreclosed at R29 never fulfils → never verifies → NOTHING to recover (policy propagates)", () => {
    const authorisation = realBookingAuthorisation("block", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    const verification = resolveVerification(fulfilment, CONSISTENT_SNAPSHOT);
    expect(resolveRecovery(verification)).toEqual<RecoveryDecision>({
      kind: "none",
      reason: "no_verification_decision",
    });
  });

  it("the org-OFF production default (foreclosed) is likewise nothing to recover even on a human SENT", () => {
    const authorisation = realBookingAuthorisation("allow", false);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    const verification = resolveVerification(fulfilment, null);
    expect(resolveRecovery(verification)).toEqual<RecoveryDecision>({
      kind: "none",
      reason: "no_verification_decision",
    });
  });
});

describe("R32 recovery engine — isRecoveryDecided / projections agree with the discriminant", () => {
  const decidedRecovery: RecoverBookingDecision = {
    kind: "recover_booking_fulfilment",
    outcome: "fulfilment_recovery_determined",
    classification: "reinstate",
    recovery_required: true,
    integrity: "missing",
    booking: BOOKING_ACTION,
  };
  // Each classification with its coherent integrity + recovery_required companion.
  const decidedCombos: readonly [RecoveryClassification, VerificationIntegrity, boolean][] = [
    ["none", "consistent", false],
    ["reinstate", "missing", true],
    ["reconcile", "inconsistent", true],
  ];
  const abstentions: readonly RecoveryAbstention[] = ["no_verification_decision", "unsupported_verification"];

  it("isRecoveryDecided is TRUE for a decided recovery and narrows it", () => {
    const res: RecoveryDecision = decidedRecovery;
    expect(isRecoveryDecided(res)).toBe(true);
    if (isRecoveryDecided(res)) {
      // Narrowed to RecoverBookingDecision — the outcome, classification, flag, integrity and booking are reachable.
      expect(res.outcome).toBe<RecoveryOutcome>("fulfilment_recovery_determined");
      expect(res.classification).toBe<RecoveryClassification>("reinstate");
      expect(res.recovery_required).toBe(true);
      expect(res.integrity).toBe<VerificationIntegrity>("missing");
      expect(res.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });

  it("isRecoveryDecided is TRUE for a decided recovery of EVERY classification (none included)", () => {
    for (const [classification, integrity, required] of decidedCombos) {
      const res: RecoveryDecision = {
        ...decidedRecovery,
        classification,
        integrity,
        recovery_required: required,
      };
      expect(isRecoveryDecided(res)).toBe(true);
    }
  });

  it("isRecoveryDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isRecoveryDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("recoveryTypeOf is recover_booking_fulfilment for a decided arm and null for every abstention", () => {
    expect(recoveryTypeOf(decidedRecovery)).toBe<ConversationRecoveryType>("recover_booking_fulfilment");
    for (const reason of abstentions) {
      expect(recoveryTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("recoveryOutcomeOf is fulfilment_recovery_determined for a decided arm and null for every abstention", () => {
    expect(recoveryOutcomeOf(decidedRecovery)).toBe<RecoveryOutcome>("fulfilment_recovery_determined");
    for (const reason of abstentions) {
      expect(recoveryOutcomeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("recoveryClassificationOf is the disposition for a decided arm and null for every abstention", () => {
    for (const [classification, integrity, required] of decidedCombos) {
      expect(
        recoveryClassificationOf({ ...decidedRecovery, classification, integrity, recovery_required: required }),
      ).toBe<RecoveryClassification>(classification);
    }
    for (const reason of abstentions) {
      expect(recoveryClassificationOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("recoveryRequiredOf is the flag for a decided arm and null for every abstention", () => {
    for (const [classification, integrity, required] of decidedCombos) {
      expect(
        recoveryRequiredOf({ ...decidedRecovery, classification, integrity, recovery_required: required }),
      ).toBe(required);
    }
    for (const reason of abstentions) {
      expect(recoveryRequiredOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("recoveryIntegrityOf is the source verdict for a decided arm and null for every abstention", () => {
    for (const [classification, integrity, required] of decidedCombos) {
      expect(
        recoveryIntegrityOf({ ...decidedRecovery, classification, integrity, recovery_required: required }),
      ).toBe<VerificationIntegrity>(integrity);
    }
    for (const reason of abstentions) {
      expect(recoveryIntegrityOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("recoveryTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(recoveryTypeOf(decidedRecovery)).toBe(decidedRecovery.kind);
  });
});

describe("R32 recovery engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveRecovery returns a coherent decision for EVERY (real verification × every record)", () => {
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
                  const verification = resolveVerification(fulfilment, recorded);
                  const recovery = resolveRecovery(verification);
                  expect(recovery.kind === "recover_booking_fulfilment" || recovery.kind === "none").toBe(true);
                  // The keystone holds on EVERY decided recovery produced anywhere in the sweep.
                  if (isRecoveryDecided(recovery)) {
                    expect(recovery.recovery_required).toBe(recovery.classification !== "none");
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("a recovery is DECIDED iff the verification was decided (the integrity verdict never opens or closes the gate)", () => {
    const verificationAbstained: VerificationDecision = { kind: "none", reason: "no_fulfilment_decision" };
    expect(isRecoveryDecided(resolveRecovery(verificationAbstained))).toBe(false);
    // A decided verification ALWAYS yields a decided recovery (whatever the verdict); the verdict only chooses the
    // classification, never whether a recovery exists.
    for (const recorded of ALL_RECORDS) {
      expect(isRecoveryDecided(resolveRecovery(decidedBookingVerification(recorded)))).toBe(true);
    }
  });

  it("is DETERMINISTIC — the same verification always yields an equal recovery", () => {
    for (const recorded of ALL_RECORDS) {
      const verification = decidedBookingVerification(recorded);
      expect(resolveRecovery(verification)).toEqual(resolveRecovery(verification));
    }
  });

  it("does NOT mutate the verification decision it reads", () => {
    const verification = decidedBookingVerification(CONSISTENT_SNAPSHOT);
    const snap = JSON.stringify(verification);
    resolveRecovery(verification);
    expect(JSON.stringify(verification)).toBe(snap);
  });
});

// A compile-time proof that `ConversationVerificationType` is exhaustively mapped by VERIFICATION_RECOVERY — if R31
// adds a verification type without a matching VERIFICATION_RECOVERY entry, this reference fails to type-check.
const _exhaustiveVerificationMap: Readonly<
  Record<ConversationVerificationType, ConversationRecoveryType | null>
> = VERIFICATION_RECOVERY;
void _exhaustiveVerificationMap;
