import { describe, it, expect } from "vitest";
import {
  EXECUTION_TYPES,
  ACTION_EXECUTION,
  resolveExecution,
  isExecutionDecided,
  executionTypeOf,
  eligibilityOf,
  type ConversationExecutionType,
  type ExecutionDecision,
  type ExecuteBookingDecision,
  type ExecutionEligibility,
  type ExecutionAbstention,
} from "@/lib/receptionist/conversation-execution";
import {
  ACTION_TYPES,
  resolveAction,
  type ActionResolution,
  type PrepareBookingAction,
  type ConversationActionType,
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
import { GUARDRAIL_VERDICTS, type GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * THE CONVERSATION EXECUTION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R28 — CONVERSATION EXECUTION ENGINE).
 *
 * lib/receptionist/conversation-execution.ts is the deterministic, leaf authority over the layer that DECIDES
 * whether a PREPARED action may execute: "given a prepared ACTION, the reply's policy verdict, and the
 * organisation's controls, MAY this action execute, and under what authority?". It is a TOTAL, DETERMINISTIC
 * function of three already-computed inputs — the R27 action (the DEFERRAL gate + payload), the R3 policy
 * verdict (the POLICY constraint) and the org controls (the ORGANISATIONAL constraint) — so it is exhaustively
 * unit-testable in isolation. Every action fed in is the REAL {@link resolveAction} over the REAL
 * {@link resolveOutcome} / {@link resolveStrategy} / {@link detectGap}, so the engine is proven against genuine
 * composition, never a hand-built action. These tests pin, EXHAUSTIVELY:
 *   • EXECUTION_TYPES is the closed execution vocabulary — exactly `execute_booking` in R28, no duplicates;
 *   • ACTION_EXECUTION is TOTAL over the R27 action vocabulary and maps prepare_booking → execute_booking;
 *   • resolveExecution DEFERS `no_action_prepared` whenever the Action Engine abstained — the FIRST gate, so
 *     the Action Engine (and transitively the Outcome Engine) stays authoritative;
 *   • resolveExecution folds the THREE constraints in a FIXED priority order (org → policy → human-review):
 *       – org disabled ⇒ `blocked_by_org` for EVERY policy verdict (the default, deny-by-default posture);
 *       – org enabled + `block` ⇒ `blocked_by_policy` (Policy stays mandatory — a block always refuses);
 *       – org enabled + non-block ⇒ `requires_human_review` (Human Review stays mandatory);
 *   • the STRONGEST eligibility is `requires_human_review` — across the WHOLE cartesian product of
 *     {real actions} × {every verdict} × {both org states} there is NO autonomous-execute value, so a booking
 *     NEVER executes autonomously (the §9 A4 guarantee, made structural);
 *   • the projections isExecutionDecided / executionTypeOf / eligibilityOf agree with the discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it DECIDES — it never persists or executes.
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
// The exact slots a satisfied arrange_booking needs — the prepare_booking payload the decision decides over.
const BOOKING_INFO: ConversationInformation = {
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};
const CALLBACK_INFO: ConversationInformation = { phone_number: PHONE };
const EMPTY: ConversationInformation = {};

// The concrete prepare_booking action, built directly for the projection/fold tests (equal to the one the REAL
// composition yields for a satisfied arrange_booking — asserted below).
const BOOKING_ACTION: PrepareBookingAction = {
  kind: "prepare_booking",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};

// The closed execution vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not
// read their own answer from EXECUTION_TYPES (the surface under test).
const ALL_EXECUTION_TYPES: readonly ConversationExecutionType[] = ["execute_booking"];

// The REAL progression trigger for a genuinely satisfied goal — derived through the R21 gap and the R22
// strategy, never hand-asserted.
const strategyFor = (goal: ConversationGoal, info: ConversationInformation): ConversationStrategy =>
  resolveStrategy(detectGap(goal, info)).strategy;
// Compose the whole stack EXACTLY as the runtime does: real strategy → real outcome → real action.
const actionFor = (
  strategy: ConversationStrategy,
  goal: ConversationGoal,
  info: ConversationInformation,
): ActionResolution => resolveAction(resolveOutcome(strategy, goal, info), strategy, goal, info);
// The REAL prepared booking action for a genuinely satisfied, genuinely progressing arrange_booking.
const realBookingAction = (): ActionResolution =>
  actionFor(strategyFor("arrange_booking", BOOKING_INFO), "arrange_booking", BOOKING_INFO);

describe("R28 execution engine — EXECUTION_TYPES: the closed execution vocabulary", () => {
  it("is EXACTLY `execute_booking` in R28 (quote/scheduling execution types are future work)", () => {
    expect(EXECUTION_TYPES).toEqual(["execute_booking"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(EXECUTION_TYPES).size).toBe(EXECUTION_TYPES.length);
    expect([...EXECUTION_TYPES].sort()).toEqual([...ALL_EXECUTION_TYPES].sort());
  });
});

describe("R28 execution engine — ACTION_EXECUTION: the total action → execution-type map", () => {
  it("is TOTAL over the whole R27 action vocabulary (every action type has an entry)", () => {
    expect(Object.keys(ACTION_EXECUTION).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it("maps prepare_booking → execute_booking", () => {
    expect(ACTION_EXECUTION.prepare_booking).toBe<ConversationExecutionType>("execute_booking");
  });

  it("every non-null execution type is in the EXECUTION_TYPES vocabulary", () => {
    for (const actionType of ACTION_TYPES) {
      const type = ACTION_EXECUTION[actionType];
      if (type !== null) expect(EXECUTION_TYPES).toContain(type);
    }
  });
});

describe("R28 execution engine — resolveExecution: the Action Engine is authoritative (defers, first gate)", () => {
  // Every abstention arm the R27 engine can return — the Execution Engine must defer on each.
  const abstentions: readonly ActionResolution[] = [
    { kind: "none", reason: "outcome_resolved" },
    { kind: "none", reason: "not_progressing" },
    { kind: "none", reason: "goal_has_no_action" },
    { kind: "none", reason: "incomplete" },
  ];

  for (const org of [{ liveExecutionEnabled: true }, { liveExecutionEnabled: false }]) {
    for (const verdict of GUARDRAIL_VERDICTS) {
      for (const action of abstentions) {
        it(`abstention → no_action_prepared (org.live=${org.liveExecutionEnabled}, verdict=${verdict})`, () => {
          expect(resolveExecution(action, verdict, org)).toEqual<ExecutionDecision>({
            kind: "none",
            reason: "no_action_prepared",
          });
        });
      }
    }
  }

  it("defers even when live execution is ON and the verdict is allow — no action ⇒ nothing to decide", () => {
    expect(
      resolveExecution({ kind: "none", reason: "not_progressing" }, "allow", {
        liveExecutionEnabled: true,
      }),
    ).toEqual<ExecutionDecision>({ kind: "none", reason: "no_action_prepared" });
  });
});

describe("R28 execution engine — resolveExecution: the organisational constraint (deny-by-default)", () => {
  for (const verdict of GUARDRAIL_VERDICTS) {
    it(`org DISABLED × verdict=${verdict} → blocked_by_org (the org gate dominates, verdict-agnostic)`, () => {
      expect(
        resolveExecution(BOOKING_ACTION, verdict, { liveExecutionEnabled: false }),
      ).toEqual<ExecuteBookingDecision>({
        kind: "execute_booking",
        eligibility: "blocked_by_org",
        action: BOOKING_ACTION,
      });
    });
  }

  it("blocked_by_org is the DEFAULT posture — a prepared booking cannot execute until the org arms it", () => {
    const decision = resolveExecution(BOOKING_ACTION, "allow", { liveExecutionEnabled: false });
    expect(isExecutionDecided(decision)).toBe(true);
    expect(eligibilityOf(decision)).toBe<ExecutionEligibility>("blocked_by_org");
  });
});

describe("R28 execution engine — resolveExecution: the policy constraint (Policy stays mandatory)", () => {
  it("org ENABLED × verdict=block → blocked_by_policy (an absolute prohibition always refuses)", () => {
    expect(
      resolveExecution(BOOKING_ACTION, "block", { liveExecutionEnabled: true }),
    ).toEqual<ExecuteBookingDecision>({
      kind: "execute_booking",
      eligibility: "blocked_by_policy",
      action: BOOKING_ACTION,
    });
  });

  it("consumes the verdict — it does not re-derive it (a `block` is honoured verbatim)", () => {
    // The engine takes the guardrail's ALREADY-computed verdict; a block forces blocked_by_policy regardless of
    // the booking payload being perfectly well-formed.
    expect(eligibilityOf(resolveExecution(BOOKING_ACTION, "block", { liveExecutionEnabled: true }))).toBe(
      "blocked_by_policy",
    );
  });
});

describe("R28 execution engine — resolveExecution: the human-review requirement (the terminal, strongest state)", () => {
  for (const verdict of GUARDRAIL_VERDICTS.filter((v) => v !== "block")) {
    it(`org ENABLED × verdict=${verdict} → requires_human_review (a booking is a §9 A4 commitment)`, () => {
      expect(
        resolveExecution(BOOKING_ACTION, verdict, { liveExecutionEnabled: true }),
      ).toEqual<ExecuteBookingDecision>({
        kind: "execute_booking",
        eligibility: "requires_human_review",
        action: BOOKING_ACTION,
      });
    });
  }

  it("the MOST PERMISSIVE inputs (org ON, verdict allow) STILL require human review — never autonomous", () => {
    // This is the cardinal R28 guarantee: even when the org has armed live execution AND policy allowed the
    // reply, the strongest a booking reaches is requires_human_review. There is no path to autonomous execution.
    const decision = resolveExecution(BOOKING_ACTION, "allow", { liveExecutionEnabled: true });
    expect(eligibilityOf(decision)).toBe<ExecutionEligibility>("requires_human_review");
  });
});

describe("R28 execution engine — the eligibility vocabulary has NO autonomous-execute value (structural)", () => {
  const CLOSED_ELIGIBILITY: readonly ExecutionEligibility[] = [
    "requires_human_review",
    "blocked_by_policy",
    "blocked_by_org",
  ];

  it("across EVERY (real action × every verdict × both org states), the decision is deterministic and never autonomous", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY]) {
          const action = actionFor(strategy, goal, info);
          for (const verdict of GUARDRAIL_VERDICTS) {
            for (const live of [true, false]) {
              const decision = resolveExecution(action, verdict, { liveExecutionEnabled: live });
              if (decision.kind === "none") {
                expect(decision.reason).toBe("no_action_prepared");
              } else {
                // A decided decision is ALWAYS one of the three non-autonomous eligibilities.
                expect(CLOSED_ELIGIBILITY).toContain(decision.eligibility);
                // And it is NEVER a value that would authorise autonomous execution (widened to string so the
                // negative assertion is expressible — the union itself has no such member, which is the point).
                const asString: string = decision.eligibility;
                expect(asString).not.toBe("execute_now");
                expect(asString).not.toBe("execute_autonomously");
              }
            }
          }
        }
      }
    }
  });

  it("the strongest eligibility reachable by ANY input is requires_human_review", () => {
    // Enumerate every reachable eligibility over the whole product; the set is exactly the three, and the
    // 'most eligible' is the human-gated one — there is nothing stronger.
    const reachable = new Set<ExecutionEligibility>();
    for (const verdict of GUARDRAIL_VERDICTS) {
      for (const live of [true, false]) {
        const decision = resolveExecution(BOOKING_ACTION, verdict, { liveExecutionEnabled: live });
        if (decision.kind !== "none") reachable.add(decision.eligibility);
      }
    }
    expect([...reachable].sort()).toEqual([...CLOSED_ELIGIBILITY].sort());
  });
});

