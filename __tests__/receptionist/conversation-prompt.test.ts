import { describe, it, expect } from "vitest";
import {
  PROMPT_ACTS,
  planPrompt,
  type PromptAct,
  type ConversationPromptPlan,
} from "@/lib/receptionist/conversation-prompt";
import {
  STRATEGY_PRIORITY,
  resolveStrategy,
  type StrategyDecision,
} from "@/lib/receptionist/conversation-strategy";
import { detectGap } from "@/lib/receptionist/conversation-gap";
import type { ConversationInformation } from "@/lib/receptionist/conversation-information";
import {
  CONVERSATION_GOALS,
  type ConversationGoal,
} from "@/lib/receptionist/conversation-goal";

/**
 * THE CONVERSATION PROMPT PLANNER — pure core, unit tier
 * (the AI Receptionist Programme, R23 — CONVERSATION PROMPT PLANNER).
 *
 * lib/receptionist/conversation-prompt.ts is the deterministic, leaf authority over conversational PROMPT
 * PLANNING — the single source of truth for "given the strategy decision, what is the next conversational
 * ACT, what field (if any) does it TARGET, what should it FOCUS on, and does it expect a REPLY?". It is the
 * THIRD purely-DERIVED layer of the stack that persists NOTHING: the plan is a TOTAL, DETERMINISTIC function
 * of a SINGLE already-derived observation — the R22 strategy decision — so it is exhaustively unit-testable
 * in isolation. Every decision fed here is built through the REAL {@link resolveStrategy} over the REAL
 * {@link detectGap}, so the planner is proven against genuine decisions, never hand-built ones. These tests
 * pin, EXHAUSTIVELY:
 *   • PROMPT_ACTS is the closed act vocabulary in its one deliberate order (no dup, no gap), and it is
 *     DISJOINT from BOTH the R22 strategy vocabulary AND the R19 goal vocabulary (a prompt act is a planned
 *     UTTERANCE — never the strategic MOVE that selects it, never the OBJECTIVE it serves);
 *   • planPrompt maps EVERY strategy to its act for EVERY goal × representative information state — greet an
 *     unknown objective, ask for the next missing field, else answer / handoff / proceed the satisfied one;
 *   • `field` is non-null EXACTLY for an `ask`, where it is the decision's `target` slot (the cardinal
 *     slot-filling behaviour), and null for every other act;
 *   • `focus` is the field-specific directive for a targeted `ask`, and the act's generic directive otherwise;
 *   • `expectsReply` is carried VERBATIM from the decision (true EXACTLY for greet / ask);
 *   • the whole surface is TOTAL over the goal vocabulary, DETERMINISTIC and NON-MUTATING, and depends ONLY
 *     on the decision (two states that yield the same decision yield the same plan).
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

// The closed act vocabulary, as an INDEPENDENT reference set — the canonical members the planner may ever
// return. Pinned here so the totality + permutation proofs do not read their own answer from PROMPT_ACTS
// (the surface under test).
const ALL_ACTS: readonly PromptAct[] = ["greet", "ask", "answer", "handoff", "proceed"];

// The canonical FOCUS directives — pinned as literals here (the module keeps its focus tables private), so
// these tests fix the EXACT directive text the planner emits. NOT customer-facing prose: the deterministic
// directive that guides the downstream draft.
const FIELD_FOCUS: Readonly<Record<string, string>> = {
  job_type: "the type of work the customer needs carried out",
  postcode: "the postcode where the work is needed",
  phone_number: "the best phone number to reach the customer on",
  email_address: "the email address to send written details to",
};
const ACT_FOCUS = {
  greet: "welcome the customer and invite them to explain what they need",
  answer: "answer the customer's enquiry directly",
  handoff: "let the customer know a human colleague will take over",
  proceed: "confirm the details gathered and move the objective forward",
} as const;

// Build a decision the same way the runtime and read model do — through the REAL R21 gap authority, then the
// REAL R22 strategy authority. The planner is fed only genuine decisions.
const decisionOf = (goal: ConversationGoal, info: ConversationInformation): StrategyDecision =>
  resolveStrategy(detectGap(goal, info));
const planOf = (goal: ConversationGoal, info: ConversationInformation): ConversationPromptPlan =>
  planPrompt(decisionOf(goal, info));

describe("R23 prompt planner — PROMPT_ACTS: the closed, ordered act vocabulary", () => {
  it("is EXACTLY the deliberate order — greet, ask, answer, handoff, proceed", () => {
    expect(PROMPT_ACTS).toEqual(["greet", "ask", "answer", "handoff", "proceed"]);
  });

  it("is a PERMUTATION of the whole act vocabulary — same members, no duplicates", () => {
    expect([...PROMPT_ACTS].sort()).toEqual([...ALL_ACTS].sort());
    expect(PROMPT_ACTS.length).toBe(ALL_ACTS.length);
    expect(new Set(PROMPT_ACTS).size).toBe(PROMPT_ACTS.length);
  });

  it("is DISJOINT from the R22 strategy vocabulary — an act is an UTTERANCE, never a move", () => {
    // The strongest independence proof: no act name is also a strategy name. `ask` ≠ request_information;
    // `answer` ≠ provide_answer; `handoff` ≠ escalate_to_human — the vocabularies never collide.
    const strategies = new Set<string>(STRATEGY_PRIORITY);
    for (const act of PROMPT_ACTS) {
      expect(strategies.has(act)).toBe(false);
    }
  });

  it("is DISJOINT from the R19 goal vocabulary — an act is an UTTERANCE, never an objective", () => {
    // `answer` ≠ answer_enquiry; `handoff` ≠ handoff_to_human — a planned utterance is never an objective.
    const goals = new Set<string>(CONVERSATION_GOALS);
    for (const act of PROMPT_ACTS) {
      expect(goals.has(act)).toBe(false);
    }
  });
});

describe("R23 prompt planner — planPrompt: the next prompt per goal (empty information)", () => {
  // With NOTHING provided, an objective that needs facts is ASKED (targeting its first slot); one that needs
  // none is greeted / answered per its kind.
  const cases: ReadonlyArray<{ goal: ConversationGoal; plan: ConversationPromptPlan }> = [
    {
      goal: "undetermined",
      plan: { act: "greet", field: null, focus: ACT_FOCUS.greet, expectsReply: true },
    },
    {
      goal: "answer_enquiry",
      plan: { act: "answer", field: null, focus: ACT_FOCUS.answer, expectsReply: false },
    },
    {
      goal: "arrange_booking",
      plan: { act: "ask", field: "job_type", focus: FIELD_FOCUS.job_type!, expectsReply: true },
    },
    {
      goal: "arrange_callback",
      plan: {
        act: "ask",
        field: "phone_number",
        focus: FIELD_FOCUS.phone_number!,
        expectsReply: true,
      },
    },
    {
      goal: "provide_quote",
      plan: { act: "ask", field: "job_type", focus: FIELD_FOCUS.job_type!, expectsReply: true },
    },
    {
      goal: "handoff_to_human",
      plan: {
        act: "ask",
        field: "phone_number",
        focus: FIELD_FOCUS.phone_number!,
        expectsReply: true,
      },
    },
  ];

  for (const c of cases) {
    it(`${c.goal}: → ${c.plan.act}${c.plan.field ? ` (${c.plan.field})` : ""}`, () => {
      expect(planOf(c.goal, {})).toEqual<ConversationPromptPlan>(c.plan);
    });
  }

  it("covers EVERY goal in the vocabulary (no goal left untested)", () => {
    expect(cases.map((c) => c.goal).sort()).toEqual([...CONVERSATION_GOALS].sort());
  });
});

describe("R23 prompt planner — planPrompt: the next prompt per goal (objective satisfied)", () => {
  // With every slot the goal needs provided, nothing is outstanding, so the plan is the goal-specific FORWARD
  // act: greet (still unknown), answer, handoff, or proceed.
  const cases: ReadonlyArray<{
    goal: ConversationGoal;
    info: ConversationInformation;
    plan: ConversationPromptPlan;
  }> = [
    {
      goal: "undetermined",
      info: FULL,
      plan: { act: "greet", field: null, focus: ACT_FOCUS.greet, expectsReply: true },
    },
    {
      goal: "answer_enquiry",
      info: FULL,
      plan: { act: "answer", field: null, focus: ACT_FOCUS.answer, expectsReply: false },
    },
    {
      goal: "arrange_booking",
      info: { job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
      plan: { act: "proceed", field: null, focus: ACT_FOCUS.proceed, expectsReply: false },
    },
    {
      goal: "arrange_callback",
      info: { phone_number: PHONE },
      plan: { act: "proceed", field: null, focus: ACT_FOCUS.proceed, expectsReply: false },
    },
    {
      goal: "provide_quote",
      info: FULL,
      plan: { act: "proceed", field: null, focus: ACT_FOCUS.proceed, expectsReply: false },
    },
    {
      goal: "handoff_to_human",
      info: { phone_number: PHONE },
      plan: { act: "handoff", field: null, focus: ACT_FOCUS.handoff, expectsReply: false },
    },
  ];

  for (const c of cases) {
    it(`${c.goal} (satisfied): → ${c.plan.act}`, () => {
      // Precondition: the gap really IS satisfied for this (goal, info) — so we are testing the forward act,
      // not accidentally the `ask` one.
      expect(detectGap(c.goal, c.info).satisfied).toBe(true);
      expect(planOf(c.goal, c.info)).toEqual<ConversationPromptPlan>(c.plan);
    });
  }
});

describe("R23 prompt planner — slot filling: the `ask` act targets the gap's field", () => {
  it("asks for the highest-priority missing slot as facts arrive OUT of order (the first planner)", () => {
    // The customer volunteered email + postcode first; the plan still targets job_type (the decision's target,
    // the gap's highest-priority outstanding field), and the focus follows the field — NOT the generic ask.
    const info: ConversationInformation = { email_address: EMAIL, postcode: POSTCODE };
    const plan = planOf("provide_quote", info);
    expect(plan.act).toBe("ask");
    expect(plan.field).toBe("job_type");
    expect(plan.focus).toBe(FIELD_FOCUS.job_type);
    // Once job_type arrives, the target — and the focus — advance to the next outstanding slot.
    const next = planOf("provide_quote", { ...info, job_type: JOB });
    expect(next.field).toBe("phone_number");
    expect(next.focus).toBe(FIELD_FOCUS.phone_number);
  });

  it("an `ask` carries the FIELD-specific focus, never the generic act focus", () => {
    // Every `ask` plan's focus is the directive for the exact field it targets.
    for (const goal of CONVERSATION_GOALS) {
      const plan = planOf(goal, {});
      if (plan.act === "ask") {
        expect(plan.field).not.toBeNull();
        expect(plan.focus).toBe(FIELD_FOCUS[plan.field as string]);
      }
    }
  });
});

describe("R23 prompt planner — field, focus & expectsReply semantics", () => {
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { phone_number: PHONE },
    { job_type: JOB, postcode: POSTCODE },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("field is non-null EXACTLY for an `ask`, and equals the decision's target", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const decision = decisionOf(goal, info);
        const plan = planPrompt(decision);
        if (plan.act === "ask") {
          expect(plan.field).not.toBeNull();
          expect(plan.field).toBe(decision.target);
        } else {
          expect(plan.field).toBeNull();
        }
      }
    }
  });

  it("focus is the field directive for an `ask`, else the act's generic directive", () => {
    const actFocus: Record<Exclude<PromptAct, "ask">, string> = {
      greet: ACT_FOCUS.greet,
      answer: ACT_FOCUS.answer,
      handoff: ACT_FOCUS.handoff,
      proceed: ACT_FOCUS.proceed,
    };
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const plan = planOf(goal, info);
        if (plan.act === "ask") {
          expect(plan.focus).toBe(FIELD_FOCUS[plan.field as string]);
        } else {
          expect(plan.focus).toBe(actFocus[plan.act]);
        }
      }
    }
  });

  it("expectsReply is carried VERBATIM from the decision, and is true EXACTLY for greet / ask", () => {
    const facing = new Set<PromptAct>(["greet", "ask"]);
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const decision = decisionOf(goal, info);
        const plan = planPrompt(decision);
        expect(plan.expectsReply).toBe(decision.expectsReply);
        expect(plan.expectsReply).toBe(facing.has(plan.act));
      }
    }
  });
});

describe("R23 prompt planner — totality, determinism & non-mutation", () => {
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("planPrompt is TOTAL — every goal × information yields a member of the act vocabulary", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const plan = planOf(goal, info);
        expect(ALL_ACTS).toContain(plan.act);
        expect(PROMPT_ACTS).toContain(plan.act);
        expect(typeof plan.focus).toBe("string");
        expect(plan.focus.length).toBeGreaterThan(0);
      }
    }
  });

  it("is DETERMINISTIC — the same decision always yields a deeply-equal plan", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const decision = decisionOf(goal, info);
        expect(planPrompt(decision)).toEqual(planPrompt(decision));
      }
    }
  });

  it("does NOT mutate the decision argument", () => {
    const decision = decisionOf("provide_quote", { job_type: JOB });
    const snapshot = structuredClone(decision);
    planPrompt(decision);
    expect(decision).toEqual(snapshot);
  });

  it("depends ONLY on the decision — two states with the same decision yield the same plan", () => {
    // answer_enquiry resolves the SAME decision (provide_answer) regardless of information; the plan keys off
    // the decision alone, so it is invariant across those states.
    const a = planOf("answer_enquiry", {});
    const b = planOf("answer_enquiry", FULL);
    expect(a).toEqual(b);
  });
});
