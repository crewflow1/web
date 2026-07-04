import { describe, it, expect } from "vitest";
import {
  CONVERSATION_INTENTS,
  CONCRETE_INTENTS,
  INITIAL_CONVERSATION_INTENT,
  isConversationIntent,
  coerceConversationIntent,
  resolveIntent,
  advanceIntent,
  INTENT_TRANSITIONS,
  isValidIntentTransition,
  planIntentTransition,
  planIntentProgression,
  type ConversationIntent,
} from "@/lib/receptionist/conversation-intent";
import type {
  ConversationContext,
  ContextMessage,
  ContextRole,
} from "@/lib/receptionist/conversation-context";

/**
 * THE CONVERSATION INTENT ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R18 — CONVERSATION INTENT ENGINE).
 *
 * lib/receptionist/conversation-intent.ts is the deterministic, leaf authority over conversational
 * intent — the single source of truth for "what does the customer want?". It executes ON TOP of the R17
 * state machine, consumes the R12/R16 context, reuses the R2 booking detector, and reaches NOTHING else
 * — no policy, no provider, no ledger, no model — so it is exhaustively unit-testable in isolation.
 * These tests pin, EXHAUSTIVELY: the intent vocabulary and its lock-step with the migration CHECK;
 * deny-unknown coercion; the total, DETERMINISTIC resolution of every signal shape (empty, handoff,
 * booking/callback via the reused detector, quote, general enquiry, precedence, latest-turn selection);
 * the fold's determinism; and — mirroring R17 — the progression relation (exactly the fold's image),
 * its total validator, and its planners (a self-loop is `unchanged`, a legal change an `advance`, an
 * ILLEGAL `concrete → unknown` regression `rejected` and never persisted; a real turn NEVER rejects —
 * the δ ⊆ legal safety property that makes the engine governance, not a gate).
 *
 * The engine's REACHING behaviour (resolve pre-dispatch → persist advance over real Postgres) is proven
 * in the integration tier; its architectural isolation (single-sourced, single consumer, persist-only-
 * under-advance) is proven in the security tier. This file proves the calculus alone.
 */

// The full intent vocabulary, enumerated locally so a drift in CONVERSATION_INTENTS is caught by the
// lock-step assertion below rather than silently propagating into every other case.
const ALL_INTENTS: readonly ConversationIntent[] = [
  "unknown",
  "general_enquiry",
  "booking_interest",
  "callback_request",
  "quote_request",
  "human_handoff",
];
const CONCRETES: readonly ConversationIntent[] = ALL_INTENTS.filter((i) => i !== "unknown");

// A minimal, valid ConversationContext built from a role/text turn list — resolveIntent reads only the
// latest CUSTOMER turn's text, but the whole object is well-formed so the test exercises the real type.
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

/** A context whose latest (and only) customer turn is `text`. */
const customer = (text: string): ConversationContext =>
  contextFrom([{ role: "customer", text }]);

describe("the intent vocabulary — lock-step with the migration CHECK constraint", () => {
  it("CONVERSATION_INTENTS is exactly the six values, in canonical order", () => {
    expect(CONVERSATION_INTENTS).toEqual(ALL_INTENTS);
  });

  it("a brand-new conversation has no classified intent", () => {
    expect(INITIAL_CONVERSATION_INTENT).toBe("unknown");
    expect(CONVERSATION_INTENTS).toContain(INITIAL_CONVERSATION_INTENT);
  });

  it("CONCRETE_INTENTS is every intent except the initial unknown", () => {
    expect(CONCRETE_INTENTS).toEqual(CONCRETES);
    expect(CONCRETE_INTENTS).not.toContain("unknown");
  });

  it("the vocabulary has no duplicates", () => {
    expect(new Set(CONVERSATION_INTENTS).size).toBe(CONVERSATION_INTENTS.length);
  });
});

describe("isConversationIntent — narrows exactly the known vocabulary", () => {
  it("accepts every canonical intent", () => {
    for (const i of ALL_INTENTS) expect(isConversationIntent(i)).toBe(true);
  });

  it("rejects out-of-vocabulary strings", () => {
    for (const bad of ["", "UNKNOWN", "booking", "quote", "handoff", "general", "unknown "]) {
      expect(isConversationIntent(bad)).toBe(false);
    }
  });

  it("rejects non-string values", () => {
    for (const bad of [null, undefined, 0, 1, {}, [], true, NaN]) {
      expect(isConversationIntent(bad)).toBe(false);
    }
  });
});

