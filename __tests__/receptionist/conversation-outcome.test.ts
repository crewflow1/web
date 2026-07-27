import { describe, it, expect } from "vitest";
import {
  OUTCOME_TYPES,
  GOAL_OUTCOME,
  resolveOutcome,
  isActionableOutcome,
  outcomeTypeOf,
  type ConversationOutcomeType,
  type OutcomeResolution,
  type CallbackOutcome,
  type OutcomeAbstention,
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
 * THE CONVERSATION OUTCOME ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R26 — CONVERSATION OUTCOME ENGINE).
 *
 * lib/receptionist/conversation-outcome.ts is the deterministic, leaf authority over the FIRST layer that
 * ACTS: "given that the objective is SATISFIED and the strategy says PROGRESS, what INTERNAL OUTCOME does
 * the conversation produce, and is it well-formed enough to record?". It is a TOTAL, DETERMINISTIC function
 * of three already-derived observations — the R22 strategy (the progression TRIGGER), the R19 goal (which
 * SELECTS the outcome type) and the R20 information (the PAYLOAD) — so it is exhaustively unit-testable in
 * isolation. Every strategy fed the actionable proof is built through the REAL {@link resolveStrategy} over
 * a REAL {@link detectGap}, so the engine is proven against genuine progression, never a hand-built trigger.
 * These tests pin, EXHAUSTIVELY:
 *   • OUTCOME_TYPES is the closed outcome vocabulary — exactly `callback` in R26, no duplicates;
 *   • GOAL_OUTCOME is TOTAL over the goal vocabulary and maps ONLY arrange_callback → callback (booking and
 *     quote are explicit R26 non-goals ⇒ null; the never-progressing goals ⇒ null);
 *   • resolveOutcome ABSTAINS `not_progressing` for EVERY non-`progress_goal` strategy × EVERY goal — the
 *     trigger really is `progress_goal` and nothing else;
 *   • resolveOutcome ABSTAINS `goal_has_no_outcome` for a progressing goal that maps to null;
 *   • resolveOutcome RESOLVES the callback outcome — carrying the E.164 number — for a genuinely satisfied,
 *     genuinely progressing arrange_callback, and this is UNIFIED with R20 validation (an absent or
 *     malformed number can NEVER become a recordable outcome — it abstains `incomplete` instead);
 *   • the projections isActionableOutcome / outcomeTypeOf agree with the resolution's discriminant;
 *   • the whole surface is TOTAL, DETERMINISTIC and NON-MUTATING, and it RESOLVES — it never persists,
 *     drafts or executes.
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

// The closed outcome vocabulary, as an INDEPENDENT reference set — pinned here so the totality proofs do
// not read their own answer from OUTCOME_TYPES (the surface under test).
const ALL_OUTCOME_TYPES: readonly ConversationOutcomeType[] = ["callback"];

// The REAL progression trigger for a genuinely satisfied arrange_callback — derived through the R21 gap and
// the R22 strategy, never hand-asserted. Every actionable-outcome proof consumes THIS, so the outcome engine
// is tested against the strategy the runtime would actually hand it.
const CALLBACK_INFO: ConversationInformation = { phone_number: PHONE };
const strategyFor = (goal: ConversationGoal, info: ConversationInformation): ConversationStrategy =>
  resolveStrategy(detectGap(goal, info)).strategy;

describe("R26 outcome engine — OUTCOME_TYPES: the closed outcome vocabulary", () => {
  it("is EXACTLY `callback` in R26 (booking / quote outcome types are future work)", () => {
    expect(OUTCOME_TYPES).toEqual(["callback"]);
  });

  it("is a set — no duplicate members", () => {
    expect(new Set(OUTCOME_TYPES).size).toBe(OUTCOME_TYPES.length);
    expect([...OUTCOME_TYPES].sort()).toEqual([...ALL_OUTCOME_TYPES].sort());
  });
});

