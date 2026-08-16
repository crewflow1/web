import { describe, it, expect } from "vitest";
import {
  deriveApprovalLevel,
  approvalLevelDefinition,
  classifyToken,
  AI_APPROVAL_LEVELS,
  READ_SCOPE_TOKENS,
  DRAFT_SCOPE_TOKENS,
  type ApprovalPostureInput,
} from "@/lib/ai-employees/approval-levels";

/**
 * Unit proofs for the explicit 1–5 AI approval-level ladder — a PURE, TOTAL, deterministic
 * classification of an employee's served posture (Directive #015 / D-05). Every posture → level
 * mapping is asserted exactly, plus the boundary cases: the default-deny floor, the seeded
 * default grant (read/draft/memory), unknown tokens, casing/whitespace/order normalisation, and
 * that execution stance dominates the token classes.
 */

function input(over: Partial<ApprovalPostureInput> = {}): ApprovalPostureInput {
  return {
    canExecute: false,
    requiresApproval: true,
    tokens: [],
    source: "registry",
    ...over,
  };
}

// =====================================================================
// The ladder metadata.
// =====================================================================

describe("AI_APPROVAL_LEVELS", () => {
  it("has exactly five rungs, numbered 1..5 in order", () => {
    expect(AI_APPROVAL_LEVELS.map((d) => d.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keys the rungs to the ladder vocabulary", () => {
    expect(AI_APPROVAL_LEVELS.map((d) => d.key)).toEqual([
      "observe",
      "recommend",
      "draft",
      "execute_with_approval",
      "autonomous",
    ]);
  });

  it("every rung carries a non-empty label, summary and mechanism", () => {
    for (const d of AI_APPROVAL_LEVELS) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.summary.length).toBeGreaterThan(0);
      expect(d.mechanism.length).toBeGreaterThan(0);
    }
  });

  it("approvalLevelDefinition round-trips every level", () => {
    for (const d of AI_APPROVAL_LEVELS) {
      expect(approvalLevelDefinition(d.level)).toEqual(d);
    }
  });
});

// =====================================================================
// Token classification.
// =====================================================================

describe("classifyToken", () => {
  it("classifies the known read/context scopes as read", () => {
    expect(classifyToken("read")).toBe("read");
    expect(classifyToken("memory")).toBe("read");
  });

  it("classifies the drafting scope as draft", () => {
    expect(classifyToken("draft")).toBe("draft");
  });

  it("classifies everything else (tool permissions, unknowns) as action", () => {
    expect(classifyToken("comm.send")).toBe("action");
    expect(classifyToken("commit")).toBe("action");
    expect(classifyToken("dispatch")).toBe("action");
    expect(classifyToken("totally-unknown-token")).toBe("action");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(classifyToken("  READ ")).toBe("read");
    expect(classifyToken("Draft")).toBe("draft");
  });

  it("exposes the read/draft scope sets it classifies against", () => {
    expect([...READ_SCOPE_TOKENS].sort()).toEqual(["memory", "read"]);
    expect([...DRAFT_SCOPE_TOKENS]).toEqual(["draft"]);
  });
});

// =====================================================================
// Level 5 — Autonomous: canExecute && !requiresApproval.
// =====================================================================

describe("deriveApprovalLevel — Level 5 Autonomous", () => {
  it("maps can_execute && !requires_approval to Autonomous regardless of tokens", () => {
    for (const tokens of [[], ["read"], ["read", "draft", "memory"], ["comm.send"]]) {
      const r = deriveApprovalLevel(
        input({ canExecute: true, requiresApproval: false, tokens }),
      );
      expect(r.level).toBe(5);
      expect(r.key).toBe("autonomous");
    }
  });

  it("cites the autonomous verdict in its evidence", () => {
    const r = deriveApprovalLevel(input({ canExecute: true, requiresApproval: false }));
    expect(r.evidence.some((e) => /autonomous verdict/i.test(e))).toBe(true);
  });
});

// =====================================================================
// Level 4 — Execute with approval: canExecute && requiresApproval.
// =====================================================================

describe("deriveApprovalLevel — Level 4 Execute with approval", () => {
  it("maps can_execute && requires_approval to Execute-with-approval regardless of tokens", () => {
    for (const tokens of [[], ["read"], ["draft"], ["comm.send"]]) {
      const r = deriveApprovalLevel(
        input({ canExecute: true, requiresApproval: true, tokens }),
      );
      expect(r.level).toBe(4);
      expect(r.key).toBe("execute_with_approval");
    }
  });
});

// =====================================================================
// Level 3 — Draft: !canExecute AND drafting-or-actionable authority.
// =====================================================================

