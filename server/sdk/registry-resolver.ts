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

// ---------------------------------------------------------------------
// R4 — the runtime authority switch (the serving decision, PURE)
// ---------------------------------------------------------------------

/**
 * Which source served an employee's authority — the `basis` a {@link ServingDecision}
 * records:
 *   • `registry` — the registry was authoritative and served (the steady state).
 *   • `legacy`   — the retained legacy model served as the AUTOMATIC fail-safe (the registry
 *                  read failed, or was silent for the subject).
 *
 * LR5.3 (the Rollback Independence Rule, 25th §2 standard) retired the operator rollback lever
 * (`CAPABILITY_AUTHORITY_SOURCE`), so `legacy` is no longer operator-selectable — it is reached
 * ONLY by the fail-safe, never by a deliberate rollback.
 */
export type AuthoritySource = "registry" | "legacy";

/**
 * The serving decision the runtime takes for ONE employee: which source's authority is
 * served and — when the legacy model is served — why. PURE metadata the bridge maps onto
 * the served {@link import("./tasks").ResolvedCapabilitySet} and logs for parity
 * monitoring; it carries any divergence so the monitor can report it.
 */
export interface ServingDecision {
  /** The source whose authority is served. */
  readonly basis: AuthoritySource;
  /**
   * Why the legacy model was served (only set when `basis` is `legacy`) — both reasons are the
   * AUTOMATIC fail-safe (LR5.3 retired the deliberate-rollback reason):
   *   • `error` — the registry read failed; the retained legacy model is the fail-safe.
   *   • `empty` — the registry is silent for the subject (no grants — e.g. a backfill
   *               gap); the retained legacy model stands in during the migration window.
   */
  readonly reason?: "error" | "empty";
  /**
   * The divergence between the legacy baseline and the registry authority, when the
   * registry was both authoritative and resolved with grants but disagreed. Recorded for
   * parity monitoring; `undefined` when the two are in parity or the registry was not the
   * served side.
   */
  readonly divergence?: AuthorityDivergence;
}

/**
 * Decide which source's authority to serve for one employee (ADR 0010 Decision 2; the runtime
 * authority switch). PURE and TOTAL — same inputs → same decision, no IO — so the switch's law
 * is unit-testable in isolation, exactly like {@link composeGrants}. The server-only bridge
 * supplies the IO (the registry read, the legacy resolution) and acts on the decision (see
 * server/sdk/registry-parity.ts).
 *
 * Order of precedence, each step safe by construction:
 *   1. registry read failed    → serve legacy (the fail-safe; the registry could not answer).
 *   2. registry silent (`none`)→ serve legacy (the migration-window fallthrough; no grants).
 *   3. otherwise               → serve the authoritative registry, recording any divergence
 *                                from the legacy baseline for parity monitoring.
 *
 * The registry is the SOLE authority — LR5.3 (the Rollback Independence Rule, 25th §2 standard)
 * retired the operator rollback control, so there is no deliberate path back to legacy. The
 * legacy model is RETAINED only as the AUTOMATIC fail-safe in steps 1–2, so the switch can
 * never strand an employee on a registry that is unreachable or not yet authored.
 */
export function decideServedAuthority(input: {
  /** The registry-resolved authority, or `null` when the registry read failed. */
  registry: ResolvedAuthority | null;
  legacy: ComparableAuthority;
}): ServingDecision {
  if (input.registry === null) return { basis: "legacy", reason: "error" };
  if (input.registry.source === "none") return { basis: "legacy", reason: "empty" };
  const divergence = compareAuthority(input.legacy, input.registry);
  return divergence ? { basis: "registry", divergence } : { basis: "registry" };
}

// ---------------------------------------------------------------------
// LR4 — the production-confidence law (the Bank-Confidence instrument, PURE)
// ---------------------------------------------------------------------

/**
 * The confidence classification of ONE employee's {@link ServingDecision} — the unit the
 * LR4 production-confidence sweep aggregates. Derived PURELY from the decision the runtime
 * actually takes, so the audit's verdict can never diverge from what the serve path does:
 *   • `registry-parity`    — served the registry, IN PARITY with the legacy baseline. The
 *                            ONLY confident outcome: authority is registry-sourced and the
 *                            retained legacy mirror still agrees.
 *   • `registry-divergent` — served the registry, but it DIVERGED from the legacy baseline.
 *                            Per the proposal §4.2 every divergence must be ACCOUNTED FOR
 *                            (an intended registry-native authoring change) — never silent.
 *   • `backfill-gap`       — the registry was silent for the subject (no grant), so the
 *                            retained legacy model was served. Proposal §4.4 requires this
 *                            to be ZERO before any removal: a gap means the subject still
 *                            depends on legacy.
 *   • `registry-error`     — the registry read failed; the retained legacy model was the
 *                            fail-safe. Confidence requires the registry to be reliably
 *                            readable, so this must be zero across the window.
 *
 * LR5.3 retired the deliberate-rollback outcome (`rolled-back`): with no operator rollback
 * lever, the audit can only observe the four outcomes above.
 */
export type ConfidenceOutcome =
  | "registry-parity"
  | "registry-divergent"
  | "backfill-gap"
  | "registry-error";

/**
 * Classify a serving decision into its confidence outcome (PURE, TOTAL). This is the LR4
 * read over the runtime serving law: it re-uses {@link decideServedAuthority}'s own verdict
 * rather than re-deriving authority, so a sweep measures exactly what the runtime serves.
 */
export function classifyServingConfidence(decision: ServingDecision): ConfidenceOutcome {
  if (decision.basis === "registry") {
    return decision.divergence ? "registry-divergent" : "registry-parity";
  }
  // basis === "legacy": the AUTOMATIC fail-safe — the registry was silent for the subject
  // (a backfill gap) or could not be read. (LR5.3 retired the deliberate-rollback reason.)
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
  /** Served the registry in parity (the confident outcome). */
  readonly registryParity: number;
  /** Served the registry but it diverged from legacy (must each be accounted for — §4.2). */
  readonly registryDivergent: number;
  /** Registry silent → served legacy (the backfill gaps §4.4 requires to be zero). */
  readonly backfillGaps: number;
  /** Registry read failed → served legacy fail-safe (must be zero across the window). */
  readonly registryErrors: number;
  /**
   * The §4 confidence bar as ONE boolean: EVERY employee served the registry in parity — no
   * divergence, no backfill gap, no read error. The registry-only runtime is
   * demonstrably whole at THIS instant. (The time WINDOW over which it must hold continuously
   * is operational — set by the CEO; this law measures the instant, the ops cadence measures
   * the window.) An empty roster is NOT ready — there is nothing to be confident about.
   */
  readonly registryOnlyReady: boolean;
}

/**
 * Aggregate per-employee outcomes into a {@link ConfidenceSummary} (PURE, deterministic,
 * frozen). The whole confidence verdict is a fold over the outcomes, so it is unit-testable
 * without any IO and can never drift from {@link classifyServingConfidence}.
 */
export function summarizeConfidence(outcomes: readonly ConfidenceOutcome[]): ConfidenceSummary {
  let registryParity = 0;
  let registryDivergent = 0;
  let backfillGaps = 0;
  let registryErrors = 0;
  for (const o of outcomes) {
    switch (o) {
      case "registry-parity":
        registryParity++;
        break;
      case "registry-divergent":
        registryDivergent++;
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
    registryParity,
    registryDivergent,
    backfillGaps,
    registryErrors,
    registryOnlyReady: total > 0 && registryParity === total,
  });
}
