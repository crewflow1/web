import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { reportReadFailure, readFailure } from "@/lib/supabase/read-failure";
import { formatDayKeyUK } from "@/lib/time/format";
import {
  computeAllJobsProfitability,
  type JobProfitability,
} from "@/lib/profitability/compute";
import { loadCompanySignals, type CompanySignalsView } from "@/server/services/intelligence";
import { buildHealthSafetySnapshot } from "@/server/services/health-safety-snapshot";
import {
  listSupplierPerformance,
  type PerformanceClient,
} from "@/server/services/supplier-performance";
import { loadCisSubcontractorRoster, type CisRosterClient } from "@/server/services/cis";
import {
  computeCompanyHealth,
  type CompanyHealth,
  type CompanyHealthInput,
} from "@/lib/health/company-health";
import {
  computeCustomerLtv,
  type CustomerLtv,
  type LtvInvoice,
} from "@/lib/health/customer-ltv";
import {
  computeSubcontractorScoreboard,
  type SubcontractorScoreboard,
} from "@/lib/health/subcontractor-score";

/**
 * COMPANY HEALTH — the read layer for the deterministic health suite.
 *
 * FETCHES AND COMPOSES; decides nothing. The per-dimension banding lives in
 * lib/health/company-health.ts (pure, unit-tested); customer value and
 * subcontractor scoring live in their own pure libs. Every figure this feeds
 * them comes from an authority that already owns it — the whole intelligence
 * view (server/services/intelligence.ts), the H&S snapshot, the shipped
 * supplier-performance measurement, and the profitability authority. ZERO new
 * tables, ZERO migrations.
 *
 * READ-ONLY BY CONSTRUCTION. No `.insert`, `.update`, `.upsert`, `.delete` or
 * `.rpc` appears here and none may be added — a health surface that could write
 * would be a second, unaudited path into the ledgers it observes.
 *
 * ACTIVE-ORG PINNED. Every table read carries `.eq("org_id", orgId)` on top of
 * RLS: `current_org_ids()` admits EVERY org the viewer belongs to, so an
 * unpinned read would BLEND a dual-org member's two companies — one company's
 * customer value or subcontractor conduct presented as the other's. The `orgId`
 * this function receives is threaded to EVERY loader, and the client is never
 * used unpinned. The composed loaders (`loadCompanySignals`,
 * `buildHealthSafetySnapshot`, `listSupplierPerformance`) carry the same pin
 * internally, proved against real Postgres in their own integration suites and
 * in __tests__/integration/rls/company-health-active-org.test.ts.
 *
 * LOUD READS, PER GROUP. Each group either computes WHOLE or fails WHOLE: a
 * partially-read invoice set is a wrong customer-value figure, so the gathers
 * throw `readFailure` and the group catch reports it; a failed group renders an
 * explicit error, never an empty metric. For the HEALTH dimensions, a failed
 * group arrives at the pure banding function as `null`, which bands
 * `insufficient` — a failed read is never a clean bill of health.
 */

// ---------------------------------------------------------------------------
// Loose client shim (several tables post-date the generated types)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string, o?: { count: "exact"; head: true }) => Builder;
  eq: (k: string, v: unknown) => Builder;
  in: (k: string, v: readonly unknown[]) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  then: PromiseLike<{ count: number | null; error: unknown }>["then"];
};

/**
 * The read surface the gathers need. Exported so the integration suite can drive
 * these EXACT functions with a real dual-org user's JWT against real Postgres —
 * the pattern that makes the org pins provable rather than merely reviewed
 * (server/services/supplier-performance.ts). A service that only ever reached for
 * `createClient()` internally could be source-pinned but never RLS-proven.
 */
export type HealthClient = { from: (t: string) => Builder };

const sv = (v: unknown) => (v == null ? null : String(v));

/** Throwing wrapper over fetchAllRows: full set or a loud failure. */
async function allRows(
  context: string,
  build: (from: number, to: number) => PromiseLike<PageResult<Row>>,
): Promise<Row[]> {
  const { data, error } = await fetchAllRows<Row>(build);
  if (error) {
    throw readFailure(context, error as { message?: string | null; code?: string | null });
  }
  return data;
}

