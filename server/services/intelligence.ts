import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { reportReadFailure, readFailure } from "@/lib/supabase/read-failure";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";
import { formatDayKeyUK } from "@/lib/time/format";
import { ROTA_LOOKBACK_MS } from "@/lib/schedule/window";
import type { TimeEntry } from "@/lib/time/compute";
import {
  computeJobProfitability,
  type CostBucket,
} from "@/lib/profitability/compute";
import { computeCommittedCosts } from "@/lib/purchase-orders/committed";
import { computeJobCommercialPosition } from "@/lib/jobs/commercial-position";
import {
  computeJobBudgetPosition,
  type JobBudgetRow,
  type VariationCostEstimate,
} from "@/lib/jobs/budget";
import {
  MATERIAL_REQUEST_OPEN_STATUSES,
} from "@/lib/material-requests/schema";
import { loadProgressForJobs, type ProgressClient } from "@/server/services/job-progress";
import { buildRetentionRegisterView } from "@/server/services/retention-register";
import { buildAgedLedgers } from "@/server/services/aged-ledgers";
import {
  readIssuedForLines,
  type StockSeamClient,
} from "@/server/services/material-fulfilment";
import { trailingDayWindow, trailingMonthsWindow, type InstantDayWindow } from "@/lib/intelligence/window";
import {
  computeUtilisation,
  type OrgUtilisation,
  type UtilisationMember,
  type UtilisationRotaRow,
} from "@/lib/intelligence/utilisation";
import {
  computeCustomerConcentration,
  type ConcentrationInvoice,
  type CustomerConcentration,
} from "@/lib/intelligence/concentration";
import {
  ACTIVE_JOB_STATUS,
  computeProgressRollup,
  type ProgressJobInput,
  type ProgressRollup,
} from "@/lib/intelligence/progress-rollup";
import {
  computeRetentionExposure,
  computeAgedDebtSummary,
  type AgedDebtSummary,
  type RetentionExposure,
} from "@/lib/intelligence/exposure";
import { computeCvrRollup, type CvrJobInput, type CvrRollup } from "@/lib/intelligence/cvr-rollup";
import {
  computeMaterialDemand,
  DEMAND_STATUSES,
  type DemandLine,
  type DemandRequest,
  type MaterialDemand,
} from "@/lib/intelligence/material-demand";
import {
  computeSnagPatterns,
  type SnagPatterns,
  type SnagRow,
} from "@/lib/intelligence/snag-patterns";

/**
 * COMPANY SIGNALS — the read layer for the deterministic intelligence layer.
 * FETCHES AND COMPOSES; decides nothing. Every threshold, clamp, floor and
 * label lives in lib/intelligence/** (pure, unit-tested); every settled money
 * figure comes from the authority that owns it (retention register, aged
 * ledgers, budget positions, fulfilment). ZERO new tables, ZERO migrations —
 * this train composes ledgers that already exist.
 *
 * READ-ONLY BY CONSTRUCTION. No `.insert`, `.update`, `.upsert`, `.delete`
 * or `.rpc` appears here and none may be added — an intelligence surface that
 * could write would be a second, unaudited path into the ledgers it observes
 * (the supplier-performance doctrine). Pinned by
 * __tests__/intelligence/source-assertions.test.ts.
 *
 * ACTIVE-ORG PINNED. Every table read carries `.eq("org_id", orgId)` on top
 * of RLS: `current_org_ids()` admits EVERY org the viewer belongs to, so an
 * unpinned read BLENDS a dual-org member's two companies — on THIS surface
 * that means one company's utilisation, concentration and debt would be
 * presented as the other's. The ONE exception is `users` (global profile
 * table, no org_id column), which is reached ONLY through `.in("id", ids)`
 * where the ids come from this org's `memberships` read — the
 * schedule-integrity precedent, and the exception is named in the source
 * test rather than left for a reviewer to notice.
 *
 * LOUD READS, PER GROUP. Each signal group either computes WHOLE or fails
 * WHOLE: a partially-read utilisation table is a wrong utilisation table (a
 * dropped page of time entries changes every ratio), so gathers throw
 * `readFailure` and `loadCompanySignals` catches PER GROUP — the failed card
 * renders an explicit error block, the rest of the page stands. A failed
 * read never renders as an empty metric (the read-failure module's whole
 * point).
 *
 * BOUNDED READS. Whole-history tables page through `fetchAllRows` (the F-1
 * silent-truncation rule) and every ordering appends unique `id` so a page
 * boundary can never drop or duplicate a row; windowed tables (rota, time
 * entries, 12-month invoices) are additionally range-bounded on their indexed
 * timestamp columns, with the rota lookback pad so a shift that started
 * before the window but ran into it still counts
 * (lib/schedule/window.ROTA_LOOKBACK_MS).
 */

