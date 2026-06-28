/**
 * CrewFlow HQ — The Capability Registry, R3: the runtime capability resolver (PURE core).
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5, the inheritance model). Governing rules: the Single Source of Authority
 * Rule (13th §2 standard), the Migration Parity Rule (14th), and the Behaviour
 * Preservation Rule (15th — set on the R2 review).
 *
 * This is the *resolution behaviour* the CEO kept in the runtime (ADR 0010 Decision 2:
 * the registry is a declarative database of authority; the runtime queries it and
 * composes the grants). It is deliberately a PURE, dependency-free module — it imports
 * nothing from the server-only SDK graph — so the composition law is unit-testable in
 * isolation and carries no request-path side effects of its own.
 *
 * The inheritance model (ADR 0010 Decision 5), composed over the four nested scope
 * levels global ⊇ organization ⊇ department ⊇ employee:
 *   • tokens            — UNION across all applicable scopes (sorted-distinct).
 *   • can_execute       — DENY-WINS: granted only if every applicable scope permits it.
 *   • requires_approval — the APPROVAL RATCHET: required if any applicable scope requires
 *                         it (ratchets upward, never downward — the stricter rule the CEO
 *                         chose over most-specific-wins).
 *   • budget_default    — the EFFECTIVE MINIMUM across scopes (the stricter ceiling);
 *                         NULL means "no ceiling at this scope" and is ignored.
 *   • memory_scope      — MOST-SPECIFIC-WINS over the safe `isolated` floor (non-security
 *                         metadata).
 * Absence resolves to the default-deny floor (ADR 0010 Decision 4): no tokens,
 * can_execute=false, requires_approval=true, memory_scope='isolated'. Because the base is
 * default-deny and approval only ratchets up, no inheritance path can manufacture
 * authority.
 *
 * R3 BOUNDARY (the Behaviour Preservation Rule): introducing this resolver changes no
 * externally observable behaviour. The legacy model stays authoritative; this resolver is
 * consulted as a continuously-verified shadow (see {@link compareAuthority} and
 * server/sdk/registry-parity.ts). The behavioural transition — serving authority FROM the
 * registry — is a later, separately-authorised slice.
 */

/** The default-deny memory floor (ADR 0010 Decision 4; mirrors the grant column default). */
export const MEMORY_SCOPE_FLOOR = "isolated" as const;

/** The four nested scope levels, least-specific → most-specific (ADR 0010 Decision 5). */
export type ScopeLevel = "global" | "organization" | "department" | "employee";

/** Specificity rank for most-specific-wins (higher = more specific). */
const SCOPE_RANK: Record<ScopeLevel, number> = {
  global: 1,
  organization: 2,
  department: 3,
  employee: 4,
};

/**
 * The subset of an `hq_capability_grants` row the resolver reads. Structurally typed (not
 * bound to a generated DB model) so the resolver keeps no dependency on the schema module
 * and the fetch can cast the untyped HQ-internal table onto it. `budget_default` may arrive
 * as a string (Postgres `numeric`) — {@link composeGrants} coerces it.
 */
export interface GrantRow {
  scope_level: ScopeLevel;
  scope_key: string | null;
  tokens: readonly string[] | null;
  can_execute: boolean | null;
  requires_approval: boolean | null;
  memory_scope: string | null;
  budget_default: number | string | null;
}

/**
 * The authority a set of grants resolves to — the registry-resolved counterpart of the
 * legacy model's resolved authority. `source` records provenance (mirrors
 * {@link import("./tasks").ResolvedCapabilitySet}'s `source` seam): `registry` when at
 * least one grant composed it, `none` when the default-deny floor stood in.
 */
export interface ResolvedAuthority {
  readonly tokens: readonly string[];
  readonly canExecute: boolean;
  readonly requiresApproval: boolean;
  readonly budgetDefault: number | null;
  readonly memoryScope: string;
  readonly source: "registry" | "none";
}

/** The default-deny floor as a {@link ResolvedAuthority} (no grants applied). */
export const AUTHORITY_FLOOR: ResolvedAuthority = Object.freeze({
  tokens: Object.freeze([]) as readonly string[],
  canExecute: false,
  requiresApproval: true,
  budgetDefault: null,
  memoryScope: MEMORY_SCOPE_FLOOR,
  source: "none",
});

