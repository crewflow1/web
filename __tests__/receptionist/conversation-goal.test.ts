import { describe, it, expect } from "vitest";
import {
  CONVERSATION_GOALS,
  CONCRETE_GOALS,
  INITIAL_CONVERSATION_GOAL,
  isConversationGoal,
  coerceConversationGoal,
  resolveGoal,
  advanceGoal,
  GOAL_TRANSITIONS,
  isValidGoalTransition,
  planGoalTransition,
  planGoalProgression,
  type ConversationGoal,
} from "@/lib/receptionist/conversation-goal";
import {
  CONVERSATION_INTENTS,
  resolveIntent,
  type ConversationIntent,
} from "@/lib/receptionist/conversation-intent";
import type {
  ConversationContext,
  ContextMessage,
  ContextRole,
} from "@/lib/receptionist/conversation-context";

/**
 * THE CONVERSATION GOAL ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R19 — CONVERSATION GOAL ENGINE).
 *
 * lib/receptionist/conversation-goal.ts is the deterministic, leaf authority over the conversational
 * OBJECTIVE — the single source of truth for "what is the conversation trying to accomplish?". It executes
 * ON TOP of the R18 intent engine (its SOLE input is a resolved ConversationIntent), reaches NOTHING else —
 * no context, no policy, no provider, no ledger, no model — and so is exhaustively unit-testable in
 * isolation. These tests pin, EXHAUSTIVELY: the goal vocabulary and its lock-step with the migration CHECK;
 * deny-unknown coercion; the TOTAL, DETERMINISTIC, one-per-intent ELEVATION of every intent to its
 * objective (and that the map is a bijection — no objective distinction is lost); the fold's determinism;
 * and — mirroring R17/R18 — the progression relation (exactly the fold's image), its total validator, and
 * its planners (a self-loop is `unchanged`, a legal change an `advance`, an ILLEGAL `concrete →
 * undetermined` regression `rejected` and never persisted; a real turn NEVER rejects — the δ ⊆ legal safety
 * property that makes the engine governance, not a gate). One block composes the WHOLE stack — resolveGoal ∘
 * resolveIntent — to prove the layering Context → Intent → Goal directly.
 *
 * The engine's REACHING behaviour (resolve pre-dispatch → persist advance over real Postgres) is proven in
 * the integration tier; its architectural isolation (single-sourced, single consumer, one import, persist-
 * only-under-advance, never moves the ownership or intent marker) is proven in the security tier. This file
 * proves the calculus alone.
 */

// The full goal vocabulary, enumerated locally so a drift in CONVERSATION_GOALS is caught by the lock-step
// assertion below rather than silently propagating into every other case.
const ALL_GOALS: readonly ConversationGoal[] = [
  "undetermined",
  "answer_enquiry",
  "arrange_booking",
  "arrange_callback",
  "provide_quote",
  "handoff_to_human",
];
const CONCRETES: readonly ConversationGoal[] = ALL_GOALS.filter((g) => g !== "undetermined");

// The expected intent → goal ELEVATION, enumerated locally (position-parallel to CONVERSATION_INTENTS) so a
// drift in the engine's private map is caught HERE rather than silently changing resolution everywhere.
const EXPECTED_ELEVATION: ReadonlyArray<readonly [ConversationIntent, ConversationGoal]> = [
  ["unknown", "undetermined"],
  ["general_enquiry", "answer_enquiry"],
  ["booking_interest", "arrange_booking"],
  ["callback_request", "arrange_callback"],
  ["quote_request", "provide_quote"],
  ["human_handoff", "handoff_to_human"],
];

describe("the goal vocabulary — lock-step with the migration CHECK constraint", () => {
  it("CONVERSATION_GOALS is exactly the six values, in canonical order", () => {
    expect(CONVERSATION_GOALS).toEqual(ALL_GOALS);
  });

  it("a brand-new conversation has no resolved objective", () => {
    expect(INITIAL_CONVERSATION_GOAL).toBe("undetermined");
    expect(CONVERSATION_GOALS).toContain(INITIAL_CONVERSATION_GOAL);
  });

  it("CONCRETE_GOALS is every goal except the initial undetermined", () => {
    expect(CONCRETE_GOALS).toEqual(CONCRETES);
    expect(CONCRETE_GOALS).not.toContain("undetermined");
  });

  it("the vocabulary has no duplicates", () => {
    expect(new Set(CONVERSATION_GOALS).size).toBe(CONVERSATION_GOALS.length);
  });

  it("has exactly one goal per intent — the vocabularies are the same size (a total, one-per-intent map)", () => {
    expect(CONVERSATION_GOALS).toHaveLength(CONVERSATION_INTENTS.length);
  });
});