describe("R28 execution engine — proven against the REAL R27 action (genuine composition)", () => {
  it("a genuinely satisfied arrange_booking yields the REAL prepare_booking action the engine decides over", () => {
    const action = realBookingAction();
    expect(action).toEqual<ActionResolution>(BOOKING_ACTION);
  });

  it("that real action, org OFF → blocked_by_org (the production default)", () => {
    expect(
      resolveExecution(realBookingAction(), "allow", { liveExecutionEnabled: false }),
    ).toEqual<ExecuteBookingDecision>({
      kind: "execute_booking",
      eligibility: "blocked_by_org",
      action: BOOKING_ACTION,
    });
  });

  it("that real action, org ON + clean verdict → requires_human_review", () => {
    expect(
      resolveExecution(realBookingAction(), "review", { liveExecutionEnabled: true }),
    ).toEqual<ExecuteBookingDecision>({
      kind: "execute_booking",
      eligibility: "requires_human_review",
      action: BOOKING_ACTION,
    });
  });

  it("a real ABSTAINED action (no booking prepared) → no_action_prepared, whatever the org/verdict", () => {
    // answer_enquiry never prepares an action — the Execution Engine defers regardless of the org/verdict.
    const action = actionFor(strategyFor("answer_enquiry", FULL), "answer_enquiry", FULL);
    expect(isExecutionDecided(resolveExecution(action, "allow", { liveExecutionEnabled: true }))).toBe(
      false,
    );
  });
});

