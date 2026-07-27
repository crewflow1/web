import { describe, it, expect } from "vitest";
import {
  VERIFICATION_TYPES,
  FULFILMENT_VERIFICATION,
  resolveVerification,
  isVerificationDecided,
  verificationTypeOf,
  verificationOutcomeOf,
  verificationIntegrityOf,
  type ConversationVerificationType,
  type VerificationOutcome,
  type VerificationIntegrity,
  type VerificationDecision,
  type VerifyBookingDecision,
  type VerificationAbstention,
  type RecordedFulfilmentSnapshot,
} from "@/lib/receptionist/conversation-verification";
import {
  FULFILMENT_TYPES,
  resolveFulfilment,
  isFulfilmentDecided,
  type ConversationFulfilmentType,
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
import {
  resolveExecution,
} from "@/lib/receptionist/conversation-execution";
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
 * THE CONVERSATION VERIFICATION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R31 — CONVERSATION VERIFICATION ENGINE).
 *
 * lib/receptionist/conversation-verification.ts is the deterministic, leaf authority over the FIRST layer that
 * VERIFIES: "given a fulfilment the stack decided to perform, did it complete CORRECTLY — is the recorded operation
 * CONSISTENT with the decision, or is it MISSING or INCONSISTENT?". It is a TOTAL, DETERMINISTIC function of TWO
 * already-computed inputs — the R30 fulfilment decision (the DEFERRAL gate) and the RECORDED snapshot (or its
 * ABSENCE) — so it is exhaustively unit-testable in isolation. Every fulfilment fed in is the REAL
 * {@link resolveFulfilment} over the REAL R28 {@link resolveExecution} / R29 {@link resolveAuthorisation} stack with
 * the grant folded by R29's OWN {@link deriveAuthorisationState} — so the engine is proven against genuine
 * composition, never a hand-built decision. These tests pin, EXHAUSTIVELY:
 *   • VERIFICATION_TYPES is the closed verification vocabulary — exactly `verify_booking_fulfilment` in R31, no dupes;
 *   • FULFILMENT_VERIFICATION is TOTAL over the R30 fulfilment vocabulary and maps fulfil_booking →
 *     verify_booking_fulfilment (so a future fulfilment type cannot silently reach the engine unverified);
 *   • resolveVerification DEFERS `no_fulfilment_decision` whenever the Fulfilment Engine abstained — the FIRST gate,
 *     so the Fulfilment Engine (and transitively Authorisation, Execution, Action and Outcome) stays authoritative;
 *   • THE INTEGRITY VERDICT — a DECIDED fulfilment reconciles to `consistent` when a matching record exists,
 *     `missing` when NO record exists (R30's best-effort gap made observable), and `inconsistent` when a record
 *     exists but diverges in ANY field — and a decision is PRODUCED for all three (detecting missing/inconsistent is
 *     the whole point, NOT an abstention);
 *   • the verify_booking_fulfilment fold — a decided fulfilment ⇒ (fulfilment_reconciled, the integrity found, the
 *     EXPECTED prepare_booking payload the decision carried), self-describing and non-drifting;
 *   • the projections isVerificationDecided / verificationTypeOf / verificationOutcomeOf / verificationIntegrityOf
 *     agree with the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it VERIFIES nothing itself — it names the
 *     integrity and stops.
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

// The concrete prepare_booking action the fulfilment carries (equal to the one the REAL composition yields).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed verification vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not
// read their own answer from VERIFICATION_TYPES (the surface under test).
const ALL_VERIFICATION_TYPES: readonly ConversationVerificationType[] = ["verify_booking_fulfilment"];
// The whole integrity vocabulary, as an INDEPENDENT reference set.
const ALL_INTEGRITIES: readonly VerificationIntegrity[] = ["consistent", "missing", "inconsistent"];

// The RECORDED snapshot that MATCHES a decided fulfilment over BOOKING_ACTION — every field the value R30 filed for
// a performed operation. Reconciles to `consistent`.
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
// One divergence per field of the snapshot — the reconciliation must catch a drift ANYWHERE.
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

// The REAL, DECIDED booking fulfilment (an approved booking) — the input the Verification Engine reconciles. A
// satisfied, approved arrange_booking always fulfils, so an abstention here is a broken fixture: fail loudly.
const decidedBookingFulfilment = (): FulfilBookingDecision => {
  const decision = realBookingFulfilment("review", true);
  if (!isFulfilmentDecided(decision)) {
    throw new Error(`expected a decided booking fulfilment, got abstention: ${decision.reason}`);
  }
  return decision;
};

describe("R31 verification engine — VERIFICATION_TYPES: the closed verification vocabulary", () => {
  it("is EXACTLY `verify_booking_fulfilment` in R31 (quote/scheduling verification types are future work)", () => {
    expect(VERIFICATION_TYPES).toEqual(["verify_booking_fulfilment"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(VERIFICATION_TYPES).size).toBe(VERIFICATION_TYPES.length);
    expect([...VERIFICATION_TYPES].sort()).toEqual([...ALL_VERIFICATION_TYPES].sort());
  });
});

describe("R31 verification engine — FULFILMENT_VERIFICATION: the total fulfilment → verification-type map", () => {
  it("is TOTAL over the whole R30 fulfilment vocabulary (every fulfilment type has an entry)", () => {
    expect(Object.keys(FULFILMENT_VERIFICATION).sort()).toEqual([...FULFILMENT_TYPES].sort());
  });

  it("maps fulfil_booking → verify_booking_fulfilment", () => {
    expect(FULFILMENT_VERIFICATION.fulfil_booking).toBe<ConversationVerificationType>(
      "verify_booking_fulfilment",
    );
  });

  it("every non-null verification type is in the VERIFICATION_TYPES vocabulary (no orphan mapping today)", () => {
    for (const fulfilmentType of FULFILMENT_TYPES) {
      const type = FULFILMENT_VERIFICATION[fulfilmentType];
      if (type !== null) expect(VERIFICATION_TYPES).toContain(type);
    }
  });
});

describe("R31 verification engine — resolveVerification: the Fulfilment Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R30 engine can return — the Verification Engine must defer on each, for EVERY record.
  const fulfilmentAbstentions = [
    "no_authorisation_decision",
    "approval_not_granted",
    "unsupported_authorisation",
  ] as const;
  const records: readonly (RecordedFulfilmentSnapshot | null)[] = [
    null,
    CONSISTENT_SNAPSHOT,
    withField({ job_type: "electrical" }),
  ];

  for (const reason of fulfilmentAbstentions) {
    for (const recorded of records) {
      it(`fulfilment abstention (${reason}) + recorded=${recorded === null ? "null" : "present"} → no_fulfilment_decision`, () => {
        expect(resolveVerification({ kind: "none", reason }, recorded)).toEqual<VerificationDecision>({
          kind: "none",
          reason: "no_fulfilment_decision",
        });
      });
    }
  }

  it("defers BEFORE the record is even considered — an abstention with a CONSISTENT record STILL yields no_fulfilment_decision", () => {
    // The deferral gate is first: even a perfectly matching record cannot conjure a verification when nothing was
    // decided to perform. There is nothing to verify.
    expect(
      resolveVerification({ kind: "none", reason: "approval_not_granted" }, CONSISTENT_SNAPSHOT),
    ).toEqual<VerificationDecision>({ kind: "none", reason: "no_fulfilment_decision" });
  });
});

describe("R31 verification engine — THE INTEGRITY VERDICT: consistent / missing / inconsistent", () => {
  it("a decided fulfilment + a MATCHING record → consistent", () => {
    const decision = resolveVerification(decidedBookingFulfilment(), CONSISTENT_SNAPSHOT);
    expect(decision).toEqual<VerificationDecision>({
      kind: "verify_booking_fulfilment",
      outcome: "fulfilment_reconciled",
      integrity: "consistent",
      booking: BOOKING_ACTION,
    });
  });

  it("a decided fulfilment + NO record (null) → missing (R30's best-effort gap made observable)", () => {
    const decision = resolveVerification(decidedBookingFulfilment(), null);
    expect(decision).toEqual<VerificationDecision>({
      kind: "verify_booking_fulfilment",
      outcome: "fulfilment_reconciled",
      integrity: "missing",
      booking: BOOKING_ACTION,
    });
  });

  it("a decided fulfilment + a record that diverges in ANY field → inconsistent (each field is reconciled)", () => {
    for (const recorded of DIVERGENT_SNAPSHOTS) {
      const decision = resolveVerification(decidedBookingFulfilment(), recorded);
      expect(decision).toEqual<VerificationDecision>({
        kind: "verify_booking_fulfilment",
        outcome: "fulfilment_reconciled",
        integrity: "inconsistent",
        booking: BOOKING_ACTION,
      });
    }
  });

  it("a DECISION is produced for ALL three verdicts — missing/inconsistent are NOT abstentions", () => {
    // The whole point of the engine is to DETECT missing/inconsistent — so a real (decided) verification is produced
    // for each, carrying the verdict. isVerificationDecided is TRUE for all three.
    const fulfilment = decidedBookingFulfilment();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, ...DIVERGENT_SNAPSHOTS]) {
      expect(isVerificationDecided(resolveVerification(fulfilment, recorded))).toBe(true);
    }
  });

  it("the three verdicts are reachable and distinct over the SAME decided fulfilment", () => {
    const fulfilment = decidedBookingFulfilment();
    const seen = new Set<VerificationIntegrity>();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, withField({ job_type: "electrical" })]) {
      const verdict = verificationIntegrityOf(resolveVerification(fulfilment, recorded));
      if (verdict !== null) seen.add(verdict);
    }
    expect([...seen].sort()).toEqual([...ALL_INTEGRITIES].sort());
  });
});

