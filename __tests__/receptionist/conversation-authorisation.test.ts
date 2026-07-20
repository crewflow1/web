import { describe, it, expect } from "vitest";
import {
  AUTHORISATION_TYPES,
  EXECUTION_AUTHORISATION,
  resolveAuthorisation,
  deriveAuthorisationState,
  isAuthorisationDecided,
  isApprovalRequired,
  authorisationTypeOf,
  requirementOf,
  openingStateOf,
  type ConversationAuthorisationType,
  type AuthorisationDecision,
  type ApproveBookingAuthorisation,
  type AuthorisationRequirement,
  type AuthorisationState,
  type AuthorisationOpeningState,
  type AuthorisationAbstention,
  type ReviewResolutionSignal,
} from "@/lib/receptionist/conversation-authorisation";
import {
  EXECUTION_TYPES,
  resolveExecution,
  type ExecuteBookingDecision,
  type ExecutionEligibility,
  type ExecutionAbstention,
  type ConversationExecutionType,
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
 * THE CONVERSATION AUTHORISATION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R29 — CONVERSATION AUTHORISATION ENGINE).
 *
 * lib/receptionist/conversation-authorisation.ts is the deterministic, leaf authority over the layer that
 * DETERMINES whether a DECIDED execution requires approval: "given an EXECUTION DECISION, IS approval required
 * before this may proceed, and what is the authorisation STATE?". It is a TOTAL, DETERMINISTIC function of ONE
 * already-computed input — the R28 execution decision (the DEFERRAL gate + the eligibility it folds) — so it is
 * exhaustively unit-testable in isolation. Every execution fed in is the REAL {@link resolveExecution} over the
 * REAL {@link resolveAction} / {@link resolveOutcome} / {@link resolveStrategy} / {@link detectGap} stack, so the
 * engine is proven against genuine composition, never a hand-built execution. These tests pin, EXHAUSTIVELY:
 *   • AUTHORISATION_TYPES is the closed authorisation vocabulary — exactly `approve_booking` in R29, no dupes;
 *   • EXECUTION_AUTHORISATION is TOTAL over the R28 execution vocabulary and maps execute_booking →
 *     approve_booking;
 *   • resolveAuthorisation DEFERS `no_execution_decision` whenever the Execution Engine abstained — the FIRST
 *     gate, so the Execution Engine (and transitively the Action and Outcome Engines) stays authoritative;
 *   • resolveAuthorisation folds the execution eligibility deterministically:
 *       – requires_human_review ⇒ (human_approval_required, `pending`) — Human Review stays mandatory;
 *       – blocked_by_policy / blocked_by_org ⇒ (not_required, `foreclosed`) — Policy's / the org's refusal
 *         propagates, without a re-run;
 *   • the STRONGEST turn-time state is `pending` — across the WHOLE cartesian product of {real executions} there
 *     is NO grant value (`approved` / `rejected`), so a booking is NEVER auto-approved (the §9 A4 guarantee, made
 *     structural);
 *   • deriveAuthorisationState is the SINGLE bridge to the EXISTING Human Review architecture — the ONLY place
 *     the grant states arise, and only from a real review resolution (`sent` ⇒ approved, `dismissed` ⇒ rejected);
 *   • the projections isAuthorisationDecided / isApprovalRequired / authorisationTypeOf / requirementOf /
 *     openingStateOf agree with the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it DETERMINES APPROVAL — it never persists,
 *     grants or executes.
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

// The closed authorisation vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do
// not read their own answer from AUTHORISATION_TYPES (the surface under test).
const ALL_AUTHORISATION_TYPES: readonly ConversationAuthorisationType[] = ["approve_booking"];

