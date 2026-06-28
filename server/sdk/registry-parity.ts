import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveEmployeeCapabilities,
  resolveEmployeePosture,
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
 * (16th — set on the R3 review).
 *
 * This is the SERVER-ONLY half of the resolver: it reads the RLS:hq registry with the
 * service-role client and bridges the legacy model to the pure composition law
 * (server/sdk/registry-resolver.ts). Three responsibilities:
 *
 *   1. {@link resolveAuthorityFromRegistry} — fetch an employee's applicable grants from
 *      `hq_capability_grants` and compose them (ADR 0010 Decision 5). The runtime capability
 *      resolver the directive calls for.
 *   2. {@link verifyRegistryParity} — the continuously-verifiable, request-path parity check:
 *      it resolves BOTH the registry authority and the legacy authority and compares them,
 *      surfacing any divergence. RETAINED through R4 as the standalone parity gate.
 *   3. {@link resolveServedCapabilities} — the R4 runtime authority SWITCH: serve the
 *      registry-resolved capabilities (the registry is now authoritative), with the legacy
 *      model retained as the fail-safe / rollback path.
 *
 * THE TRANSITION (R3 → R4). R3 stood the registry up as a continuously-verified SHADOW: the
 * legacy model stayed authoritative and was served, while {@link verifyRegistryParity} proved
 * equivalence on the request path, strictly fail-open (the Behaviour Preservation Rule). R4 is
 * the SWITCH the shadow earned (the Shadow Validation Rule): {@link resolveServedCapabilities}
 * serves the registry as the authoritative source (`ResolvedCapabilitySet.source: "registry"`),
 * folding the shadow comparison onto the very value it serves. The legacy model is RETAINED —
 * as the deliberate rollback (`CAPABILITY_AUTHORITY_SOURCE=legacy`) and the automatic fail-safe
 * (a registry read error or a subject the registry is silent about both fall back to legacy) —
 * so the switch can never strand an employee. Removal of the legacy model is a later,
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
 * The R4 runtime authority switch (CEO Directive #015 / D-05, R4): resolve the capabilities
 * to SERVE for an employee, with the Capability Registry as the AUTHORITATIVE source and the
 * legacy `ai_employees` model RETAINED as the fail-safe / rollback path.
 *
 * This is the seam the identity assembly calls in place of the bare legacy
 * {@link resolveEmployeeCapabilities}. It:
 *   • reads the `CAPABILITY_AUTHORITY_SOURCE` control (default `registry`);
 *   • on a deliberate rollback (`legacy`) serves the legacy capabilities and never touches
 *     the registry — a clean escape hatch independent of registry availability;
 *   • otherwise resolves the registry authority and CONTINUOUSLY COMPARES it to the legacy
 *     baseline (the shadow verification of the Behaviour Preservation Rule, now folded onto
 *     the very value it serves so there is no gap between what is verified and what is
 *     served), then serves the registry (`ResolvedCapabilitySet.source: "registry"`);
 *   • falls back to the retained legacy capabilities (`source: "ai_employees"`) when the
 *     registry read fails or the registry is silent for the subject (no grants — e.g. a
 *     backfill gap), so the switch can NEVER strand an employee.
 *
 * STRICTLY non-throwing: any unexpected error degrades to the legacy capabilities (the
 * platform's proven floor). Divergence and every fallback are logged for parity monitoring.
 * The decision law itself is the PURE {@link decideServedAuthority}; this function only
 * supplies the IO (the env control, the registry read) and the monitoring side effects.
 *
 * `opts.client` / `opts.control` exist for tests — they mirror
 * {@link resolveAuthorityFromRegistry}'s injectable client; production passes neither, so the
 * control is the env and the client is the service-role admin client.
 */
export async function resolveServedCapabilities(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient; control?: AuthoritySource } = {},
): Promise<ResolvedCapabilitySet> {
  const legacyCapabilities = resolveEmployeeCapabilities(emp);
  try {
    const control = opts.control ?? env.CAPABILITY_AUTHORITY_SOURCE;

    // Deliberate rollback: serve the legacy model and do not depend on the registry at all.
    if (control === "legacy") return legacyCapabilities;

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
      return Object.freeze({ tokens: registry.tokens, source: registry.source });
    }

    // Served the retained legacy model. A silent registry (`empty`) is worth a monitoring
    // line (likely a backfill gap); a deliberate rollback was handled above.
    if (decision.reason === "empty") {
      console.warn(
        `[capability-authority] registry is silent for ${emp.slug} (no grants) — serving retained legacy (migration fallthrough)`,
      );
    }
    return legacyCapabilities;
  } catch (err) {
    console.warn(
      `[capability-authority] resolution failed for ${emp?.slug ?? "?"} — serving retained legacy:`,
      err instanceof Error ? err.message : String(err),
    );
    return legacyCapabilities;
  }
}
