import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEMORY_SCOPES, type MemoryScope } from "@/lib/ai-employees/model";
import {
  resolveEmployeeCapabilities,
  resolveEmployeePosture,
  type EmploymentPosture,
  type ResolvedCapabilitySet,
} from "@/server/sdk/tasks";
import {
  applicableGrants,
  compareAuthority,
  composeGrants,
  decideServedAuthority,
  MEMORY_SCOPE_FLOOR,
  type AuthorityDivergence,
  type AuthoritySource,
  type ComparableAuthority,
  type GrantRow,
  type ResolvedAuthority,
} from "@/server/sdk/registry-resolver";

/**
 * CrewFlow HQ — The Capability Registry, R3+R4: the runtime authority bridge (the IO seam).
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md.
 * Governing rules: the Single Source of Authority Rule (13th §2 standard), the Migration
 * Parity Rule (14th), the Behaviour Preservation Rule (15th), the Shadow Validation Rule
 * (16th — set on the R3 review), and the Registry Completeness Rule (20th — set on the LR2
 * review), whose SERVING clause this increment (LR3) advances.
 *
 * This is the SERVER-ONLY half of the resolver: it reads the RLS:hq registry with the
 * service-role client and bridges the legacy model to the pure composition law
 * (server/sdk/registry-resolver.ts). Four responsibilities:
 *
 *   1. {@link resolveAuthorityFromRegistry} — fetch an employee's applicable grants from
 *      `hq_capability_grants` and compose them (ADR 0010 Decision 5). The runtime capability
 *      resolver the directive calls for.
 *   2. {@link verifyRegistryParity} — the continuously-verifiable, request-path parity check:
 *      it resolves BOTH the registry authority and the legacy authority and compares them,
 *      surfacing any divergence. RETAINED through R4 + LR3 as the standalone parity gate.
 *   3. {@link resolveServedAuthority} — the LR3 runtime authority SWITCH: serve EVERY authority
 *      dimension (tokens, posture AND memory scope) from the now-authoritative registry, with
 *      the legacy model retained as the fail-safe / rollback path.
 *   4. {@link resolveServedCapabilities} — the R4 capabilities projection of that switch,
 *      RETAINED as the focused tokens-only seam (it delegates to {@link resolveServedAuthority}).
 *
 * THE TRANSITION (R3 → R4 → LR3). R3 stood the registry up as a continuously-verified SHADOW:
 * the legacy model stayed authoritative and was served, while {@link verifyRegistryParity}
 * proved equivalence on the request path, strictly fail-open (the Behaviour Preservation Rule).
 * R4 was the SWITCH the shadow earned (the Shadow Validation Rule) — but only for TOKENS: it
 * served the registry's tokens while the bridge still discarded the registry-resolved posture
 * and memory scope, so the identity served those two from the legacy model. LR3 closes that gap
 * — the last runtime READ paths still depending on legacy authority — by serving every
 * dimension from the ONE source the decision chooses ({@link resolveServedAuthority}), folding
 * the shadow comparison onto all four served dimensions. The legacy model is RETAINED — as the
 * deliberate rollback (`CAPABILITY_AUTHORITY_SOURCE=legacy`) and the automatic fail-safe (a
 * registry read error or a subject the registry is silent about both fall back to legacy) — so
 * the switch can never strand an employee. Removal of the legacy model is a later,
 * separately-authorised phase, not this one.
 */

/** The columns the resolver reads from `hq_capability_grants`. */
const GRANT_COLUMNS =
  "scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope, budget_default";

/** A safe scope-key shape for the PostgREST `or` filter (controlled identifiers only). */
const SAFE_KEY = /^[a-z0-9_-]+$/i;

type GrantQueryResult = { data: GrantRow[] | null; error: { message: string } | null };
interface GrantSelect extends PromiseLike<GrantQueryResult> {
  or(filter: string): PromiseLike<GrantQueryResult>;
}
/**
 * The minimal read surface the resolver needs. `hq_capability_grants` is a service-role-only
 * HQ internal not in the generated `Database` types, so callers cast their typed client onto
 * this (the same pattern the R1/R2 suites use).
 */