// ---------------------------------------------------------------------------
// Loose client shim (several tables post-date the generated types)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  in: (k: string, v: readonly unknown[]) => Builder;
  is: (k: string, v: unknown) => Builder;
  gte: (k: string, v: unknown) => Builder;
  lte: (k: string, v: unknown) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

export type IntelligenceClient = { from: (t: string) => Builder };

const mv = (v: unknown) => v as number | string | null;
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

/** The job's site as a short label — the retention register's display idiom. */
function siteLabel(job: Row): string | null {
  const parts = [sv(job.site_address_line1), sv(job.site_city), sv(job.site_postcode)]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Shared jobs read (labels + status + customer fallback, used by 4 groups)
// ---------------------------------------------------------------------------

type JobLite = {
  id: string;
  status: string | null;
  customerId: string | null;
  label: string | null;
};

async function gatherJobs(db: IntelligenceClient, orgId: string): Promise<JobLite[]> {
  const rows = await allRows("intelligence: jobs", (from, to) =>
    db
      .from("jobs")
      .select("id, status, customer_id, site_address_line1, site_city, site_postcode")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  return rows.map((j) => ({
    id: String(j.id),
    status: sv(j.status),
    customerId: sv(j.customer_id),
    label: siteLabel(j),
  }));
}

// ---------------------------------------------------------------------------
// Group: utilisation
// ---------------------------------------------------------------------------

export async function gatherUtilisation(
  db: IntelligenceClient,
  orgId: string,
  window: InstantDayWindow,
  nowMs: number,
): Promise<OrgUtilisation> {
  const memberships = await allRows("intelligence: memberships", (from, to) =>
    db
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .order("user_id", { ascending: true })
      .range(from, to),
  );
  const memberIds = [...new Set(memberships.map((m) => String(m.user_id)))];

  // The rota lookback pad: a shift that STARTED before the window but ran
  // into it is a real participant; `ends_at` is unindexed, so the indexed
  // `starts_at` lower bound is padded instead (the schedule-window rule).
  const fromInstant = new Date(window.startMs - ROTA_LOOKBACK_MS).toISOString();
  const toInstant = new Date(window.endMs).toISOString();

  const [users, rota, timeEntries] = await Promise.all([
    memberIds.length === 0
      ? Promise.resolve([] as Row[])
      : allRows("intelligence: users", (from, to) =>
          db
            .from("users")
            // GLOBAL table (no org_id column): scoped by the membership ids
            // above — the documented exception to the org-pin rule.
            .select("id, full_name, hourly_pay")
            .in("id", memberIds)
            .order("id", { ascending: true })
            .range(from, to),
        ),
    allRows("intelligence: rota entries", (from, to) =>
      db
        .from("rota_entries")
        .select("user_id, job_id, starts_at, ends_at")
        .eq("org_id", orgId)
        .gte("starts_at", fromInstant)
        .lte("starts_at", toInstant)
        .order("starts_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("intelligence: time entries", (from, to) =>
      db
        .from("time_entries")
        .select("id, user_id, job_id, started_at, ended_at, breaks")
        .eq("org_id", orgId)
        .gte("started_at", fromInstant)
        .lte("started_at", toInstant)
        .order("started_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const nameById = new Map(users.map((u) => [String(u.id), sv(u.full_name)]));
  const rateById = new Map(
    users.map((u) => [String(u.id), u.hourly_pay == null ? null : Number(u.hourly_pay)]),
  );

  const members: UtilisationMember[] = memberIds.map((id) => ({
    userId: id,
    name: nameById.get(id) ?? null,
    hourlyPay: rateById.get(id) ?? null,
  }));

  return computeUtilisation({
    members,
    rota: rota as unknown as UtilisationRotaRow[],
    timeEntries: timeEntries as unknown as TimeEntry[],
    window,
    nowMs,
  });
}

// ---------------------------------------------------------------------------
// Group: customer concentration
// ---------------------------------------------------------------------------

export async function gatherConcentration(
  db: IntelligenceClient,
  orgId: string,
  window: InstantDayWindow,
  jobs: JobLite[],
): Promise<CustomerConcentration> {
  const fromInstant = new Date(window.startMs).toISOString();

  const [invoices, customers] = await Promise.all([
    allRows("intelligence: invoices", (from, to) =>
      db
        .from("invoices")
        .select("id, status, amount, customer_id, job_id, created_at")
        .eq("org_id", orgId)
        .gte("created_at", fromInstant)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("intelligence: customers", (from, to) =>
      db
        .from("customers")
        .select("id, name")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  return computeCustomerConcentration({
    invoices: invoices as unknown as ConcentrationInvoice[],
    naming: {
      customerName: new Map(customers.map((c) => [String(c.id), String(c.name ?? "")])),
      jobCustomer: new Map(jobs.map((j) => [j.id, j.customerId])),
    },
    window,
  });
}

// ---------------------------------------------------------------------------
// Group: job progress rollup (composes the series read layer)
// ---------------------------------------------------------------------------

/**
 * Ceiling on jobs the rollup reads series for in one render. A cap, stated on
 * the surface when hit, rather than a silent truncation; ordering is by id so
 * the capped set is stable between loads.
 */
export const PROGRESS_ROLLUP_JOB_LIMIT = 200;

export async function gatherProgressRollup(
  db: IntelligenceClient,
  orgId: string,
  jobs: JobLite[],
  now: Date,
): Promise<{ rollup: ProgressRollup; capped: boolean }> {
  const active = jobs.filter((j) => j.status === ACTIVE_JOB_STATUS);
  const capped = active.length > PROGRESS_ROLLUP_JOB_LIMIT;
  const considered = active.slice(0, PROGRESS_ROLLUP_JOB_LIMIT);

  const { byJob, failed } = await loadProgressForJobs(
    db as unknown as ProgressClient,
    orgId,
    considered.map((j) => j.id),
    now,
  );
  if (failed) {
    // A partially-read series is a wrong trend — fail the whole group.
    throw readFailure("intelligence: job progress series", {
      message: "progress series read failed",
    });
  }

  const inputs: ProgressJobInput[] = considered.map((j) => {
    const summary = byJob.get(j.id);
    return {
      jobId: j.id,
      label: j.label,
      href: `/jobs/${j.id}`,
      points: summary?.points ?? [],
      summary:
        summary ??
        ({
          points: [],
          latest: null,
          previous: null,
          percent: null,
          delta: null,
          trend: "none",
          daysSinceUpdate: null,
          stale: false,
          spanDays: null,
        } as ProgressJobInput["summary"]),
    };
  });

  return { rollup: computeProgressRollup(inputs, formatDayKeyUK(now)), capped };
}

// ---------------------------------------------------------------------------
// Group: CVR rollup (composes the budget authority per job, org-wide)
// ---------------------------------------------------------------------------

export async function gatherCvrRollup(
  db: IntelligenceClient,
  orgId: string,
  jobs: JobLite[],
): Promise<CvrRollup> {
  // Current baselines only: superseded_at IS NULL is the current-revision
  // predicate, single by partial unique index (server/services/job-budget.ts).
  const budgets = await allRows("intelligence: job budgets", (from, to) =>
    db
      .from("job_budgets")
      .select(
        "job_id, revision, total_cost, labour_cost, materials_cost, subcontractors_cost, " +
          "misc_cost, target_margin_pct, note, created_at",
      )
      .eq("org_id", orgId)
      .is("superseded_at", null)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const jobById = new Map(jobs.map((j) => [j.id, j]));
  // "Active" for CVR: any job not completed — a blocked or new job with a
  // budget still has a live cost plan; a completed one is history.
  const budgetByJob = new Map<string, JobBudgetRow>();
  for (const b of budgets) {
    const jobId = sv(b.job_id);
    if (!jobId) continue;
    const job = jobById.get(jobId);
    if (!job || job.status === "completed") continue;
    budgetByJob.set(jobId, b as unknown as JobBudgetRow);
  }
  const jobIds = [...budgetByJob.keys()];
  if (jobIds.length === 0) return computeCvrRollup([]);

  const [quotes, invoices, finances, purchaseOrders] = await Promise.all([
    allRows("intelligence: quotes", (from, to) =>
      db
        .from("quotes")
        .select(
          "id, job_id, status, subtotal, total, variation_number, " +
            "cost_labour, cost_materials, cost_subcontractors, cost_misc, cost_total",
        )
        .eq("org_id", orgId)
        .in("job_id", jobIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("intelligence: budget invoices", (from, to) =>
      db
        .from("invoices")
        .select("id, job_id, status, amount, total")
        .eq("org_id", orgId)
        .in("job_id", jobIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("intelligence: finances", (from, to) =>
      db
        .from("finances")
        .select("id, job_id, amount, category, purchase_order_id")
        .eq("org_id", orgId)
        .in("job_id", jobIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("intelligence: purchase orders", (from, to) =>
      db
        .from("purchase_orders")
        .select("id, job_id, status, total, subtotal")
        .eq("org_id", orgId)
        .in("job_id", jobIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const byJob = <T extends Row>(rows: Row[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = sv(r.job_id);
      if (!k) continue;
      const list = m.get(k);
      if (list) list.push(r as T);
      else m.set(k, [r as T]);
    }
    return m;
  };
  const quotesByJob = byJob(quotes);
  const invoicesByJob = byJob(invoices);
  const financesByJob = byJob(finances);
  const posByJob = byJob(purchaseOrders);

  const ZERO: Record<CostBucket, number> = { labour: 0, materials: 0, subcontractors: 0, misc: 0 };

  const inputs: CvrJobInput[] = jobIds.map((jobId) => {
    const jobQuotes = quotesByJob.get(jobId) ?? [];
    const jobInvoices = invoicesByJob.get(jobId) ?? [];
    const jobFinances = financesByJob.get(jobId) ?? [];
    const jobPos = posByJob.get(jobId) ?? [];

    // EXACTLY the commercial page's composition (the one existing caller of
    // computeJobBudgetPosition) — same authorities, same precedence.
    const profit = computeJobProfitability(
      jobId,
      jobInvoices.map((i) => ({ job_id: sv(i.job_id), amount: mv(i.amount) })),
      jobFinances.map((f) => ({
        job_id: sv(f.job_id),
        amount: mv(f.amount),
        category: sv(f.category),
      })),
    );

    // Bills already posted against each PO — bill beats PO, counted once.
    const billedByPo = new Map<string, number>();
    for (const f of jobFinances) {
      const poId = sv(f.purchase_order_id);
      if (!poId) continue;
      billedByPo.set(
        poId,
        Math.round(((billedByPo.get(poId) ?? 0) + Number(f.amount ?? 0)) * 100) / 100,
      );
    }
    const committed = computeCommittedCosts(
      jobPos.map((p) => ({
        status: String(p.status ?? ""),
        total: mv(p.total),
        subtotal: mv(p.subtotal),
        billed: billedByPo.get(String(p.id)) ?? 0,
      })),
    );

    const contract = computeJobCommercialPosition({
      quotes: jobQuotes.map((q) => ({
        status: String(q.status ?? ""),
        total: mv(q.total),
        subtotal: mv(q.subtotal),
        variation_number: q.variation_number == null ? null : Number(q.variation_number),
      })),
      invoices: jobInvoices.map((i) => ({ status: String(i.status ?? ""), total: mv(i.total) })),
    });

    const variationEstimates: VariationCostEstimate[] = jobQuotes
      .filter((q) => q.variation_number != null && String(q.status) === "accepted")
      .map((q) => ({
        total_cost: mv(q.cost_total),
        labour_cost: mv(q.cost_labour),
        materials_cost: mv(q.cost_materials),
        subcontractors_cost: mv(q.cost_subcontractors),
        misc_cost: mv(q.cost_misc),
      }));

    const job = jobById.get(jobId);
    return {
      jobId,
      label: job?.label ?? null,
      href: `/jobs/${jobId}/commercial`,
      position: computeJobBudgetPosition({
        budget: budgetByJob.get(jobId) ?? null,
        approvedVariationEstimates: variationEstimates,
        actualTotal: profit?.costs_total ?? 0,
        actualByBucket: profit?.costs_by_bucket ?? ZERO,
        remainingCommitted: committed.remaining,
        revisedValueNet: contract.revisedNet,
      }),
    };
  });

  return computeCvrRollup(inputs);
}

// ---------------------------------------------------------------------------
// Group: material demand (composes the stock seam)
// ---------------------------------------------------------------------------

export async function gatherMaterialDemand(
  db: IntelligenceClient,
  orgId: string,
  todayIso: string,
): Promise<MaterialDemand> {
  const requests = await allRows("intelligence: material requests", (from, to) =>
    db
      .from("material_requests")
      .select("id, status, needed_by, job_id")
      .eq("org_id", orgId)
      .in("status", MATERIAL_REQUEST_OPEN_STATUSES)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const demandSet = new Set<string>(DEMAND_STATUSES);
  const demandRequestIds = requests
    .filter((r) => demandSet.has(String(r.status)))
    .map((r) => String(r.id));

  let lines: Row[] = [];
  if (demandRequestIds.length > 0) {
    lines = await allRows("intelligence: material request lines", (from, to) =>
      db
        .from("material_request_lines")
        .select("id, material_request_id, description, qty, unit, stock_item_id")
        .eq("org_id", orgId)
        .in("material_request_id", demandRequestIds)
        .order("material_request_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
  }

  // The stock seam — the ONLY reader of issue movements, feature-detected.
  const { issued, stockModulePending } = await readIssuedForLines(
    db as unknown as StockSeamClient,
    orgId,
    lines.map((l) => String(l.id)),
  );

  return computeMaterialDemand({
    requests: requests as unknown as DemandRequest[],
    lines: lines as unknown as DemandLine[],
    issued,
    stockModulePending,
    todayIso,
  });
}

// ---------------------------------------------------------------------------
// Group: snag patterns
// ---------------------------------------------------------------------------

export async function gatherSnagPatterns(
  db: IntelligenceClient,
  orgId: string,
  jobs: JobLite[],
  todayIso: string,
): Promise<SnagPatterns> {
  const snags = await allRows("intelligence: snags", (from, to) =>
    db
      .from("snags")
      .select("id, job_id, trade, status, priority, due_date")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const jobLabel = new Map<string, string>();
  for (const j of jobs) if (j.label) jobLabel.set(j.id, j.label);

  return computeSnagPatterns({
    snags: snags as unknown as SnagRow[],
    jobLabel,
    todayIso,
  });
}

// ---------------------------------------------------------------------------
// The assembled view
// ---------------------------------------------------------------------------

/** A group either computed WHOLE, or failed WHOLE and says so. */
export type SignalGroup<T> = { data: T; failed: false } | { data: null; failed: true };

export interface CompanySignalsView {
  /** The as-at business day for date-column comparisons (invoice authority). */
  asAtIso: string;
  /** The London day the page rendered for. */
  todayKey: string;
  utilisation: SignalGroup<OrgUtilisation>;
  concentration: SignalGroup<CustomerConcentration>;
  progress: SignalGroup<{ rollup: ProgressRollup; capped: boolean }>;
  exposure: SignalGroup<{
    retention: RetentionExposure;
    agedDebt: AgedDebtSummary;
  }>;
  cvr: SignalGroup<CvrRollup>;
  materials: SignalGroup<MaterialDemand>;
  snags: SignalGroup<SnagPatterns>;
}

/** How far back utilisation looks (London days, inclusive of today). */
export const UTILISATION_WINDOW_DAYS = 30;
/** How far back concentration looks (London months). */
export const CONCENTRATION_WINDOW_MONTHS = 12;

async function group<T>(context: string, run: () => Promise<T>): Promise<SignalGroup<T>> {
  try {
    return { data: await run(), failed: false };
  } catch (err) {
    // The gathers already threw a described readFailure; report it so Sentry
    // sees the panel-scoped failure, then let the card render its error block.
    reportReadFailure(context, {
      message: err instanceof Error ? err.message : String(err),
    });
    return { data: null, failed: true };
  }
}

/**
 * Load every company signal for one org. `now` is injectable so tests and the
 * page pin one instant, and every windowed figure states the same day.
 */
export async function loadCompanySignals(
  orgId: string,
  now: Date = new Date(),
): Promise<CompanySignalsView> {
  const supabase = await createClient();
  const db = supabase as unknown as IntelligenceClient;

  const asAtIso = invoiceBusinessToday(now);
  const todayKey = formatDayKeyUK(now);
  const window30 = trailingDayWindow(now, UTILISATION_WINDOW_DAYS);
  const window12m = trailingMonthsWindow(now, CONCENTRATION_WINDOW_MONTHS);

  // The shared jobs read feeds four groups. If IT fails, those groups fail —
  // whole, loudly, individually.
  let jobs: JobLite[] | null = null;
  try {
    jobs = await gatherJobs(db, orgId);
  } catch (err) {
    reportReadFailure("intelligence: jobs (shared)", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const [utilisation, concentration, progress, exposure, cvr, materials, snags] =
    await Promise.all([
      group("intelligence: utilisation", () =>
        gatherUtilisation(db, orgId, window30, now.getTime()),
      ),
      group("intelligence: concentration", async () => {
        if (!jobs) throw new Error("jobs read failed");
        return gatherConcentration(db, orgId, window12m, jobs);
      }),
      group("intelligence: progress rollup", async () => {
        if (!jobs) throw new Error("jobs read failed");
        return gatherProgressRollup(db, orgId, jobs, now);
      }),
      group("intelligence: exposure", async () => {
        // Composed whole services — each already active-org pinned, paged and
        // loud internally; their loadError flags are honoured as failures so
        // an errored ledger can never render as "£0 outstanding".
        const [retention, aged] = await Promise.all([
          buildRetentionRegisterView(orgId, now),
          // Debtors only on this surface — role "staff" skips the payables
          // read entirely (creditors are admin-gated and unused here).
          buildAgedLedgers(orgId, "staff", now),
        ]);
        if (retention.loadError || aged.loadError) {
          throw new Error("exposure ledgers read failed");
        }
        return {
          retention: computeRetentionExposure(retention.register.totals),
          agedDebt: computeAgedDebtSummary(aged.debtors.totals),
        };
      }),
      group("intelligence: cvr rollup", async () => {
        if (!jobs) throw new Error("jobs read failed");
        return gatherCvrRollup(db, orgId, jobs);
      }),
      group("intelligence: material demand", () => gatherMaterialDemand(db, orgId, asAtIso)),
      group("intelligence: snag patterns", async () => {
        if (!jobs) throw new Error("jobs read failed");
        return gatherSnagPatterns(db, orgId, jobs, asAtIso);
      }),
    ]);

  return {
    asAtIso,
    todayKey,
    utilisation,
    concentration,
    progress,
    exposure,
    cvr,
    materials,
    snags,
  };
}
