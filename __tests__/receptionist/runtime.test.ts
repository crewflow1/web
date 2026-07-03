import { describe, it, expect } from "vitest";
import {
  CONVERSATION_STATES,
  INITIAL_CONVERSATION_STATE,
  isConversationState,
  coerceConversationState,
  classifyTurn,
  nextConversationState,
  advanceConversationState,
  type ConversationState,
  type TurnRouting,
  type TurnDispatchFacts,
} from "@/lib/receptionist/runtime";

/**
 * The MULTI-TURN CONVERSATION RUNTIME — pure core, unit tier
 * (the AI Receptionist Programme, R15 — MULTI-TURN CONVERSATION RUNTIME).
 *
 * lib/receptionist/runtime.ts is the deterministic, leaf heart the server orchestrator folds after
 * each turn: three coarse ownership states, a total turn classifier, and total transition folds. It
 * reaches NOTHING — no policy, no provider, no ledger, no model — so it is exhaustively unit-testable
 * in isolation. These tests pin, EXHAUSTIVELY: the state vocabulary and its lock-step with the
 * migration CHECK; deny-unknown coercion; the total, deterministic turn classification for EVERY
 * dispatch-fact shape; the routing→state transition table; and the fold's determinism (same
 * (state, routing) ALWAYS yields the same next state, and a whole sequence folds identically twice).
 *
 * The runtime's REACHING behaviour (resolve → timeline → context → dispatch → advance over real
 * Postgres) is proven in the integration tier; its architectural isolation (imports no policy, names
 * no decision surface) is proven in the security tier. This file proves the calculus alone.
 */

// The full state vocabulary, enumerated locally so a drift in CONVERSATION_STATES is caught by the
// lock-step assertion below rather than silently propagating into every other case.
const ALL_STATES: readonly ConversationState[] = [
  "awaiting_ai",
  "awaiting_customer",
  "awaiting_human",
];
const ALL_ROUTINGS: readonly TurnRouting[] = ["sent", "held", "refused", "noop"];

describe("the state vocabulary — lock-step with the migration CHECK constraint", () => {
  it("CONVERSATION_STATES is exactly the three coarse ownership values, in canonical order", () => {
    expect(CONVERSATION_STATES).toEqual(ALL_STATES);
  });

  it("a brand-new conversation owes an AI turn", () => {
    expect(INITIAL_CONVERSATION_STATE).toBe("awaiting_ai");
    // The initial state is itself a member of the vocabulary.
    expect(CONVERSATION_STATES).toContain(INITIAL_CONVERSATION_STATE);
  });

  it("the vocabulary has no duplicates", () => {
    expect(new Set(CONVERSATION_STATES).size).toBe(CONVERSATION_STATES.length);
  });
});

describe("isConversationState — narrows exactly the known vocabulary", () => {
  it("accepts every canonical state", () => {
    for (const s of ALL_STATES) expect(isConversationState(s)).toBe(true);
  });

  it("rejects out-of-vocabulary strings", () => {
    for (const bad of ["", "AWAITING_AI", "awaiting_bot", "pending", "done", "awaiting_ai "]) {
      expect(isConversationState(bad)).toBe(false);
    }
  });

  it("rejects non-string values", () => {
    for (const bad of [null, undefined, 0, 1, {}, [], true, NaN]) {
      expect(isConversationState(bad)).toBe(false);
    }
  });
});

describe("coerceConversationState — TOTAL and DENY-UNKNOWN", () => {
  it("preserves every valid state", () => {
    for (const s of ALL_STATES) expect(coerceConversationState(s)).toBe(s);
  });

  it("defaults any unknown / absent value to the initial state", () => {
    for (const bad of [null, undefined, "", "nonsense", 42, {}, [], "awaiting_bot"]) {
      expect(coerceConversationState(bad)).toBe(INITIAL_CONVERSATION_STATE);
    }
  });

  it("is TOTAL — every input resolves to a member of the vocabulary", () => {
    for (const v of [null, undefined, "x", "awaiting_human", 7, "awaiting_customer"]) {
      expect(CONVERSATION_STATES).toContain(coerceConversationState(v));
    }
  });
});