describe("deriveApprovalLevel — Level 3 Draft", () => {
  it("maps a draft scope (cannot execute) to Draft", () => {
    const r = deriveApprovalLevel(input({ tokens: ["draft"] }));
    expect(r.level).toBe(3);
    expect(r.key).toBe("draft");
  });

  it("maps the seeded default grant (read/draft/memory, floor posture) to Draft", () => {
    const r = deriveApprovalLevel(
      input({
        canExecute: false,
        requiresApproval: true,
        tokens: ["read", "draft", "memory"],
      }),
    );
    expect(r.level).toBe(3);
    expect(r.key).toBe("draft");
  });

  it("maps an actionable token without execution rights to Draft", () => {
    const r = deriveApprovalLevel(input({ tokens: ["comm.send"] }));
    expect(r.level).toBe(3);
    expect(r.key).toBe("draft");
    expect(r.evidence.some((e) => /actionable capability/i.test(e))).toBe(true);
  });

  it("still Draft when read scopes accompany a draft/action token", () => {
    const r = deriveApprovalLevel(input({ tokens: ["read", "memory", "comm.send"] }));
    expect(r.level).toBe(3);
  });
});

// =====================================================================
// Level 2 — Recommend: !canExecute AND read/context tokens only.
// =====================================================================

describe("deriveApprovalLevel — Level 2 Recommend", () => {
  it("maps read-only scopes (cannot execute) to Recommend", () => {
    const r = deriveApprovalLevel(input({ tokens: ["read"] }));
    expect(r.level).toBe(2);
    expect(r.key).toBe("recommend");
  });

  it("maps read + memory (cannot execute) to Recommend", () => {
    const r = deriveApprovalLevel(input({ tokens: ["read", "memory"] }));
    expect(r.level).toBe(2);
    expect(r.key).toBe("recommend");
  });

  it("cites the read/context-only evidence", () => {
    const r = deriveApprovalLevel(input({ tokens: ["memory"] }));
    expect(r.evidence.some((e) => /read\/context capability only/i.test(e))).toBe(true);
  });
});

// =====================================================================
// Level 1 — Observe: !canExecute AND no tokens.
// =====================================================================

describe("deriveApprovalLevel — Level 1 Observe", () => {
  it("maps the bare, tokenless, cannot-execute posture to Observe", () => {
    const r = deriveApprovalLevel(input({ tokens: [] }));
    expect(r.level).toBe(1);
    expect(r.key).toBe("observe");
  });

  it("maps the default-deny FLOOR to Observe and records the floor in evidence", () => {
    // The frozen fail-safe: no tokens, locked posture, served by the floor.
    const r = deriveApprovalLevel(
      input({ canExecute: false, requiresApproval: true, tokens: [], source: "floor" }),
    );
    expect(r.level).toBe(1);
    expect(r.key).toBe("observe");
    expect(r.evidence.some((e) => /default-deny floor/i.test(e))).toBe(true);
  });

  it("does not add a floor note when served by the registry", () => {
    const r = deriveApprovalLevel(input({ source: "registry" }));
    expect(r.evidence.some((e) => /default-deny floor/i.test(e))).toBe(false);
  });
});

// =====================================================================
// Totality, determinism, normalisation, immutability.
// =====================================================================

describe("deriveApprovalLevel — totality & determinism", () => {
  it("is total: every posture/token combination yields a valid 1..5 level", () => {
    const tokenSets = [[], ["read"], ["memory"], ["draft"], ["comm.send"], ["read", "draft"]];
    for (const canExecute of [false, true]) {
      for (const requiresApproval of [false, true]) {
        for (const tokens of tokenSets) {
          const r = deriveApprovalLevel(input({ canExecute, requiresApproval, tokens }));
          expect([1, 2, 3, 4, 5]).toContain(r.level);
          // The derived definition matches the canonical rung metadata.
          expect(r.label).toBe(approvalLevelDefinition(r.level).label);
          expect(r.key).toBe(approvalLevelDefinition(r.level).key);
        }
      }
    }
  });

  it("is deterministic and order/case/whitespace-insensitive on tokens", () => {
    const a = deriveApprovalLevel(input({ tokens: ["draft", "read", "memory"] }));
    const b = deriveApprovalLevel(input({ tokens: [" MEMORY ", "Read", "DRAFT", "read"] }));
    expect(a.level).toBe(b.level);
    expect(a.evidence).toEqual(b.evidence);
  });

  it("ignores empty/blank tokens", () => {
    const r = deriveApprovalLevel(input({ tokens: ["", "   "] }));
    expect(r.level).toBe(1);
    expect(r.key).toBe("observe");
  });

  it("returns a frozen result with frozen evidence", () => {
    const r = deriveApprovalLevel(input({ tokens: ["read"] }));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.evidence)).toBe(true);
  });

  it("always records the posture booleans and the token set in evidence", () => {
    const r = deriveApprovalLevel(input({ tokens: ["read", "draft"] }));
    expect(r.evidence[0]).toMatch(/can_execute=false, requires_approval=true/);
    expect(r.evidence.some((e) => /Capability tokens: draft, read/.test(e))).toBe(true);
  });
});
