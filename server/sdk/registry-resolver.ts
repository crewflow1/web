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
 * EVOLUTION (R3 → LR5.4B). R3 stood this resolver up as a continuously-verified SHADOW of the
 * legacy model (the Behaviour Preservation Rule); R4/LR3 switched the runtime to serve it; LR5.4A
 * migrated the last hidden SQL reader (hq_memory_write) onto the registry; and LR5.4B — the FINAL
 * removal increment, authorised under the Legacy Independence Rule (28th §2 standard: physical
 * legacy structures may be removed only once completely independent of runtime execution) and
 * sequenced last by the Data Removal Rule (26th) — removed the legacy authority columns and the
 * shadow-comparison machinery entirely. The registry is now the SOLE source of served authority:
 * there is no legacy baseline left to compare against, and the runtime fail-safe is the
 * default-deny floor below ({@link AUTHORITY_FLOOR}), reached only when the registry cannot be
 * read or is silent for a subject — never a fallback to a legacy model.
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

// ---------------------------------------------------------------------
// R4 → LR5.4B — the runtime authority switch (the serving decision, PURE)
// ---------------------------------------------------------------------

/**
 * Which source served an employee's authority — the `basis` a {@link ServingDecision}
 * records:
 *   • `registry` — the registry was authoritative and served (the steady state).
 *   • `floor`    — the default-deny floor ({@link AUTHORITY_FLOOR}) served as the AUTOMATIC
 *                  fail-safe (the registry read failed, or was silent for the subject).
 *
 * LR5.4B (the Data Removal Rule, 26th §2 standard) removed the legacy authority columns, so the
 * fail-safe is no longer a legacy model — it is the safe default-deny floor. (LR5.3 had already
 * retired the operator rollback lever, so `floor` is reached ONLY by the automatic fail-safe.)
 */
export type AuthoritySource = "registry" | "floor";

/**
 * The serving decision the runtime takes for ONE employee: which source's authority is served
 * and — when the floor is served — why. PURE metadata the bridge maps onto the served
 * {@link import("./tasks").ResolvedCapabilitySet} and logs for fail-safe monitoring.
 */
export interface ServingDecision {
  /** The source whose authority is served. */
  readonly basis: AuthoritySource;
  /**
   * Why the default-deny floor was served (only set when `basis` is `floor`) — both reasons are
   * the AUTOMATIC fail-safe:
   *   • `error` — the registry read failed; the floor is the fail-safe.
   *   • `empty` — the registry is silent for the subject (no grants — e.g. a backfill gap); the
   *               floor stands in. Confidence (§4.4) requires this to be ZERO before removal.
   */
  readonly reason?: "error" | "empty";
}

/**
 * Decide which source's authority to serve for one employee (ADR 0010 Decision 2; the runtime
 * authority switch). PURE and TOTAL — same inputs → same decision, no IO — so the switch's law
 * is unit-testable in isolation, exactly like {@link composeGrants}. The server-only bridge
 * supplies the IO (the registry read) and acts on the decision (see server/sdk/registry-parity.ts).
 *
 * Order of precedence, each step safe by construction:
 *   1. registry read failed     → serve the floor (the fail-safe; the registry could not answer).
 *   2. registry silent (`none`) → serve the floor (the migration-window fallthrough; no grants).
 *   3. otherwise                → serve the authoritative registry.
 *
 * The registry is the SOLE authority. LR5.3 retired the operator rollback control and LR5.4B
 * removed the legacy columns, so there is no path back to a legacy model: the fail-safe in
 * steps 1–2 is the default-deny floor, which can never strand an employee on a registry that is
 * unreachable or not yet authored (it denies by default, the safe stance).
 */
export function decideServedAuthority(input: {
  /** The registry-resolved authority, or `null` when the registry read failed. */
  registry: ResolvedAuthority | null;
}): ServingDecision {
  if (input.registry === null) return { basis: "floor", reason: "error" };
  if (input.registry.source === "none") return { basis: "floor", reason: "empty" };
  return { basis: "registry" };
}