// A decided execution decision at a chosen eligibility, built directly — the input the Authorisation Engine folds.
const directExecution = (eligibility: ExecutionEligibility): ExecuteBookingDecision => ({
  kind: "execute_booking",
  eligibility,
  action: BOOKING_ACTION,
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

// The REAL execution decision for a genuinely satisfied booking, at a chosen policy verdict and org gate —
// narrowed to the decided arm. A satisfied arrange_booking always prepares an action and DECIDES over it, so an
// abstention here is a broken fixture, not a valid outcome: fail loudly rather than silently widen the type.
const realBookingExecution = (
  verdict: (typeof GUARDRAIL_VERDICTS)[number],
  liveExecutionEnabled: boolean,
): ExecuteBookingDecision => {
  const execution = resolveExecution(realBookingAction(), verdict, { liveExecutionEnabled });
  if (execution.kind === "none") {
    throw new Error(`expected a decided booking execution, got abstention: ${execution.reason}`);
  }
  return execution;
};

describe("R29 authorisation engine — AUTHORISATION_TYPES: the closed authorisation vocabulary", () => {
  it("is EXACTLY `approve_booking` in R29 (quote/scheduling approval types are future work)", () => {
    expect(AUTHORISATION_TYPES).toEqual(["approve_booking"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(AUTHORISATION_TYPES).size).toBe(AUTHORISATION_TYPES.length);
    expect([...AUTHORISATION_TYPES].sort()).toEqual([...ALL_AUTHORISATION_TYPES].sort());
  });
});

describe("R29 authorisation engine — EXECUTION_AUTHORISATION: the total execution → authorisation-type map", () => {
  it("is TOTAL over the whole R28 execution vocabulary (every execution type has an entry)", () => {
    expect(Object.keys(EXECUTION_AUTHORISATION).sort()).toEqual([...EXECUTION_TYPES].sort());
  });

  it("maps execute_booking → approve_booking", () => {
    expect(EXECUTION_AUTHORISATION.execute_booking).toBe<ConversationAuthorisationType>("approve_booking");
  });

  it("every non-null authorisation type is in the AUTHORISATION_TYPES vocabulary", () => {
    for (const executionType of EXECUTION_TYPES) {
      const type = EXECUTION_AUTHORISATION[executionType];
      if (type !== null) expect(AUTHORISATION_TYPES).toContain(type);
    }
  });
});

describe("R29 authorisation engine — resolveAuthorisation: the Execution Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R28 engine can return — the Authorisation Engine must defer on each.
  const executionAbstentions: readonly ExecutionAbstention[] = ["no_action_prepared", "unsupported_action"];

  for (const reason of executionAbstentions) {
    it(`execution abstention (${reason}) → no_execution_decision`, () => {
      expect(resolveAuthorisation({ kind: "none", reason })).toEqual<AuthorisationDecision>({
        kind: "none",
        reason: "no_execution_decision",
      });
    });
  }

  it("defers on a REAL abstained execution — answer_enquiry never prepares an action, so nothing is decided", () => {
    const action = actionFor(strategyFor("answer_enquiry", FULL), "answer_enquiry", FULL);
    const execution = resolveExecution(action, "allow", { liveExecutionEnabled: true });
    expect(resolveAuthorisation(execution)).toEqual<AuthorisationDecision>({
      kind: "none",
      reason: "no_execution_decision",
    });
  });
});

describe("R29 authorisation engine — resolveAuthorisation: the requirement + turn-time state fold", () => {
  it("requires_human_review ⇒ human_approval_required + pending (a booking is a §9 A4 commitment)", () => {
    const execution = directExecution("requires_human_review");
    expect(resolveAuthorisation(execution)).toEqual<AuthorisationDecision>({
      kind: "approve_booking",
      requirement: "human_approval_required",
      state: "pending",
      execution,
    });
  });

  for (const eligibility of ["blocked_by_policy", "blocked_by_org"] as const) {
    it(`${eligibility} ⇒ not_required + foreclosed (blocked upstream — there is nothing to approve)`, () => {
      const execution = directExecution(eligibility);
      expect(resolveAuthorisation(execution)).toEqual<AuthorisationDecision>({
        kind: "approve_booking",
        requirement: "not_required",
        state: "foreclosed",
        execution,
      });
    });
  }

  it("carries the exact execution decision it authorises over (self-describing for the audit ledger)", () => {
    const execution = directExecution("requires_human_review");
    const authorisation = resolveAuthorisation(execution);
    expect(isAuthorisationDecided(authorisation)).toBe(true);
    if (isAuthorisationDecided(authorisation)) {
      expect(authorisation.execution).toBe(execution);
    }
  });
});

describe("R29 authorisation engine — the turn-time state has NO grant value (structural)", () => {
  const OPENING_STATES: readonly AuthorisationOpeningState[] = ["pending", "foreclosed"];

  it("across EVERY (real action × every verdict × both org states), a decided state is only pending/foreclosed — never a grant", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY]) {
          const action = actionFor(strategy, goal, info);
          for (const verdict of GUARDRAIL_VERDICTS) {
            for (const live of [true, false]) {
              const execution = resolveExecution(action, verdict, { liveExecutionEnabled: live });
              const authorisation = resolveAuthorisation(execution);
              if (authorisation.kind === "none") {
                expect(authorisation.reason).toBe("no_execution_decision");
              } else {
                // A decided authorisation's turn-time state is ALWAYS one of the two non-granting states.
                expect(OPENING_STATES).toContain(authorisation.state);
                // And it is NEVER a grant value (widened to string so the negative assertion is expressible —
                // the AuthorisationOpeningState union itself has no such member, which is the whole point).
                const asString: string = authorisation.state;
                expect(asString).not.toBe("approved");
                expect(asString).not.toBe("rejected");
              }
            }
          }
        }
      }
    }
  });

  it("the strongest turn-time state reachable by ANY input is pending", () => {
    // Enumerate every reachable turn-time state over the whole product; the set is exactly the two, and the
    // 'strongest' is the human-gated `pending` — there is no grant reachable at decision time.
    const reachable = new Set<AuthorisationOpeningState>();
    for (const verdict of GUARDRAIL_VERDICTS) {
      for (const live of [true, false]) {
        const execution = resolveExecution(BOOKING_ACTION, verdict, { liveExecutionEnabled: live });
        const authorisation = resolveAuthorisation(execution);
        if (authorisation.kind !== "none") reachable.add(authorisation.state);
      }
    }
    expect([...reachable].sort()).toEqual([...OPENING_STATES].sort());
  });
});

