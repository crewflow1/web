import "server-only";

/**
 * CrewFlow HQ — Sales AI lead-sourcing runner (roadmap atom R088, "P5 Sales AI"
 * residual: autonomous lead sourcing).
 *
 * Until now HQ prospect companies entered the Sales AI database ONLY through
 * manual `createCompany` (hq-sales.ts) — there was no sourcing task type. This
 * runner gives the Sales AI a weekly `lead_sourcing` task on the generic Task
 * Engine that, WHEN the Companies House credential is configured, pulls
 * candidate UK construction companies off the public register and records them
 * as NEW prospects through the existing sanctioned write door. It owns NO
 * tables — the canonical runner SDK drives the lifecycle (the Reference
 * Employee Rule), exactly like the other roster-worker runners.
 *
 * DARK BY CONSTRUCTION (the standing CEO doctrine — gated features are built
 * dark; activation is a config flip, never a code change):
 *   • The ONLY gate is the same credential the Research AI's adapter already
 *     honours: `COMPANIES_HOUSE_API_KEY` (research-fetch.ts). With no key set
 *     — which is the state today — the handler refuses BEFORE any fetch and
 *     COMPLETES the task with the honest dark outcome
 *     `{ sourced: 0, dark: true, reason: "companies-house key not configured" }`.
 *     Zero companies are sourced and the artifact says so; nothing is
 *     fabricated, nothing is fetched, nothing errors.
 *   • Setting the key is the whole activation switch. No code path changes.
 *
 * Honesty + safety:
 *   • DETERMINISTIC, no LLM: the query is a fixed, documented derivation — the
 *     UK register (Companies House is inherently the qualification rubric's UK
 *     territory gate, lib/qualification/criteria.ts `territoryOf`) filtered to
 *     the construction sector as the OFFICIAL UK SIC 2007 Section F code list
 *     (divisions 41–43 — the same sector the rubric's `sectorOf` targets).
 *     There is no per-org region config in lib/hq or lib/sales today, so none
 *     is invented — the territory is the rubric's own UK-wide gate.
 *   • Writes go through the EXISTING sanctioned door only: `createCompany`
 *     (hq-sales.ts) — the same function manual entry uses, which also records
 *     the `created` timeline event. Never a raw table write.
 *   • DB provenance: `hq_sales_companies.source` is an FK to
 *     `hq_sales_sources(slug)` and `lead_sourcing` is NOT a seeded slug (and
 *     this lane ships no migration), so rows carry the seeded, accurate
 *     `companies_house` source slug; the fuller `lead_sourcing` provenance
 *     (task, week, query) lives in the task's result jsonb.
 *   • Candidates already on the book (matched by registered company number)
 *     are skipped, and the existing-number read is LOUD — a failed read throws
 *     (retryable) rather than risking duplicate inserts on a blind write.
 *   • Prospects land at status 'new' — the pipeline's entry state. Nothing here
 *     qualifies, contacts, or advances a company; the Qualification AI and a
 *     human own everything downstream.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { createCompany, type CompanyWriteInput } from "@/server/services/hq-sales";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  resolveWorkerIdentity,
  normaliseWorkerOutcome,
  type WorkerRunOutcome,
} from "@/server/services/hq-worker-runner-kit";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

/** The Sales AI roster employee this leg runs as (seeded; also the exec-runner slug). */
const SALES_AI_SLUG = "sales-ai";
/** The durable task_type this leg drains off the generic engine. */
const LEAD_SOURCING_TASK_TYPE = "lead_sourcing";
/**
 * DB provenance for sourced rows — an EXISTING seeded `hq_sales_sources` slug
 * (`source` is FK-constrained; `lead_sourcing` is not seeded and this lane
 * ships no migration). It is also the honest one: the register IS the source.
 */
const LEAD_SOURCING_DB_SOURCE = "companies_house";
/** New prospects per weekly run — a deliberate trickle, not a bulk import. */
const SOURCING_BATCH_LIMIT = 10;
/** Candidates requested from the register (headroom for already-known skips). */
const SEARCH_PAGE_SIZE = 50;
/** Per-request timeout, mirroring research-fetch's bounded-fetch posture. */
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * UK SIC 2007 Section F — Construction (divisions 41–43), the official code
 * list. A documented public standard, not invented org config: it is the
 * machine-readable form of the same "construction sector" the qualification
 * rubric's `sectorOf` classifies on.
 */
