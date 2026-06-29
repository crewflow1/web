import { describe, it, expect } from "vitest";
import {
  applicableGrants,
  AUTHORITY_FLOOR,
  classifyServingConfidence,
  compareAuthority,
  composeGrants,
  decideServedAuthority,
  MEMORY_SCOPE_FLOOR,
  summarizeConfidence,
  type ComparableAuthority,
  type ConfidenceOutcome,
  type GrantRow,
  type ResolvedAuthority,
  type ServingDecision,
} from "@/server/sdk/registry-resolver";

/**
 * The Capability Registry — R3 + R4 runtime resolver, PURE law unit proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5, the inheritance model). Governing rules: the Single Source of Authority
 * Rule (13th §2 standard), the Migration Parity Rule (14th), the Behaviour Preservation
 * Rule (15th), the Shadow Validation Rule (16th).
 *
 * The resolution behaviour the CEO kept in the runtime is a PURE function — so the ADR
 * 0010 Decision 5 inheritance law is proven the same way the doorman's is: a table of
 * grants → resolved authority, with no mocks and no transport. These pin every dimension
 * of the law and, critically, the two parity-load-bearing edges where the registry MUST
 * match the legacy normalisation exactly (`can_execute === true` / `requires_approval !==
 * false`) — if either silently flipped, the registry would manufacture or leak authority
 * the legacy model never gave and R2's proven parity would break.
 *
 * §10 adds the R4 SERVING law ({@link decideServedAuthority}): which source is served, with
 * the registry authoritative and the legacy model retained only as the automatic fail-safe —
 * also a PURE function, so the decision's safety (it can never strand an employee) is proven by
 * a table of inputs, not by discipline. LR5.3 (the Rollback Independence Rule) retired the
 * operator rollback control: the registry is now the SOLE authority, reached for every subject
 * the registry can speak for, with legacy served only on a read error or a silent subject.
 */

/** A grant that, alone, composes to a clean PERMITS baseline (one employee-scoped row). */
const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  scope_level: "employee",
  scope_key: "emp",
  tokens: [],
  can_execute: true,
  requires_approval: false,
  memory_scope: null,
  budget_default: null,
  ...over,
});

const comparable = (over: Partial<ComparableAuthority> = {}): ComparableAuthority => ({
  tokens: [],
  canExecute: false,
  requiresApproval: true,
  memoryScope: MEMORY_SCOPE_FLOOR,
  ...over,
});

// =====================================================================
// 0. Absence resolves to the default-deny floor (ADR 0010 Decision 4).
// =====================================================================

describe("composeGrants — the default-deny floor", () => {
  it("an empty grant set resolves to the floor (no authority can be manufactured)", () => {
    const r = composeGrants([]);
    expect(r).toBe(AUTHORITY_FLOOR);
    expect(r).toEqual({
      tokens: [],
      canExecute: false,
      requiresApproval: true,
      budgetDefault: null,
      memoryScope: "isolated",
      source: "none",
    });
  });

  it("the floor is frozen and self-consistent (MEMORY_SCOPE_FLOOR is 'isolated')", () => {
    expect(MEMORY_SCOPE_FLOOR).toBe("isolated");
    expect(Object.isFrozen(AUTHORITY_FLOOR)).toBe(true);
    expect(AUTHORITY_FLOOR.source).toBe("none");
  });
});

// =====================================================================
// 1. tokens — UNION across scopes, sorted-distinct, empties dropped.
// =====================================================================

describe("composeGrants — tokens are the sorted-distinct UNION", () => {
  it("unions tokens across grants, de-duplicates, and sorts", () => {
    const r = composeGrants([
      grant({ tokens: ["read.web", "memory.write"] }),
      grant({ tokens: ["memory.write", "lead.qualify"] }),
    ]);
    expect(r.tokens).toEqual(["lead.qualify", "memory.write", "read.web"]);
  });

  it("drops empty strings and tolerates a null token array", () => {
    const r = composeGrants([grant({ tokens: ["a", "", "b"] }), grant({ tokens: null })]);
    expect(r.tokens).toEqual(["a", "b"]);
  });

  it("returns a frozen token array (the resolved set is immutable)", () => {
    const r = composeGrants([grant({ tokens: ["a"] })]);
    expect(Object.isFrozen(r.tokens)).toBe(true);
  });
});

// =====================================================================
// 2. can_execute — DENY-WINS (AND), with the legacy `=== true` edge.
// =====================================================================