describe("coerceConversationIntent — TOTAL and DENY-UNKNOWN", () => {
  it("preserves every valid intent", () => {
    for (const i of ALL_INTENTS) expect(coerceConversationIntent(i)).toBe(i);
  });

  it("defaults any unknown / absent value to the initial intent", () => {
    for (const bad of [null, undefined, "", "nonsense", 42, {}, [], "booking"]) {
      expect(coerceConversationIntent(bad)).toBe(INITIAL_CONVERSATION_INTENT);
    }
  });

  it("is TOTAL — every input resolves to a member of the vocabulary", () => {
    for (const v of [null, undefined, "x", "human_handoff", 7, "quote_request"]) {
      expect(CONVERSATION_INTENTS).toContain(coerceConversationIntent(v));
    }
  });
});

describe("resolveIntent — DETERMINISTIC, MODEL-FREE classification of the customer's latest turn", () => {
  it("a null context has no signal → unknown", () => {
    expect(resolveIntent(null)).toBe("unknown");
  });

  it("an empty conversation (no turns) → unknown", () => {
    expect(resolveIntent(contextFrom([]))).toBe("unknown");
  });

  it("a conversation with only assistant turns → unknown (no customer signal)", () => {
    const ctx = contextFrom([
      { role: "assistant", text: "Hello, how can I help?" },
      { role: "assistant", text: "Are you still there?" },
    ]);
    expect(resolveIntent(ctx)).toBe("unknown");
  });

  it("an empty / whitespace customer message → unknown", () => {
    for (const blank of ["", "   ", "\n\t "]) expect(resolveIntent(customer(blank))).toBe("unknown");
  });

  it("a substantive message with no specialised cue → general_enquiry", () => {
    for (const t of ["hi, my boiler is leaking", "the tap in the kitchen is dripping", "hello there"]) {
      expect(resolveIntent(customer(t))).toBe("general_enquiry");
    }
  });

  it("a price / quote enquiry → quote_request", () => {
    for (const t of [
      "how much for a boiler service?",
      "can I get a quote please",
      "what's the price for a rewire",
      "roughly what would it cost",
      "give me a ballpark estimate",
    ]) {
      expect(resolveIntent(customer(t))).toBe("quote_request");
    }
  });

  it("a human-handoff request → human_handoff", () => {
    for (const t of [
      "I want to speak to a human",
      "can I talk to someone please",
      "put me through to a manager",
      "I'd like to make a complaint",
      "get me a real person",
    ]) {
      expect(resolveIntent(customer(t))).toBe("human_handoff");
    }
  });

  it("resolves to a member of the vocabulary for EVERY input (TOTAL)", () => {
    for (const t of ["", "hi", "book me in tuesday", "call me back", "how much", "speak to a human"]) {
      expect(CONVERSATION_INTENTS).toContain(resolveIntent(customer(t)));
    }
  });

  it("is DETERMINISTIC — the same context resolves the same intent every call", () => {
    const ctx = customer("can I get a quote for a new bathroom?");
    const runs = Array.from({ length: 50 }, () => resolveIntent(ctx));
    expect(new Set(runs)).toEqual(new Set(["quote_request"]));
  });

  it("classifies the LATEST customer turn, ignoring earlier turns and assistant turns", () => {
    const ctx = contextFrom([
      { role: "customer", text: "how much for a service?" }, // earlier: quote
      { role: "assistant", text: "It depends — what do you need?" },
      { role: "customer", text: "actually just call me back" }, // latest: callback
    ]);
    expect(resolveIntent(ctx)).toBe("callback_request");
  });
});

