import { describe, it, expect } from "vitest";
import {
  FULFILMENT_TYPES,
  AUTHORISATION_FULFILMENT,
  resolveFulfilment,
  isFulfilmentDecided,
  fulfilmentTypeOf,
  fulfilmentOutcomeOf,
  type ConversationFulfilmentType,
  type FulfilmentOutcome,
  type FulfilmentDecision,
  type FulfilBookingDecision,
  type FulfilmentAbstention,
} from "@/lib/receptionist/conversation-fulfilment";
import {
  AUTHORISATION_TYPES,
  resolveAuthorisation,
  deriveAuthorisationState,
  isAuthorisationDecided,
  type ConversationAuthorisationType,
  type ApproveBookingAuthorisation,
  type AuthorisationState,
  type AuthorisationOpeningState,
} from "@/lib/receptionist/conversation-authorisation";
import {
  resolveExecution,
  type ExecuteBookingDecision,
  type ExecutionEligibility,
} from "@/lib/receptionist/conversation-execution";
import {
  resolveAction,
  type ActionResolution,
  type PrepareBookingAction,
} from "@/lib/receptionist/conversation-action";
import { resolveOutcome } from "@/lib/receptionist/conversation-outcome";
import {
  CONVERSATION_GOALS,
  type ConversationGoal,
} from "@/lib/receptionist/conversation-goal";
import {
  STRATEGY_PRIORITY,
  resolveStrategy,
  type ConversationStrategy,
} from "@/lib/receptionist/conversation-strategy";
import { detectGap } from "@/lib/receptionist/conversation-gap";
import type { ConversationInformation } from "@/lib/receptionist/conversation-information";
import { GUARDRAIL_VERDICTS } from "@/lib/receptionist/policy";

/**
 * THE CONVERSATION FULFILMENT ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R30 — CONVERSATION FULFILMENT ENGINE).
 *
 * lib/receptionist/conversation-fulfilment.ts is the deterministic, leaf authority over the FIRST layer that
 * PERFORMS: "given an APPROVED authorisation, WHAT internal business operation must be carried out, over what
 * payload?". It is a TOTAL, DETERMINISTIC function of TWO already-computed inputs — the R29 authorisation decision
 * (the DEFERRAL gate) and its already-derived terminal grant (the HUMAN REVIEW gate) — so it is exhaustively
 * unit-testable in isolation. Every authorisation fed in is the REAL {@link resolveAuthorisation} over the REAL
 * R28 {@link resolveExecution} / R27 {@link resolveAction} / R26 {@link resolveOutcome} stack, and every grant is
 * folded by R29's OWN {@link deriveAuthorisationState} — so the engine is proven against genuine composition,
 * never a hand-built approval. These tests pin, EXHAUSTIVELY:
 *   • FULFILMENT_TYPES is the closed fulfilment vocabulary — exactly `fulfil_booking` in R30, no dupes;
 *   • AUTHORISATION_FULFILMENT is TOTAL over the R29 authorisation vocabulary and maps approve_booking →
 *     fulfil_booking (so a policy-blocked/quote/scheduling type cannot silently reach the engine);
 *   • resolveFulfilment DEFERS `no_authorisation_decision` whenever the Authorisation Engine abstained — the FIRST
 *     gate, so the Authorisation Engine (and transitively Execution, Action and Outcome) stays authoritative;
 *   • THE HUMAN REVIEW GATE — a fulfilment is emitted ONLY when the terminal grant is `approved`; EVERY other
 *     state (`pending`, `rejected`, `foreclosed`) yields `approval_not_granted` and NO fulfilment — so a booking
 *     can never be carried out without the human's grant, made structural;
 *   • the grant arises ONLY through R29's `deriveAuthorisationState` bridge (a real `sent` resolution on a pending
 *     authorisation) — a dismissed/absent resolution, or a foreclosed authorisation, can never fulfil;
 *   • the fulfil_booking fold — an approved approve_booking ⇒ (booking_recorded, the exact prepare_booking payload
 *     the whole stack decided over), self-describing and non-drifting;
 *   • the projections isFulfilmentDecided / fulfilmentTypeOf / fulfilmentOutcomeOf agree with the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it PERFORMS nothing itself — it names the
 *     approved operation and stops.
 */

// The canonical field values a customer provides — one per information field, in the exact form the R20
// extractors canonicalise to (so an information record here is byte-identical to a persisted one).
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
// The exact slots a satisfied arrange_booking needs — the prepare_booking payload the execution decides over.
const BOOKING_INFO: ConversationInformation = {
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};
const CALLBACK_INFO: ConversationInformation = { phone_number: PHONE };
const EMPTY: ConversationInformation = {};