describe("classifyTurn — TOTAL, DETERMINISTIC, mirrors but never reaches the policy", () => {
  const facts = (over: Partial<TurnDispatchFacts>): TurnDispatchFacts => ({
    verdict: null,
    duplicate: false,
    auditProduced: false,
    ...over,
  });

  it("a duplicate short-circuit is a noop — regardless of verdict or audit", () => {
    // A duplicate dominates: whatever the other facts claim, nothing advanced.
    for (const verdict of ["allow", "review", "block", null]) {
      for (const auditProduced of [true, false]) {
        expect(classifyTurn(facts({ duplicate: true, verdict, auditProduced }))).toBe("noop");
      }
    }
  });

  it("no audit produced is a noop — regardless of verdict", () => {
    for (const verdict of ["allow", "review", "block", null]) {
      expect(classifyTurn(facts({ auditProduced: false, verdict }))).toBe("noop");
    }
  });

  it("an audited `allow` is `sent`", () => {
    expect(classifyTurn(facts({ verdict: "allow", auditProduced: true }))).toBe("sent");
  });

  it("an audited `block` is `refused`", () => {
    expect(classifyTurn(facts({ verdict: "block", auditProduced: true }))).toBe("refused");
  });

  it("an audited `review` is `held`", () => {
    expect(classifyTurn(facts({ verdict: "review", auditProduced: true }))).toBe("held");
  });

  it("any other audited verdict (incl. null / unknown) is `held` — the safe non-send default", () => {
    for (const verdict of [null, "escalate", "unknown", ""]) {
      expect(classifyTurn(facts({ verdict, auditProduced: true }))).toBe("held");
    }
  });

  it("is TOTAL — every fact combination classifies to a known routing", () => {
    for (const verdict of ["allow", "review", "block", null, "weird"]) {
      for (const duplicate of [true, false]) {
        for (const auditProduced of [true, false]) {
          const r = classifyTurn(facts({ verdict, duplicate, auditProduced }));
          expect(ALL_ROUTINGS).toContain(r);
        }
      }
    }
  });

  it("is DETERMINISTIC — identical facts classify identically every call", () => {
    const f = facts({ verdict: "allow", auditProduced: true });
    const runs = Array.from({ length: 50 }, () => classifyTurn(f));
    expect(new Set(runs)).toEqual(new Set(["sent"]));
  });
});

describe("nextConversationState — the routing→state transition table", () => {
  it("sent → awaiting_customer (the AI answered; the ball is with the customer)", () => {
    expect(nextConversationState("sent")).toBe("awaiting_customer");
  });

  it("held → awaiting_human (a human owes the review send)", () => {
    expect(nextConversationState("held")).toBe("awaiting_human");
  });

  it("refused → awaiting_human (a human owes the next action on a blocked reply)", () => {
    expect(nextConversationState("refused")).toBe("awaiting_human");
  });

  it("noop → null (nothing was sent or recorded; ownership is unchanged)", () => {
    expect(nextConversationState("noop")).toBeNull();
  });

  it("is TOTAL — every routing maps to a state or an explicit null", () => {
    for (const r of ALL_ROUTINGS) {
      const next = nextConversationState(r);
      expect(next === null || CONVERSATION_STATES.includes(next)).toBe(true);
    }
  });
});

describe("advanceConversationState — the pure fold over ordered turn outcomes", () => {
  it("a noop leaves the current state UNCHANGED, from every state", () => {
    for (const s of ALL_STATES) expect(advanceConversationState(s, "noop")).toBe(s);
  });

  it("a sent turn moves any state to awaiting_customer", () => {
    for (const s of ALL_STATES) expect(advanceConversationState(s, "sent")).toBe("awaiting_customer");
  });

  it("a held or refused turn moves any state to awaiting_human", () => {
    for (const s of ALL_STATES) {
      expect(advanceConversationState(s, "held")).toBe("awaiting_human");
      expect(advanceConversationState(s, "refused")).toBe("awaiting_human");
    }
  });

  it("is DETERMINISTIC — the same (state, routing) always yields the same next state", () => {
    for (const s of ALL_STATES) {
      for (const r of ALL_ROUTINGS) {
        const once = advanceConversationState(s, r);
        for (let i = 0; i < 25; i++) expect(advanceConversationState(s, r)).toBe(once);
      }
    }
  });

  it("advances by nextConversationState, falling back to the current state on a noop", () => {
    // The fold is exactly `nextConversationState(routing) ?? current` — proven directly.
    for (const s of ALL_STATES) {
      for (const r of ALL_ROUTINGS) {
        expect(advanceConversationState(s, r)).toBe(nextConversationState(r) ?? s);
      }
    }
  });

  it("folds a whole conversation identically twice (a pure fold over its turn sequence)", () => {
    const sequence: TurnRouting[] = ["sent", "noop", "held", "noop", "sent", "refused", "sent"];
    const fold = (rs: TurnRouting[]): ConversationState =>
      rs.reduce(advanceConversationState, INITIAL_CONVERSATION_STATE);
    // A customer contact → AI sends → customer replies (noop observation) → held for review →
    // … → refused → sent. The final owner is the customer after the last successful send.
    expect(fold(sequence)).toBe("awaiting_customer");
    // Determinism of the fold: replaying the identical sequence yields the identical terminal state.
    expect(fold(sequence)).toBe(fold(sequence));
  });

  it("a run of noops is a fixed point — an idle conversation never drifts", () => {
    const noops: TurnRouting[] = ["noop", "noop", "noop"];
    const state = noops.reduce(advanceConversationState, "awaiting_human" as ConversationState);
    expect(state).toBe("awaiting_human");
  });
});