describe("R26 outcome engine — GOAL_OUTCOME: the total goal → outcome-type map", () => {
  it("is TOTAL over the whole goal vocabulary (every goal has an entry)", () => {
    expect(Object.keys(GOAL_OUTCOME).sort()).toEqual([...CONVERSATION_GOALS].sort());
  });

  it("maps ONLY arrange_callback → callback; every other goal → null", () => {
    for (const goal of CONVERSATION_GOALS) {
      expect(GOAL_OUTCOME[goal]).toBe(goal === "arrange_callback" ? "callback" : null);
    }
  });

  it("every non-null outcome type is in the OUTCOME_TYPES vocabulary", () => {
    for (const goal of CONVERSATION_GOALS) {
      const type = GOAL_OUTCOME[goal];
      if (type !== null) expect(OUTCOME_TYPES).toContain(type);
    }
  });

  it("booking and quote are EXPLICIT R26 non-goals ⇒ they resolve to NO outcome", () => {
    expect(GOAL_OUTCOME.arrange_booking).toBeNull();
    expect(GOAL_OUTCOME.provide_quote).toBeNull();
  });
});

describe("R26 outcome engine — resolveOutcome: the trigger is progress_goal and nothing else", () => {
  const nonProgress = STRATEGY_PRIORITY.filter((s) => s !== "progress_goal");

  it("covers EVERY non-progress strategy (no strategy left untested)", () => {
    expect([...nonProgress, "progress_goal"].sort()).toEqual([...STRATEGY_PRIORITY].sort());
  });

  for (const strategy of nonProgress) {
    for (const goal of CONVERSATION_GOALS) {
      it(`${strategy} × ${goal}: ABSTAINS not_progressing (never acts)`, () => {
        const res = resolveOutcome(strategy, goal, FULL);
        expect(res).toEqual<OutcomeResolution>({ kind: "none", reason: "not_progressing" });
      });
    }
  }
});

describe("R26 outcome engine — resolveOutcome: progressing a goal with no outcome abstains", () => {
  const noOutcomeGoals = CONVERSATION_GOALS.filter((g) => GOAL_OUTCOME[g] === null);

  for (const goal of noOutcomeGoals) {
    it(`progress_goal × ${goal}: ABSTAINS goal_has_no_outcome (progresses, records nothing)`, () => {
      const res = resolveOutcome("progress_goal", goal, FULL);
      expect(res).toEqual<OutcomeResolution>({ kind: "none", reason: "goal_has_no_outcome" });
    });
  }

  it("covers EVERY goal that maps to null", () => {
    expect(noOutcomeGoals.sort()).toEqual(
      [...CONVERSATION_GOALS].filter((g) => g !== "arrange_callback").sort(),
    );
  });
});

describe("R26 outcome engine — resolveOutcome: the callback outcome (the actionable arm)", () => {
  it("progress_goal × arrange_callback × valid phone → the callback outcome carrying the E.164 number", () => {
    const res = resolveOutcome("progress_goal", "arrange_callback", CALLBACK_INFO);
    expect(res).toEqual<OutcomeResolution>({ kind: "callback", phone_number: PHONE });
  });

  it("is proven against the REAL R22 progression — a satisfied arrange_callback genuinely progresses", () => {
    // Precondition: the gap really IS satisfied and the REAL strategy really IS progress_goal — so we test
    // the outcome against the trigger the runtime would actually hand it, not a hand-built one.
    expect(detectGap("arrange_callback", CALLBACK_INFO).satisfied).toBe(true);
    const strategy = strategyFor("arrange_callback", CALLBACK_INFO);
    expect(strategy).toBe<ConversationStrategy>("progress_goal");
    const res = resolveOutcome(strategy, "arrange_callback", CALLBACK_INFO);
    expect(res).toEqual<OutcomeResolution>({ kind: "callback", phone_number: PHONE });
  });

  it("carries the EXACT number from the information record (extra fields are ignored)", () => {
    // A callback needs only the phone; other provided facts (job, postcode, email) do not change the payload.
    const res = resolveOutcome("progress_goal", "arrange_callback", FULL);
    expect(res).toEqual<OutcomeResolution>({ kind: "callback", phone_number: PHONE });
  });
});