describe("isConversationGoal — narrows exactly the known vocabulary", () => {
  it("accepts every canonical goal", () => {
    for (const g of ALL_GOALS) expect(isConversationGoal(g)).toBe(true);
  });

  it("rejects out-of-vocabulary strings (including intent names — the layers do not share a vocabulary)", () => {
    for (const bad of ["", "UNDETERMINED", "booking", "quote", "unknown", "general_enquiry", "quote_request", "undetermined "]) {
      expect(isConversationGoal(bad)).toBe(false);
    }
  });

  it("rejects non-string values", () => {
    for (const bad of [null, undefined, 0, 1, {}, [], true, NaN]) {
      expect(isConversationGoal(bad)).toBe(false);
    }
  });
});

describe("coerceConversationGoal — TOTAL and DENY-UNKNOWN", () => {
  it("preserves every valid goal", () => {
    for (const g of ALL_GOALS) expect(coerceConversationGoal(g)).toBe(g);
  });

  it("defaults any unknown / absent value to the initial goal", () => {
    for (const bad of [null, undefined, "", "nonsense", 42, {}, [], "quote_request", "booking"]) {
      expect(coerceConversationGoal(bad)).toBe(INITIAL_CONVERSATION_GOAL);
    }
  });

  it("is TOTAL — every input resolves to a member of the vocabulary", () => {
    for (const v of [null, undefined, "x", "handoff_to_human", 7, "provide_quote"]) {
      expect(CONVERSATION_GOALS).toContain(coerceConversationGoal(v));
    }
  });
});

describe("resolveGoal — ELEVATES a resolved intent to the conversational objective (TOTAL, DETERMINISTIC, MODEL-FREE)", () => {
  it("maps every intent to its expected objective (the exact elevation)", () => {
    for (const [intent, goal] of EXPECTED_ELEVATION) {
      expect(resolveGoal(intent), `${intent} → ${goal}`).toBe(goal);
    }
  });

  it("is TOTAL over the whole intent vocabulary — every intent elevates to a member of CONVERSATION_GOALS", () => {
    for (const intent of CONVERSATION_INTENTS) {
      expect(CONVERSATION_GOALS).toContain(resolveGoal(intent));
    }
  });

  it("the no-signal intent (unknown) elevates to the no-objective goal (undetermined)", () => {
    expect(resolveGoal("unknown")).toBe(INITIAL_CONVERSATION_GOAL);
  });

  it("every CONCRETE intent elevates to a CONCRETE goal — a real want always yields a real objective", () => {
    for (const intent of CONVERSATION_INTENTS.filter((i) => i !== "unknown")) {
      expect(CONCRETE_GOALS).toContain(resolveGoal(intent));
    }
  });

  it("is a BIJECTION — the six intents elevate to six DISTINCT goals (no objective distinction is lost)", () => {
    const produced = CONVERSATION_INTENTS.map((i) => resolveGoal(i));
    expect(new Set(produced).size).toBe(CONVERSATION_INTENTS.length);
    expect(new Set(produced)).toEqual(new Set(CONVERSATION_GOALS));
  });

  it("is DETERMINISTIC — the same intent resolves the same goal every call", () => {
    for (const intent of CONVERSATION_INTENTS) {
      const once = resolveGoal(intent);
      for (let i = 0; i < 25; i++) expect(resolveGoal(intent)).toBe(once);
    }
  });
});

// =====================================================================
// THE GOAL PROGRESSION MODEL — mirrors the R17 state machine and the R18 intent engine.
//
// advanceGoal is the turn fold (keep prior on undetermined, else adopt resolved). GOAL_TRANSITIONS is its
// image; isValidGoalTransition the total validator; planGoalTransition the raw planner; planGoalProgression
// the turn-driven planner. These blocks pin, EXHAUSTIVELY: the relation is EXACTLY the fold's image
// (single-sourced, no drift); monotonic objective (a concrete goal never regresses to undetermined); the
// planner's three kinds; and the δ ⊆ legal safety property (a real turn never rejects).
// =====================================================================

