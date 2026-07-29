import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { round2, toPounds } from "@/lib/money";
import { OVERDUE_COLLECTABLE_STATUSES } from "@/lib/invoices/overdue";
import { computeRetentionDueRollup } from "@/lib/retentions/rollup";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeOrgRetentionNetting, type OrgRetentionJob } from "@/lib/commercial/retention-attribution";
import {
  computeJobCashForecast,
  aggregateCashForecast,
  type JobCashForecast,
  type OrgCashForecast,
} from "@/lib/commercial/cash-forecast";
import {
  computeOrgCashSummary,
  buildCashQueues,
  type OrgCashInvoice,
  type OrgCashSummary,
  type CashQueueItem,
} from "@/lib/commercial/org-cash";

/**
 * H2-CASH — the org-wide "Get Paid" view (M2) + precise position and forecast (M3).
 *
 * RLS-scoped, PAGED reads composing the existing authorities (invoice ledger +
 * retention + billing stages + the live quote contract). No new cash engine, no
 * re-summed outstanding. M3 adds per-job grouping so:
 *   - collectableNow nets ONLY retention embedded in unpaid invoices (precise);
 *   - the forecast distinguishes overdue / due / planned / unscheduled;
 *   - org totals === Σ per-job positions (reconciliation by construction).
 * Best-effort: any failure returns an empty view, never throwing.
 */

type Row = Record<string, unknown>;
type AnyB = PromiseLike<{ data: Row[] | null }> & {
  select: (c: string) => AnyB;
  order: (k: string, o: { ascending: boolean }) => AnyB;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  eq: (k: string, v: unknown) => AnyB;
  is: (k: string, v: null) => AnyB;
  in: (k: string, v: unknown[]) => AnyB;
};
type LooseClient = { from: (t: string) => AnyB };
const mv = (v: unknown) => v as number | string | null;

export interface RecentPayment {
  invoiceNumber: string | null;
  amount: number;
  paidAt: string | null;
  jobLabel: string | null;
  href: string;
}
export interface ReadyStage {
  jobId: string;
  jobLabel: string | null;
  name: string;
  amount: number;
}
/** A job with revised contract value that has no billing stage and no invoice. */
export interface UnscheduledJob {
  jobId: string;
  jobLabel: string | null;
  amount: number;
  href: string;
}
export interface OrgCashView {
  summary: OrgCashSummary;
  /** M3: deterministic short-horizon forecast (overdue/due/planned/unscheduled). */
  forecast: OrgCashForecast;
  queues: { overdue: CashQueueItem[]; dueSoon: CashQueueItem[]; partPaid: CashQueueItem[] };
  recentlyPaid: RecentPayment[];
  readyStages: ReadyStage[];
  /** M3: jobs carrying contract value with no plan and no invoice (a chase-the-plan nudge). */
  unscheduledJobs: UnscheduledJob[];
  /** M3: held retention NOT embedded in any unpaid invoice (a future receivable). */
  retentionOutsideOutstanding: number;
  /** True when the reads failed — the caller shows a "couldn't load" banner rather
   * than a falsely-reassuring all-zero "nothing owed" cockpit. */
  loadError: boolean;
}

const EMPTY: OrgCashView = {
  summary: {
    owedNow: 0, overdue: 0, dueThisWeek: 0, dueThisMonth: 0, retentionHeld: 0,
    retentionDueNow: 0, retentionWithheldFromCollectable: 0, collectableNow: 0,
    readyToInvoice: 0, overdueCount: 0, invoiceCount: 0,
  },
  forecast: {
    overdue: 0, due: { next7: 0, next30: 0, later: 0, undated: 0 },
    draftedNotIssued: 0, planned: { next7: 0, next30: 0, later: 0, undated: 0 },
    plannedTotal: 0, plannedCapped: 0, revised: 0, billed: 0, stillToBill: 0, unscheduled: 0,
    dueNext7: 0, dueNext30: 0, plannedNext7: 0, plannedNext30: 0,
  },
  queues: { overdue: [], dueSoon: [], partPaid: [] },
  recentlyPaid: [],
  readyStages: [],
  unscheduledJobs: [],
  retentionOutsideOutstanding: 0,
  loadError: true,
};

/**
 * Read every row of a table for ONE org — RLS-scoped AND explicitly `org_id`-
 * pinned. The pin is load-bearing, not just defence-in-depth: current_org_ids()
 * returns EVERY org the viewer belongs to (memberships are many-to-many), so a
 * user in two orgs would otherwise see both orgs' cash blended on one org's page.
 */
async function paged(
  db: LooseClient,
  table: string,
  cols: string,
  orderKey: string,
  orgId: string,
): Promise<{ rows: Row[]; failed: boolean }> {
  const { data, error } = await fetchAllRows<Row>((from, to) => {
    // fetchAllRows requires a UNIQUE total order or rows sharing the sort key can
    // be dropped/duplicated at a page boundary (the F-1 silent-truncation class).
    // Several reads order by a NON-unique FK (invoice_id / job_id), so always
    // append the primary-key `id` as a stable tiebreaker.
    const base = db.from(table).select(cols).eq("org_id", orgId).order(orderKey, { ascending: true });
    return (orderKey === "id" ? base : base.order("id", { ascending: true })).range(from, to);
  });
  // Best-effort posture stands (partial rows are used), but a partial read must
  // set the page's existing loadError banner — never silently understate money.
  return { rows: data, failed: error != null };
}