// ---------------------------------------------------------------------
// LR4 — the production-confidence law (the Bank-Confidence instrument, PURE)
// ---------------------------------------------------------------------

/**
 * The confidence classification of ONE employee's {@link ServingDecision} — the unit the
 * LR4 production-confidence sweep aggregates. Derived PURELY from the decision the runtime
 * actually takes, so the audit's verdict can never diverge from what the serve path does:
 *   • `registry-served` — served the registry (the steady state). The ONLY confident outcome:
 *                         authority is registry-sourced. LR5.4B removed the legacy baseline, so
 *                         there is no longer a parity-vs-divergent distinction to draw — being
 *                         served by the registry IS the confidence signal.
 *   • `backfill-gap`    — the registry was silent for the subject (no grant), so the default-deny
 *                         floor was served. Proposal §4.4 requires this to be ZERO before any
 *                         removal: a gap means the subject would be stranded on the floor.
 *   • `registry-error`  — the registry read failed; the default-deny floor was the fail-safe.
 *                         Confidence requires the registry to be reliably readable, so this must
 *                         be zero across the window.
 *
 * LR5.4B (the Data Removal Rule) collapsed the former `registry-parity` / `registry-divergent`
 * pair into the single `registry-served`: with the legacy columns gone there is nothing to
 * compare the registry against, so the audit measures registry-only HEALTH, not parity.
 */
export type ConfidenceOutcome = "registry-served" | "backfill-gap" | "registry-error";

/**
 * Classify a serving decision into its confidence outcome (PURE, TOTAL). This is the LR4
 * read over the runtime serving law: it re-uses {@link decideServedAuthority}'s own verdict
 * rather than re-deriving authority, so a sweep measures exactly what the runtime serves.
 */
export function classifyServingConfidence(decision: ServingDecision): ConfidenceOutcome {
  if (decision.basis === "registry") return "registry-served";
  // basis === "floor": the AUTOMATIC fail-safe — the registry was silent for the subject
  // (a backfill gap) or could not be read.
  return decision.reason === "empty" ? "backfill-gap" : "registry-error";
}

/**
 * The aggregate confidence of a roster sweep — the measurable signal the proposal §4
 * ("Production-confidence requirements") and the Compatibility Layer Rule's "measurable exit
 * criteria" / "continuous parity validation" attributes require, so the observation window
 * is MEASURED, not merely elapsed.
 */
export interface ConfidenceSummary {
  /** Employees swept. */
  readonly total: number;
  /** Served the registry (the confident outcome). */
  readonly registryServed: number;
  /** Registry silent → served the floor (the backfill gaps §4.4 requires to be zero). */
  readonly backfillGaps: number;
  /** Registry read failed → served the floor fail-safe (must be zero across the window). */
  readonly registryErrors: number;
  /**
   * The §4 confidence bar as ONE boolean: EVERY employee served the registry — no backfill gap,
   * no read error. The registry-only runtime is demonstrably whole at THIS instant. (The time
   * WINDOW over which it must hold continuously is operational — set by the CEO; this law
   * measures the instant, the ops cadence measures the window.) An empty roster is NOT ready —
   * there is nothing to be confident about.
   */
  readonly registryOnlyReady: boolean;
}

/**
 * Aggregate per-employee outcomes into a {@link ConfidenceSummary} (PURE, deterministic,
 * frozen). The whole confidence verdict is a fold over the outcomes, so it is unit-testable
 * without any IO and can never drift from {@link classifyServingConfidence}.
 */
export function summarizeConfidence(outcomes: readonly ConfidenceOutcome[]): ConfidenceSummary {
  let registryServed = 0;
  let backfillGaps = 0;
  let registryErrors = 0;
  for (const o of outcomes) {
    switch (o) {
      case "registry-served":
        registryServed++;
        break;
      case "backfill-gap":
        backfillGaps++;
        break;
      case "registry-error":
        registryErrors++;
        break;
    }
  }
  const total = outcomes.length;
  return Object.freeze({
    total,
    registryServed,
    backfillGaps,
    registryErrors,
    registryOnlyReady: total > 0 && registryServed === total,
  });
}