describe("R29 authorisation engine — proven against the REAL R28 execution (genuine composition)", () => {
  it("a genuinely satisfied arrange_booking yields the REAL prepare_booking action the execution decides over", () => {
    expect(realBookingAction()).toEqual<ActionResolution>(BOOKING_ACTION);
  });

  it("that real booking, org OFF → approve_booking / not_required / foreclosed (the production default)", () => {
    const execution = realBookingExecution("allow", false);
    expect(resolveAuthorisation(execution)).toEqual<AuthorisationDecision>({
      kind: "approve_booking",
      requirement: "not_required",
      state: "foreclosed",
      execution,
    });
  });

  it("org ON + clean verdict → approve_booking / human_approval_required / pending", () => {
    const execution = realBookingExecution("review", true);
    expect(resolveAuthorisation(execution)).toEqual<AuthorisationDecision>({
      kind: "approve_booking",
      requirement: "human_approval_required",
      state: "pending",
      execution,
    });
  });

  it("org ON + block verdict → approve_booking / not_required / foreclosed (policy's refusal propagates)", () => {
    const execution = realBookingExecution("block", true);
    expect(resolveAuthorisation(execution)).toEqual<AuthorisationDecision>({
      kind: "approve_booking",
      requirement: "not_required",
      state: "foreclosed",
      execution,
    });
  });

  it("the MOST PERMISSIVE inputs (org ON, verdict allow) STILL only reach pending — never a grant", () => {
    // The cardinal R29 guarantee: even when the org armed live execution AND policy allowed the reply, the
    // strongest a booking's authorisation reaches at decision time is `pending`. There is no path to a grant.
    const execution = realBookingExecution("allow", true);
    const authorisation = resolveAuthorisation(execution);
    expect(openingStateOf(authorisation)).toBe<AuthorisationOpeningState>("pending");
    expect(isApprovalRequired(authorisation)).toBe(true);
  });
});

describe("R29 authorisation engine — deriveAuthorisationState: the single bridge to Human Review", () => {
  const signals: readonly ReviewResolutionSignal[] = ["sent", "dismissed", null];

  it("a foreclosed authorisation stays foreclosed for EVERY resolution (nothing to revive)", () => {
    for (const signal of signals) {
      expect(deriveAuthorisationState("foreclosed", signal)).toBe<AuthorisationState>("foreclosed");
    }
  });

  it("pending + sent ⇒ approved (the human granted and sent the confirmation)", () => {
    expect(deriveAuthorisationState("pending", "sent")).toBe<AuthorisationState>("approved");
  });

  it("pending + dismissed ⇒ rejected (the human refused)", () => {
    expect(deriveAuthorisationState("pending", "dismissed")).toBe<AuthorisationState>("rejected");
  });

  it("pending + no resolution yet ⇒ still pending (awaiting the human)", () => {
    expect(deriveAuthorisationState("pending", null)).toBe<AuthorisationState>("pending");
  });

  it("the grant states arise ONLY through this bridge (never from resolveAuthorisation)", () => {
    // resolveAuthorisation's image is only pending/foreclosed; approved/rejected exist ONLY through this fold of
    // an EXISTING Human Review resolution — that is how R29 integrates with the grant without duplicating it.
    const produced = new Set<AuthorisationState>();
    for (const opening of ["pending", "foreclosed"] as const) {
      for (const signal of signals) {
        produced.add(deriveAuthorisationState(opening, signal));
      }
    }
    expect(produced.has("approved")).toBe(true);
    expect(produced.has("rejected")).toBe(true);
  });
});