describe("advanceGoal — the pure fold over ordered per-turn resolutions", () => {
  it("a no-objective (undetermined) resolution KEEPS the prior goal, from every prior", () => {
    for (const prior of ALL_GOALS) expect(advanceGoal(prior, "undetermined")).toBe(prior);
  });

  it("a concrete resolution ADOPTS it, from every prior", () => {
    for (const prior of ALL_GOALS) {
      for (const resolved of CONCRETES) {
        expect(advanceGoal(prior, resolved)).toBe(resolved);
      }
    }
  });

  it("advances by `resolved === undetermined ? prior : resolved` directly", () => {
    for (const prior of ALL_GOALS) {
      for (const resolved of ALL_GOALS) {
        expect(advanceGoal(prior, resolved)).toBe(resolved === "undetermined" ? prior : resolved);
      }
    }
  });

  it("is DETERMINISTIC — the same (prior, resolved) always yields the same next goal", () => {
    for (const prior of ALL_GOALS) {
      for (const resolved of ALL_GOALS) {
        const once = advanceGoal(prior, resolved);
        for (let i = 0; i < 25; i++) expect(advanceGoal(prior, resolved)).toBe(once);
      }
    }
  });

  it("folds a whole conversation identically twice (a pure fold over its resolution sequence)", () => {
    const sequence: ConversationGoal[] = [
      "answer_enquiry",
      "undetermined",
      "provide_quote",
      "undetermined",
      "arrange_booking",
      "undetermined",
    ];
    const fold = (rs: ConversationGoal[]): ConversationGoal =>
      rs.reduce(advanceGoal, INITIAL_CONVERSATION_GOAL);
    // enquiry → (idle) → quote → (idle) → booking → (idle): the last concrete objective wins.
    expect(fold(sequence)).toBe("arrange_booking");
    expect(fold(sequence)).toBe(fold(sequence));
  });

  it("a run of no-objective turns is a fixed point — an idle conversation never un-resolves its objective", () => {
    const idle: ConversationGoal[] = ["undetermined", "undetermined", "undetermined"];
    expect(idle.reduce(advanceGoal, "provide_quote" as ConversationGoal)).toBe("provide_quote");
  });
});

