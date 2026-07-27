import { describe, it, expect } from "vitest";
import {
  CONVERSATION_STATES,
  INITIAL_CONVERSATION_STATE,
  isConversationState,
  coerceConversationState,
  classifyTurn,
  nextConversationState,
  advanceConversationState,
  CONVERSATION_TRANSITIONS,
  isValidConversationTransition,
  planStateTransition,
  planConversationTransition,
  type ConversationState,
  type TurnRouting,
  type TurnDispatchFacts,
} from "@/lib/receptionist/runtime";

/**
 * The MULTI-TURN CONVERSATION RUNTIME — pure core, unit tier
 * (the AI Receptionist Programme, R15 — MULTI-TURN CONVERSATION RUNTIME; R17 — FORMAL STATE MACHINE).
 *
 * lib/receptionist/runtime.ts is the deterministic, leaf heart the server orchestrator folds after
 * each turn: three coarse ownership states, a total turn classifier, total transition folds, and (R17)
 * the FORMAL STATE MACHINE that governs every persisted progression. It reaches NOTHING — no policy, no
 * provider, no ledger, no model — so it is exhaustively unit-testable in isolation. These tests pin,
 * EXHAUSTIVELY: the state vocabulary and its lock-step with the migration CHECK; deny-unknown coercion;
 * the total, deterministic turn classification for EVERY dispatch-fact shape; the routing→state
 * transition table; the fold's determinism (same (state, routing) ALWAYS yields the same next state,
 * and a whole sequence folds identically twice); and — R17 — the state machine's legal-edge relation
 * (exactly the fold's image), its total validator, and its planner (a self-loop is `unchanged`, a legal
 * change an `advance`, an ILLEGAL edge `rejected` and never persisted; a real turn NEVER rejects).
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

// =====================================================================
// R17 — THE FORMAL CONVERSATION STATE MACHINE.
//
// R15's fold (advanceConversationState) is TOTAL but from-agnostic and unguarded. R17 wraps it in a
// FORMAL STATE MACHINE: an explicit legal-edge relation (CONVERSATION_TRANSITIONS), a total validator
// (isValidConversationTransition), and two planners (planStateTransition over raw endpoints;
// planConversationTransition over a turn's routing). These blocks pin, EXHAUSTIVELY: the relation is
// EXACTLY the fold's image (single-sourced, no drift); the validator accepts precisely the declared
// edges and every edge the fold produces; planStateTransition classifies a self-loop `unchanged`, a
// legal change an `advance`, and an ILLEGAL edge `rejected` with an explanatory reason; and the
// turn-driven planConversationTransition plans exactly the fold's target, its `advance` kind is EXACTLY
// a state change (the runtime's persisted `state_advanced` bit), and it NEVER rejects a real turn —
// the δ ⊆ legal safety property that makes the machine governance over the runtime, not a gate on it.
// =====================================================================

describe("the FORMAL state machine (R17) — CONVERSATION_TRANSITIONS is exactly the fold's image", () => {
  // The δ-image of a state: every state advanceConversationState can reach from it over some routing.
  const deltaImage = (from: ConversationState): Set<ConversationState> =>
    new Set(ALL_ROUTINGS.map((r) => advanceConversationState(from, r)));

  it("every declared edge targets a known state", () => {
    for (const from of ALL_STATES) {
      for (const to of CONVERSATION_TRANSITIONS[from]) {
        expect(CONVERSATION_STATES).toContain(to);
      }
    }
  });

  it("every state has a reflexive self-edge — an idle self-loop never leaves its owner", () => {
    for (const s of ALL_STATES) expect(CONVERSATION_TRANSITIONS[s]).toContain(s);
  });

  it("declares no duplicate targets", () => {
    for (const s of ALL_STATES) {
      const targets = CONVERSATION_TRANSITIONS[s];
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it("is EXACTLY the image of advanceConversationState — the relation is the fold's reachable set, no more", () => {
    // The single invariant that keeps the graph and the fold in lock-step: the legal-edge relation is
    // neither wider (a phantom edge the runtime never makes) nor narrower (a real progression it would
    // reject) than what the fold actually produces.
    for (const from of ALL_STATES) {
      expect(new Set(CONVERSATION_TRANSITIONS[from])).toEqual(deltaImage(from));
    }
  });

  it("a conversation NEVER regresses to awaiting_ai as a turn outcome — reachable only as a self-loop", () => {
    // awaiting_ai ("the AI owes the FIRST turn") is targeted by no state but itself: only a fresh
    // inbound (not a turn outcome) owes the AI a first turn.
    expect(isValidConversationTransition("awaiting_ai", "awaiting_ai")).toBe(true);
    expect(isValidConversationTransition("awaiting_customer", "awaiting_ai")).toBe(false);
    expect(isValidConversationTransition("awaiting_human", "awaiting_ai")).toBe(false);
  });
});

describe("isValidConversationTransition — TOTAL over state × state, exactly the declared edges", () => {
  it("accepts exactly the declared edges across all nine ordered pairs", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        expect(isValidConversationTransition(from, to)).toBe(
          CONVERSATION_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it("accepts every edge the fold actually produces — δ ⊆ legal, so a real turn is never rejected", () => {
    for (const from of ALL_STATES) {
      for (const r of ALL_ROUTINGS) {
        expect(isValidConversationTransition(from, advanceConversationState(from, r))).toBe(true);
      }
    }
  });

  it("is characterised by 'never regress to awaiting_ai except the awaiting_ai self-loop'", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const expected = to !== "awaiting_ai" || from === "awaiting_ai";
        expect(isValidConversationTransition(from, to)).toBe(expected);
      }
    }
  });
});

describe("planStateTransition — unchanged / advance / rejected over the whole state × state space", () => {
  it("a self-loop is `unchanged`, for every state", () => {
    for (const s of ALL_STATES) {
      expect(planStateTransition(s, s)).toEqual({ kind: "unchanged", state: s });
    }
  });

  it("a declared legal non-self edge is an `advance` that names both endpoints", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (to !== from && isValidConversationTransition(from, to)) {
          expect(planStateTransition(from, to)).toEqual({ kind: "advance", from, to });
        }
      }
    }
  });

  it("an illegal edge is `rejected` and NEVER persisted — the two regressions to awaiting_ai", () => {
    for (const from of ["awaiting_customer", "awaiting_human"] as const) {
      const plan = planStateTransition(from, "awaiting_ai");
      expect(plan.kind).toBe("rejected");
      if (plan.kind === "rejected") {
        expect(plan.from).toBe(from);
        expect(plan.to).toBe("awaiting_ai");
        // The reason names the illegal edge for the governance log.
        expect(plan.reason).toContain(from);
        expect(plan.reason).toContain("awaiting_ai");
      }
    }
  });

  it("is TOTAL — every (from, to) pair resolves to exactly one of the three kinds, agreeing with the validator", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const plan = planStateTransition(from, to);
        expect(["advance", "unchanged", "rejected"]).toContain(plan.kind);
        if (to === from) expect(plan.kind).toBe("unchanged");
        else if (isValidConversationTransition(from, to)) expect(plan.kind).toBe("advance");
        else expect(plan.kind).toBe("rejected");
      }
    }
  });

  it("is DETERMINISTIC — identical (from, to) plans identically every call", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const once = planStateTransition(from, to);
        for (let i = 0; i < 10; i++) expect(planStateTransition(from, to)).toEqual(once);
      }
    }
  });
});

describe("planConversationTransition — the turn-driven planner (δ ⊆ legal ⇒ never rejects)", () => {
  it("plans exactly advanceConversationState's target: `unchanged` on a self-target, else `advance`", () => {
    for (const s of ALL_STATES) {
      for (const r of ALL_ROUTINGS) {
        const target = advanceConversationState(s, r);
        const plan = planConversationTransition(s, r);
        if (target === s) expect(plan).toEqual({ kind: "unchanged", state: s });
        else expect(plan).toEqual({ kind: "advance", from: s, to: target });
      }
    }
  });

  it("NEVER rejects a real turn — a proven safety property (the fold's image IS the legal relation)", () => {
    for (const s of ALL_STATES) {
      for (const r of ALL_ROUTINGS) {
        expect(planConversationTransition(s, r).kind).not.toBe("rejected");
      }
    }
  });

  it("its `advance` kind is EXACTLY a state change — the runtime's persisted `state_advanced` bit", () => {
    for (const s of ALL_STATES) {
      for (const r of ALL_ROUTINGS) {
        const advanced = planConversationTransition(s, r).kind === "advance";
        expect(advanced).toBe(advanceConversationState(s, r) !== s);
      }
    }
  });

  it("a noop is an `unchanged` self-loop from every state — an idle turn persists nothing", () => {
    for (const s of ALL_STATES) {
      expect(planConversationTransition(s, "noop")).toEqual({ kind: "unchanged", state: s });
    }
  });

  it("a `sent` advances to awaiting_customer — except from awaiting_customer, where it is unchanged", () => {
    expect(planConversationTransition("awaiting_ai", "sent")).toEqual({
      kind: "advance",
      from: "awaiting_ai",
      to: "awaiting_customer",
    });
    expect(planConversationTransition("awaiting_human", "sent")).toEqual({
      kind: "advance",
      from: "awaiting_human",
      to: "awaiting_customer",
    });
    expect(planConversationTransition("awaiting_customer", "sent")).toEqual({
      kind: "unchanged",
      state: "awaiting_customer",
    });
  });

  it("a `held` or `refused` advances to awaiting_human — except from awaiting_human, unchanged", () => {
    for (const r of ["held", "refused"] as const) {
      expect(planConversationTransition("awaiting_ai", r)).toEqual({
        kind: "advance",
        from: "awaiting_ai",
        to: "awaiting_human",
      });
      expect(planConversationTransition("awaiting_customer", r)).toEqual({
        kind: "advance",
        from: "awaiting_customer",
        to: "awaiting_human",
      });
      expect(planConversationTransition("awaiting_human", r)).toEqual({
        kind: "unchanged",
        state: "awaiting_human",
      });
    }
  });

  it("is DETERMINISTIC — identical (from, routing) plans identically every call", () => {
    for (const s of ALL_STATES) {
      for (const r of ALL_ROUTINGS) {
        const once = planConversationTransition(s, r);
        for (let i = 0; i < 25; i++) expect(planConversationTransition(s, r)).toEqual(once);
      }
    }
  });

  it("governs a whole conversation identically to the raw fold — governance, not movement", () => {
    // Fold a real sequence THROUGH the planner (persisting only advances) and confirm the terminal
    // state is identical to the raw advanceConversationState fold: the machine guards the progression
    // but changes none of it.
    const sequence: TurnRouting[] = ["sent", "noop", "held", "noop", "sent", "refused", "sent"];
    let planned: ConversationState = INITIAL_CONVERSATION_STATE;
    for (const r of sequence) {
      const plan = planConversationTransition(planned, r);
      expect(plan.kind).not.toBe("rejected");
      if (plan.kind === "advance") planned = plan.to;
    }
    const rawFold = sequence.reduce(advanceConversationState, INITIAL_CONVERSATION_STATE);
    expect(planned).toBe(rawFold);
    expect(planned).toBe("awaiting_customer");
  });
});
