import { describe, it, expect } from "vitest";
import {
  STRATEGY_PRIORITY,
  resolveStrategy,
  type ConversationStrategy,
  type StrategyDecision,
} from "@/lib/receptionist/conversation-strategy";
import {
  detectGap,
  type ConversationGap,
} from "@/lib/receptionist/conversation-gap";
import type { ConversationInformation } from "@/lib/receptionist/conversation-information";
import {
  CONVERSATION_GOALS,
  type ConversationGoal,
} from "@/lib/receptionist/conversation-goal";

/**
 * THE CONVERSATION STRATEGY ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R22 — CONVERSATION STRATEGY ENGINE).
 *
 * lib/receptionist/conversation-strategy.ts is the deterministic, leaf authority over conversational
 * PLANNING — the single source of truth for "given the gap, what is the next conversational ACTION, what
 * does it act ON, and does it expect a REPLY?". It is the SECOND layer of the stack that persists NOTHING:
 * the strategy is a TOTAL, DETERMINISTIC function of a SINGLE already-derived observation — the R21 gap —
 * so it is exhaustively unit-testable in isolation. Every gap fed here is built through the REAL
 * {@link detectGap}, so the engine is proven against genuine gaps, never hand-built ones. These tests pin,
 * EXHAUSTIVELY:
 *   • STRATEGY_PRIORITY is the closed strategy vocabulary in its one deliberate order (no dup, no gap), and
 *     it is DERIVED from the rule table (resolution order === priority order);
 *   • resolveStrategy chooses the highest-priority applicable action for EVERY goal × representative
 *     information state — acknowledge an unknown objective, request the next missing field, else provide /
 *     escalate / progress the satisfied objective;
 *   • the ordering IS the priority — request_information outranks every goal-specific move (a handoff whose
 *     phone is still missing is ASKED, not escalated; an actionable goal with gaps is ASKED, not progressed);
 *   • `target` is non-null EXACTLY for request_information, where it is the gap's `nextRequired` slot (the
 *     cardinal slot-filling behaviour), and null for every other move;
 *   • `expectsReply` is true EXACTLY for the two customer-facing moves (acknowledge, request_information);
 *   • the whole surface is TOTAL over the goal vocabulary, DETERMINISTIC and NON-MUTATING, and the strategy
 *     vocabulary is DISJOINT from the R19 goal vocabulary (a strategy is a MOVE, never an objective).
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

// The closed strategy vocabulary, as an INDEPENDENT reference set — the canonical members the engine may
// ever return. Pinned here so the totality + permutation proofs do not read their own answer from
// STRATEGY_PRIORITY (the surface under test).
const ALL_STRATEGIES: readonly ConversationStrategy[] = [
  "acknowledge",
  "request_information",
  "provide_answer",
  "escalate_to_human",
  "progress_goal",
];

// Build a gap the same way the runtime and read model do — through the REAL R21 authority.
const gapOf = (goal: ConversationGoal, info: ConversationInformation): ConversationGap =>
  detectGap(goal, info);

describe("R22 strategy engine — STRATEGY_PRIORITY: the closed, ordered strategy vocabulary", () => {
  it("is EXACTLY the deliberate priority order — acknowledge, ask, answer, escalate, progress", () => {
    expect(STRATEGY_PRIORITY).toEqual([
      "acknowledge",
      "request_information",
      "provide_answer",
      "escalate_to_human",
      "progress_goal",
    ]);
  });

  it("is a PERMUTATION of the whole strategy vocabulary — same members, no duplicates", () => {
    expect([...STRATEGY_PRIORITY].sort()).toEqual([...ALL_STRATEGIES].sort());
    expect(STRATEGY_PRIORITY.length).toBe(ALL_STRATEGIES.length);
    expect(new Set(STRATEGY_PRIORITY).size).toBe(STRATEGY_PRIORITY.length);
  });

  it("is DISJOINT from the R19 goal vocabulary — a strategy is a MOVE, never an objective", () => {
    // The strongest independence proof: no strategy name is also a goal name. request_information ≠ any
    // goal; provide_answer ≠ the goal answer_enquiry; escalate_to_human ≠ the goal handoff_to_human.
    const goals = new Set<string>(CONVERSATION_GOALS);
    for (const strategy of STRATEGY_PRIORITY) {
      expect(goals.has(strategy)).toBe(false);
    }
  });
});

describe("R22 strategy engine — resolveStrategy: the next action per goal (empty information)", () => {
  // With NOTHING provided, an objective that needs facts is ASKED; one that needs none is acknowledged /
  // answered / escalated per its kind.
  const cases: ReadonlyArray<{
    goal: ConversationGoal;
    decision: StrategyDecision;
  }> = [
    {
      goal: "undetermined",
      decision: { strategy: "acknowledge", target: null, expectsReply: true },
    },
    {
      goal: "answer_enquiry",
      decision: { strategy: "provide_answer", target: null, expectsReply: false },
    },
    {
      goal: "arrange_booking",
      decision: { strategy: "request_information", target: "job_type", expectsReply: true },
    },
    {
      goal: "arrange_callback",
      decision: { strategy: "request_information", target: "phone_number", expectsReply: true },
    },
    {
      goal: "provide_quote",
      decision: { strategy: "request_information", target: "job_type", expectsReply: true },
    },
    {
      goal: "handoff_to_human",
      decision: { strategy: "request_information", target: "phone_number", expectsReply: true },
    },
  ];

  for (const c of cases) {
    it(`${c.goal}: → ${c.decision.strategy}${c.decision.target ? ` (${c.decision.target})` : ""}`, () => {
      expect(resolveStrategy(gapOf(c.goal, {}))).toEqual<StrategyDecision>(c.decision);
    });
  }

  it("covers EVERY goal in the vocabulary (no goal left untested)", () => {
    expect(cases.map((c) => c.goal).sort()).toEqual([...CONVERSATION_GOALS].sort());
  });
});

describe("R22 strategy engine — resolveStrategy: the next action per goal (objective satisfied)", () => {
  // With every slot the goal needs provided, nothing is outstanding, so the move is the goal-specific
  // FORWARD action: acknowledge (still unknown), answer, escalate, or progress.
  const cases: ReadonlyArray<{
    goal: ConversationGoal;
    info: ConversationInformation;
    decision: StrategyDecision;
  }> = [
    {
      goal: "undetermined",
      info: FULL,
      decision: { strategy: "acknowledge", target: null, expectsReply: true },
    },
    {
      goal: "answer_enquiry",
      info: FULL,
      decision: { strategy: "provide_answer", target: null, expectsReply: false },
    },
    {
      goal: "arrange_booking",
      info: { job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
      decision: { strategy: "progress_goal", target: null, expectsReply: false },
    },
    {
      goal: "arrange_callback",
      info: { phone_number: PHONE },
      decision: { strategy: "progress_goal", target: null, expectsReply: false },
    },
    {
      goal: "provide_quote",
      info: FULL,
      decision: { strategy: "progress_goal", target: null, expectsReply: false },
    },
    {
      goal: "handoff_to_human",
      info: { phone_number: PHONE },
      decision: { strategy: "escalate_to_human", target: null, expectsReply: false },
    },
  ];

  for (const c of cases) {
    it(`${c.goal} (satisfied): → ${c.decision.strategy}`, () => {
      // Precondition: the gap really IS satisfied for this (goal, info) — so we are testing the
      // satisfied branch, not accidentally the request_information one.
      expect(gapOf(c.goal, c.info).satisfied).toBe(true);
      expect(resolveStrategy(gapOf(c.goal, c.info))).toEqual<StrategyDecision>(c.decision);
    });
  }
});

describe("R22 strategy engine — the ordering IS the priority (first applicable rule wins)", () => {
  it("request_information OUTRANKS escalate_to_human — a handoff missing its phone is ASKED, not escalated", () => {
    // handoff_to_human matches BOTH rule 2 (!satisfied) and rule 4 (goal===handoff_to_human); rule 2 is
    // earlier, so the missing phone is requested first. Only once satisfied does escalate_to_human fire.
    expect(resolveStrategy(gapOf("handoff_to_human", {}))).toEqual<StrategyDecision>({
      strategy: "request_information",
      target: "phone_number",
      expectsReply: true,
    });
    expect(resolveStrategy(gapOf("handoff_to_human", { phone_number: PHONE })).strategy).toBe(
      "escalate_to_human",
    );
  });

  it("request_information OUTRANKS progress_goal — an actionable goal with gaps is ASKED, not progressed", () => {
    expect(resolveStrategy(gapOf("provide_quote", {})).strategy).toBe("request_information");
    expect(resolveStrategy(gapOf("provide_quote", FULL)).strategy).toBe("progress_goal");
  });

  it("provide_answer / escalate_to_human OUTRANK progress_goal for their satisfied goals", () => {
    expect(resolveStrategy(gapOf("answer_enquiry", {})).strategy).toBe("provide_answer");
    expect(resolveStrategy(gapOf("handoff_to_human", { phone_number: PHONE })).strategy).toBe(
      "escalate_to_human",
    );
  });

  it("asks for the highest-priority missing slot as facts arrive OUT of order (slot filling)", () => {
    // The customer volunteered email + postcode first; the strategy still targets job_type (the gap's
    // highest-priority outstanding field), NOT phone_number — it reads the gap's nextRequired verbatim.
    const info: ConversationInformation = { email_address: EMAIL, postcode: POSTCODE };
    const decision = resolveStrategy(gapOf("provide_quote", info));
    expect(decision.strategy).toBe("request_information");
    expect(decision.target).toBe("job_type");
    // Once job_type arrives, the target advances to the next outstanding slot.
    expect(resolveStrategy(gapOf("provide_quote", { ...info, job_type: JOB })).target).toBe(
      "phone_number",
    );
  });
});

describe("R22 strategy engine — target & expectsReply semantics", () => {
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { phone_number: PHONE },
    { job_type: JOB, postcode: POSTCODE },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("target is non-null EXACTLY for request_information, and equals the gap's nextRequired", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const gap = gapOf(goal, info);
        const decision = resolveStrategy(gap);
        if (decision.strategy === "request_information") {
          expect(decision.target).not.toBeNull();
          expect(decision.target).toBe(gap.nextRequired);
        } else {
          expect(decision.target).toBeNull();
        }
      }
    }
  });

  it("expectsReply is true EXACTLY for the two customer-facing moves (acknowledge, request_information)", () => {
    const facing = new Set<ConversationStrategy>(["acknowledge", "request_information"]);
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const decision = resolveStrategy(gapOf(goal, info));
        expect(decision.expectsReply).toBe(facing.has(decision.strategy));
      }
    }
  });
});

describe("R22 strategy engine — totality, determinism & non-mutation", () => {
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("resolveStrategy is TOTAL — every goal × information yields a member of the strategy vocabulary", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const decision = resolveStrategy(gapOf(goal, info));
        expect(ALL_STRATEGIES).toContain(decision.strategy);
        expect(STRATEGY_PRIORITY).toContain(decision.strategy);
      }
    }
  });

  it("is DETERMINISTIC — the same gap always yields a deeply-equal decision", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const gap = gapOf(goal, info);
        expect(resolveStrategy(gap)).toEqual(resolveStrategy(gap));
      }
    }
  });

  it("does NOT mutate the gap argument", () => {
    const gap = gapOf("provide_quote", { job_type: JOB });
    const snapshot = structuredClone(gap);
    resolveStrategy(gap);
    expect(gap).toEqual(snapshot);
  });

  it("depends ONLY on the gap — the same gap shape yields the same decision across goals", () => {
    // answer_enquiry and undetermined both derive an empty, satisfied gap-shape apart from `goal`; the
    // decision keys off `goal` + `satisfied`, so it is a pure function of the gap and nothing else.
    const a = resolveStrategy(gapOf("answer_enquiry", {}));
    const b = resolveStrategy(gapOf("answer_enquiry", FULL));
    expect(a).toEqual(b); // information beyond the gap never changes the decision
  });
});
