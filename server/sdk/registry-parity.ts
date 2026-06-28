import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveEmployeeCapabilities, resolveEmployeePosture } from "@/server/sdk/tasks";
import {
  applicableGrants,
  compareAuthority,
  composeGrants,
  MEMORY_SCOPE_FLOOR,
  type AuthorityDivergence,
  type ComparableAuthority,
  type GrantRow,
  type ResolvedAuthority,
} from "@/server/sdk/registry-resolver";

/**
 * CrewFlow HQ — The Capability Registry, R3: the runtime parity bridge (the IO seam).
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md.
 * Governing rules: the Single Source of Authority Rule (13th §2 standard), the Migration
 * Parity Rule (14th), the Behaviour Preservation Rule (15th).
 *
 * This is the SERVER-ONLY half of the resolver: it reads the RLS:hq registry with the
 * service-role client and bridges the legacy model to the pure composition law
 * (server/sdk/registry-resolver.ts). Two responsibilities:
 *
 *   1. {@link resolveAuthorityFromRegistry} — fetch an employee's applicable grants from
 *      `hq_capability_grants` and compose them (ADR 0010 Decision 5). This is the runtime
 *      capability resolver the directive calls for.
 *   2. {@link verifyRegistryParity} — the continuously-verifiable, request-path parity
 *      check the Behaviour Preservation Rule mandates: it resolves BOTH the registry
 *      authority and the legacy authority and compares them, surfacing any divergence.
 *
 * BEHAVIOUR PRESERVATION (read before wiring this anywhere). R3 introduces this resolver
 * but changes NO externally observable behaviour. {@link verifyRegistryParity} is a
 * SHADOW: it never mutates identity, never feeds `ctx`, and is strictly FAIL-OPEN — any
 * error (missing env, RLS, transport, a divergence) is logged and swallowed, so the legacy
 * authority path (which stays authoritative) is never disturbed. The behavioural transition
 * — serving authority FROM the registry (`ResolvedCapabilitySet.source: "registry"`) — is a
 * later, separately-authorised slice (R4), not this one.
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