describe("R26 outcome engine — resolveOutcome: RESOLUTION and VALIDATION are unified (defence in depth)", () => {
  it("an ABSENT phone abstains incomplete — an unringable callback is never recorded", () => {
    const res = resolveOutcome("progress_goal", "arrange_callback", {});
    expect(res).toEqual<OutcomeResolution>({ kind: "none", reason: "incomplete" });
  });

  // Malformed persisted values the R20 validator rejects — none may become a recordable outcome.
  const malformed: ReadonlyArray<{ label: string; value: string }> = [
    { label: "no leading +", value: "07700900123" },
    { label: "too few digits", value: "+123456789" },
    { label: "non-numeric", value: "notaphone" },
    { label: "empty", value: "" },
    { label: "spaces / punctuation", value: "+44 7700 900123" },
  ];

  for (const m of malformed) {
    it(`a malformed phone (${m.label}) abstains incomplete`, () => {
      const res = resolveOutcome("progress_goal", "arrange_callback", { phone_number: m.value });
      expect(res).toEqual<OutcomeResolution>({ kind: "none", reason: "incomplete" });
    });
  }
});

describe("R26 outcome engine — isActionableOutcome / outcomeTypeOf: the projections agree with the discriminant", () => {
  const callback: CallbackOutcome = { kind: "callback", phone_number: PHONE };
  const abstentions: ReadonlyArray<OutcomeAbstention> = [
    "not_progressing",
    "goal_has_no_outcome",
    "incomplete",
  ];

  it("isActionableOutcome is TRUE for the callback outcome and narrows it", () => {
    const res: OutcomeResolution = callback;
    expect(isActionableOutcome(res)).toBe(true);
    if (isActionableOutcome(res)) {
      // Narrowed to CallbackOutcome — the payload is reachable without a cast.
      expect(res.phone_number).toBe(PHONE);
    }
  });

  it("isActionableOutcome is FALSE for every abstention reason", () => {
    for (const reason of abstentions) {
      expect(isActionableOutcome({ kind: "none", reason })).toBe(false);
    }
  });

  it("outcomeTypeOf is the callback type for the actionable arm and null for every abstention", () => {
    expect(outcomeTypeOf(callback)).toBe<ConversationOutcomeType>("callback");
    for (const reason of abstentions) {
      expect(outcomeTypeOf({ kind: "none", reason })).toBeNull();
    }
  });

  it("outcomeTypeOf agrees with the actionable arm's kind (identity on the actionable arms)", () => {
    expect(outcomeTypeOf(callback)).toBe(callback.kind);
  });
});

describe("R26 outcome engine — the surface is total, deterministic and non-mutating", () => {
  it("is TOTAL — resolveOutcome returns a resolution for EVERY strategy × goal (with full info)", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        const res = resolveOutcome(strategy, goal, FULL);
        expect(res.kind === "callback" || res.kind === "none").toBe(true);
      }
    }
  });

  it("is DETERMINISTIC — the same inputs always yield an equal resolution", () => {
    for (const strategy of STRATEGY_PRIORITY) {
      for (const goal of CONVERSATION_GOALS) {
        expect(resolveOutcome(strategy, goal, FULL)).toEqual(resolveOutcome(strategy, goal, FULL));
      }
    }
  });

  it("does NOT mutate the information it reads", () => {
    const info: ConversationInformation = { phone_number: PHONE };
    const snapshot = JSON.stringify(info);
    resolveOutcome("progress_goal", "arrange_callback", info);
    expect(JSON.stringify(info)).toBe(snapshot);
  });
});
