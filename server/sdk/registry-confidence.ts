import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  classifyServingConfidence,
  decideServedAuthority,
  summarizeConfidence,
  type AuthoritySource,
  type ConfidenceOutcome,
  type ConfidenceSummary,
  type ResolvedAuthority,
} from "@/server/sdk/registry-resolver";
import {
  legacyAuthorityOf,
  resolveAuthorityFromRegistry,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";

/**
 * CrewFlow HQ — The Capability Registry, LR4: the production-confidence audit (the
 * Bank-Confidence instrument).
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 4. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing rules: the Rollback Readiness
 * Rule (17th §2 standard — "confidence is sustained production stability, not a single green
 * deploy"), the Shadow Validation Rule (16th — the shadow that earned the switch is the
 * instrument that now banks confidence), and the **Compatibility Layer Rule** (21st — set on
 * the LR3 review), whose "measurable exit criteria" and "continuous parity validation"
 * attributes this instrument makes concrete. It implements the Legacy Removal Proposal's
 * **C4 — "Bank production confidence (§4)"** increment (docs/bible/governance/
 * directive-015-legacy-removal-proposal.md §4, §6-C4): the deliberate confidence-banking
 * phase that gates EVERY removal increment (C5+).
 *
 * WHAT THIS IS — and what it is NOT. This is a READ-ONLY observability instrument: a roster
 * sweep that, for every live employee, runs the SAME pure serving decision the runtime serves
 * ({@link decideServedAuthority}) and classifies the outcome ({@link classifyServingConfidence}),
 * then aggregates a measurable {@link ConfidenceSummary}. It makes the §4 window MEASURED, not
 * merely elapsed. It REMOVES NOTHING, MUTATES NOTHING (it must never alter authority while
 * measuring it), and changes no served behaviour — the legacy columns, the deterministic
 * mirror, the rollback control, and the parity verification all remain exactly as LR3 left
 * them. Removal of any of those is a later, separately-authorised phase (C5–C7), which LR4
 * only prepares the EVIDENCE for; it does not begin it.
 *
 * The §4 bar this measures, as one boolean ({@link ConfidenceSummary.registryOnlyReady}):
 * EVERY employee is served the registry IN PARITY — zero divergence, zero backfill gaps
 * (§4.4), zero read errors, zero rollback. The instant is measured here; the sustained
 * WINDOW over which it must hold continuously is operational (the CEO sets the duration —
 * proposal §9 fork B) and is gathered by running this sweep on an ops/CI cadence.
 */

/** The columns the legacy resolver needs to resolve an employee's authority (the roster read). */
const EMP_COLUMNS = "slug, department, tools_allowed, permissions, memory_scope";

/**
 * The minimal read surface needed to enumerate the roster. `ai_employees` is a
 * service-role-only HQ internal not in the generated `Database` types, so callers cast their
 * typed client onto this (the same pattern {@link GrantReadClient} uses for the grants table).
 */
export interface RosterReadClient {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
}

/** Coerce a raw `ai_employees` row into the {@link LegacyEmployee} shape the resolver reads. */
function toLegacyEmployee(row: Record<string, unknown>): LegacyEmployee {
  return {
    slug: row.slug as string,
    department: (row.department as string | null) ?? null,
    tools_allowed: (row.tools_allowed as string[] | null) ?? null,
    permissions: (row.permissions as LegacyEmployee["permissions"]) ?? null,
    memory_scope: (row.memory_scope as string | null) ?? null,
  };
}

/**
 * Read the live roster in the {@link LegacyEmployee} shape. THROWS on a query error — unlike
 * the per-employee registry read (which is a measured confidence signal), a roster-read
 * failure means the instrument could not run at all, and an audit that silently reports
 * "nothing to see" when it could not read anything would be worse than loud failure.
 */
async function readRoster(client: RosterReadClient): Promise<LegacyEmployee[]> {
  const res = await client.from("ai_employees").select(EMP_COLUMNS);
  if (res.error) throw new Error(`[registry-confidence] roster read failed: ${res.error.message}`);
  return ((res.data ?? []) as Record<string, unknown>[]).map(toLegacyEmployee);
}

/** One employee's confidence verdict in the sweep. */
export interface EmployeeConfidence {
  readonly slug: string;
  readonly outcome: ConfidenceOutcome;
  /** The divergent dimensions, present only when `outcome` is `registry-divergent`. */
  readonly divergence?: readonly string[];
}

/** The full production-confidence report: the aggregate signal plus the per-employee detail. */
export interface RegistryConfidenceReport {
  /** Which source the sweep measured against (the env control, or an injected override). */
  readonly control: AuthoritySource;
  /** The measurable aggregate — the §4 confidence signal. */
  readonly summary: ConfidenceSummary;
  /** Every employee's verdict, so a divergence or gap can be named and accounted for (§4.2). */
  readonly employees: readonly EmployeeConfidence[];
}

/**
 * Sweep the roster and produce the production-confidence report (LR4 / Legacy Removal Proposal
 * C4). For each employee it resolves the registry authority (fail-soft to a read error, which
 * is itself a measured signal), composes the legacy baseline via the canonical legacy resolver
 * ({@link legacyAuthorityOf}, so the comparison can never drift from what the runtime
 * enforces), and runs the PURE serving decision to classify the outcome — exactly what the
 * serve path would do for that employee.
 *
 * READ-ONLY and side-effect-free: it issues only `.select()`/`.or()` reads (never writes the
 * mirror, the grants, or the legacy columns — you must not mutate authority while measuring
 * it). A per-employee registry-read failure is CAUGHT and classified as `registry-error`
 * (evidence, not an exception); only a roster-read failure throws (the instrument could not
 * run).
 *
 * `opts` mirrors {@link import("./registry-parity").resolveServedAuthority}'s injectable
 * seams: production passes none (the control is the env, the clients are the service-role
 * admin client, the roster is read live); tests inject `roster` / `client` / `control`.
 */
export async function auditRegistryConfidence(
  opts: {
    roster?: readonly LegacyEmployee[];
    client?: GrantReadClient;
    control?: AuthoritySource;
  } = {},
): Promise<RegistryConfidenceReport> {
  const control = opts.control ?? env.CAPABILITY_AUTHORITY_SOURCE;

  // One admin client serves both reads when not injected; skip it entirely if both are given.
  const admin = !opts.roster || !opts.client ? createAdminClient() : null;
  const grantClient = opts.client ?? (admin as unknown as GrantReadClient);
  const roster = opts.roster ?? (await readRoster(admin as unknown as RosterReadClient));

  const employees: EmployeeConfidence[] = [];
  for (const emp of roster) {
    // Resolve the registry authority; a read failure becomes `null` → the serving law
    // classifies it `error` (a measured fail-safe), never an abort of the sweep.
    let registry: ResolvedAuthority | null = null;
    try {
      registry = await resolveAuthorityFromRegistry(grantClient, {
        slug: emp.slug,
        department: emp.department,
      });
    } catch {
      registry = null;
    }

    const decision = decideServedAuthority({ control, registry, legacy: legacyAuthorityOf(emp) });
    const outcome = classifyServingConfidence(decision);
    employees.push(
      decision.divergence
        ? { slug: emp.slug, outcome, divergence: decision.divergence.dimensions }
        : { slug: emp.slug, outcome },
    );
  }

  return Object.freeze({
    control,
    summary: summarizeConfidence(employees.map((e) => e.outcome)),
    employees: Object.freeze(employees),
  });
}