describe("R31 verification engine — the verify_booking_fulfilment fold (outcome + expected payload)", () => {
  it("a decided fulfilment ⇒ fulfilment_reconciled, for every record shape", () => {
    const fulfilment = decidedBookingFulfilment();
    for (const recorded of [CONSISTENT_SNAPSHOT, null, ...DIVERGENT_SNAPSHOTS]) {
      expect(verificationOutcomeOf(resolveVerification(fulfilment, recorded))).toBe<VerificationOutcome>(
        "fulfilment_reconciled",
      );
    }
  });

  it("carries the EXACT expected prepare_booking payload the fulfilment decided over (self-describing, no drift)", () => {
    const fulfilment = decidedBookingFulfilment();
    const decision = resolveVerification(fulfilment, null);
    expect(isVerificationDecided(decision)).toBe(true);
    if (isVerificationDecided(decision)) {
      // The expected booking is the fulfilment's own payload, carried through by reference — it can never drift.
      expect(decision.booking).toBe(fulfilment.booking);
      expect(decision.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });
});

describe("R31 verification engine — proven against the REAL R30 stack + Human Review bridge (genuine composition)", () => {
  it("real booking → fulfil → verify(matching record) ⇒ consistent", () => {
    const fulfilment = realBookingFulfilment("review", true);
    expect(isFulfilmentDecided(fulfilment)).toBe(true);
    expect(resolveVerification(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<VerificationDecision>({
      kind: "verify_booking_fulfilment",
      outcome: "fulfilment_reconciled",
      integrity: "consistent",
      booking: BOOKING_ACTION,
    });
  });

  it("real booking → fulfil → verify(no record) ⇒ missing", () => {
    expect(verificationIntegrityOf(resolveVerification(realBookingFulfilment("review", true), null))).toBe(
      "missing",
    );
  });

  it("real booking → fulfil → verify(divergent record) ⇒ inconsistent", () => {
    const decision = resolveVerification(realBookingFulfilment("review", true), withField({ status: "reversed" }));
    expect(verificationIntegrityOf(decision)).toBe("inconsistent");
  });

  it("the SAME real booking, but the human DISMISSED ⇒ rejected → no fulfilment → NOTHING to verify", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const approval = deriveAuthorisationState(authorisation.state, "dismissed");
    const fulfilment = resolveFulfilment(authorisation, approval);
    // The refusal propagates: no fulfilment was decided, so verification defers — even against a matching record.
    expect(resolveVerification(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<VerificationDecision>({
      kind: "none",
      reason: "no_fulfilment_decision",
    });
  });

  it("the SAME real booking, but NO human resolution yet ⇒ pending → no fulfilment → NOTHING to verify", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, null));
    expect(resolveVerification(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<VerificationDecision>({
      kind: "none",
      reason: "no_fulfilment_decision",
    });
  });

  it("a policy-blocked booking foreclosed at R29 never fulfils → NOTHING to verify (policy propagates)", () => {
    const authorisation = realBookingAuthorisation("block", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(resolveVerification(fulfilment, CONSISTENT_SNAPSHOT)).toEqual<VerificationDecision>({
      kind: "none",
      reason: "no_fulfilment_decision",
    });
  });

  it("the org-OFF production default (foreclosed) is likewise nothing to verify even on a human SENT", () => {
    const authorisation = realBookingAuthorisation("allow", false);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const fulfilment = resolveFulfilment(authorisation, deriveAuthorisationState(authorisation.state, "sent"));
    expect(resolveVerification(fulfilment, null)).toEqual<VerificationDecision>({
      kind: "none",
      reason: "no_fulfilment_decision",
    });
  });
});

describe("R31 verification engine — isVerificationDecided / projections agree with the discriminant", () => {
  const decided: VerifyBookingDecision = {
    kind: "verify_booking_fulfilment",
    outcome: "fulfilment_reconciled",
    integrity: "consistent",
    booking: BOOKING_ACTION,
  };
  const abstentions: readonly VerificationAbstention[] = ["no_fulfilment_decision", "unsupported_fulfilment"];

  it("isVerificationDecided is TRUE for a decided verification and narrows it", () => {
    const res: VerificationDecision = decided;
    expect(isVerificationDecided(res)).toBe(true);
    if (isVerificationDecided(res)) {
      // Narrowed to VerifyBookingDecision — the outcome, integrity and booking are reachable without a cast.
      expect(res.outcome).toBe<VerificationOutcome>("fulfilment_reconciled");
      expect(res.integrity).toBe<VerificationIntegrity>("consistent");
      expect(res.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });

  it("isVerificationDecided is TRUE for a decided verification of EVERY integrity (missing included)", () => {
    for (const integrity of ALL_INTEGRITIES) {
      const res: VerificationDecision = { ...decided, integrity };
      expect(isVerificationDecided(res)).toBe(true);
    }
  });

  it("isVerificationDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isVerificationDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("verificationTypeOf is verify_booking_fulfilment for a decided arm and null for every abstention", () => {
    expect(verificationTypeOf(decided)).toBe<ConversationVerificationType>("verify_booking_fulfilment");
    for (const reason of abstentions) {
      expect(verificationTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("verificationOutcomeOf is fulfilment_reconciled for a decided arm and null for every abstention", () => {
    expect(verificationOutcomeOf(decided)).toBe<VerificationOutcome>("fulfilment_reconciled");
    for (const reason of abstentions) {
      expect(verificationOutcomeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("verificationIntegrityOf is the verdict for a decided arm and null for every abstention", () => {
    for (const integrity of ALL_INTEGRITIES) {
      expect(verificationIntegrityOf({ ...decided, integrity })).toBe<VerificationIntegrity>(integrity);
    }
    for (const reason of abstentions) {
      expect(verificationIntegrityOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("verificationTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(verificationTypeOf(decided)).toBe(decided.kind);
  });
});

describe("R31 verification engine — the surface is total, deterministic and non-mutating", () => {
  const records: readonly (RecordedFulfilmentSnapshot | null)[] = [
    null,
    CONSISTENT_SNAPSHOT,
    ...DIVERGENT_SNAPSHOTS,
  ];

  it("is TOTAL — resolveVerification returns a decision for EVERY (real fulfilment × every record)", () => {
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
                for (const recorded of records) {
                  const res = resolveVerification(fulfilment, recorded);
                  expect(res.kind === "verify_booking_fulfilment" || res.kind === "none").toBe(true);
                }
              }
            }
          }
        }
      }
    }
  });

  it("a verification is DECIDED iff the fulfilment was decided (the record never opens or closes the gate)", () => {
    const fulfilmentDecided = decidedBookingFulfilment();
    const fulfilmentAbstained: FulfilmentDecision = { kind: "none", reason: "approval_not_granted" };
    for (const recorded of records) {
      // A decided fulfilment ALWAYS yields a decided verification (whatever the record); an abstained fulfilment
      // NEVER does. The record only chooses the integrity verdict, never whether a verification exists.
      expect(isVerificationDecided(resolveVerification(fulfilmentDecided, recorded))).toBe(true);
      expect(isVerificationDecided(resolveVerification(fulfilmentAbstained, recorded))).toBe(false);
    }
  });

  it("is DETERMINISTIC — the same (fulfilment, record) always yields an equal verification", () => {
    const fulfilment = decidedBookingFulfilment();
    for (const recorded of records) {
      expect(resolveVerification(fulfilment, recorded)).toEqual(resolveVerification(fulfilment, recorded));
    }
  });

  it("does NOT mutate the fulfilment decision or the record it reads", () => {
    const fulfilment = decidedBookingFulfilment();
    const fulfilmentSnap = JSON.stringify(fulfilment);
    const recorded = { ...CONSISTENT_SNAPSHOT };
    const recordedSnap = JSON.stringify(recorded);
    resolveVerification(fulfilment, recorded);
    expect(JSON.stringify(fulfilment)).toBe(fulfilmentSnap);
    expect(JSON.stringify(recorded)).toBe(recordedSnap);
  });
});

// A compile-time proof that `ConversationFulfilmentType` is exhaustively mapped by FULFILMENT_VERIFICATION — if R30
// adds a fulfilment type without a matching FULFILMENT_VERIFICATION entry, this reference fails to type-check.
const _exhaustiveFulfilmentMap: Readonly<
  Record<ConversationFulfilmentType, ConversationVerificationType | null>
> = FULFILMENT_VERIFICATION;
void _exhaustiveFulfilmentMap;