export const CONSTRUCTION_SIC_CODES: readonly string[] = [
  // 41 — construction of buildings
  "41100", "41201", "41202",
  // 42 — civil engineering
  "42110", "42120", "42130", "42210", "42220", "42910", "42990",
  // 43 — specialised construction activities
  "43110", "43120", "43130", "43210", "43220", "43290",
  "43310", "43320", "43330", "43341", "43342", "43390",
  "43910", "43991", "43999",
];

// ---------------------------------------------------------------------
// Week stamp — one sourcing run per ISO week (UTC Monday), the same weekly
// cadence stamp the marketing content runner keys on.
// ---------------------------------------------------------------------

/** ISO date of the UTC Monday of `now`'s week — the dedupe stamp. Exported pure for tests. */
export function leadSourcingWeekOf(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// The dark adapter — Companies House advanced search, key-gated BEFORE any
// fetch (the exact refusal posture of research-fetch.ts lookupCompaniesHouse).
// ---------------------------------------------------------------------

export type SourcedCandidate = {
  companyNumber: string;
  name: string;
  status: string | null;
  incorporatedOn: string | null;
  sicCodes: string[];
  registeredOffice: string | null;
};

function formatOffice(office: unknown): string | null {
  const o = (office ?? {}) as Record<string, unknown>;
  const parts = [o.address_line_1, o.address_line_2, o.locality, o.region, o.postal_code]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
  return parts.length ? parts.join(", ").slice(0, 300) : null;
}

/**
 * Query the Companies House ADVANCED SEARCH for active UK construction-sector
 * companies (SIC Section F). Deterministic parameters; bounded page; throws on
 * a transport/API failure so an ARMED run fails loudly (retryable) instead of
 * completing with a fake empty result. NEVER called while dark — the handler
 * gates on the key before reaching here.
 */
async function searchConstructionCompanies(apiKey: string): Promise<SourcedCandidate[]> {
  const params = new URLSearchParams();
  for (const code of CONSTRUCTION_SIC_CODES) params.append("sic_codes", code);
  params.append("company_status", "active");
  params.append("size", String(SEARCH_PAGE_SIZE));

  // CH REST API uses HTTP Basic with the API key as the username, no password.
  const token = Buffer.from(`${apiKey}:`).toString("base64");
  const res = await fetch(
    `https://api.company-information.service.gov.uk/advanced-search/companies?${params.toString()}`,
    {
      headers: { authorization: `Basic ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`companies-house advanced search failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];

  const out: SourcedCandidate[] = [];
  for (const raw of items as Array<Record<string, unknown>>) {
    const companyNumber =
      typeof raw.company_number === "string" ? raw.company_number.trim().toUpperCase() : null;
    const name = typeof raw.company_name === "string" ? raw.company_name.trim() : null;
    if (!companyNumber || !name) continue; // an unidentifiable hit is unusable
    out.push({
      companyNumber,
      name: name.slice(0, 300),
      status: typeof raw.company_status === "string" ? raw.company_status : null,
      incorporatedOn: typeof raw.date_of_creation === "string" ? raw.date_of_creation : null,
      sicCodes: Array.isArray(raw.sic_codes)
        ? (raw.sic_codes as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      registeredOffice: formatOffice(raw.registered_office_address),
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// LOUD read — which of the candidate company numbers are already prospects.
// A failed read throws (retryable) so a blind write can never duplicate.
// ---------------------------------------------------------------------

async function knownCompanyNumbers(numbers: string[]): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("hq_sales_companies" as never) as unknown as {
      select: (c: string) => {
        in: (k: string, v: ReadonlyArray<unknown>) => {
          limit: (n: number) => PromiseLike<{
            data: Array<{ companies_house_number: string | null }> | null;
            error: SupabaseReadError | null;
          }>;
        };
      };
    }
  )
    .select("companies_house_number")
    .in("companies_house_number", numbers)
    // Structurally bounded by the .in() batch (SOURCING_BATCH_MAX = 10 per
    // run); the explicit clamp is the F-1 guard's honest-bound idiom.
    .limit(1000);
  if (error) throw readFailure("hq-lead-sourcing: known company numbers", error);
  const known = new Set<string>();
  for (const row of Array.isArray(data) ? data : []) {
    if (row.companies_house_number) known.add(row.companies_house_number.toUpperCase());
  }
  return known;
}

// ---------------------------------------------------------------------
// The result artifact the task completes with.
// ---------------------------------------------------------------------

export type LeadSourcingResult = {
  kind: "lead_sourcing";
  /** UTC Monday of the week this run covers. */
  weekOf: string;
  /** True when the Companies House credential is absent — nothing was fetched. */
  dark: boolean;
  reason: string | null;
  /** Companies actually recorded this run (0 while dark — never fabricated). */
  sourced: number;
  /** Candidates returned by the register (0 while dark). */
  candidates: number;
  /** Candidates skipped because their company number is already a prospect. */
  skippedExisting: number;
  /** createCompany failures this run (logged; the run still reports honestly). */
  insertFailures: number;
  /** The recorded prospects, for the artifact reader. */
  companies: Array<{ id: string; name: string; companyNumber: string }>;
  /**
   * Full provenance — the `lead_sourcing` marker lives HERE (the DB `source`
   * column is FK-bound to seeded slugs, so rows carry `companies_house`).
   */
  provenance: {
    source: "lead_sourcing";
    register: "companies_house_advanced_search";
    dbSourceSlug: typeof LEAD_SOURCING_DB_SOURCE;
    query: {
      companyStatus: "active";
      sicSection: "F (construction, UK SIC 2007 divisions 41-43)";
      sicCodes: readonly string[];
      territory: "uk";
      pageSize: number;
      batchLimit: number;
    };
  };
};

function baseResult(weekOf: string): LeadSourcingResult {
  return {
    kind: "lead_sourcing",
    weekOf,
    dark: false,
    reason: null,
    sourced: 0,
    candidates: 0,
    skippedExisting: 0,
    insertFailures: 0,
    companies: [],
    provenance: {
      source: "lead_sourcing",
      register: "companies_house_advanced_search",
      dbSourceSlug: LEAD_SOURCING_DB_SOURCE,
      query: {
        companyStatus: "active",
        sicSection: "F (construction, UK SIC 2007 divisions 41-43)",
        sicCodes: CONSTRUCTION_SIC_CODES,
        territory: "uk",
        pageSize: SEARCH_PAGE_SIZE,
        batchLimit: SOURCING_BATCH_LIMIT,
      },
    },
  };
}

/** Map a register candidate onto the sanctioned write door's full input shape.
 *  Only register-grounded facts are filled; everything unknown stays null. */
function candidateToCompanyInput(c: SourcedCandidate): CompanyWriteInput {
  return {
    name: c.name,
    summary:
      `Sourced from the Companies House public register (advanced search: active UK ` +
      `construction companies, SIC Section F). Register status: ${c.status ?? "unknown"}.` +
      (c.sicCodes.length ? ` SIC codes: ${c.sicCodes.join(", ")}.` : ""),
    website: null,
    // Grounded by the SIC filter — only Section F companies are returned.
    industry: "Construction",
    employeeCount: null,
    annualTurnoverGbp: null,
    location: c.registeredOffice,
    region: null,
    county: null,
    // Companies House is the UK register — territory is inherent, not guessed.
    country: "United Kingdom",
    primaryEmail: null,
    primaryPhone: null,
    linkedinUrl: null,
    instagramUrl: null,
    facebookUrl: null,
    companiesHouseUrl: `https://find-and-update.company-information.service.gov.uk/company/${c.companyNumber}`,
    companiesHouseNumber: c.companyNumber,
    websiteTechnology: [],
    crmScore: null,
    aiQualificationScore: null,
    estimatedDealValueGbp: null,
    status: "new", // the pipeline's entry state — sourcing never advances a company
    source: LEAD_SOURCING_DB_SOURCE,
    assignedToEmail: null,
    tags: [],
    revenueEstimateGbp: null,
    growthScore: null,
    constructionSector: null, // register-unverified; the Research AI enriches this
    softwareUsed: [],
    estimatedSoftwareSpendGbp: null,
    fleetSize: null,
    staffSize: null,
    websiteQualityScore: null,
    marketingQualityScore: null,
    hiringActivityScore: null,
    digitalMaturityScore: null,
  };
}

// ---------------------------------------------------------------------
// The handler. DETERMINISTIC + adapter-gated — no LLM, no governed seam.
// ---------------------------------------------------------------------

const leadSourcingHandler: TaskHandler = async (ctx) => {
  const result = baseResult(leadSourcingWeekOf(new Date()));

  // THE dark gate — the adapter's own credential, refused BEFORE any fetch
  // (mirrors research-fetch.ts lookupCompaniesHouse). Dark is a COMPLETION,
  // never a failure: the honest outcome is "zero sourced, and here is why".
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY?.trim();
  if (!apiKey) {
    result.dark = true;
    result.reason = "companies-house key not configured";
    return result;
  }

  // ---- ARMED (not today's state) ------------------------------------
  const candidates = await searchConstructionCompanies(apiKey);
  result.candidates = candidates.length;

  // LOUD dedupe read — throw (retryable) rather than risk duplicates.
  const known = await knownCompanyNumbers(candidates.map((c) => c.companyNumber));

  const actor = { id: null, email: ctx.task.created_by ?? null };
  for (const candidate of candidates) {
    if (result.sourced >= SOURCING_BATCH_LIMIT) break;
    if (known.has(candidate.companyNumber)) {
      result.skippedExisting += 1;
      continue;
    }
    // The EXISTING sanctioned door — the same write manual entry uses; it also
    // records the `created` timeline event with the source slug.
    const created = await createCompany(candidateToCompanyInput(candidate), actor);
    if (!created.ok) {
      console.error("[hq-lead-sourcing] createCompany failed", {
        companyNumber: candidate.companyNumber,
        error: created.error,
      });
      result.insertFailures += 1;
      continue;
    }
    known.add(candidate.companyNumber); // register pages can repeat a company
    result.sourced += 1;
    result.companies.push({
      id: created.id,
      name: candidate.name,
      companyNumber: candidate.companyNumber,
    });
  }

  // Every write refused with candidates in hand is a real defect — fail loudly
  // (retryable) instead of completing a run that recorded nothing it found.
  if (result.sourced === 0 && result.insertFailures > 0) {
    throw new Error(
      `lead sourcing: all ${result.insertFailures} candidate insert(s) failed`,
    );
  }
  return result;
};

// ---------------------------------------------------------------------
// The tick surface — the exact enqueue/drain shape the roster-workers WORKERS
// array wires ((now: Date) => Promise<unknown> / (limit?: number) => Promise<unknown>).
// ---------------------------------------------------------------------

export async function enqueueLeadSourcing(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(SALES_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  // One sourcing pass per ISO week — a weekly trickle by contract, and the
  // dedupeKey makes a re-tick a no-op instead of a backlog.
  const week = leadSourcingWeekOf(now);
  const enq = await enqueueTask({
    taskType: LEAD_SOURCING_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${LEAD_SOURCING_TASK_TYPE}:${week}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-lead-sourcing] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runLeadSourcingTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(SALES_AI_SLUG);
  registerTaskHandler(LEAD_SOURCING_TASK_TYPE, identity, leadSourcingHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(LEAD_SOURCING_TASK_TYPE, leadSourcingHandler, identity),
  );
}

export async function drainLeadSourcingTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(SALES_AI_SLUG);
  registerTaskHandler(LEAD_SOURCING_TASK_TYPE, identity, leadSourcingHandler);
  const summary = await drainTaskType(LEAD_SOURCING_TASK_TYPE, leadSourcingHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { SALES_AI_SLUG, LEAD_SOURCING_TASK_TYPE, LEAD_SOURCING_DB_SOURCE, leadSourcingHandler };