describe("GOAL_TRANSITIONS is exactly the fold's image", () => {
  // The δ-image of a goal: everything advanceGoal can reach from it over some resolved goal.
  const deltaImage = (from: ConversationGoal): Set<ConversationGoal> =>
    new Set(ALL_GOALS.map((resolved) => advanceGoal(from, resolved)));

  it("every declared edge targets a known goal", () => {
    for (const from of ALL_GOALS) {
      for (const to of GOAL_TRANSITIONS[from]) expect(CONVERSATION_GOALS).toContain(to);
    }
  });

  it("every goal has a reflexive self-edge — an idle self-loop never un-resolves its objective", () => {
    for (const g of ALL_GOALS) expect(GOAL_TRANSITIONS[g]).toContain(g);
  });

  it("declares no duplicate targets", () => {
    for (const g of ALL_GOALS) {
      const targets = GOAL_TRANSITIONS[g];
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it("is EXACTLY the image of advanceGoal — the relation is the fold's reachable set, no more", () => {
    for (const from of ALL_GOALS) {
      expect(new Set(GOAL_TRANSITIONS[from])).toEqual(deltaImage(from));
    }
  });

  it("a concrete goal NEVER regresses to undetermined — undetermined is reachable only as its own self-loop", () => {
    expect(isValidGoalTransition("undetermined", "undetermined")).toBe(true);
    for (const from of CONCRETES) expect(isValidGoalTransition(from, "undetermined")).toBe(false);
  });
});

describe("isValidGoalTransition — TOTAL over goal × goal, exactly the declared edges", () => {
  it("accepts exactly the declared edges across all thirty-six ordered pairs", () => {
    for (const from of ALL_GOALS) {
      for (const to of ALL_GOALS) {
        expect(isValidGoalTransition(from, to)).toBe(GOAL_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("accepts every edge the fold produces — δ ⊆ legal, so a real turn is never rejected", () => {
    for (const from of ALL_GOALS) {
      for (const resolved of ALL_GOALS) {
        expect(isValidGoalTransition(from, advanceGoal(from, resolved))).toBe(true);
      }
    }
  });

  it("is characterised by 'never regress to undetermined except the undetermined self-loop'", () => {
    for (const from of ALL_GOALS) {
      for (const to of ALL_GOALS) {
        const expected = to !== "undetermined" || from === "undetermined";
        expect(isValidGoalTransition(from, to)).toBe(expected);
      }
    }
  });
});

describe("planGoalTransition — unchanged / advance / rejected over the whole goal × goal space", () => {
  it("a self-loop is `unchanged`, for every goal", () => {
    for (const g of ALL_GOALS) {
      expect(planGoalTransition(g, g)).toEqual({ kind: "unchanged", goal: g });
    }
  });

  it("a declared legal non-self edge is an `advance` that names both endpoints", () => {
    for (const from of ALL_GOALS) {
      for (const to of ALL_GOALS) {
        if (to !== from && isValidGoalTransition(from, to)) {
          expect(planGoalTransition(from, to)).toEqual({ kind: "advance", from, to });
        }
      }
    }
  });

  it("an illegal edge (a concrete goal back to undetermined) is `rejected` and NEVER persisted", () => {
    for (const from of CONCRETES) {
      const plan = planGoalTransition(from, "undetermined");
      expect(plan.kind).toBe("rejected");
      if (plan.kind === "rejected") {
        expect(plan.from).toBe(from);
        expect(plan.to).toBe("undetermined");
        expect(plan.reason).toContain(from);
        expect(plan.reason).toContain("undetermined");
      }
    }
  });

  it("is TOTAL — every (from, to) pair resolves to exactly one kind, agreeing with the validator", () => {
    for (const from of ALL_GOALS) {
      for (const to of ALL_GOALS) {
        const plan = planGoalTransition(from, to);
        expect(["advance", "unchanged", "rejected"]).toContain(plan.kind);
        if (to === from) expect(plan.kind).toBe("unchanged");
        else if (isValidGoalTransition(from, to)) expect(plan.kind).toBe("advance");
        else expect(plan.kind).toBe("rejected");
      }
    }
  });

  it("is DETERMINISTIC — identical (from, to) plans identically every call", () => {
    for (const from of ALL_GOALS) {
      for (const to of ALL_GOALS) {
        const once = planGoalTransition(from, to);
        for (let i = 0; i < 10; i++) expect(planGoalTransition(from, to)).toEqual(once);
      }
    }
  });
});

describe("planGoalProgression — the turn-driven planner (δ ⊆ legal ⇒ never rejects)", () => {
  it("plans exactly advanceGoal's target: `unchanged` on a self-target, else `advance`", () => {
    for (const prior of ALL_GOALS) {
      for (const resolved of ALL_GOALS) {
        const target = advanceGoal(prior, resolved);
        const plan = planGoalProgression(prior, resolved);
        if (target === prior) expect(plan).toEqual({ kind: "unchanged", goal: prior });
        else expect(plan).toEqual({ kind: "advance", from: prior, to: target });
      }
    }
  });

  it("NEVER rejects a real turn — a proven safety property (the fold's image IS the legal relation)", () => {
    for (const prior of ALL_GOALS) {
      for (const resolved of ALL_GOALS) {
        expect(planGoalProgression(prior, resolved).kind).not.toBe("rejected");
      }
    }
  });

  it("its `advance` kind is EXACTLY a goal change — the runtime's persisted `goal_advanced` bit", () => {
    for (const prior of ALL_GOALS) {
      for (const resolved of ALL_GOALS) {
        const advanced = planGoalProgression(prior, resolved).kind === "advance";
        expect(advanced).toBe(advanceGoal(prior, resolved) !== prior);
      }
    }
  });

  it("a no-objective (undetermined) resolution is an `unchanged` self-loop from every prior — monotonic", () => {
    for (const prior of ALL_GOALS) {
      expect(planGoalProgression(prior, "undetermined")).toEqual({ kind: "unchanged", goal: prior });
    }
  });

  it("from undetermined, a concrete resolution is an `advance` that resolves the objective", () => {
    for (const resolved of CONCRETES) {
      expect(planGoalProgression("undetermined", resolved)).toEqual({
        kind: "advance",
        from: "undetermined",
        to: resolved,
      });
    }
  });

  it("is DETERMINISTIC — identical (prior, resolved) plans identically every call", () => {
    for (const prior of ALL_GOALS) {
      for (const resolved of ALL_GOALS) {
        const once = planGoalProgression(prior, resolved);
        for (let i = 0; i < 25; i++) expect(planGoalProgression(prior, resolved)).toEqual(once);
      }
    }
  });

  it("governs a whole conversation identically to the raw fold — governance, not movement", () => {
    const sequence: ConversationGoal[] = [
      "answer_enquiry",
      "undetermined",
      "provide_quote",
      "undetermined",
      "arrange_booking",
      "handoff_to_human",
    ];
    let planned: ConversationGoal = INITIAL_CONVERSATION_GOAL;
    for (const resolved of sequence) {
      const plan = planGoalProgression(planned, resolved);
      expect(plan.kind).not.toBe("rejected");
      if (plan.kind === "advance") planned = plan.to;
    }
    const rawFold = sequence.reduce(advanceGoal, INITIAL_CONVERSATION_GOAL);
    expect(planned).toBe(rawFold);
    expect(planned).toBe("handoff_to_human");
  });
});

// =====================================================================
// THE STACK — resolveGoal ∘ resolveIntent: the goal engine executes ON TOP of the intent engine, which
// consumes the context. This block proves the layering Context → Intent → Goal directly, at the unit tier.
// =====================================================================

// A minimal, valid ConversationContext built from a role/text turn list (the same shape the R18 intent
// tests use). resolveIntent reads only the latest CUSTOMER turn's text; the whole object is well-formed so
// the composition exercises the real types end to end.
function contextFrom(
  turns: ReadonlyArray<{ role: ContextRole; text: string }>,
): ConversationContext {
  const messages: ContextMessage[] = turns.map((t, i) => ({
    message_id: `m${i}`,
    role: t.role,
    channel: "sms",
    event_at: `2026-01-01T10:${String(i).padStart(2, "0")}:00.000Z`,
    text: t.text,
    tokens: 0,
  }));
  return {
    conversation: {
      conversation_id: "conv-1",
      org_id: "org-1",
      employee_slug: "voice-receptionist-ai",
      channel: "sms",
      status: "active",
      message_count: messages.length,
      first_message_at: "2026-01-01T10:00:00.000Z",
      last_message_at: "2026-01-01T10:00:00.000Z",
      last_direction: "inbound",
    },
    contact: { contact_ref: "+447700900000", contact_name: null },
    summary: null,
    elision: null,
    messages,
    boundaries: {
      total_message_count: messages.length,
      included_message_count: messages.length,
      omitted_message_count: 0,
      included_from: messages[0]?.event_at ?? null,
      included_to: messages[messages.length - 1]?.event_at ?? null,
      truncated: false,
    },
    budget: { budget: 4000, tokens_used: 0, within_budget: true },
    text: "",
  };
}

/** The composed stack: elevate the customer's latest turn straight through the intent engine to a goal. */
const goalFor = (text: string): ConversationGoal =>
  resolveGoal(resolveIntent(contextFrom([{ role: "customer", text }])));

describe("the stack — resolveGoal ∘ resolveIntent elevates a customer message to the objective", () => {
  it("a price question elevates to provide_quote", () => {
    expect(goalFor("how much do you charge for a boiler service?")).toBe("provide_quote");
  });

  it("an appointment request elevates to arrange_booking", () => {
    expect(goalFor("can I book an appointment for Tuesday?")).toBe("arrange_booking");
  });

  it("a callback request elevates to arrange_callback", () => {
    expect(goalFor("please call me back later")).toBe("arrange_callback");
  });

  it("a human-handoff request elevates to handoff_to_human", () => {
    expect(goalFor("I want to speak to a manager")).toBe("handoff_to_human");
  });

  it("a substantive message with no specialised cue elevates to answer_enquiry", () => {
    expect(goalFor("hi, my boiler is leaking")).toBe("answer_enquiry");
  });

  it("a content-free turn carries no objective — undetermined (monotonic when folded)", () => {
    expect(goalFor("   ")).toBe("undetermined");
    // Folded onto a known objective, a content-free turn keeps it — never regresses.
    const resolved = goalFor("   ");
    expect(planGoalProgression("provide_quote", resolved)).toEqual({
      kind: "unchanged",
      goal: "provide_quote",
    });
  });

  it("end-to-end — from undetermined, a resolved quote enquiry advances to provide_quote", () => {
    const resolved = goalFor("can you give me a quote please?");
    expect(resolved).toBe("provide_quote");
    expect(planGoalProgression("undetermined", resolved)).toEqual({
      kind: "advance",
      from: "undetermined",
      to: "provide_quote",
    });
  });

  it("end-to-end — a re-classifying turn advances between concrete objectives (customer changed their aim)", () => {
    const resolved = goalFor("actually can I speak to a person");
    expect(resolved).toBe("handoff_to_human");
    expect(planGoalProgression("provide_quote", resolved)).toEqual({
      kind: "advance",
      from: "provide_quote",
      to: "handoff_to_human",
    });
  });
});