// The concrete prepare_booking action, built directly for the fold/projection tests (equal to the one the REAL
// composition yields for a satisfied arrange_booking — asserted below).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed fulfilment vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not
// read their own answer from FULFILMENT_TYPES (the surface under test).
const ALL_FULFILMENT_TYPES: readonly ConversationFulfilmentType[] = ["fulfil_booking"];
// The whole authorisation-state lifecycle, as an INDEPENDENT reference set — the gate must be tested over ALL four.
const ALL_STATES: readonly AuthorisationState[] = ["pending", "approved", "rejected", "foreclosed"];

// A decided execution decision at a chosen eligibility, built directly — reaches the authorisation the engine folds.
const directExecution = (eligibility: ExecutionEligibility): ExecuteBookingDecision => ({
  kind: "execute_booking",
  eligibility,
  action: BOOKING_ACTION,
});

// A decided authorisation at a chosen turn-time state, built directly — the input the Fulfilment Engine reads. Its
// `state` field is NOT what the gate reads (that is the separate `approval` argument, the DERIVED grant); it is
// carried only so the decision is a faithful R29 shape.
const directAuthorisation = (state: AuthorisationOpeningState): ApproveBookingAuthorisation => ({
  kind: "approve_booking",
  requirement: state === "pending" ? "human_approval_required" : "not_required",
  state,
  execution: directExecution(state === "pending" ? "requires_human_review" : "blocked_by_org"),
});

// The REAL progression trigger for a genuinely satisfied goal — derived through the R21 gap and the R22 strategy.
const strategyFor = (goal: ConversationGoal, info: ConversationInformation): ConversationStrategy =>
  resolveStrategy(detectGap(goal, info)).strategy;
// Compose the DERIVING stack EXACTLY as the runtime does: real strategy → real outcome → real action.
const actionFor = (
  strategy: ConversationStrategy,
  goal: ConversationGoal,
  info: ConversationInformation,
): ActionResolution => resolveAction(resolveOutcome(strategy, goal, info), strategy, goal, info);
// The REAL prepared booking action for a genuinely satisfied, genuinely progressing arrange_booking.
const realBookingAction = (): ActionResolution =>
  actionFor(strategyFor("arrange_booking", BOOKING_INFO), "arrange_booking", BOOKING_INFO);

// The REAL, DECIDED authorisation for a genuinely satisfied booking at a chosen policy verdict + org gate — the
// full R27→R28→R29 composition, narrowed to the decided arm. A satisfied arrange_booking always prepares, decides
// and authorises, so an abstention here is a broken fixture: fail loudly rather than silently widen the type.
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

describe("R30 fulfilment engine — FULFILMENT_TYPES: the closed fulfilment vocabulary", () => {
  it("is EXACTLY `fulfil_booking` in R30 (quote/scheduling/promotion fulfilment types are future work)", () => {
    expect(FULFILMENT_TYPES).toEqual(["fulfil_booking"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(FULFILMENT_TYPES).size).toBe(FULFILMENT_TYPES.length);
    expect([...FULFILMENT_TYPES].sort()).toEqual([...ALL_FULFILMENT_TYPES].sort());
  });
});

describe("R30 fulfilment engine — AUTHORISATION_FULFILMENT: the total authorisation → fulfilment-type map", () => {
  it("is TOTAL over the whole R29 authorisation vocabulary (every authorisation type has an entry)", () => {
    expect(Object.keys(AUTHORISATION_FULFILMENT).sort()).toEqual([...AUTHORISATION_TYPES].sort());
  });

  it("maps approve_booking → fulfil_booking", () => {
    expect(AUTHORISATION_FULFILMENT.approve_booking).toBe<ConversationFulfilmentType>("fulfil_booking");
  });

  it("every non-null fulfilment type is in the FULFILMENT_TYPES vocabulary (no orphan mapping today)", () => {
    for (const authorisationType of AUTHORISATION_TYPES) {
      const type = AUTHORISATION_FULFILMENT[authorisationType];
      if (type !== null) expect(FULFILMENT_TYPES).toContain(type);
    }
  });
});

describe("R30 fulfilment engine — resolveFulfilment: the Authorisation Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R29 engine can return — the Fulfilment Engine must defer on each, for EVERY grant.
  const authorisationAbstentions = ["no_execution_decision", "unsupported_execution"] as const;

  for (const reason of authorisationAbstentions) {
    for (const approval of ALL_STATES) {
      it(`authorisation abstention (${reason}) + grant=${approval} → no_authorisation_decision`, () => {
        expect(resolveFulfilment({ kind: "none", reason }, approval)).toEqual<FulfilmentDecision>({
          kind: "none",
          reason: "no_authorisation_decision",
        });
      });
    }
  }

  it("defers BEFORE the grant is even considered — an abstention with grant=approved STILL yields no_authorisation_decision", () => {
    // The deferral gate is first: even the strongest grant cannot conjure a fulfilment when nothing was authorised.
    expect(resolveFulfilment({ kind: "none", reason: "no_execution_decision" }, "approved")).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "no_authorisation_decision",
    });
  });
});