/** Coerce a `numeric` budget (which may arrive as a string) to a finite number, else null. */
function coerceBudget(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compose a set of applicable grants into the resolved authority, per the ADR 0010
 * Decision 5 inheritance law. PURE and deterministic: the same grants always yield the
 * same authority, and the result is frozen. The caller is responsible for passing ONLY
 * the grants that apply to the subject (the fetch in {@link resolveAuthorityFromRegistry}
 * does this); composeGrants applies the law over whatever it is given.
 */
export function composeGrants(grants: readonly GrantRow[]): ResolvedAuthority {
  if (grants.length === 0) return AUTHORITY_FLOOR;

  // tokens — UNION, empties dropped, sorted-distinct (a stable, comparable set).
  const tokenSet = new Set<string>();
  for (const g of grants) {
    for (const t of g.tokens ?? []) {
      if (typeof t === "string" && t.length > 0) tokenSet.add(t);
    }
  }

  // can_execute — DENY-WINS: true only if every applicable grant permits it (a missing /
  // garbage value is treated as deny, mirroring the legacy `can_execute === true`).
  const canExecute = grants.every((g) => g.can_execute === true);

  // requires_approval — the APPROVAL RATCHET: required if any grant requires it (a missing
  // / garbage value is treated as "requires", mirroring the legacy `requires_approval !==
  // false`), so approval ratchets upward and never silently weakens.
  const requiresApproval = grants.some((g) => g.requires_approval !== false);

  // budget_default — EFFECTIVE MINIMUM across scopes; NULL ceilings are ignored.
  let budgetDefault: number | null = null;
  for (const g of grants) {
    const b = coerceBudget(g.budget_default);
    if (b !== null) budgetDefault = budgetDefault === null ? b : Math.min(budgetDefault, b);
  }

  // memory_scope — MOST-SPECIFIC-WINS over the `isolated` floor.
  let memoryScope: string = MEMORY_SCOPE_FLOOR;
  let bestRank = -1;
  for (const g of grants) {
    const rank = SCOPE_RANK[g.scope_level] ?? -1;
    if (rank > bestRank && typeof g.memory_scope === "string" && g.memory_scope.length > 0) {
      memoryScope = g.memory_scope;
      bestRank = rank;
    }
  }

  return Object.freeze({
    tokens: Object.freeze([...tokenSet].sort()) as readonly string[],
    canExecute,
    requiresApproval,
    budgetDefault,
    memoryScope,
    source: "registry" as const,
  });
}

/** Keep only the grants that apply to a subject at (slug, department) across all levels. */
export function applicableGrants(
  grants: readonly GrantRow[],
  subject: { slug: string; department?: string | null },
): GrantRow[] {
  return grants.filter((g) => {
    switch (g.scope_level) {
      case "global":
        return true; // applies to everyone
      case "department":
        return subject.department != null && g.scope_key === subject.department;
      case "employee":
        return g.scope_key === subject.slug;
      case "organization":
        // No per-employee organization key exists in the legacy model (ai_employees has no
        // organization column); organization grants are authored post-migration. None are
        // matched here, so they contribute nothing — exactly the flat-mirror state R2 left.
        return false;
      default:
        return false;
    }
  });
}

/** The shape the parity comparison comments on — the dimensions the legacy model also has. */
export interface ComparableAuthority {
  readonly tokens: readonly string[];
  readonly canExecute: boolean;
  readonly requiresApproval: boolean;
  readonly memoryScope: string;
}

/** A recorded divergence between the legacy authority and the registry authority. */
export interface AuthorityDivergence {
  /** The dimensions that differ (e.g. `["tokens", "requiresApproval"]`). Never empty. */
  readonly dimensions: readonly string[];
  readonly legacy: ComparableAuthority;
  readonly registry: ComparableAuthority;
}

/** Order-independent equality of two token sets (both are expected sorted-distinct). */
function tokensEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((t) => set.has(t));
}

/**
 * Compare the legacy-resolved authority to the registry-resolved authority across the
 * dimensions the legacy model carries (tokens, can_execute, requires_approval,
 * memory_scope). Budget is excluded: the legacy model has no per-employee budget, so
 * `budget_default` is registry-only forward metadata with no legacy counterpart to verify.
 *
 * Returns the divergence (the offending dimensions) or `null` when the two are in parity.
 * PURE — this is the deterministic, runtime-callable analogue of the R2 SQL parity
 * function, and the mechanism by which the runtime "continuously verifies parity during
 * the transition" (the Behaviour Preservation Rule).
 */
export function compareAuthority(
  legacy: ComparableAuthority,
  registry: ComparableAuthority,
): AuthorityDivergence | null {
  const dimensions: string[] = [];
  if (!tokensEqual(legacy.tokens, registry.tokens)) dimensions.push("tokens");
  if (legacy.canExecute !== registry.canExecute) dimensions.push("canExecute");
  if (legacy.requiresApproval !== registry.requiresApproval) dimensions.push("requiresApproval");
  if (legacy.memoryScope !== registry.memoryScope) dimensions.push("memoryScope");
  if (dimensions.length === 0) return null;
  return { dimensions, legacy, registry };
}