export interface GrantReadClient {
  from(table: string): { select(columns: string): GrantSelect };
}

/** The structural slice of an `ai_employees` row the parity bridge reads. */
export interface LegacyEmployee {
  slug: string;
  department?: string | null;
  tools_allowed?: readonly string[] | null;
  permissions?: {
    scopes?: readonly string[] | null;
    can_execute?: boolean | null;
    requires_approval?: boolean | null;
  } | null;
  memory_scope?: string | null;
}

/**
 * Resolve an employee's authority FROM the registry: fetch the grants applicable to the
 * subject across all scope levels (global ∪ department ∪ employee — organization carries no
 * per-employee key in the legacy model and is empty until post-migration authoring) and
 * compose them per ADR 0010 Decision 5. Throws on a query error (the caller fails open).
 */
export async function resolveAuthorityFromRegistry(
  client: GrantReadClient,
  subject: { slug: string; department?: string | null },
): Promise<ResolvedAuthority> {
  const clauses = ["scope_level.eq.global"];
  if (SAFE_KEY.test(subject.slug)) {
    clauses.push(`and(scope_level.eq.employee,scope_key.eq.${subject.slug})`);
  }
  if (subject.department && SAFE_KEY.test(subject.department)) {
    clauses.push(`and(scope_level.eq.department,scope_key.eq.${subject.department})`);
  }

  const res = await client.from("hq_capability_grants").select(GRANT_COLUMNS).or(clauses.join(","));
  if (res.error) throw new Error(res.error.message);

  // The .or already narrows to the subject's scopes; applicableGrants is a deterministic
  // backstop so composition never sees a row that does not apply.
  return composeGrants(applicableGrants((res.data ?? []) as GrantRow[], subject));
}

/**
 * The legacy model's resolved authority for an employee, expressed in the comparable shape.
 * Reuses the canonical legacy resolvers ({@link resolveEmployeeCapabilities} /
 * {@link resolveEmployeePosture}) so the legacy side of the comparison can never drift from
 * what the runtime actually enforces today (the Single Source of Authority Rule).
 */
export function legacyAuthorityOf(emp: LegacyEmployee): ComparableAuthority {
  const caps = resolveEmployeeCapabilities(emp);
  const posture = resolveEmployeePosture(emp);
  const memoryScope =
    typeof emp.memory_scope === "string" && emp.memory_scope.length > 0
      ? emp.memory_scope
      : MEMORY_SCOPE_FLOOR;
  return {
    tokens: caps.tokens,
    canExecute: posture.canExecute,
    requiresApproval: posture.requiresApproval,
    memoryScope,
  };
}

/** The outcome of a runtime parity check. `ok` is true in parity OR when skipped fail-open. */
export interface RegistryParityOutcome {
  ok: boolean;
  /** True when the check could not run and was failed open (legacy unaffected). */
  skipped?: boolean;
  /** The divergence, when the registry authority disagreed with the legacy authority. */
  divergence?: AuthorityDivergence;
}

/**
 * Continuously verify, on the request path, that the registry resolves to the SAME authority
 * the legacy model does for this employee — the runtime analogue of the R2 SQL parity gate
 * (the Behaviour Preservation Rule's "the runtime itself proves equivalence").
 *
 * STRICTLY FAIL-OPEN and side-effect-free beyond a log line: it never throws, never mutates
 * the identity, and never feeds `ctx`. The legacy authority remains authoritative regardless
 * of the outcome; a divergence or error only costs this tick's verification (and a warning).
 */
