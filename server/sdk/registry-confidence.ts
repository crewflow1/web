import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  classifyServingConfidence,
  decideServedAuthority,
  summarizeConfidence,
  type ConfidenceOutcome,
  type ConfidenceSummary,
  type ResolvedAuthority,
} from "@/server/sdk/registry-resolver";
import {
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
 * then aggregates a measurable {@link ConfidenceSummary}. It REMOVES NOTHING, MUTATES NOTHING
 * (it must never alter authority while measuring it) and changes no served behaviour. LR4 stood
 * it up to bank the §4 confidence that AUTHORISED the removal increments; the evidence it
 * gathered is PRESERVED (the Data Removal Rule, 26th §2 standard, retains production-confidence
 * evidence). It now reads the registry-SOLE end state — LR5.4B removed the legacy columns, the
 * deterministic mirror and the shadow-parity machinery — so the sweep measures registry serving
 * HEALTH, not a shadow comparison: there is no legacy baseline left to diverge from.
 *
 * The bar this measures, as one boolean ({@link ConfidenceSummary.registryOnlyReady}): EVERY
 * employee is SERVED the registry — zero backfill gaps (a silent registry falls to the
 * default-deny floor), zero read errors. The instant is measured here; the sustained WINDOW
 * over which it must hold continuously is operational (an ops/CI cadence runs this sweep).
 */

/** The columns the resolver needs to query the registry for an employee (the roster read). */
const EMP_COLUMNS = "slug, department";

/**
 * The minimal read surface needed to enumerate the roster. `ai_employees` is a
 * service-role-only HQ internal not in the generated `Database` types, so callers cast their
 * typed client onto this (the same pattern {@link GrantReadClient} uses for the grants table).
 */
export interface RosterReadClient {
  from(table: string): {
    select(columns: string): {
      is(
        column: string,
        value: null,
      ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
}

/** Coerce a raw `ai_employees` row into the {@link LegacyEmployee} shape the resolver reads. */
function toLegacyEmployee(row: Record<string, unknown>): LegacyEmployee {
  return {
    slug: row.slug as string,
    department: (row.department as string | null) ?? null,
  };
}

/**
 * Read the live roster in the {@link LegacyEmployee} shape. THROWS on a query error — unlike
 * the per-employee registry read (which is a measured confidence signal), a roster-read
 * failure means the instrument could not run at all, and an audit that silently reports
 * "nothing to see" when it could not read anything would be worse than loud failure.
 */
async function readRoster(client: RosterReadClient): Promise<LegacyEmployee[]> {
  // Retirement (20261222) is TERMINAL at the DB — a retired row refuses every
  // update, so it can never transition to a working state; the floor is its
  // correct, permanent posture. The audit therefore sweeps the OPERABLE roster:
  // a retired identity is decommissioned history, not a registry gap.
  const res = await client.from("ai_employees").select(EMP_COLUMNS).is("retired_at", null);
  if (res.error) throw new Error(`[registry-confidence] roster read failed: ${res.error.message}`);
  return ((res.data ?? []) as Record<string, unknown>[]).map(toLegacyEmployee);
}

/** One employee's confidence verdict in the sweep. */
export interface EmployeeConfidence {
  readonly slug: string;
  readonly outcome: ConfidenceOutcome;
}

/** The full production-confidence report: the aggregate signal plus the per-employee detail. */
export interface RegistryConfidenceReport {
  /** The measurable aggregate — the §4 confidence signal. */
  readonly summary: ConfidenceSummary;
  /** Every employee's verdict, so a backfill gap or read error can be named and accounted for (§4.2). */
  readonly employees: readonly EmployeeConfidence[];
}

/**
 * Sweep the roster and produce the production-confidence report (LR4 / Legacy Removal Proposal
 * C4). For each employee it resolves the registry authority (fail-soft to a read error, which
 * is itself a measured signal) and runs the PURE serving decision to classify the outcome —
 * exactly what the serve path would do for that employee.
 *
 * READ-ONLY and side-effect-free: it issues only `.select()`/`.or()` reads (never writes the
 * grants — you must not mutate authority while measuring it). A per-employee registry-read
 * failure is CAUGHT and classified as `registry-error` (evidence, not an exception); only a
 * roster-read failure throws (the instrument could not run).
 *
 * `opts` mirrors {@link import("./registry-parity").resolveServedAuthority}'s injectable
 * seams: production passes none (the clients are the service-role admin client, the roster is
 * read live); tests inject `roster` / `client`.
 */
export async function auditRegistryConfidence(
  opts: {
    roster?: readonly LegacyEmployee[];
    client?: GrantReadClient;
  } = {},
): Promise<RegistryConfidenceReport> {
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

    const decision = decideServedAuthority({ registry });
    const outcome = classifyServingConfidence(decision);
    employees.push({ slug: emp.slug, outcome });
  }

  return Object.freeze({
    summary: summarizeConfidence(employees.map((e) => e.outcome)),
    employees: Object.freeze(employees),
  });
}
