import { describe, it, expect } from "vitest";
import {
  applicableGrants,
  AUTHORITY_FLOOR,
  compareAuthority,
  composeGrants,
  decideServedAuthority,
  MEMORY_SCOPE_FLOOR,
  type ComparableAuthority,
  type GrantRow,
  type ResolvedAuthority,
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
 * the registry authoritative and the legacy model retained as the rollback / fail-safe — also
 * a PURE function, so the switch's safety (it can never strand an employee, and never serves
 * the registry under a rollback) is proven by a table of inputs, not by discipline.
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

describe("decideServedAuthority — the runtime authority switch (R4)", () => {
  it("serves the AUTHORITATIVE registry when control=registry and the registry spoke", () => {
    const legacy = comparable({ tokens: ["read.web"] });
    const registry = resolved({ tokens: ["read.web"], source: "registry" });
    const d = decideServedAuthority({ control: "registry", registry, legacy });
    expect(d.basis).toBe("registry");
    expect(d.reason).toBeUndefined();
    expect(d.divergence).toBeUndefined(); // in parity
  });

  it("still serves the registry when it DIVERGES — divergence is monitored, not a fallback", () => {
    // The registry is authoritative: a disagreement with the legacy baseline is recorded for
    // parity monitoring, but the registry is what gets served (this is the whole point of R4).
    const legacy = comparable({ tokens: ["read.web"] });
    const registry = resolved({ tokens: ["read.web", "lead.qualify"], source: "registry" });
    const d = decideServedAuthority({ control: "registry", registry, legacy });
    expect(d.basis).toBe("registry");
    expect(d.divergence?.dimensions).toEqual(["tokens"]);
  });

  it("ROLLS BACK to legacy when control=legacy, even if the registry would have served", () => {
    // The deliberate rollback lever: legacy wins regardless of what the registry holds — and
    // the registry value is NOT consulted for the decision (no divergence is computed).
    const legacy = comparable({ tokens: ["read.web"] });
    const registry = resolved({ tokens: ["everything"], source: "registry" });
    const d = decideServedAuthority({ control: "legacy", registry, legacy });
    expect(d.basis).toBe("legacy");
    expect(d.reason).toBe("rollback");
    expect(d.divergence).toBeUndefined();
  });

  it("FAIL-SAFE to legacy when the registry read failed (registry=null)", () => {
    const d = decideServedAuthority({ control: "registry", registry: null, legacy: comparable() });
    expect(d.basis).toBe("legacy");
    expect(d.reason).toBe("error");
  });

  it("FALLS THROUGH to legacy when the registry is silent for the subject (source 'none')", () => {
    // No applicable grants → AUTHORITY_FLOOR (source 'none'). During the migration window the
    // retained legacy model stands in (a backfill gap can never strand the employee).
    const d = decideServedAuthority({
      control: "registry",
      registry: AUTHORITY_FLOOR,
      legacy: comparable({ tokens: ["read.web"] }),
    });
    expect(d.basis).toBe("legacy");
    expect(d.reason).toBe("empty");
  });

  it("checks the read-error before the silent-registry case (null is never 'empty')", () => {
    const d = decideServedAuthority({ control: "registry", registry: null, legacy: comparable() });
    expect(d.reason).toBe("error");
    expect(d.reason).not.toBe("empty");
  });

  it("is TOTAL and deny-safe — legacy is the fallback in every non-registry branch", () => {
    // Whatever the failure, the switch resolves to a served source; it never throws and never
    // resolves to "nothing" (the legacy model is always the floor it falls back to).
    for (const d of [
      decideServedAuthority({ control: "legacy", registry: null, legacy: comparable() }),
      decideServedAuthority({ control: "registry", registry: null, legacy: comparable() }),
      decideServedAuthority({ control: "registry", registry: AUTHORITY_FLOOR, legacy: comparable() }),
    ]) {
      expect(d.basis).toBe("legacy");
    }
  });
});