describe("resolveIntent — FOLDS the reused R2 booking detector (reuse, not duplication)", () => {
  it("an appointment request → booking_interest", () => {
    for (const t of [
      "can I book an appointment for Tuesday?",
      "I'd like to book you in",
      "are you free next week?",
      "can someone come out on Thursday morning",
    ]) {
      expect(resolveIntent(customer(t))).toBe("booking_interest");
    }
  });

  it("a callback request → callback_request (callback precedence inherited from the detector)", () => {
    for (const t of ["call me back please", "give me a ring later", "can you phone me back"]) {
      expect(resolveIntent(customer(t))).toBe("callback_request");
    }
  });
});

describe("resolveIntent — deterministic PRECEDENCE among competing signals", () => {
  it("human handoff overrides a booking cue in the same message", () => {
    // "book" is an appointment cue, but an explicit request for a manager wins.
    expect(resolveIntent(customer("I wanted to book but can I speak to a manager"))).toBe(
      "human_handoff",
    );
  });

  it("human handoff overrides a quote cue in the same message", () => {
    expect(resolveIntent(customer("how much is it — actually let me talk to a person"))).toBe(
      "human_handoff",
    );
  });

  it("a booking cue takes precedence over a bare price cue (it is the appointment it primarily is)", () => {
    // "come out … Tuesday" is an appointment; the "how much" is secondary.
    expect(resolveIntent(customer("how much to come out on Tuesday?"))).toBe("booking_interest");
  });
});

// =====================================================================
// THE INTENT PROGRESSION MODEL — mirrors the R17 state machine.
//
// advanceIntent is the turn fold (keep prior on unknown, else adopt resolved). INTENT_TRANSITIONS is
// its image; isValidIntentTransition the total validator; planIntentTransition the raw planner;
// planIntentProgression the turn-driven planner. These blocks pin, EXHAUSTIVELY: the relation is EXACTLY
// the fold's image (single-sourced, no drift); monotonic knowledge (a concrete intent never regresses
// to unknown); the planner's three kinds; and the δ ⊆ legal safety property (a real turn never rejects).
// =====================================================================

describe("advanceIntent — the pure fold over ordered per-turn resolutions", () => {
  it("a no-signal (unknown) resolution KEEPS the prior intent, from every prior", () => {
    for (const prior of ALL_INTENTS) expect(advanceIntent(prior, "unknown")).toBe(prior);
  });

  it("a concrete resolution ADOPTS it, from every prior", () => {
    for (const prior of ALL_INTENTS) {
      for (const resolved of CONCRETES) {
        expect(advanceIntent(prior, resolved)).toBe(resolved);
      }
    }
  });

  it("advances by `resolved === unknown ? prior : resolved` directly", () => {
    for (const prior of ALL_INTENTS) {
      for (const resolved of ALL_INTENTS) {
        expect(advanceIntent(prior, resolved)).toBe(resolved === "unknown" ? prior : resolved);
      }
    }
  });

  it("is DETERMINISTIC — the same (prior, resolved) always yields the same next intent", () => {
    for (const prior of ALL_INTENTS) {
      for (const resolved of ALL_INTENTS) {
        const once = advanceIntent(prior, resolved);
        for (let i = 0; i < 25; i++) expect(advanceIntent(prior, resolved)).toBe(once);
      }
    }
  });

  it("folds a whole conversation identically twice (a pure fold over its resolution sequence)", () => {
    const sequence: ConversationIntent[] = [
      "general_enquiry",
      "unknown",
      "quote_request",
      "unknown",
      "booking_interest",
      "unknown",
    ];
    const fold = (rs: ConversationIntent[]): ConversationIntent =>
      rs.reduce(advanceIntent, INITIAL_CONVERSATION_INTENT);
    // enquiry → (idle) → quote → (idle) → booking → (idle): the last concrete signal wins.
    expect(fold(sequence)).toBe("booking_interest");
    expect(fold(sequence)).toBe(fold(sequence));
  });

  it("a run of no-signal turns is a fixed point — an idle conversation never un-knows its intent", () => {
    const idle: ConversationIntent[] = ["unknown", "unknown", "unknown"];
    expect(idle.reduce(advanceIntent, "quote_request" as ConversationIntent)).toBe("quote_request");
  });
});