describe("R30 fulfilment engine — THE HUMAN REVIEW GATE: a fulfilment is emitted ONLY for an approved grant", () => {
  it("across ALL four terminal states, ONLY `approved` yields fulfil_booking — every other state abstains", () => {
    const authorisation = directAuthorisation("pending");
    for (const approval of ALL_STATES) {
      const decision = resolveFulfilment(authorisation, approval);
      if (approval === "approved") {
        expect(decision).toEqual<FulfilmentDecision>({
          kind: "fulfil_booking",
          outcome: "booking_recorded",
          booking: BOOKING_ACTION,
        });
      } else {
        expect(decision).toEqual<FulfilmentDecision>({ kind: "none", reason: "approval_not_granted" });
      }
    }
  });

  it("pending (awaiting the human) → NO fulfilment", () => {
    expect(resolveFulfilment(directAuthorisation("pending"), "pending")).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "approval_not_granted",
    });
  });

  it("rejected (the human refused) → NO fulfilment", () => {
    expect(resolveFulfilment(directAuthorisation("pending"), "rejected")).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "approval_not_granted",
    });
  });

  it("foreclosed (blocked upstream, never revivable) → NO fulfilment", () => {
    expect(resolveFulfilment(directAuthorisation("foreclosed"), "foreclosed")).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "approval_not_granted",
    });
  });

  it("exactly ONE of the four terminal states opens fulfilment (the gate is a single point)", () => {
    const authorisation = directAuthorisation("pending");
    const opening = ALL_STATES.filter((s) => isFulfilmentDecided(resolveFulfilment(authorisation, s)));
    expect(opening).toEqual<AuthorisationState[]>(["approved"]);
  });
});

describe("R30 fulfilment engine — the fulfil_booking fold (outcome + payload)", () => {
  it("approved approve_booking ⇒ booking_recorded", () => {
    const decision = resolveFulfilment(directAuthorisation("pending"), "approved");
    expect(fulfilmentOutcomeOf(decision)).toBe<FulfilmentOutcome>("booking_recorded");
  });

  it("carries the EXACT prepare_booking payload the authorisation decided over (self-describing, no drift)", () => {
    const authorisation = directAuthorisation("pending");
    const decision = resolveFulfilment(authorisation, "approved");
    expect(isFulfilmentDecided(decision)).toBe(true);
    if (isFulfilmentDecided(decision)) {
      // The payload is the authorisation's own action, carried through by reference — it can never drift.
      expect(decision.booking).toBe(authorisation.execution.action);
      expect(decision.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });
});

describe("R30 fulfilment engine — proven against the REAL R28/R29 stack + the Human Review bridge (genuine composition)", () => {
  it("a genuinely satisfied arrange_booking yields the REAL prepare_booking action carried into the fulfilment", () => {
    expect(realBookingAction()).toEqual<ActionResolution>(BOOKING_ACTION);
  });

  it("real booking → authorise (pending) → human SENT → deriveAuthorisationState ⇒ approved → fulfil_booking", () => {
    const authorisation = realBookingAuthorisation("review", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("pending");
    // The grant is R29's to derive — the runtime folds the human's `sent` resolution through THIS bridge.
    const approval = deriveAuthorisationState(authorisation.state, "sent");
    expect(approval).toBe<AuthorisationState>("approved");
    expect(resolveFulfilment(authorisation, approval)).toEqual<FulfilmentDecision>({
      kind: "fulfil_booking",
      outcome: "booking_recorded",
      booking: BOOKING_ACTION,
    });
  });

  it("the SAME real booking, but the human DISMISSED ⇒ rejected → NO fulfilment (the refusal is honoured)", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const approval = deriveAuthorisationState(authorisation.state, "dismissed");
    expect(approval).toBe<AuthorisationState>("rejected");
    expect(resolveFulfilment(authorisation, approval)).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "approval_not_granted",
    });
  });

  it("the SAME real booking, but NO human resolution yet ⇒ pending → NO fulfilment (awaiting the human)", () => {
    const authorisation = realBookingAuthorisation("review", true);
    const approval = deriveAuthorisationState(authorisation.state, null);
    expect(approval).toBe<AuthorisationState>("pending");
    expect(resolveFulfilment(authorisation, approval)).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "approval_not_granted",
    });
  });

  it("a policy-blocked booking foreclosed at R29 can NEVER derive to approved → NO fulfilment (policy propagates)", () => {
    const authorisation = realBookingAuthorisation("block", true);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    // Even a `sent` resolution keeps a foreclosed authorisation foreclosed — so it can never be fulfilled.
    const approval = deriveAuthorisationState(authorisation.state, "sent");
    expect(approval).toBe<AuthorisationState>("foreclosed");
    expect(resolveFulfilment(authorisation, approval)).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "approval_not_granted",
    });
  });

  it("the org-OFF production default (foreclosed) is likewise unfulfillable even on a human SENT", () => {
    const authorisation = realBookingAuthorisation("allow", false);
    expect(authorisation.state).toBe<AuthorisationOpeningState>("foreclosed");
    const approval = deriveAuthorisationState(authorisation.state, "sent");
    expect(resolveFulfilment(authorisation, approval)).toEqual<FulfilmentDecision>({
      kind: "none",
      reason: "approval_not_granted",
    });
  });
});