describe("composeGrants — can_execute is DENY-WINS", () => {
  it("is granted only when EVERY applicable grant permits it", () => {
    expect(composeGrants([grant({ can_execute: true }), grant({ can_execute: true })]).canExecute).toBe(true);
    expect(composeGrants([grant({ can_execute: true }), grant({ can_execute: false })]).canExecute).toBe(false);
  });

  it("treats a missing/garbage value as DENY (mirrors legacy `can_execute === true`)", () => {
    // The parity-load-bearing edge: only literal-true grants execution.
    expect(composeGrants([grant({ can_execute: null })]).canExecute).toBe(false);
    expect(composeGrants([grant({ can_execute: true }), grant({ can_execute: null })]).canExecute).toBe(false);
  });
});

// =====================================================================
// 3. requires_approval — the APPROVAL RATCHET (OR, upward-only).
// =====================================================================

describe("composeGrants — requires_approval is the upward ratchet", () => {
  it("is required if ANY applicable grant requires it", () => {
    expect(
      composeGrants([grant({ requires_approval: false }), grant({ requires_approval: false })]).requiresApproval,
    ).toBe(false);
    expect(
      composeGrants([grant({ requires_approval: false }), grant({ requires_approval: true })]).requiresApproval,
    ).toBe(true);
  });

  it("treats a missing/garbage value as REQUIRES (mirrors legacy `requires_approval !== false`)", () => {
    // The parity-load-bearing edge: approval ratchets up, never silently weakens.
    expect(composeGrants([grant({ requires_approval: null })]).requiresApproval).toBe(true);
    expect(
      composeGrants([grant({ requires_approval: false }), grant({ requires_approval: null })]).requiresApproval,
    ).toBe(true);
  });
});

// =====================================================================
// 4. budget_default — EFFECTIVE MINIMUM, NULL ignored, numeric coerced.
// =====================================================================

describe("composeGrants — budget_default is the effective minimum", () => {
  it("takes the minimum across scopes", () => {
    expect(composeGrants([grant({ budget_default: 500 }), grant({ budget_default: 200 })]).budgetDefault).toBe(200);
  });

  it("ignores NULL ceilings (NULL means 'no ceiling at this scope')", () => {
    expect(composeGrants([grant({ budget_default: null }), grant({ budget_default: 300 })]).budgetDefault).toBe(300);
    expect(composeGrants([grant({ budget_default: null }), grant({ budget_default: null })]).budgetDefault).toBeNull();
  });

  it("coerces a Postgres numeric string, and ignores a non-finite one", () => {
    expect(composeGrants([grant({ budget_default: "150" }), grant({ budget_default: 400 })]).budgetDefault).toBe(150);
    expect(composeGrants([grant({ budget_default: "not-a-number" })]).budgetDefault).toBeNull();
  });
});

// =====================================================================
// 5. memory_scope — MOST-SPECIFIC-WINS over the `isolated` floor.
// =====================================================================

describe("composeGrants — memory_scope is most-specific-wins", () => {
  it("the most specific scope's value wins, regardless of grant order", () => {
    const grants = [
      grant({ scope_level: "global", scope_key: null, memory_scope: "global" }),
      grant({ scope_level: "department", scope_key: "sales", memory_scope: "department" }),
      grant({ scope_level: "employee", memory_scope: "isolated" }),
    ];
    expect(composeGrants(grants).memoryScope).toBe("isolated");
    expect(composeGrants([...grants].reverse()).memoryScope).toBe("isolated");
  });

  it("skips grants with no memory_scope, so a less-specific value can stand", () => {
    const r = composeGrants([
      grant({ scope_level: "department", scope_key: "sales", memory_scope: "department" }),
      grant({ scope_level: "employee", memory_scope: null }),
    ]);
    expect(r.memoryScope).toBe("department");
  });

  it("falls back to the isolated floor when no grant carries a memory_scope", () => {
    expect(composeGrants([grant({ memory_scope: null })]).memoryScope).toBe("isolated");
  });
});

// =====================================================================
// 6. Provenance, immutability, determinism.
// =====================================================================