describe("INTENT_TRANSITIONS is exactly the fold's image", () => {
  // The δ-image of an intent: everything advanceIntent can reach from it over some resolved intent.
  const deltaImage = (from: ConversationIntent): Set<ConversationIntent> =>
    new Set(ALL_INTENTS.map((resolved) => advanceIntent(from, resolved)));

  it("every declared edge targets a known intent", () => {
    for (const from of ALL_INTENTS) {
      for (const to of INTENT_TRANSITIONS[from]) expect(CONVERSATION_INTENTS).toContain(to);
    }
  });

  it("every intent has a reflexive self-edge — an idle self-loop never un-knows its intent", () => {
    for (const i of ALL_INTENTS) expect(INTENT_TRANSITIONS[i]).toContain(i);
  });

  it("declares no duplicate targets", () => {
    for (const i of ALL_INTENTS) {
      const targets = INTENT_TRANSITIONS[i];
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it("is EXACTLY the image of advanceIntent — the relation is the fold's reachable set, no more", () => {
    for (const from of ALL_INTENTS) {
      expect(new Set(INTENT_TRANSITIONS[from])).toEqual(deltaImage(from));
    }
  });

  it("a concrete intent NEVER regresses to unknown — unknown is reachable only as its own self-loop", () => {
    expect(isValidIntentTransition("unknown", "unknown")).toBe(true);
    for (const from of CONCRETES) expect(isValidIntentTransition(from, "unknown")).toBe(false);
  });
});

describe("isValidIntentTransition — TOTAL over intent × intent, exactly the declared edges", () => {
  it("accepts exactly the declared edges across all thirty-six ordered pairs", () => {
    for (const from of ALL_INTENTS) {
      for (const to of ALL_INTENTS) {
        expect(isValidIntentTransition(from, to)).toBe(INTENT_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("accepts every edge the fold produces — δ ⊆ legal, so a real turn is never rejected", () => {
    for (const from of ALL_INTENTS) {
      for (const resolved of ALL_INTENTS) {
        expect(isValidIntentTransition(from, advanceIntent(from, resolved))).toBe(true);
      }
    }
  });

  it("is characterised by 'never regress to unknown except the unknown self-loop'", () => {
    for (const from of ALL_INTENTS) {
      for (const to of ALL_INTENTS) {
        const expected = to !== "unknown" || from === "unknown";
        expect(isValidIntentTransition(from, to)).toBe(expected);
      }
    }
  });
});

describe("planIntentTransition — unchanged / advance / rejected over the whole intent × intent space", () => {
  it("a self-loop is `unchanged`, for every intent", () => {
    for (const i of ALL_INTENTS) {
      expect(planIntentTransition(i, i)).toEqual({ kind: "unchanged", intent: i });
    }
  });

  it("a declared legal non-self edge is an `advance` that names both endpoints", () => {
    for (const from of ALL_INTENTS) {
      for (const to of ALL_INTENTS) {
        if (to !== from && isValidIntentTransition(from, to)) {
          expect(planIntentTransition(from, to)).toEqual({ kind: "advance", from, to });
        }
      }
    }
  });

  it("an illegal edge (a concrete intent back to unknown) is `rejected` and NEVER persisted", () => {
    for (const from of CONCRETES) {
      const plan = planIntentTransition(from, "unknown");
      expect(plan.kind).toBe("rejected");
      if (plan.kind === "rejected") {
        expect(plan.from).toBe(from);
        expect(plan.to).toBe("unknown");
        expect(plan.reason).toContain(from);
        expect(plan.reason).toContain("unknown");
      }
    }
  });

  it("is TOTAL — every (from, to) pair resolves to exactly one kind, agreeing with the validator", () => {
    for (const from of ALL_INTENTS) {
      for (const to of ALL_INTENTS) {
        const plan = planIntentTransition(from, to);
        expect(["advance", "unchanged", "rejected"]).toContain(plan.kind);
        if (to === from) expect(plan.kind).toBe("unchanged");
        else if (isValidIntentTransition(from, to)) expect(plan.kind).toBe("advance");
        else expect(plan.kind).toBe("rejected");
      }
    }
  });

  it("is DETERMINISTIC — identical (from, to) plans identically every call", () => {
    for (const from of ALL_INTENTS) {
      for (const to of ALL_INTENTS) {
        const once = planIntentTransition(from, to);
        for (let i = 0; i < 10; i++) expect(planIntentTransition(from, to)).toEqual(once);
      }
    }
  });
});

describe("planIntentProgression — the turn-driven planner (δ ⊆ legal ⇒ never rejects)", () => {
  it("plans exactly advanceIntent's target: `unchanged` on a self-target, else `advance`", () => {
    for (const prior of ALL_INTENTS) {
      for (const resolved of ALL_INTENTS) {
        const target = advanceIntent(prior, resolved);
        const plan = planIntentProgression(prior, resolved);
        if (target === prior) expect(plan).toEqual({ kind: "unchanged", intent: prior });
        else expect(plan).toEqual({ kind: "advance", from: prior, to: target });
      }
    }
  });

  it("NEVER rejects a real turn — a proven safety property (the fold's image IS the legal relation)", () => {
    for (const prior of ALL_INTENTS) {
      for (const resolved of ALL_INTENTS) {
        expect(planIntentProgression(prior, resolved).kind).not.toBe("rejected");
      }
    }
  });

  it("its `advance` kind is EXACTLY an intent change — the runtime's persisted `intent_advanced` bit", () => {
    for (const prior of ALL_INTENTS) {
      for (const resolved of ALL_INTENTS) {
        const advanced = planIntentProgression(prior, resolved).kind === "advance";
        expect(advanced).toBe(advanceIntent(prior, resolved) !== prior);
      }
    }
  });

  it("a no-signal (unknown) resolution is an `unchanged` self-loop from every prior — monotonic", () => {
    for (const prior of ALL_INTENTS) {
      expect(planIntentProgression(prior, "unknown")).toEqual({ kind: "unchanged", intent: prior });
    }
  });

  it("from unknown, a concrete resolution is an `advance` that learns the intent", () => {
    for (const resolved of CONCRETES) {
      expect(planIntentProgression("unknown", resolved)).toEqual({
        kind: "advance",
        from: "unknown",
        to: resolved,
      });
    }
  });

  it("is DETERMINISTIC — identical (prior, resolved) plans identically every call", () => {
    for (const prior of ALL_INTENTS) {
      for (const resolved of ALL_INTENTS) {
        const once = planIntentProgression(prior, resolved);
        for (let i = 0; i < 25; i++) expect(planIntentProgression(prior, resolved)).toEqual(once);
      }
    }
  });

  it("governs a whole conversation identically to the raw fold — governance, not movement", () => {
    const sequence: ConversationIntent[] = [
      "general_enquiry",
      "unknown",
      "quote_request",
      "unknown",
      "booking_interest",
      "human_handoff",
    ];
    let planned: ConversationIntent = INITIAL_CONVERSATION_INTENT;
    for (const resolved of sequence) {
      const plan = planIntentProgression(planned, resolved);
      expect(plan.kind).not.toBe("rejected");
      if (plan.kind === "advance") planned = plan.to;
    }
    const rawFold = sequence.reduce(advanceIntent, INITIAL_CONVERSATION_INTENT);
    expect(planned).toBe(rawFold);
    expect(planned).toBe("human_handoff");
  });
});

describe("end-to-end — resolveIntent drives a governed progression", () => {
  it("from unknown, a resolved quote enquiry advances to quote_request", () => {
    const resolved = resolveIntent(customer("can you give me a quote please?"));
    expect(resolved).toBe("quote_request");
    expect(planIntentProgression("unknown", resolved)).toEqual({
      kind: "advance",
      from: "unknown",
      to: "quote_request",
    });
  });

  it("a content-free (empty) turn keeps a known intent — monotonic, never regresses to unknown", () => {
    const resolved = resolveIntent(customer("   "));
    expect(resolved).toBe("unknown");
    expect(planIntentProgression("quote_request", resolved)).toEqual({
      kind: "unchanged",
      intent: "quote_request",
    });
  });

  it("a re-classifying turn advances between concrete intents (customer changed what they want)", () => {
    const resolved = resolveIntent(customer("actually can I speak to a manager"));
    expect(resolved).toBe("human_handoff");
    expect(planIntentProgression("quote_request", resolved)).toEqual({
      kind: "advance",
      from: "quote_request",
      to: "human_handoff",
    });
  });
});
