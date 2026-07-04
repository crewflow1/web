import { describe, it, expect } from "vitest";
import {
  RESPONSE_OBJECTIVES,
  buildResponseSpec,
  type ResponseObjective,
  type ResponseGuardrail,
  type ResponseSpecification,
} from "@/lib/receptionist/conversation-response";
import {
  PROMPT_ACTS,
  planPrompt,
  type ConversationPromptPlan,
} from "@/lib/receptionist/conversation-prompt";
import {
  STRATEGY_PRIORITY,
  resolveStrategy,
} from "@/lib/receptionist/conversation-strategy";
import { detectGap } from "@/lib/receptionist/conversation-gap";
import type { ConversationInformation } from "@/lib/receptionist/conversation-information";
import {
  CONVERSATION_GOALS,
  type ConversationGoal,
} from "@/lib/receptionist/conversation-goal";

/**
 * THE CONVERSATION RESPONSE ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R24 — CONVERSATION RESPONSE ENGINE).
 *
 * lib/receptionist/conversation-response.ts is the deterministic, leaf authority over RESPONSE PREPARATION —
 * the single source of truth for "given the prompt plan, HOW should the response be produced: what OBJECTIVE,
 * what field (if any) does it SOLICIT, what model-ready DIRECTIVE guides the draft, does it await a REPLY, and
 * what GUARDRAILS must the produced response honour?". It is the FOURTH purely-DERIVED layer of the stack that
 * persists NOTHING: the spec is a TOTAL, DETERMINISTIC function of a SINGLE already-derived observation — the
 * R23 prompt plan — so it is exhaustively unit-testable in isolation. Every plan fed here is built through the
 * REAL {@link planPrompt} over the REAL {@link resolveStrategy} over the REAL {@link detectGap}, so the engine is
 * proven against genuine plans, never hand-built ones. These tests pin, EXHAUSTIVELY:
 *   • RESPONSE_OBJECTIVES is the closed objective vocabulary in its one deliberate order (no dup, no gap), and
 *     it is DISJOINT from the R23 prompt-act vocabulary, the R22 strategy vocabulary AND the R19 goal vocabulary
 *     (a response objective is a preparation MODE — never the planned act, the strategic move, or the objective);
 *   • buildResponseSpec maps EVERY plan to its response spec for EVERY goal × representative information state —
 *     welcome an unknown objective, gather the next missing field, else inform / transfer / confirm;
 *   • `solicits` is non-null EXACTLY for a `gather` (from a `greet`/`ask`/… → `gather` mapping), where it is the
 *     plan's targeted field (the cardinal prompt-execution behaviour), and null for every other objective;
 *   • `directive` is the model-ready instruction — it EMBEDS the plan's focus verbatim, frames a `gather` as a
 *     request and every other objective as its purpose, and appends the reply clause EXACTLY when awaiting a reply;
 *   • `awaitsReply` is carried VERBATIM from the plan's expectsReply (true EXACTLY for welcome / gather);
 *   • `guardrails` always carry the two universal invariants plus the objective-specific one;
 *   • the whole surface is TOTAL over the goal vocabulary, DETERMINISTIC and NON-MUTATING, and depends ONLY on
 *     the plan (two states that yield the same plan yield the same spec).
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

// The closed objective vocabulary, as an INDEPENDENT reference set — the canonical members the engine may ever
// return. Pinned here so the totality + permutation proofs do not read their own answer from RESPONSE_OBJECTIVES
// (the surface under test).
const ALL_OBJECTIVES: readonly ResponseObjective[] = [
  "welcome",
  "gather",
  "inform",
  "transfer",
  "confirm",
];

// The canonical per-objective GUARDRAIL envelope — pinned as literals here (the module keeps its guardrail table
// private), so these tests fix the EXACT guardrail sets. Every objective carries the two universal guardrails,
// plus its objective-specific one.
const GUARDRAILS: Readonly<Record<ResponseObjective, readonly ResponseGuardrail[]>> = {
  welcome: ["conversational_only", "single_reply"],
  gather: ["conversational_only", "single_reply", "solicit_one_field"],
  inform: ["conversational_only", "single_reply", "ground_in_context"],
  transfer: ["conversational_only", "single_reply", "no_commitments"],
  confirm: ["conversational_only", "single_reply", "no_commitments"],
};
const UNIVERSAL_GUARDRAILS: readonly ResponseGuardrail[] = ["conversational_only", "single_reply"];

// The EXACT model-ready directive text the engine emits — pinned as literals (the module keeps composeDirective
// private), so these tests fix the precise instruction, not a recomputation of it. NOT customer-facing prose.
const D_WELCOME =
  "Compose a reply that will welcome the customer and invite them to explain what they need. Expect a reply from the customer.";
const D_INFORM = "Compose a reply that will answer the customer's enquiry directly.";
const D_TRANSFER = "Compose a reply that will let the customer know a human colleague will take over.";
const D_CONFIRM = "Compose a reply that will confirm the details gathered and move the objective forward.";
const D_GATHER_JOB =
  "Compose a reply that asks the customer for the type of work the customer needs carried out. Expect a reply from the customer.";
const D_GATHER_PHONE =
  "Compose a reply that asks the customer for the best phone number to reach the customer on. Expect a reply from the customer.";

// Build a spec the same way the runtime and read model do — through the REAL R21 gap authority, then the REAL
// R22 strategy authority, then the REAL R23 prompt planner. The engine is fed only genuine plans.
const planOf = (goal: ConversationGoal, info: ConversationInformation): ConversationPromptPlan =>
  planPrompt(resolveStrategy(detectGap(goal, info)));
const specOf = (goal: ConversationGoal, info: ConversationInformation): ResponseSpecification =>
  buildResponseSpec(planOf(goal, info));

describe("R24 response engine — RESPONSE_OBJECTIVES: the closed, ordered objective vocabulary", () => {
  it("is EXACTLY the deliberate order — welcome, gather, inform, transfer, confirm", () => {
    expect(RESPONSE_OBJECTIVES).toEqual(["welcome", "gather", "inform", "transfer", "confirm"]);
  });

  it("is a PERMUTATION of the whole objective vocabulary — same members, no duplicates", () => {
    expect([...RESPONSE_OBJECTIVES].sort()).toEqual([...ALL_OBJECTIVES].sort());
    expect(RESPONSE_OBJECTIVES.length).toBe(ALL_OBJECTIVES.length);
    expect(new Set(RESPONSE_OBJECTIVES).size).toBe(RESPONSE_OBJECTIVES.length);
  });

  it("is DISJOINT from the R23 prompt-act vocabulary — an objective is a MODE, never a planned act", () => {
    // The strongest independence proof: no objective name is also a prompt-act name. A response objective is HOW
    // the reply is prepared, distinct from the ACT the plan named.
    const acts = new Set<string>(PROMPT_ACTS);
    for (const objective of RESPONSE_OBJECTIVES) {
      expect(acts.has(objective)).toBe(false);
    }
  });

  it("is DISJOINT from the R22 strategy vocabulary — an objective is a MODE, never a move", () => {
    const strategies = new Set<string>(STRATEGY_PRIORITY);
    for (const objective of RESPONSE_OBJECTIVES) {
      expect(strategies.has(objective)).toBe(false);
    }
  });

  it("is DISJOINT from the R19 goal vocabulary — an objective is a MODE, never the conversation's objective", () => {
    const goals = new Set<string>(CONVERSATION_GOALS);
    for (const objective of RESPONSE_OBJECTIVES) {
      expect(goals.has(objective)).toBe(false);
    }
  });
});

describe("R24 response engine — buildResponseSpec: the response spec per goal (empty information)", () => {
  // With NOTHING provided, an objective that needs facts is GATHERED (soliciting its first slot); one that
  // needs none is welcomed / informed per its kind.
  const cases: ReadonlyArray<{ goal: ConversationGoal; spec: ResponseSpecification }> = [
    {
      goal: "undetermined",
      spec: {
        objective: "welcome",
        solicits: null,
        directive: D_WELCOME,
        awaitsReply: true,
        guardrails: GUARDRAILS.welcome,
      },
    },
    {
      goal: "answer_enquiry",
      spec: {
        objective: "inform",
        solicits: null,
        directive: D_INFORM,
        awaitsReply: false,
        guardrails: GUARDRAILS.inform,
      },
    },
    {
      goal: "arrange_booking",
      spec: {
        objective: "gather",
        solicits: "job_type",
        directive: D_GATHER_JOB,
        awaitsReply: true,
        guardrails: GUARDRAILS.gather,
      },
    },
    {
      goal: "arrange_callback",
      spec: {
        objective: "gather",
        solicits: "phone_number",
        directive: D_GATHER_PHONE,
        awaitsReply: true,
        guardrails: GUARDRAILS.gather,
      },
    },
    {
      goal: "provide_quote",
      spec: {
        objective: "gather",
        solicits: "job_type",
        directive: D_GATHER_JOB,
        awaitsReply: true,
        guardrails: GUARDRAILS.gather,
      },
    },
    {
      goal: "handoff_to_human",
      spec: {
        objective: "gather",
        solicits: "phone_number",
        directive: D_GATHER_PHONE,
        awaitsReply: true,
        guardrails: GUARDRAILS.gather,
      },
    },
  ];

  for (const c of cases) {
    it(`${c.goal}: → ${c.spec.objective}${c.spec.solicits ? ` (${c.spec.solicits})` : ""}`, () => {
      expect(specOf(c.goal, {})).toEqual<ResponseSpecification>(c.spec);
    });
  }

  it("covers EVERY goal in the vocabulary (no goal left untested)", () => {
    expect(cases.map((c) => c.goal).sort()).toEqual([...CONVERSATION_GOALS].sort());
  });
});

describe("R24 response engine — buildResponseSpec: the response spec per goal (objective satisfied)", () => {
  // With every slot the goal needs provided, nothing is outstanding, so the spec is the goal-specific FORWARD
  // objective: welcome (still unknown), inform, transfer, or confirm.
  const cases: ReadonlyArray<{
    goal: ConversationGoal;
    info: ConversationInformation;
    spec: ResponseSpecification;
  }> = [
    {
      goal: "undetermined",
      info: FULL,
      spec: {
        objective: "welcome",
        solicits: null,
        directive: D_WELCOME,
        awaitsReply: true,
        guardrails: GUARDRAILS.welcome,
      },
    },
    {
      goal: "answer_enquiry",
      info: FULL,
      spec: {
        objective: "inform",
        solicits: null,
        directive: D_INFORM,
        awaitsReply: false,
        guardrails: GUARDRAILS.inform,
      },
    },
    {
      goal: "arrange_booking",
      info: { job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
      spec: {
        objective: "confirm",
        solicits: null,
        directive: D_CONFIRM,
        awaitsReply: false,
        guardrails: GUARDRAILS.confirm,
      },
    },
    {
      goal: "arrange_callback",
      info: { phone_number: PHONE },
      spec: {
        objective: "confirm",
        solicits: null,
        directive: D_CONFIRM,
        awaitsReply: false,
        guardrails: GUARDRAILS.confirm,
      },
    },
    {
      goal: "provide_quote",
      info: FULL,
      spec: {
        objective: "confirm",
        solicits: null,
        directive: D_CONFIRM,
        awaitsReply: false,
        guardrails: GUARDRAILS.confirm,
      },
    },
    {
      goal: "handoff_to_human",
      info: { phone_number: PHONE },
      spec: {
        objective: "transfer",
        solicits: null,
        directive: D_TRANSFER,
        awaitsReply: false,
        guardrails: GUARDRAILS.transfer,
      },
    },
  ];

  for (const c of cases) {
    it(`${c.goal} (satisfied): → ${c.spec.objective}`, () => {
      // Precondition: the gap really IS satisfied for this (goal, info) — so we are testing the forward
      // objective, not accidentally the `gather` one.
      expect(detectGap(c.goal, c.info).satisfied).toBe(true);
      expect(specOf(c.goal, c.info)).toEqual<ResponseSpecification>(c.spec);
    });
  }
});

describe("R24 response engine — prompt execution: the `gather` objective solicits the plan's field", () => {
  it("solicits the highest-priority missing slot as facts arrive OUT of order (the first response)", () => {
    // The customer volunteered email + postcode first; the spec still solicits job_type (the plan's target, the
    // gap's highest-priority outstanding field), and the directive follows the field — NOT a generic ask.
    const info: ConversationInformation = { email_address: EMAIL, postcode: POSTCODE };
    const plan = planOf("provide_quote", info);
    const spec = buildResponseSpec(plan);
    expect(spec.objective).toBe("gather");
    expect(spec.solicits).toBe("job_type");
    expect(spec.solicits).toBe(plan.field);
    expect(spec.directive).toBe(D_GATHER_JOB);
    // Once job_type arrives, the solicited field — and the directive — advance to the next outstanding slot.
    const next = buildResponseSpec(planOf("provide_quote", { ...info, job_type: JOB }));
    expect(next.solicits).toBe("phone_number");
    expect(next.directive).toBe(D_GATHER_PHONE);
  });

  it("a `gather` spec solicits EXACTLY the plan's targeted field and carries the solicit-one-field guardrail", () => {
    for (const goal of CONVERSATION_GOALS) {
      const plan = planOf(goal, {});
      const spec = buildResponseSpec(plan);
      if (spec.objective === "gather") {
        expect(spec.solicits).not.toBeNull();
        expect(spec.solicits).toBe(plan.field);
        expect(spec.guardrails).toContain<ResponseGuardrail>("solicit_one_field");
      }
    }
  });
});

describe("R24 response engine — objective, solicits, directive, awaitsReply & guardrails semantics", () => {
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { phone_number: PHONE },
    { job_type: JOB, postcode: POSTCODE },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("the objective is EXACTLY the plan's act mapped once — greet→welcome, ask→gather, answer→inform, handoff→transfer, proceed→confirm", () => {
    const ACT_OBJECTIVE: Record<string, ResponseObjective> = {
      greet: "welcome",
      ask: "gather",
      answer: "inform",
      handoff: "transfer",
      proceed: "confirm",
    };
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const plan = planOf(goal, info);
        expect(buildResponseSpec(plan).objective).toBe(ACT_OBJECTIVE[plan.act]);
      }
    }
  });

  it("solicits is non-null EXACTLY for a `gather`, and equals the plan's field", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const plan = planOf(goal, info);
        const spec = buildResponseSpec(plan);
        if (spec.objective === "gather") {
          expect(spec.solicits).not.toBeNull();
          expect(spec.solicits).toBe(plan.field);
        } else {
          expect(spec.solicits).toBeNull();
        }
      }
    }
  });

  it("the directive EMBEDS the plan's focus verbatim and frames it by objective", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const plan = planOf(goal, info);
        const spec = buildResponseSpec(plan);
        // The directive consumes the R23 focus rather than recomputing it: the focus always appears in it.
        expect(spec.directive).toContain(plan.focus);
        // A `gather` frames the focus as a request; every other objective frames it as its purpose.
        if (spec.objective === "gather") {
          expect(spec.directive).toContain(`asks the customer for ${plan.focus}`);
        } else {
          expect(spec.directive).toContain(`will ${plan.focus}`);
        }
      }
    }
  });

  it("the directive appends the reply clause EXACTLY when awaiting a reply", () => {
    const CLAUSE = " Expect a reply from the customer.";
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const spec = specOf(goal, info);
        expect(spec.directive.endsWith(CLAUSE)).toBe(spec.awaitsReply);
      }
    }
  });

  it("awaitsReply is carried VERBATIM from the plan, and is true EXACTLY for welcome / gather", () => {
    const facing = new Set<ResponseObjective>(["welcome", "gather"]);
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const plan = planOf(goal, info);
        const spec = buildResponseSpec(plan);
        expect(spec.awaitsReply).toBe(plan.expectsReply);
        expect(spec.awaitsReply).toBe(facing.has(spec.objective));
      }
    }
  });

  it("guardrails ALWAYS carry the two universal invariants, plus the objective-specific one", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const spec = specOf(goal, info);
        for (const g of UNIVERSAL_GUARDRAILS) {
          expect(spec.guardrails).toContain(g);
        }
        expect(spec.guardrails).toEqual(GUARDRAILS[spec.objective]);
      }
    }
  });
});

describe("R24 response engine — totality, determinism & non-mutation", () => {
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("buildResponseSpec is TOTAL — every goal × information yields a member of the objective vocabulary", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const spec = specOf(goal, info);
        expect(ALL_OBJECTIVES).toContain(spec.objective);
        expect(RESPONSE_OBJECTIVES).toContain(spec.objective);
        expect(typeof spec.directive).toBe("string");
        expect(spec.directive.length).toBeGreaterThan(0);
        expect(spec.guardrails.length).toBeGreaterThan(0);
      }
    }
  });

  it("is DETERMINISTIC — the same plan always yields a deeply-equal spec", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const plan = planOf(goal, info);
        expect(buildResponseSpec(plan)).toEqual(buildResponseSpec(plan));
      }
    }
  });

  it("does NOT mutate the plan argument", () => {
    const plan = planOf("provide_quote", { job_type: JOB });
    const snapshot = structuredClone(plan);
    buildResponseSpec(plan);
    expect(plan).toEqual(snapshot);
  });

  it("depends ONLY on the plan — two states with the same plan yield the same spec", () => {
    // answer_enquiry yields the SAME plan (answer/inform) regardless of information; the spec keys off the plan
    // alone, so it is invariant across those states.
    const a = specOf("answer_enquiry", {});
    const b = specOf("answer_enquiry", FULL);
    expect(a).toEqual(b);
  });
});