describe("R28 execution engine — isExecutionDecided / executionTypeOf / eligibilityOf: projections agree", () => {
  const decided: ExecuteBookingDecision = {
    kind: "execute_booking",
    eligibility: "requires_human_review",
    action: BOOKING_ACTION,
  };
  const abstentions: readonly ExecutionAbstention[] = ["no_action_prepared", "unsupported_action"];

  it("isExecutionDecided is TRUE for a decided decision and narrows it", () => {
    const res: ExecutionDecision = decided;
    expect(isExecutionDecided(res)).toBe(true);
    if (isExecutionDecided(res)) {
      // Narrowed to ExecuteBookingDecision — the eligibility and payload are reachable without a cast.
      expect(res.eligibility).toBe<ExecutionEligibility>("requires_human_review");
      expect(res.action).toEqual(BOOKING_ACTION);
    }
  });

  it("isExecutionDecided is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isExecutionDecided({ kind: "none", reason })).toBe(false);
    }
  });

  it("executionTypeOf is the execute_booking type for the decided arm and null for every abstention", () => {
    expect(executionTypeOf(decided)).toBe<ConversationExecutionType>("execute_booking");
    for (const reason of abstentions) {
      expect(executionTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("eligibilityOf is the decided arm's eligibility and null for every abstention", () => {
    expect(eligibilityOf(decided)).toBe<ExecutionEligibility>("requires_human_review");
    for (const reason of abstentions) {
      expect(eligibilityOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("executionTypeOf agrees with the decided arm's kind (identity on the decided arms)", () => {
    expect(executionTypeOf(decided)).toBe(decided.kind);
  });
});

describe("R28 execution engine — the surface is total, deterministic and non-mutating", () => {
  const infos: readonly ConversationInformation[] = [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY];
  const verdicts: readonly GuardrailVerdict[] = GUARDRAIL_VERDICTS;

  it("is TOTAL — resolveExecution returns a decision for EVERY action × verdict × org", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of infos) {
          const action = actionFor(strategy, goal, info);
          for (const verdict of verdicts) {
            for (const live of [true, false]) {
              const res = resolveExecution(action, verdict, { liveExecutionEnabled: live });
              expect(res.kind === "execute_booking" || res.kind === "none").toBe(true);
            }
          }
        }
      }
    }
  });

  it("is DETERMINISTIC — the same inputs always yield an equal decision", () => {
    for (const verdict of verdicts) {
      for (const live of [true, false]) {
        const org = { liveExecutionEnabled: live };
        expect(resolveExecution(BOOKING_ACTION, verdict, org)).toEqual(
          resolveExecution(BOOKING_ACTION, verdict, org),
        );
      }
    }
  });

  it("does NOT mutate the action it reads", () => {
    const action: PrepareBookingAction = { ...BOOKING_ACTION };
    const snapshot = JSON.stringify(action);
    resolveExecution(action, "allow", { liveExecutionEnabled: true });
    expect(JSON.stringify(action)).toBe(snapshot);
  });

  it("does NOT mutate the org constraints it reads", () => {
    const org = { liveExecutionEnabled: true };
    const snapshot = JSON.stringify(org);
    resolveExecution(BOOKING_ACTION, "block", org);
    expect(JSON.stringify(org)).toBe(snapshot);
  });
});

// A compile-time proof that `ConversationActionType` is exhaustively mapped by ACTION_EXECUTION — if R27 adds
// an action type without a matching ACTION_EXECUTION entry, this reference fails to type-check.
const _exhaustiveActionMap: Readonly<Record<ConversationActionType, ConversationExecutionType | null>> =
  ACTION_EXECUTION;
void _exhaustiveActionMap;
