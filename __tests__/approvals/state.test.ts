import { describe, it, expect } from "vitest";
import {
  APPROVAL_STATES,
  APPROVAL_ACTIONS,
  ACTIVE_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  isActive,
  isTerminal,
  canApply,
  nextState,
  legalActions,
  verbFor,
  type ApprovalAction,
  type ApprovalState,
} from "@/lib/approvals/state";
import { isVerb } from "@/lib/events/registry";

/**
 * CrewFlow HQ — The Approval Engine state machine (Directive 010, Phase 2) — unit.
 *
 * This is the deterministic core every AI employee inherits, so it is pinned the
 * way the qualification rubric is: as a PURE function, exhaustively, with no DB.
 * The real database trigger ENFORCES the same machine; the security tier pins that
 * the two agree, and the integration tier proves the trigger behaves. Here we prove
 * the map itself is total, deterministic, and exactly the six reserved verbs.
 */

describe("approval state machine — the state partition", () => {
  it("has exactly five states, partitioned into active and terminal with no overlap", () => {
    expect([...APPROVAL_STATES].sort()).toEqual(
      ["approved", "escalated", "expired", "pending", "rejected"].sort(),
    );
    expect([...ACTIVE_STATES].sort()).toEqual(["escalated", "pending"]);
    expect([...TERMINAL_STATES].sort()).toEqual(["approved", "expired", "rejected"]);
    // The partition is a true partition: union = all, intersection = ∅.
    const union = new Set([...ACTIVE_STATES, ...TERMINAL_STATES]);
    expect(union.size).toBe(APPROVAL_STATES.length);
    for (const s of ACTIVE_STATES) expect(TERMINAL_STATES).not.toContain(s);
  });

  it("isActive / isTerminal classify every state and are mutually exclusive", () => {
    for (const s of APPROVAL_STATES) {
      expect(isActive(s)).toBe(!isTerminal(s));
    }
    expect(isActive("pending")).toBe(true);
    expect(isActive("escalated")).toBe(true);
    expect(isTerminal("approved")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
  });
});

describe("approval state machine — actions map 1:1 to the reserved verbs", () => {
  it("has exactly the six actions", () => {
    expect([...APPROVAL_ACTIONS].sort()).toEqual(
      ["approve", "edit", "escalate", "expire", "reject", "request"].sort(),
    );
  });

  it("each action emits a DISTINCT, REGISTERED approval.* verb", () => {
    const verbs = APPROVAL_ACTIONS.map((a) => verbFor(a));
    // All six are real registry verbs (compile-time enforced; runtime double-check).
    for (const v of verbs) {
      expect(isVerb(v)).toBe(true);
      expect(v.startsWith("approval.")).toBe(true);
    }
    // 1:1 — no two actions share a verb.
    expect(new Set(verbs).size).toBe(verbs.length);
    expect(verbs.sort()).toEqual(
      [
        "approval.requested",
        "approval.edited",
        "approval.escalated",
        "approval.granted",
        "approval.rejected",
        "approval.expired",
      ].sort(),
    );
  });

  it("decision invariants are declared where the trigger enforces them", () => {
    // reject needs a reason; approve/reject/edit are human acts needing a reviewer.
    expect(TRANSITIONS.reject.requiresReason).toBe(true);
    expect(TRANSITIONS.approve.requiresReason).toBe(false);
    expect(TRANSITIONS.reject.requiresReviewer).toBe(true);
    expect(TRANSITIONS.approve.requiresReviewer).toBe(true);
    expect(TRANSITIONS.edit.requiresReviewer).toBe(true);
    // request is the employee's; expire is the system's — neither needs a reviewer.
    expect(TRANSITIONS.request.requiresReviewer).toBe(false);
    expect(TRANSITIONS.expire.requiresReviewer).toBe(false);
    expect(TRANSITIONS.request.actor).toBe("ai_employee");
    expect(TRANSITIONS.expire.actor).toBe("system");
  });
});

describe("approval state machine — transitions are deterministic and total", () => {
  it("request is an INSERT — never legal on an existing row, from any state", () => {
    for (const s of APPROVAL_STATES) {
      expect(canApply("request", s)).toBe(false);
      expect(nextState("request", s)).toBeNull();
    }
  });

  it("from pending: edit (stay), escalate, approve, reject, expire — and nothing else", () => {
    expect(legalActions("pending").sort()).toEqual(
      ["approve", "edit", "escalate", "expire", "reject"].sort(),
    );
    expect(nextState("edit", "pending")).toBe("pending"); // edit records, doesn't move
    expect(nextState("escalate", "pending")).toBe("escalated");
    expect(nextState("approve", "pending")).toBe("approved");
    expect(nextState("reject", "pending")).toBe("rejected");
    expect(nextState("expire", "pending")).toBe("expired");
  });

  it("from escalated: edit (stay), approve, reject, expire — but NOT re-escalate or de-escalate", () => {
    expect(legalActions("escalated").sort()).toEqual(
      ["approve", "edit", "expire", "reject"].sort(),
    );
    expect(nextState("edit", "escalated")).toBe("escalated");
    expect(nextState("approve", "escalated")).toBe("approved");
    expect(nextState("reject", "escalated")).toBe("rejected");
    expect(nextState("expire", "escalated")).toBe("expired");
    // No second escalation, and crucially no de-escalation path back to pending.
    expect(canApply("escalate", "escalated")).toBe(false);
    expect(nextState("escalate", "escalated")).toBeNull();
  });

  it("terminal states are frozen — NO action is legal from approved/rejected/expired", () => {
    for (const s of TERMINAL_STATES) {
      expect(legalActions(s)).toEqual([]);
      for (const a of APPROVAL_ACTIONS) {
        expect(canApply(a, s)).toBe(false);
        expect(nextState(a, s)).toBeNull();
      }
    }
  });

  it("is total and deterministic — every (action,state) pair has a stable answer", () => {
    for (const a of APPROVAL_ACTIONS) {
      for (const s of APPROVAL_STATES) {
        const first = nextState(a as ApprovalAction, s as ApprovalState);
        const second = nextState(a as ApprovalAction, s as ApprovalState);
        expect(first).toBe(second); // deterministic
        // total: a legal pair yields a state, an illegal one yields null — never throws.
        if (canApply(a, s)) {
          expect(first).not.toBeNull();
          expect(APPROVAL_STATES).toContain(first);
        } else {
          expect(first).toBeNull();
        }
      }
    }
  });
});