/** Group a row list by a (possibly-null) key, using "" for null. */
function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r[key] == null ? "" : String(r[key]);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

export async function buildOrgCash(orgId: string, now: Date = new Date()): Promise<OrgCashView> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const pagedResults = await Promise.all([
      paged(db, "invoices", "id, number, status, total, amount, due_date, job_id, paid_at", "id", orgId),
      paged(db, "invoice_payments", "invoice_id, amount, paid_at", "invoice_id", orgId),
      paged(db, "jobs", "id, customer_id, retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct", "id", orgId),
      paged(db, "customers", "id, name", "id", orgId),
      paged(db, "retention_releases", "job_id, amount", "job_id", orgId),
      paged(db, "job_billing_plans", "id, status", "id", orgId),
      paged(db, "quotes", "job_id, variation_number, status, total", "job_id", orgId),
    ]);
    let partialLoad = pagedResults.some((r) => r.failed);
    const [
      invoiceRows = [],
      paymentRows = [],
      jobRows = [],
      customerRows = [],
      releaseRows = [],
      planRows = [],
      quoteRows = [],
    ] = pagedResults.map((r) => r.rows);

    // Per-invoice paid (ledger).
    const paidByInvoice = new Map<string, number>();
    for (const p of paymentRows) {
      const id = String(p.invoice_id);
      paidByInvoice.set(id, round2((paidByInvoice.get(id) ?? 0) + toPounds(mv(p.amount))));
    }
    // Job → customer-name label.
    const customerName = new Map(customerRows.map((c) => [String(c.id), String(c.name ?? "")]));
    const jobLabel = new Map<string, string | null>();
    for (const j of jobRows) jobLabel.set(String(j.id), customerName.get(String(j.customer_id ?? "")) ?? null);

    const invoices: OrgCashInvoice[] = invoiceRows.map((i) => ({
      id: String(i.id),
      number: (i.number as string | null) ?? null,
      status: String(i.status ?? ""),
      total: mv(i.total),
      due_date: (i.due_date as string | null) ?? null,
      paid: paidByInvoice.get(String(i.id)) ?? 0,
      jobId: (i.job_id as string | null) ?? null,
      jobLabel: i.job_id ? jobLabel.get(String(i.job_id)) ?? null : null,
    }));

    // Retention held/due across the org — reuse the authority (drives the tiles).
    const rollup = computeRetentionDueRollup({
      jobs: jobRows.map((j) => ({
        id: String(j.id),
        ratePercent: mv(j.retention_percent),
        practicalCompletionDate: (j.practical_completion_date as string | null) ?? null,
        defectsLiabilityMonths: mv(j.defects_liability_months),
        firstReleasePct: mv(j.retention_first_release_pct),
      })),
      invoices: invoiceRows.map((i) => ({ job_id: (i.job_id as string | null) ?? null, status: String(i.status ?? ""), amount: mv(i.amount) })),
      releases: releaseRows.map((r) => ({ job_id: (r.job_id as string | null) ?? null, amount: mv(r.amount) })),
      now,
    });

    // Ready-to-invoice + forecast planned billing: planned (un-invoiced) stages of
    // ACTIVE plans. One paged, org-pinned read (never a silently-truncated bare select).
    const activePlanIds = planRows.filter((p) => String(p.status) === "active").map((p) => String(p.id));
    let stageRows: Row[] = [];
    if (activePlanIds.length > 0) {
      const { data, error } = await fetchAllRows<Row>((from, to) =>
        db.from("job_billing_stages")
          .select("id, job_id, name, amount, vat_rate, due_date, plan_id, invoice_id")
          .eq("org_id", orgId)
          .is("invoice_id", null)
          .in("plan_id", activePlanIds)
          .order("id", { ascending: true })
          .range(from, to),
      );
      if (error != null) partialLoad = true;
      stageRows = data;
    }
    const readyStages: ReadyStage[] = stageRows
      .filter((s) => toPounds(mv(s.amount)) > 0)
      .map((s) => ({ jobId: String(s.job_id), jobLabel: jobLabel.get(String(s.job_id)) ?? null, name: String(s.name ?? ""), amount: round2(toPounds(mv(s.amount))) }));
    const readyToInvoice = readyStages.reduce((acc, s) => round2(acc + s.amount), 0);

    // ── Per-job grouping → precise retention netting + forecast (org === Σ jobs) ──
    const invByJob = groupBy(invoiceRows, "job_id");
    const quotesByJob = groupBy(quoteRows, "job_id");
    const stagesByJob = groupBy(stageRows, "job_id");
    const releasesByJob = groupBy(releaseRows, "job_id");
    const jobsById = new Map(jobRows.map((j) => [String(j.id), j]));

    // Universe of job ids to position: any job touched by an invoice, quote, stage,
    // release, or the jobs table itself (plus "" = invoices with no job).
    const jobIds = new Set<string>([
      ...invByJob.keys(), ...quotesByJob.keys(), ...stagesByJob.keys(),
      ...releasesByJob.keys(), ...jobRows.map((j) => String(j.id)),
    ]);

    const nettingJobs: OrgRetentionJob[] = [];
    const jobForecasts: JobCashForecast[] = [];
    const unscheduledJobs: UnscheduledJob[] = [];

    for (const jid of jobIds) {
      const jInv = invByJob.get(jid) ?? [];
      const job = jid ? jobsById.get(jid) : null;
      const ratePercent = mv(job?.retention_percent);

      // Per-job retention held (the authority) — for the netting cap.
      const position = computeRetentionPosition({
        ratePercent,
        invoices: jInv.map((i) => ({ status: String(i.status ?? ""), amount: mv(i.amount) })),
        releases: (releasesByJob.get(jid) ?? []).map((r) => ({ amount: mv(r.amount) })),
      });
      nettingJobs.push({
        ratePercent,
        retentionHeld: position.held,
        // Embedded retention must be netted over the SAME universe owedNow counts
        // (the COLLECTABLE statuses), NOT all non-draft. A `paid` invoice that
        // carries a residual balance (its total was edited up after settlement)
        // is excluded from owedNow, so netting its retention would steal cash from
        // other jobs and break org === Σ jobs. `retentionHeld` stays the authority
        // figure (accrued over all non-draft − released) — only the embedding set
        // is aligned to owedNow.
        invoices: jInv
          .filter((i) => (OVERDUE_COLLECTABLE_STATUSES as readonly string[]).includes(String(i.status ?? "")))
          .map((i) => ({
            net: mv(i.amount),
            grossRemaining: round2(Math.max(0, toPounds(mv(i.total)) - (paidByInvoice.get(String(i.id)) ?? 0))),
          })),
      });

      const forecast = computeJobCashForecast({
        quotes: (quotesByJob.get(jid) ?? []).map((qr) => ({
          variation_number: (qr.variation_number as number | null) ?? null,
          status: String(qr.status ?? ""),
          total: mv(qr.total),
        })),
        invoices: jInv.map((i) => ({
          status: String(i.status ?? ""),
          total: mv(i.total),
          due_date: (i.due_date as string | null) ?? null,
          paid: paidByInvoice.get(String(i.id)) ?? 0,
        })),
        stages: (stagesByJob.get(jid) ?? []).map((s) => ({
          invoice_id: (s.invoice_id as string | null) ?? null,
          amount: mv(s.amount),
          vat_rate: mv(s.vat_rate),
          due_date: (s.due_date as string | null) ?? null,
        })),
        now,
      });
      jobForecasts.push(forecast);
      if (jid && forecast.unscheduled > 0) {
        unscheduledJobs.push({ jobId: jid, jobLabel: jobLabel.get(jid) ?? null, amount: forecast.unscheduled, href: `/jobs/${jid}/billing` });
      }
    }

    const orgNetting = computeOrgRetentionNetting(nettingJobs);
    const forecast = aggregateCashForecast(jobForecasts);

    const summary = computeOrgCashSummary({
      invoices,
      retentionHeld: rollup.totalHeld,
      retentionDueNow: rollup.dueNow,
      retentionWithheldFromCollectable: orgNetting.withheldFromCollectable,
      readyToInvoice,
      now,
    });
    const queues = buildCashQueues({ invoices, now });

    unscheduledJobs.sort((a, b) => b.amount - a.amount);

    // Recently paid — the last handful of receipts (positive cash visibility).
    const invoiceNumberById = new Map(invoiceRows.map((i) => [String(i.id), (i.number as string | null) ?? null]));
    const invoiceJobById = new Map(invoiceRows.map((i) => [String(i.id), (i.job_id as string | null) ?? null]));
    const recentlyPaid: RecentPayment[] = paymentRows
      .filter((p) => p.paid_at)
      .sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)))
      .slice(0, 8)
      .map((p) => {
        const invId = String(p.invoice_id);
        const jid = invoiceJobById.get(invId);
        return {
          invoiceNumber: invoiceNumberById.get(invId) ?? null,
          amount: round2(toPounds(mv(p.amount))),
          paidAt: (p.paid_at as string | null) ?? null,
          jobLabel: jid ? jobLabel.get(String(jid)) ?? null : null,
          href: `/invoices/${invId}`,
        };
      });

    return {
      summary,
      forecast,
      queues,
      recentlyPaid,
      readyStages,
      unscheduledJobs,
      retentionOutsideOutstanding: orgNetting.heldOutsideOutstanding,
      loadError: partialLoad,
    };
  } catch (err) {
    console.warn("[org-cash] buildOrgCash failed", err);
    return EMPTY;
  }
}
