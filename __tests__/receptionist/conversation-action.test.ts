import { describe, it, expect } from "vitest";
import {
  ACTION_TYPES,
  GOAL_ACTION,
  resolveAction,
  isActionableAction,
  actionTypeOf,
  type ConversationActionType,
  type ActionResolution,
  type PrepareBookingAction,
  type ActionAbstention,
} from "@/lib/receptionist/conversation-action";
import {
  GOAL_OUTCOME,
  resolveOutcome,
  isActionableOutcome,
  type CallbackOutcome,
  type OutcomeResolution,
} from "@/lib/receptionist/conversation-outcome";
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

/**
 * THE CONVERSATION ACTION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R27 — CONVERSATION ACTION ENGINE).
 *
 * lib/receptionist/conversation-action.ts is the deterministic, leaf authority over the layer that CONVERTS a
 * resolved outcome into an internal business action PROPOSAL: "given the conversation's resolved OUTCOME, the
 * progressing strategy, the goal and the information, what INTERNAL ACTION should the organisation PREPARE?".
 * It is a TOTAL, DETERMINISTIC function of four already-derived observations — the R26 outcome (the DEFERRAL
 * gate), the R22 strategy (the progression TRIGGER), the R19 goal (which SELECTS the action type) and the R20
 * information (the PAYLOAD) — so it is exhaustively unit-testable in isolation. Every outcome fed in is the
 * REAL {@link resolveOutcome}, and every strategy the REAL {@link resolveStrategy} over a REAL
 * {@link detectGap}, so the engine is proven against genuine composition, never a hand-built trigger. These
 * tests pin, EXHAUSTIVELY:
 *   • ACTION_TYPES is the closed action vocabulary — exactly `prepare_booking` in R27, no duplicates;
 *   • GOAL_ACTION is TOTAL over the goal vocabulary and maps ONLY arrange_booking → prepare_booking;
 *   • GOAL_ACTION is DISJOINT from the R26 GOAL_OUTCOME — no goal maps to BOTH an action and an outcome, so
 *     the Outcome Engine stays authoritative and the two engines never contend;
 *   • resolveAction DEFERS `outcome_resolved` whenever the Outcome Engine resolved an actionable outcome — the
 *     FIRST gate, and it DOMINATES the goal map (an actionable outcome always wins, structurally);
 *   • resolveAction ABSTAINS `not_progressing` for EVERY non-`progress_goal` strategy × EVERY goal;
 *   • resolveAction ABSTAINS `goal_has_no_action` for a progressing goal that maps to null;
 *   • resolveAction RESOLVES the prepare_booking action — carrying job_type, postcode and the E.164 number —
 *     for a genuinely satisfied, genuinely progressing arrange_booking the Outcome Engine ABSTAINS on, and
 *     this is UNIFIED with R20 validation (an absent or malformed field can NEVER become a preparable action —
 *     it abstains `incomplete` instead);
 *   • the composition NEVER yields both an actionable outcome AND an actionable action on one turn;
 *   • the projections isActionableAction / actionTypeOf agree with the resolution's discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it PREPARES — it never persists, drafts
 *     or executes.
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
// The exact slots a satisfied arrange_booking needs (GOAL_SLOTS.arrange_booking) — the prepare_booking payload.
const BOOKING_INFO: ConversationInformation = {
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
};
// The exact slots a satisfied arrange_callback needs — used to build a REAL actionable callback outcome.
const CALLBACK_INFO: ConversationInformation = { phone_number: PHONE };
const EMPTY: ConversationInformation = {};

// The closed action vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do not
// read their own answer from ACTION_TYPES (the surface under test).
const ALL_ACTION_TYPES: readonly ConversationActionType[] = ["prepare_booking"];

// The REAL progression trigger for a genuinely satisfied goal — derived through the R21 gap and the R22
// strategy, never hand-asserted.
const strategyFor = (goal: ConversationGoal, info: ConversationInformation): ConversationStrategy =>
  resolveStrategy(detectGap(goal, info)).strategy;
// Compose the two engines EXACTLY as the runtime does: resolve the real outcome, then feed it to the action.
const actionFor = (
  strategy: ConversationStrategy,
  goal: ConversationGoal,
  info: ConversationInformation,
): ActionResolution => resolveAction(resolveOutcome(strategy, goal, info), strategy, goal, info);

describe("R27 action engine — ACTION_TYPES: the closed action vocabulary", () => {
  it("is EXACTLY `prepare_booking` in R27 (booking execution / quote action types are future work)", () => {
    expect(ACTION_TYPES).toEqual(["prepare_booking"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(ACTION_TYPES).size).toBe(ACTION_TYPES.length);
    expect([...ACTION_TYPES].sort()).toEqual([...ALL_ACTION_TYPES].sort());
  });
});

describe("R27 action engine — GOAL_ACTION: the total goal → action-type map", () => {
  it("is TOTAL over the whole goal vocabulary (every goal has an entry)", () => {
    expect(Object.keys(GOAL_ACTION).sort()).toEqual([...CONVERSATION_GOALS].sort());
  });

  it("maps ONLY arrange_booking → prepare_booking; every other goal → null", () => {
    for (const goal of CONVERSATION_GOALS) {
      expect(GOAL_ACTION[goal]).toBe(goal === "arrange_booking" ? "prepare_booking" : null);
    }
  });

  it("every non-null action type is in the ACTION_TYPES vocabulary", () => {
    for (const goal of CONVERSATION_GOALS) {
      const type = GOAL_ACTION[goal];
      if (type !== null) expect(ACTION_TYPES).toContain(type);
    }
  });

  it("a callback is an R26 OUTCOME, not an R27 action ⇒ arrange_callback resolves to NO action", () => {
    expect(GOAL_ACTION.arrange_callback).toBeNull();
  });

  it("quote generation is an EXPLICIT R27 non-goal ⇒ provide_quote resolves to NO action", () => {
    expect(GOAL_ACTION.provide_quote).toBeNull();
  });
});

describe("R27 action engine — the Outcome Engine stays authoritative: GOAL_ACTION ⟂ GOAL_OUTCOME", () => {
  it("no goal maps to BOTH an action and an outcome (the maps are DISJOINT)", () => {
    for (const goal of CONVERSATION_GOALS) {
      const hasAction = GOAL_ACTION[goal] !== null;
      const hasOutcome = GOAL_OUTCOME[goal] !== null;
      expect(hasAction && hasOutcome).toBe(false);
    }
  });

  it("the partition is exactly as designed — callback→outcome, booking→action, the rest→neither", () => {
    expect(GOAL_OUTCOME.arrange_callback).toBe("callback");
    expect(GOAL_ACTION.arrange_callback).toBeNull();
    expect(GOAL_ACTION.arrange_booking).toBe("prepare_booking");
    expect(GOAL_OUTCOME.arrange_booking).toBeNull();
  });
});

describe("R27 action engine — resolveAction: the Outcome Engine is authoritative (defers, first gate)", () => {
  it("a genuinely satisfied arrange_callback resolves an actionable OUTCOME ⇒ the action DEFERS", () => {
    // Precondition: the REAL composition yields an actionable callback outcome for a satisfied arrange_callback.
    const outcome = resolveOutcome("progress_goal", "arrange_callback", CALLBACK_INFO);
    expect(isActionableOutcome(outcome)).toBe(true);
    // The Action Engine stands down — the Outcome Engine owns the turn.
    const action = resolveAction(outcome, "progress_goal", "arrange_callback", CALLBACK_INFO);
    expect(action).toEqual<ActionResolution>({ kind: "none", reason: "outcome_resolved" });
  });

  it("the deferral gate DOMINATES the goal map — an actionable outcome wins even over arrange_booking", () => {
    // Belt-and-braces: a (contrived) actionable callback outcome paired with the booking goal + full booking
    // slots — the goal map alone would resolve prepare_booking, but gate 1 defers first.
    const actionableOutcome: CallbackOutcome = { kind: "callback", phone_number: PHONE };
    const action = resolveAction(actionableOutcome, "progress_goal", "arrange_booking", BOOKING_INFO);
    expect(action).toEqual<ActionResolution>({ kind: "none", reason: "outcome_resolved" });
  });
});

describe("R27 action engine — resolveAction: the trigger is progress_goal and nothing else", () => {
  const nonProgress = STRATEGY_PRIORITY.filter((s) => s !== "progress_goal");

  it("covers EVERY non-progress strategy (no strategy left untested)", () => {
    expect([...nonProgress, "progress_goal"].sort()).toEqual([...STRATEGY_PRIORITY].sort());
  });

  for (const strategy of nonProgress) {
    for (const goal of CONVERSATION_GOALS) {
      it(`${strategy} × ${goal}: ABSTAINS not_progressing (never prepares)`, () => {
        // The real outcome for a non-progress strategy is itself an abstention, so the action falls through
        // the deferral gate to the progression gate and abstains not_progressing.
        expect(actionFor(strategy, goal, FULL)).toEqual<ActionResolution>({
          kind: "none",
          reason: "not_progressing",
        });
      });
    }
  }
});

describe("R27 action engine — resolveAction: progressing a goal with no action abstains", () => {
  // The goals that prepare NO action AND resolve NO outcome — progress_goal over these reaches the
  // goal_has_no_action gate directly (the outcome abstains goal_has_no_outcome, so the deferral gate passes).
  const pureNoActionGoals = CONVERSATION_GOALS.filter(
    (g) => GOAL_ACTION[g] === null && GOAL_OUTCOME[g] === null,
  );

  for (const goal of pureNoActionGoals) {
    it(`progress_goal × ${goal}: ABSTAINS goal_has_no_action (progresses, prepares nothing)`, () => {
      expect(actionFor("progress_goal", goal, FULL)).toEqual<ActionResolution>({
        kind: "none",
        reason: "goal_has_no_action",
      });
    });
  }

  it("covers EVERY no-action / no-outcome goal", () => {
    expect(pureNoActionGoals.sort()).toEqual(
      [...CONVERSATION_GOALS].filter((g) => g !== "arrange_booking" && g !== "arrange_callback").sort(),
    );
  });

  it("arrange_callback with no valid phone (outcome abstains) ALSO abstains goal_has_no_action", () => {
    // arrange_callback maps to an OUTCOME, so it only reaches the action's goal gate when the outcome itself
    // abstains (here: an unringable callback). Then GOAL_ACTION.arrange_callback === null ⇒ goal_has_no_action.
    const outcome = resolveOutcome("progress_goal", "arrange_callback", EMPTY);
    expect(isActionableOutcome(outcome)).toBe(false);
    expect(actionFor("progress_goal", "arrange_callback", EMPTY)).toEqual<ActionResolution>({
      kind: "none",
      reason: "goal_has_no_action",
    });
  });
});

describe("R27 action engine — resolveAction: the prepare_booking action (the actionable arm)", () => {
  it("progress_goal × arrange_booking × full slots → the prepare_booking action carrying job/postcode/phone", () => {
    expect(actionFor("progress_goal", "arrange_booking", BOOKING_INFO)).toEqual<ActionResolution>({
      kind: "prepare_booking",
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
  });

  it("is proven against the REAL R22 progression AND the REAL R26 outcome abstention", () => {
    // Precondition: the gap really IS satisfied, the REAL strategy really IS progress_goal, and the Outcome
    // Engine really ABSTAINS on arrange_booking (goal_has_no_outcome) — so booking preparation fires precisely
    // on the satisfied objective the Outcome Engine leaves unclaimed, exactly as the runtime composes them.
    expect(detectGap("arrange_booking", BOOKING_INFO).satisfied).toBe(true);
    const strategy = strategyFor("arrange_booking", BOOKING_INFO);
    expect(strategy).toBe<ConversationStrategy>("progress_goal");
    const outcome = resolveOutcome(strategy, "arrange_booking", BOOKING_INFO);
    expect(outcome).toEqual<OutcomeResolution>({ kind: "none", reason: "goal_has_no_outcome" });
    expect(resolveAction(outcome, strategy, "arrange_booking", BOOKING_INFO)).toEqual<ActionResolution>({
      kind: "prepare_booking",
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
  });

  it("carries the EXACT slots from the information record (extra fields — e.g. email — are ignored)", () => {
    expect(actionFor("progress_goal", "arrange_booking", FULL)).toEqual<ActionResolution>({
      kind: "prepare_booking",
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
  });
});

describe("R27 action engine — resolveAction: RESOLUTION and VALIDATION are unified (defence in depth)", () => {
  it("all slots absent abstains incomplete — an unusable booking is never prepared", () => {
    expect(actionFor("progress_goal", "arrange_booking", EMPTY)).toEqual<ActionResolution>({
      kind: "none",
      reason: "incomplete",
    });
  });

  // Each single missing slot — a satisfied objective should never reach here, but a partial persisted record
  // must never become a preparable action.
  const missing: ReadonlyArray<{ label: string; info: ConversationInformation }> = [
    { label: "absent job_type", info: { postcode: POSTCODE, phone_number: PHONE } },
    { label: "absent postcode", info: { job_type: JOB, phone_number: PHONE } },
    { label: "absent phone_number", info: { job_type: JOB, postcode: POSTCODE } },
  ];
  for (const m of missing) {
    it(`${m.label} abstains incomplete`, () => {
      expect(actionFor("progress_goal", "arrange_booking", m.info)).toEqual<ActionResolution>({
        kind: "none",
        reason: "incomplete",
      });
    });
  }

  // Malformed persisted values the R20 validator rejects — none may become a preparable action.
  const malformed: ReadonlyArray<{ label: string; info: ConversationInformation }> = [
    { label: "unknown job_type", info: { job_type: "banana", postcode: POSTCODE, phone_number: PHONE } },
    { label: "malformed postcode", info: { job_type: JOB, postcode: "ZZ", phone_number: PHONE } },
    { label: "phone with no +", info: { job_type: JOB, postcode: POSTCODE, phone_number: "07700900123" } },
    { label: "phone too short", info: { job_type: JOB, postcode: POSTCODE, phone_number: "+123456789" } },
  ];
  for (const m of malformed) {
    it(`${m.label} abstains incomplete`, () => {
      expect(actionFor("progress_goal", "arrange_booking", m.info)).toEqual<ActionResolution>({
        kind: "none",
        reason: "incomplete",
      });
    });
  }
});

describe("R27 action engine — isActionableAction / actionTypeOf: the projections agree with the discriminant", () => {
  const booking: PrepareBookingAction = {
    kind: "prepare_booking",
    job_type: JOB,
    postcode: POSTCODE,
    phone_number: PHONE,
  };
  const abstentions: ReadonlyArray<ActionAbstention> = [
    "outcome_resolved",
    "not_progressing",
    "goal_has_no_action",
    "incomplete",
  ];

  it("isActionableAction is TRUE for the prepare_booking action and narrows it", () => {
    const res: ActionResolution = booking;
    expect(isActionableAction(res)).toBe(true);
    if (isActionableAction(res)) {
      // Narrowed to PrepareBookingAction — the payload is reachable without a cast.
      expect(res.job_type).toBe(JOB);
      expect(res.postcode).toBe(POSTCODE);
      expect(res.phone_number).toBe(PHONE);
    }
  });

  it("isActionableAction is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isActionableAction({ kind: "none", reason })).toBe(false);
    }
  });

  it("actionTypeOf is the prepare_booking type for the actionable arm and null for every abstention", () => {
    expect(actionTypeOf(booking)).toBe<ConversationActionType>("prepare_booking");
    for (const reason of abstentions) {
      expect(actionTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("actionTypeOf agrees with the actionable arm's kind (identity on the actionable arms)", () => {
    expect(actionTypeOf(booking)).toBe(booking.kind);
  });
});

describe("R27 action engine — the surface is total, deterministic and non-mutating", () => {
  const infos: readonly ConversationInformation[] = [FULL, BOOKING_INFO, CALLBACK_INFO, EMPTY];

  it("is TOTAL — resolveAction returns a resolution for EVERY strategy × goal × info", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of infos) {
          const res = actionFor(strategy, goal, info);
          expect(res.kind === "prepare_booking" || res.kind === "none").toBe(true);
        }
      }
    }
  });

  it("is DETERMINISTIC — the same inputs always yield an equal resolution", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of infos) {
          expect(actionFor(strategy, goal, info)).toEqual(actionFor(strategy, goal, info));
        }
      }
    }
  });

  it("NEVER yields both an actionable OUTCOME and an actionable ACTION on one turn (authority holds)", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        for (const info of infos) {
          const outcome = resolveOutcome(strategy, goal, info);
          const action = resolveAction(outcome, strategy, goal, info);
          expect(isActionableOutcome(outcome) && isActionableAction(action)).toBe(false);
        }
      }
    }
  });

  it("does NOT mutate the information it reads", () => {
    const info: ConversationInformation = { ...BOOKING_INFO };
    const snapshot = JSON.stringify(info);
    resolveAction(
      resolveOutcome("progress_goal", "arrange_booking", info),
      "progress_goal",
      "arrange_booking",
      info,
    );
    expect(JSON.stringify(info)).toBe(snapshot);
  });
});