export async function verifyRegistryParity(emp: LegacyEmployee): Promise<RegistryParityOutcome> {
  try {
    const client = createAdminClient() as unknown as GrantReadClient;
    const registry = await resolveAuthorityFromRegistry(client, {
      slug: emp.slug,
      department: emp.department,
    });
    const legacy = legacyAuthorityOf(emp);
    const divergence = compareAuthority(legacy, registry);
    if (divergence) {
      console.warn(
        `[registry-parity] divergence for ${emp.slug} on ${divergence.dimensions.join(
          ", ",
        )} — legacy stays authoritative (Behaviour Preservation Rule)`,
      );
      return { ok: false, divergence };
    }
    return { ok: true };
  } catch (err) {
    console.warn(
      `[registry-parity] check skipped for ${emp?.slug ?? "?"} (fail-open):`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: true, skipped: true };
  }
}

/**
 * The FULL authority served for an employee — tokens, posture AND memory scope, EVERY
 * dimension resolved from the ONE source the serving decision chose. The pure resolver
 * already composes all of them ({@link composeGrants} → {@link ResolvedAuthority}); LR3 stops
 * the bridge discarding the posture and memory scope it used to drop (R4 served tokens only).
 */
export interface ServedAuthority {
  /** The opaque capability tokens (the R4 dimension). */
  readonly capabilities: ResolvedCapabilitySet;
  /** The coarse autonomy stance the doorman reads as layer 1 (the LR3 dimension). */
  readonly posture: EmploymentPosture;
  /** The memory scope the memory facet binds to (the LR3 dimension; informational). */
  readonly memoryScope: MemoryScope;
  /** Which side served every dimension above — the registry, or the retained legacy model. */
  readonly source: "registry" | "ai_employees";
}

/** Coerce a raw memory_scope string to the {@link MemoryScope} vocabulary, else the floor. */
function coerceMemoryScope(value: string | null | undefined): MemoryScope {
  return value != null && (MEMORY_SCOPES as readonly string[]).includes(value)
    ? (value as MemoryScope)
    : MEMORY_SCOPE_FLOOR;
}

/**
 * The legacy model's FULL served authority for an employee, in the served shape — the
 * retained fallback EVERY non-registry branch returns (rollback, registry read error, a
 * silent registry, or an unexpected failure). Reuses the canonical legacy resolvers
 * ({@link resolveEmployeeCapabilities} / {@link resolveEmployeePosture}) so the fallback can
 * never drift from what the runtime enforces today (the Single Source of Authority Rule),
 * with memory_scope coerced to the vocabulary over the safe `isolated` floor.
 */
function legacyServedAuthority(emp: LegacyEmployee): ServedAuthority {
  return Object.freeze({
    capabilities: resolveEmployeeCapabilities(emp),
    posture: resolveEmployeePosture(emp),
    memoryScope: coerceMemoryScope(emp.memory_scope),
    source: "ai_employees" as const,
  });
}

/**
 * The LR3 runtime authority switch (CEO Directive #015 / D-05, Legacy Removal increment 3):
 * resolve the FULL authority to SERVE for an employee — tokens, posture AND memory scope —
 * with the Capability Registry as the AUTHORITATIVE source and the legacy `ai_employees`
 * model RETAINED as the fail-safe / rollback path.
 *
 * This is the seam the identity assembly calls in place of the bare legacy resolvers. R4
 * switched TOKENS to the registry but the bridge still discarded the registry-resolved
 * posture and memory scope, so the identity served those two from the legacy model (posture
 * defaulted to the locked floor; memory scope to the legacy column). LR3 closes that gap by
 * serving every dimension from the ONE source {@link decideServedAuthority} chooses — tokens,
 * posture and memory scope therefore come from the same side coherently; the registry can
 * never serve tokens while the legacy model serves posture. It:
 *   • reads the `CAPABILITY_AUTHORITY_SOURCE` control (default `registry`);
 *   • on a deliberate rollback (`legacy`) serves the retained legacy authority and never
 *     touches the registry — a clean escape hatch independent of registry availability;
 *   • otherwise resolves the registry authority and CONTINUOUSLY COMPARES it to the legacy
 *     baseline (the shadow verification of the Behaviour Preservation Rule, now folded onto
 *     ALL FOUR served dimensions, not just tokens), then serves the registry;
 *   • falls back to the retained legacy authority when the registry read fails or the registry
 *     is silent for the subject (no grants — e.g. a backfill gap), so the switch can NEVER
 *     strand an employee.
 *
 * BEHAVIOUR-PRESERVING at the cut: while the R2 flat mirror holds, the registry resolves to
 * the same authority as the legacy model, so the served posture equals the legacy posture (the
 * locked floor for the execution-locked reference employees — Directive 001) and the served
 * memory scope equals the legacy column. Memory scope on the identity is informational (the
 * memory SQL still enforces server-side off the deterministically-mirrored legacy column);
 * serving it from the registry only makes that informational field agree with the grant.
 *
 * STRICTLY non-throwing: any unexpected error degrades to the retained legacy authority (the
 * platform's proven floor). Divergence and every fallback are logged for parity monitoring.
 * The decision law itself is the PURE {@link decideServedAuthority}; this function only
 * supplies the IO (the env control, the registry read) and the monitoring side effects.
 *
 * `opts.client` / `opts.control` exist for tests — they mirror
 * {@link resolveAuthorityFromRegistry}'s injectable client; production passes neither, so the
 * control is the env and the client is the service-role admin client.
 */