describe("R29 authorisation engine — isAuthorisationDecided / isApprovalRequired / projections agree", () => {
  const decidedPending: ApproveBookingAuthorisation = {
    kind: "approve_booking",
    requirement: "human_approval_required",
    state: "pending",
    execution: directExecution("requires_human_review"),
  };
  const decidedForeclosed: ApproveBookingAuthorisation = {
    kind: "approve_booking",
    requirement: "not_required",
    state: "foreclosed",
    execution: directExecution("blocked_by_org"),
  };
  const abstentions: readonly AuthorisationAbstention[] = ["no_execution_decision", "unsupported_execution"];

  it("isAuthorisationDecided is TRUE for a decided authorisation and narrows it", () => {
    const res: AuthorisationDecision = decidedPending;
    expect(isAuthorisationDecided(res)).toBe(true);
    if (isAuthorisationDecided(res)) {
      // Narrowed to ApproveBookingAuthorisation — the requirement, state and execution are reachable without a cast.
      expect(res.requirement).toBe<AuthorisationRequirement>("human_approval_required");
      expect(res.state).toBe<AuthorisationOpeningState>("pending");
      expect(res.execution.eligibility).toBe<ExecutionEligibility>("requires_human_review");
    }
  });

  it("isAuthorisationDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isAuthorisationDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("isApprovalRequired is TRUE only for a human_approval_required decision", () => {
    expect(isApprovalRequired(decidedPending)).toBe(true);
    expect(isApprovalRequired(decidedForeclosed)).toBe(false);
    for (const reason of abstentions) {
      expect(isApprovalRequired({ kind: "none", reason })).toBe(false);
    }
  });

  it("authorisationTypeOf is approve_booking for a decided arm and null for every abstention", () => {
    expect(authorisationTypeOf(decidedPending)).toBe<ConversationAuthorisationType>("approve_booking");
    expect(authorisationTypeOf(decidedForeclosed)).toBe<ConversationAuthorisationType>("approve_booking");
    for (const reason of abstentions) {
      expect(authorisationTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("requirementOf is the decided arm's requirement and null for every abstention", () => {
    expect(requirementOf(decidedPending)).toBe<AuthorisationRequirement>("human_approval_required");
    expect(requirementOf(decidedForeclosed)).toBe<AuthorisationRequirement>("not_required");
    for (const reason of abstentions) {
      expect(requirementOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("openingStateOf is the decided arm's state and null for every abstention — never a grant", () => {
    expect(openingStateOf(decidedPending)).toBe<AuthorisationOpeningState>("pending");
    expect(openingStateOf(decidedForeclosed)).toBe<AuthorisationOpeningState>("foreclosed");
    for (const reason of abstentions) {
      expect(openingStateOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("authorisationTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(authorisationTypeOf(decidedPending)).toBe(decidedPending.kind);
  });
});

describe("R29 authorisation engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveAuthorisation returns a decision for EVERY real execution", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY]) {
          const action = actionFor(strategy, goal, info);
          for (const verdict of GUARDRAIL_VERDICTS) {
            for (const live of [true, false]) {
              const execution = resolveExecution(action, verdict, { liveExecutionEnabled: live });
              const res = resolveAuthorisation(execution);
              expect(res.kind === "approve_booking" || res.kind === "none").toBe(true);
            }
          }
        }
      }
    }
  });

  it("is DETERMINISTIC — the same execution always yields an equal authorisation", () => {
    for (const eligibility of ["requires_human_review", "blocked_by_policy", "blocked_by_org"] as const) {
      const execution = directExecution(eligibility);
      expect(resolveAuthorisation(execution)).toEqual(resolveAuthorisation(execution));
    }
  });

  it("does NOT mutate the execution decision it reads", () => {
    const execution = directExecution("requires_human_review");
    const snapshot = JSON.stringify(execution);
    resolveAuthorisation(execution);
    expect(JSON.stringify(execution)).toBe(snapshot);
  });

  it("deriveAuthorisationState is DETERMINISTIC and total over (opening × resolution)", () => {
    const allStates: readonly AuthorisationState[] = ["pending", "approved", "rejected", "foreclosed"];
    for (const opening of ["pending", "foreclosed"] as const) {
      for (const resolution of ["sent", "dismissed", null] as const) {
        const once = deriveAuthorisationState(opening, resolution);
        expect(deriveAuthorisationState(opening, resolution)).toBe(once);
        expect(allStates).toContain(once);
      }
    }
  });
});

// A compile-time proof that `ConversationExecutionType` is exhaustively mapped by EXECUTION_AUTHORISATION — if
// R28 adds an execution type without a matching EXECUTION_AUTHORISATION entry, this reference fails to type-check.
const _exhaustiveExecutionMap: Readonly<
  Record<ConversationExecutionType, ConversationAuthorisationType | null>
> = EXECUTION_AUTHORISATION;
void _exhaustiveExecutionMap;