/** A single head count, org-pinned and loud. */
async function countRows(
  db: HealthClient,
  context: string,
  table: string,
  orgId: string,
  extra?: (b: Builder) => Builder,
): Promise<number> {
  let q = db.from(table).select("id", { count: "exact", head: true }).eq("org_id", orgId);
  if (extra) q = extra(q);
  const { count, error } = (await q) as unknown as { count: number | null; error: unknown };
  if (error) {
    throw readFailure(context, error as { message?: string | null; code?: string | null });
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Group wrapper — WHOLE or an explicit failure
// ---------------------------------------------------------------------------

export type SignalGroup<T> = { data: T; failed: false } | { data: null; failed: true };

async function group<T>(context: string, run: () => Promise<T>): Promise<SignalGroup<T>> {
  try {
    return { data: await run(), failed: false };
  } catch (err) {
    reportReadFailure(context, {
      message: err instanceof Error ? err.message : String(err),
    });
    return { data: null, failed: true };
  }
}

// ---------------------------------------------------------------------------
// Group: profitability (composes the profitability authority, org-wide)
// ---------------------------------------------------------------------------

export async function gatherProfitability(
  db: HealthClient,
  orgId: string,
): Promise<JobProfitability[]> {
  const [jobs, invoices, finances] = await Promise.all([
    allRows("company-health: jobs", (from, to) =>
      db.from("jobs").select("id").eq("org_id", orgId).order("id", { ascending: true }).range(from, to),
    ),
    allRows("company-health: invoices", (from, to) =>
      db
        .from("invoices")
        .select("id, job_id, amount")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("company-health: finances", (from, to) =>
      db
        .from("finances")
        .select("id, job_id, amount, category")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  return computeAllJobsProfitability(
    jobs.map((j) => ({ id: String(j.id) })),
    invoices.map((i) => ({ job_id: sv(i.job_id), amount: i.amount as number | string | null })),
    finances.map((f) => ({
      job_id: sv(f.job_id),
      amount: f.amount as number | string | null,
      category: sv(f.category),
    })),
  );
}

// ---------------------------------------------------------------------------
// Group: customer lifetime value
// ---------------------------------------------------------------------------

export async function gatherCustomerLtv(db: HealthClient, orgId: string): Promise<CustomerLtv> {
  const [invoices, customers, jobs] = await Promise.all([
    allRows("company-health: LTV invoices", (from, to) =>
      db
        .from("invoices")
        .select("id, status, amount, customer_id, job_id")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("company-health: customers", (from, to) =>
      db.from("customers").select("id, name").eq("org_id", orgId).order("id", { ascending: true }).range(from, to),
    ),
    allRows("company-health: LTV jobs", (from, to) =>
      db
        .from("jobs")
        .select("id, customer_id")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  return computeCustomerLtv({
    invoices: invoices as unknown as LtvInvoice[],
    naming: {
      customerName: new Map(customers.map((c) => [String(c.id), String(c.name ?? "")])),
      jobCustomer: new Map(jobs.map((j) => [String(j.id), sv(j.customer_id)])),
    },
  });
}

// ---------------------------------------------------------------------------
// Group: subcontractor scoreboard (CIS subs, via supplier performance)
// ---------------------------------------------------------------------------

export async function gatherSubcontractorScoreboard(
  db: HealthClient,
  orgId: string,
): Promise<SubcontractorScoreboard> {
  // The CIS roster comes through the admin-gated cis service — the SOLE reader of
  // the cis_subcontractors tax table (a security chokepoint). It returns supplier
  // id + name ONLY, never the UTR, and a non-admin reads an EMPTY roster WITHOUT
  // an error, so the scoreboard is empty rather than a false clean sheet.
  const roster = await loadCisSubcontractorRoster(db as unknown as CisRosterClient, orgId);
  if (roster.length === 0) return computeSubcontractorScoreboard([]);

  // Compose the SHIPPED measurement, scoped to exactly this org's CIS suppliers.
  const performances = await listSupplierPerformance(
    db as unknown as PerformanceClient,
    orgId,
    roster.map((r) => ({ id: r.supplierId, name: r.name })),
  );

  return computeSubcontractorScoreboard(performances);
}

// ---------------------------------------------------------------------------
// Group: safety snapshot + coverage
// ---------------------------------------------------------------------------

type SafetyInput = NonNullable<CompanyHealthInput["safety"]>;

async function gatherSafety(db: HealthClient, orgId: string): Promise<SafetyInput> {
  // The snapshot itself throws loudly on any failed read (it makes SAFETY
  // CLAIMS). The coverage counts prove there is a programme to judge at all —
  // without one, the pure banding refuses to paint an all-zero snapshot green.
  const [snapshot, ramsCount, permitCount, activeJobCount] = await Promise.all([
    buildHealthSafetySnapshot(orgId),
    countRows(db, "company-health: RAMS coverage", "risk_assessments", orgId),
    countRows(db, "company-health: permit coverage", "permits_to_work", orgId),
    countRows(db, "company-health: active-job coverage", "jobs", orgId, (b) =>
      b.eq("status", "in-progress"),
    ),
  ]);

  return {
    snapshot,
    hasAnySafetyRecord: ramsCount > 0 || permitCount > 0 || activeJobCount > 0,
  };
}

// ---------------------------------------------------------------------------
// The assembled view
// ---------------------------------------------------------------------------

export interface CompanyHealthView {
  /** The London day the page rendered for. */
  todayKey: string;
  /** Per-dimension RAG. Always present — failed groups band `insufficient`. */
  health: CompanyHealth;
  /** Customer lifetime value — its own loud group. */
  ltv: SignalGroup<CustomerLtv>;
  /** CIS subcontractor scoreboard — its own loud group. */
  subcontractors: SignalGroup<SubcontractorScoreboard>;
}

/**
 * Load the full company-health view for one org. `now` is injectable so tests
 * and the page pin one instant. `orgId` is threaded to EVERY loader — the whole
 * intelligence view, the H&S snapshot, the profitability read, customer value
 * and the subcontractor roster all read the ACTIVE org only.
 */
export async function loadCompanyHealth(
  orgId: string,
  now: Date = new Date(),
  /**
   * An already-loaded intelligence view. The /insights page renders the raw
   * signals card too, so it loads the view ONCE and hands it in here — otherwise
   * the whole (heavy) intelligence read would run twice per page. Omitted, this
   * loads its own, so callers that only want health (and the integration suite)
   * need pass nothing.
   */
  preloadedSignals?: CompanySignalsView,
): Promise<CompanyHealthView> {
  // Defence in depth: a pre-loaded view MUST belong to the org we are banding, or
  // three of the five dimensions would silently blend another company's numbers.
  // The sole caller passes ctx.org.id-matched signals; this refuses a future misuse.
  if (preloadedSignals?.orgId && preloadedSignals.orgId !== orgId) {
    throw new Error(
      `loadCompanyHealth: preloaded signals for org ${preloadedSignals.orgId} do not match ${orgId}`,
    );
  }
  const supabase = await createClient();
  const db = supabase as unknown as HealthClient;
  const todayKey = formatDayKeyUK(now);

  // The whole deterministic intelligence view — active-org pinned, loud and
  // group-isolated internally. Its outputs feed three of the five dimensions.
  const [signals, safety, profitability, ltv, subcontractors] = await Promise.all([
    preloadedSignals ? Promise.resolve(preloadedSignals) : loadCompanySignals(orgId, now),
    group("company-health: safety", () => gatherSafety(db, orgId)),
    group("company-health: profitability", () => gatherProfitability(db, orgId)),
    group("company-health: customer LTV", () => gatherCustomerLtv(db, orgId)),
    group("company-health: subcontractor scoreboard", () =>
      gatherSubcontractorScoreboard(db, orgId),
    ),
  ]);

  // Map the intelligence groups onto the health dimensions. A failed group
  // becomes `null`, which the pure banding treats as `insufficient` — never green.
  const cash =
    !signals.exposure.failed && !signals.cvr.failed
      ? {
          agedDebt: signals.exposure.data.agedDebt,
          retention: signals.exposure.data.retention,
          cvr: signals.cvr.data,
        }
      : null;
  const delivery =
    !signals.progress.failed && !signals.programmeVariance.failed
      ? {
          progress: signals.progress.data.rollup,
          programme: signals.programmeVariance.data.rollup,
        }
      : null;
  const supplier = !signals.supplierPerformance.failed ? signals.supplierPerformance.data : null;

  const input: CompanyHealthInput = {
    cash,
    delivery,
    safety: safety.failed ? null : safety.data,
    supplier,
    profitability: profitability.failed ? null : profitability.data,
  };

  return {
    todayKey,
    health: computeCompanyHealth(input),
    ltv,
    subcontractors,
  };
}