export async function resolveServedAuthority(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient; control?: AuthoritySource } = {},
): Promise<ServedAuthority> {
  const legacy = legacyServedAuthority(emp);
  try {
    const control = opts.control ?? env.CAPABILITY_AUTHORITY_SOURCE;

    // Deliberate rollback: serve the legacy model and do not depend on the registry at all.
    if (control === "legacy") return legacy;

    // Registry authoritative: resolve it (fail-open to null), then let the pure law decide.
    let registry: ResolvedAuthority | null = null;
    try {
      const client = opts.client ?? (createAdminClient() as unknown as GrantReadClient);
      registry = await resolveAuthorityFromRegistry(client, {
        slug: emp.slug,
        department: emp.department,
      });
    } catch (err) {
      console.warn(
        `[capability-authority] registry read failed for ${emp.slug} — serving retained legacy (fail-safe):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    const decision = decideServedAuthority({ control, registry, legacy: legacyAuthorityOf(emp) });

    if (decision.basis === "registry" && registry) {
      if (decision.divergence) {
        console.warn(
          `[capability-authority] registry authoritative for ${emp.slug} but DIVERGES from the legacy baseline on ${decision.divergence.dimensions.join(
            ", ",
          )} — serving the registry (legacy retained for rollback)`,
        );
      }
      // Serve EVERY dimension from the registry: tokens (R4), posture and memory scope (LR3).
      return Object.freeze({
        capabilities: Object.freeze({ tokens: registry.tokens, source: registry.source }),
        posture: Object.freeze({
          canExecute: registry.canExecute,
          requiresApproval: registry.requiresApproval,
        }),
        memoryScope: coerceMemoryScope(registry.memoryScope),
        source: "registry" as const,
      });
    }

    // Served the retained legacy model. A silent registry (`empty`) is worth a monitoring
    // line (likely a backfill gap); a deliberate rollback was handled above.
    if (decision.reason === "empty") {
      console.warn(
        `[capability-authority] registry is silent for ${emp.slug} (no grants) — serving retained legacy (migration fallthrough)`,
      );
    }
    return legacy;
  } catch (err) {
    console.warn(
      `[capability-authority] resolution failed for ${emp?.slug ?? "?"} — serving retained legacy:`,
      err instanceof Error ? err.message : String(err),
    );
    return legacy;
  }
}

/**
 * The R4 capabilities projection of the {@link resolveServedAuthority} switch — RETAINED as
 * the focused "served capabilities" seam (the tokens dimension only). It delegates to the full
 * switch and returns its `capabilities`, so the registry / rollback / fail-safe discipline is
 * defined in exactly ONE place and the tokens served here can never diverge from the tokens
 * the full authority serves. `opts.client` / `opts.control` exist for tests.
 */
export async function resolveServedCapabilities(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient; control?: AuthoritySource } = {},
): Promise<ResolvedCapabilitySet> {
  return (await resolveServedAuthority(emp, opts)).capabilities;
}