describe("composeGrants — provenance and purity", () => {
  it("records source 'registry' and freezes the result when any grant composed it", () => {
    const r = composeGrants([grant({ tokens: ["a"] })]);
    expect(r.source).toBe("registry");
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("is deterministic — identical grants always yield deep-equal authority", () => {
    const grants = [grant({ tokens: ["b", "a"], budget_default: 100 })];
    expect(composeGrants(grants)).toEqual(composeGrants(grants));
  });
});

// =====================================================================
// 7. The R2 flat-mirror collapse + the R4 inheritance the resolver enables.
// =====================================================================

describe("composeGrants — flat mirror today, inheritance tomorrow", () => {
  it("a lone employee grant resolves to exactly itself (R2's parity-proven flat mirror)", () => {
    // R2 populated ONLY employee-scoped grants, so composition collapses to the employee
    // grant = the legacy resolution. This is why R3 preserves behaviour by construction.
    const r = composeGrants([
      grant({ tokens: ["lead.qualify", "read.web"], can_execute: false, requires_approval: true, memory_scope: "department" }),
    ]);
    expect(r).toMatchObject({
      tokens: ["lead.qualify", "read.web"],
      canExecute: false,
      requiresApproval: true,
      memoryScope: "department",
      source: "registry",
    });
  });

  it("composes the full Decision-5 law across nested scopes (the inheritance R4 will serve)", () => {
    const r = composeGrants([
      grant({ scope_level: "global", scope_key: null, tokens: ["read.web"], can_execute: true, requires_approval: false, budget_default: 1000, memory_scope: "global" }),
      grant({ scope_level: "department", scope_key: "sales", tokens: ["lead.qualify"], can_execute: true, requires_approval: true, budget_default: 400, memory_scope: "department" }),
      grant({ scope_level: "employee", tokens: ["memory.write"], can_execute: true, requires_approval: false, budget_default: 250, memory_scope: "isolated" }),
    ]);
    expect(r).toEqual({
      tokens: ["lead.qualify", "memory.write", "read.web"], // UNION
      canExecute: true, // every scope permits → granted
      requiresApproval: true, // department requires → ratcheted up
      budgetDefault: 250, // effective minimum
      memoryScope: "isolated", // employee is most specific
      source: "registry",
    });
  });
});

// =====================================================================
// 8. applicableGrants — only the grants that apply to the subject.
// =====================================================================

describe("applicableGrants — scope matching", () => {
  const all: GrantRow[] = [
    grant({ scope_level: "global", scope_key: null, tokens: ["g"] }),
    grant({ scope_level: "department", scope_key: "sales", tokens: ["d-sales"] }),
    grant({ scope_level: "department", scope_key: "eng", tokens: ["d-eng"] }),
    grant({ scope_level: "employee", scope_key: "alice", tokens: ["e-alice"] }),
    grant({ scope_level: "employee", scope_key: "bob", tokens: ["e-bob"] }),
    grant({ scope_level: "organization", scope_key: "acme", tokens: ["o"] }),
  ];

  it("global applies to everyone; employee matches the slug; department matches the dept", () => {
    const got = applicableGrants(all, { slug: "alice", department: "sales" });
    expect(got.flatMap((g) => g.tokens ?? []).sort()).toEqual(["d-sales", "e-alice", "g"]);
  });

  it("matches no other employee's or department's grant", () => {
    const got = applicableGrants(all, { slug: "alice", department: "sales" });
    const tokens = got.flatMap((g) => g.tokens ?? []);
    expect(tokens).not.toContain("e-bob");
    expect(tokens).not.toContain("d-eng");
  });

  it("never matches an organization grant (no per-employee org key in the legacy model)", () => {
    const got = applicableGrants(all, { slug: "alice", department: "sales" });
    expect(got.flatMap((g) => g.tokens ?? [])).not.toContain("o");
  });

  it("matches no department grant when the subject has no department", () => {
    const got = applicableGrants(all, { slug: "alice", department: null });
    expect(got.flatMap((g) => g.tokens ?? []).sort()).toEqual(["e-alice", "g"]);
  });
});

// =====================================================================
// 9. compareAuthority — the runtime-callable parity analogue.
// =====================================================================

describe("compareAuthority — divergence detection", () => {
  it("returns null when the two authorities agree on all four dimensions", () => {
    const a = comparable({ tokens: ["x", "y"], canExecute: true, requiresApproval: false, memoryScope: "department" });
    expect(compareAuthority(a, comparable({ tokens: ["x", "y"], canExecute: true, requiresApproval: false, memoryScope: "department" }))).toBeNull();
  });

  it("treats tokens as order-independent sets", () => {
    expect(compareAuthority(comparable({ tokens: ["a", "b"] }), comparable({ tokens: ["b", "a"] }))).toBeNull();
  });

  it("names exactly the dimension that differs", () => {
    expect(compareAuthority(comparable(), comparable({ tokens: ["x"] }))?.dimensions).toEqual(["tokens"]);
    expect(compareAuthority(comparable(), comparable({ canExecute: true }))?.dimensions).toEqual(["canExecute"]);
    expect(compareAuthority(comparable(), comparable({ requiresApproval: false }))?.dimensions).toEqual(["requiresApproval"]);
    expect(compareAuthority(comparable(), comparable({ memoryScope: "global" }))?.dimensions).toEqual(["memoryScope"]);
  });

  it("reports every divergent dimension at once, and carries both sides", () => {
    const legacy = comparable({ tokens: ["a"], canExecute: false, requiresApproval: true, memoryScope: "isolated" });
    const registry = comparable({ tokens: ["b"], canExecute: true, requiresApproval: false, memoryScope: "global" });
    const d = compareAuthority(legacy, registry);
    expect(d?.dimensions).toEqual(["tokens", "canExecute", "requiresApproval", "memoryScope"]);
    expect(d?.legacy).toBe(legacy);
    expect(d?.registry).toBe(registry);
  });

  it("never compares budget — it is registry-only forward metadata with no legacy counterpart", () => {
    // ComparableAuthority carries no budget, so the dimension can never appear.
    const d = compareAuthority(comparable({ tokens: ["a"] }), comparable({ tokens: ["b"] }));
    expect(d?.dimensions).not.toContain("budget");
    expect(d?.dimensions).not.toContain("budgetDefault");
  });
});

// =====================================================================
// 10. decideServedAuthority — the R4 serving law (the runtime authority switch).
// =====================================================================

/** A registry-resolved authority that, alone, would be served (source "registry"). */
const resolved = (over: Partial<ResolvedAuthority> = {}): ResolvedAuthority => ({
  tokens: [],
  canExecute: false,
  requiresApproval: true,
  budgetDefault: null,
  memoryScope: MEMORY_SCOPE_FLOOR,
  source: "registry",
  ...over,
});

describe("decideServedAuthority — the runtime serving decision (R4; rollback retired LR5.3)", () => {
  it("serves the AUTHORITATIVE registry when the registry spoke", () => {
    const legacy = comparable({ tokens: ["read.web"] });
    const registry = resolved({ tokens: ["read.web"], source: "registry" });
    const d = decideServedAuthority({ registry, legacy });
    expect(d.basis).toBe("registry");
    expect(d.reason).toBeUndefined();
    expect(d.divergence).toBeUndefined(); // in parity
  });

  it("still serves the registry when it DIVERGES — divergence is monitored, not a fallback", () => {
    // The registry is authoritative: a disagreement with the legacy baseline is recorded for
    // parity monitoring, but the registry is what gets served (this is the whole point of R4).
    const legacy = comparable({ tokens: ["read.web"] });
    const registry = resolved({ tokens: ["read.web", "lead.qualify"], source: "registry" });
    const d = decideServedAuthority({ registry, legacy });
    expect(d.basis).toBe("registry");
    expect(d.divergence?.dimensions).toEqual(["tokens"]);
  });

  it("FAIL-SAFE to legacy when the registry read failed (registry=null)", () => {
    const d = decideServedAuthority({ registry: null, legacy: comparable() });
    expect(d.basis).toBe("legacy");
    expect(d.reason).toBe("error");
  });

  it("FALLS THROUGH to legacy when the registry is silent for the subject (source 'none')", () => {
    // No applicable grants → AUTHORITY_FLOOR (source 'none'). During the migration window the
    // retained legacy model stands in (a backfill gap can never strand the employee).
    const d = decideServedAuthority({
      registry: AUTHORITY_FLOOR,
      legacy: comparable({ tokens: ["read.web"] }),
    });
    expect(d.basis).toBe("legacy");
    expect(d.reason).toBe("empty");
  });

  it("checks the read-error before the silent-registry case (null is never 'empty')", () => {
    const d = decideServedAuthority({ registry: null, legacy: comparable() });
    expect(d.reason).toBe("error");
    expect(d.reason).not.toBe("empty");
  });

  it("is TOTAL and deny-safe — legacy is the fail-safe in every non-registry branch", () => {
    // Whatever the failure, the decision resolves to a served source; it never throws and never
    // resolves to "nothing" (the legacy model is always the floor it falls back to).
    for (const d of [
      decideServedAuthority({ registry: null, legacy: comparable() }),
      decideServedAuthority({ registry: AUTHORITY_FLOOR, legacy: comparable() }),
    ]) {
      expect(d.basis).toBe("legacy");
    }
  });
});

// =====================================================================
// 11. The LR4 production-confidence law (classify + summarize), PURE.
//     The Bank-Confidence instrument's verdict is a fold over the SAME
//     serving decisions the runtime serves — proposal §4 made measurable.
// =====================================================================

describe("classifyServingConfidence — one decision → one confidence outcome", () => {
  it("served registry IN PARITY → registry-parity (the only confident outcome)", () => {
    expect(classifyServingConfidence({ basis: "registry" })).toBe("registry-parity");
  });

  it("served registry but DIVERGED → registry-divergent (must be accounted for, §4.2)", () => {
    const decision: ServingDecision = {
      basis: "registry",
      divergence: {
        dimensions: ["tokens"],
        legacy: comparable(),
        registry: comparable({ tokens: ["x"] }),
      },
    };
    expect(classifyServingConfidence(decision)).toBe("registry-divergent");
  });

  it("registry silent (reason 'empty') → backfill-gap (§4.4 must be zero)", () => {
    expect(classifyServingConfidence({ basis: "legacy", reason: "empty" })).toBe("backfill-gap");
  });

  it("registry read failed (reason 'error') → registry-error", () => {
    expect(classifyServingConfidence({ basis: "legacy", reason: "error" })).toBe("registry-error");
  });

  it("is TOTAL — a legacy basis with no reason still classifies (defensive default)", () => {
    // With the rollback control retired (LR5.3), a legacy basis is only ever the automatic
    // fail-safe; a reason-less legacy decision defends to registry-error, never silent success.
    expect(classifyServingConfidence({ basis: "legacy" })).toBe("registry-error");
  });

  it("composes with decideServedAuthority — the audit measures what the runtime serves", () => {
    // The whole point: the classification is taken from the runtime's OWN decision law, so a
    // sweep's verdict can never diverge from what the serve path does.
    const inParity = decideServedAuthority({
      registry: resolved({ tokens: ["read.web"] }),
      legacy: comparable({ tokens: ["read.web"] }),
    });
    expect(classifyServingConfidence(inParity)).toBe("registry-parity");

    const gap = decideServedAuthority({
      registry: AUTHORITY_FLOOR,
      legacy: comparable({ tokens: ["read.web"] }),
    });
    expect(classifyServingConfidence(gap)).toBe("backfill-gap");

    const failSafe = decideServedAuthority({
      registry: null,
      legacy: comparable({ tokens: ["read.web"] }),
    });
    expect(classifyServingConfidence(failSafe)).toBe("registry-error");
  });
});

describe("summarizeConfidence — the measurable §4 aggregate", () => {
  it("counts every class and is frozen", () => {
    const outcomes: ConfidenceOutcome[] = [
      "registry-parity",
      "registry-parity",
      "registry-divergent",
      "backfill-gap",
      "registry-error",
    ];
    const s = summarizeConfidence(outcomes);
    expect(s).toEqual({
      total: 5,
      registryParity: 2,
      registryDivergent: 1,
      backfillGaps: 1,
      registryErrors: 1,
      registryOnlyReady: false,
    });
    expect(Object.isFrozen(s)).toBe(true);
  });

  it("registryOnlyReady is true ONLY when every employee is served registry in parity", () => {
    expect(summarizeConfidence(["registry-parity", "registry-parity"]).registryOnlyReady).toBe(true);
    // A single non-parity outcome of any kind defeats readiness.
    for (const spoiler of ["registry-divergent", "backfill-gap", "registry-error"] as const) {
      expect(summarizeConfidence(["registry-parity", spoiler]).registryOnlyReady).toBe(false);
    }
  });

  it("an EMPTY roster is NOT ready — there is nothing to be confident about", () => {
    const s = summarizeConfidence([]);
    expect(s.total).toBe(0);
    expect(s.registryOnlyReady).toBe(false);
  });

  it("is deterministic — the same outcomes always summarise identically", () => {
    const outcomes: ConfidenceOutcome[] = ["registry-parity", "backfill-gap", "registry-parity"];
    expect(summarizeConfidence(outcomes)).toEqual(summarizeConfidence(outcomes));
  });
});