describe("R30 fulfilment engine — isFulfilmentDecided / projections agree with the discriminant", () => {
  const decided: FulfilBookingDecision = {
    kind: "fulfil_booking",
    outcome: "booking_recorded",
    booking: BOOKING_ACTION,
  };
  const abstentions: readonly FulfilmentAbstention[] = [
    "no_authorisation_decision",
    "approval_not_granted",
    "unsupported_authorisation",
  ];

  it("isFulfilmentDecided is TRUE for a decided fulfilment and narrows it", () => {
    const res: FulfilmentDecision = decided;
    expect(isFulfilmentDecided(res)).toBe(true);
    if (isFulfilmentDecided(res)) {
      // Narrowed to FulfilBookingDecision — the outcome and booking are reachable without a cast.
      expect(res.outcome).toBe<FulfilmentOutcome>("booking_recorded");
      expect(res.booking).toEqual<PrepareBookingAction>(BOOKING_ACTION);
    }
  });

  it("isFulfilmentDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isFulfilmentDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("fulfilmentTypeOf is fulfil_booking for a decided arm and null for every abstention", () => {
    expect(fulfilmentTypeOf(decided)).toBe<ConversationFulfilmentType>("fulfil_booking");
    for (const reason of abstentions) {
      expect(fulfilmentTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("fulfilmentOutcomeOf is booking_recorded for a decided arm and null for every abstention", () => {
    expect(fulfilmentOutcomeOf(decided)).toBe<FulfilmentOutcome>("booking_recorded");
    for (const reason of abstentions) {
      expect(fulfilmentOutcomeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("fulfilmentTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(fulfilmentTypeOf(decided)).toBe(decided.kind);
  });
});

describe("R30 fulfilment engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveFulfilment returns a decision for EVERY (real authorisation × every grant)", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY]) {
          const action = actionFor(strategy, goal, info);
          for (const verdict of GUARDRAIL_VERDICTS) {
            for (const live of [true, false]) {
              const authorisation = resolveAuthorisation(
                resolveExecution(action, verdict, { liveExecutionEnabled: live }),
              );
              for (const approval of ALL_STATES) {
                const res = resolveFulfilment(authorisation, approval);
                expect(res.kind === "fulfil_booking" || res.kind === "none").toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it("across the WHOLE product, a fulfilment is emitted ONLY when the authorisation was decided AND the grant is approved", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY]) {
          const action = actionFor(strategy, goal, info);
          for (const verdict of GUARDRAIL_VERDICTS) {
            for (const live of [true, false]) {
              const authorisation = resolveAuthorisation(
                resolveExecution(action, verdict, { liveExecutionEnabled: live }),
              );
              for (const approval of ALL_STATES) {
                const decided = isFulfilmentDecided(resolveFulfilment(authorisation, approval));
                expect(decided).toBe(isAuthorisationDecided(authorisation) && approval === "approved");
              }
            }
          }
        }
      }
    }
  });

  it("is DETERMINISTIC — the same (authorisation, grant) always yields an equal fulfilment", () => {
    const authorisation = directAuthorisation("pending");
    for (const approval of ALL_STATES) {
      expect(resolveFulfilment(authorisation, approval)).toEqual(resolveFulfilment(authorisation, approval));
    }
  });

  it("does NOT mutate the authorisation decision it reads", () => {
    const authorisation = directAuthorisation("pending");
    const snapshot = JSON.stringify(authorisation);
    resolveFulfilment(authorisation, "approved");
    expect(JSON.stringify(authorisation)).toBe(snapshot);
  });
});

// A compile-time proof that `ConversationAuthorisationType` is exhaustively mapped by AUTHORISATION_FULFILMENT — if
// R29 adds an authorisation type without a matching AUTHORISATION_FULFILMENT entry, this reference fails to type-check.
const _exhaustiveAuthorisationMap: Readonly<
  Record<ConversationAuthorisationType, ConversationFulfilmentType | null>
> = AUTHORISATION_FULFILMENT;
void _exhaustiveAuthorisationMap;
