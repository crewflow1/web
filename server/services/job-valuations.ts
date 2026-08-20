import "server-only";

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { round2, toPounds } from "@/lib/money";
import { computeRetentionPosition, type RetentionPosition } from "@/lib/retentions/compute";
import {
  resolveValuationFigures,
  sumCertifiedBase,
  type CumulationValuation,
  type ValuationFigures,
  type ValuationStatus,
} from "@/lib/valuations/compute";

/**
 * THE job-valuations read — org-pinned, paged, LOUD.
 *
 * Reads a job's interim valuations, the variation links, the job's invoices and
 * retention releases, and composes the per-period figures (via the pure
 * `resolveValuationFigures`) plus the job's DERIVED retention position (via the
 * existing `computeRetentionPosition` authority — never re-implemented here).
 *
 * The three loud-read rules (mirrors server/services/retention-register.ts):
 *   1. Org-pinned — every read carries its own `.eq("org_id", orgId)`; RLS
 *      returns ALL the viewer's orgs, so RLS is not scoping.
 *   2. Paged with a unique total order — every read goes through `fetchAllRows`
 *      and appends `id` to the ordering so no page-boundary row is dropped.
 *   3. Loud on failure — a failed read sets `loadError`; the page shows a banner
 *      instead of a silent "£0 / nothing certified" (understated money).
 *
 * READ ONLY — this service performs no insert/update/delete/rpc.
 */

type Row = Record<string, unknown>;

type AnyB = PromiseLike<{ data: Row[] | null }> & {
  select: (c: string) => AnyB;
  order: (k: string, o: { ascending: boolean }) => AnyB;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  eq: (k: string, v: unknown) => AnyB;
};
type LooseClient = { from: (t: string) => AnyB };

const mv = (v: unknown) => v as number | string | null;
const sv = (v: unknown) => (v == null ? null : String(v));

export type JobValuationLine = {
  id: string;
  sequence: number;
  status: ValuationStatus;
  periodStart: string | null;
  periodEnd: string | null;
  valuationDate: string;
  notes: string | null;
  invoiceId: string | null;
  /** Σ linked variation ex-VAT values (live for drafts; snapshot once certified). */
  variationsTotal: number;
  variationCount: number;
  figures: ValuationFigures;
};

export type JobValuationsView = {
  jobId: string;
  retentionPercent: number;
  /** DERIVED retention position for the job (accrued/released/held). */
  retention: RetentionPosition;
  lines: JobValuationLine[];
  /** Σ certified/invoiced net increments — the cumulative gross certified base. */
  certifiedToDate: number;
  loadError: boolean;
};

function emptyView(jobId: string, loadError: boolean): JobValuationsView {
  return {
    jobId,
    retentionPercent: 0,
    retention: {
      ratePercent: 0,
      invoicedBase: 0,
      accrued: 0,
      released: 0,
      held: 0,
      isActive: false,
      isFullyReleased: false,
    },
    lines: [],
    certifiedToDate: 0,
    loadError,
  };
}

async function paged(
  db: LooseClient,
  table: string,
  cols: string,
  orderKey: string,
  filters: Array<[string, unknown]>,
): Promise<{ rows: Row[]; failed: boolean }> {
  const { data, error } = await fetchAllRows<Row>((from, to) => {
    let base = db.from(table).select(cols);
    for (const [k, v] of filters) base = base.eq(k, v);
    base = base.order(orderKey, { ascending: true });
    return (orderKey === "id" ? base : base.order("id", { ascending: true })).range(from, to);
  });
  return { rows: data, failed: error != null };
}

/**
 * Build the valuations view for ONE job. `orgId` is the active org — passed in,
 * pinned on every read.
 */
export async function buildJobValuationsView(
  orgId: string,
  jobId: string,
): Promise<JobValuationsView> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const [jobsRes, valsRes, linksRes, invRes, relRes] = await Promise.all([
      paged(db, "jobs", "id, retention_percent", "id", [
        ["org_id", orgId],
        ["id", jobId],
      ]),
      paged(
        db,
        "job_valuations",
        "id, sequence, status, period_start, period_end, valuation_date, notes, " +
          "invoice_id, work_completed_to_date, materials_on_site, deductions, vat_rate, " +
          "variations_total, gross_valuation, previous_certified_gross, net_certified_this, " +
          "retention_percent",
        "sequence",
        [
          ["org_id", orgId],
          ["job_id", jobId],
        ],
      ),
      paged(db, "job_valuation_variations", "id, valuation_id, amount", "id", [
        ["org_id", orgId],
      ]),
      // Retention base + the whole invoice set for this job (status owns which
      // are certified; `paid` is derived elsewhere — retention uses `amount`).
      paged(db, "invoices", "id, job_id, status, amount", "id", [["org_id", orgId]]),
      paged(db, "retention_releases", "id, job_id, amount", "id", [["org_id", orgId]]),
    ]);

    const loadError =
      jobsRes.failed || valsRes.failed || linksRes.failed || invRes.failed || relRes.failed;

    const job = jobsRes.rows[0];
    const retentionPercent = Math.min(100, Math.max(0, toPounds(mv(job?.retention_percent))));

    // Live variation totals per draft valuation (certified rows use their snapshot).
    const linkTotals = new Map<string, { total: number; count: number }>();
    for (const l of linksRes.rows) {
      const vid = sv(l.valuation_id);
      if (!vid) continue;
      const cur = linkTotals.get(vid) ?? { total: 0, count: 0 };
      cur.total = round2(cur.total + toPounds(mv(l.amount)));
      cur.count += 1;
      linkTotals.set(vid, cur);
    }

    // Cumulation set: id + status + net_certified_this for the whole job.
    const cumulation: CumulationValuation[] = valsRes.rows.map((r) => ({
      id: String(r.id),
      status: sv(r.status),
      net_certified_this: mv(r.net_certified_this),
    }));

    const lines: JobValuationLine[] = valsRes.rows.map((r) => {
      const id = String(r.id);
      const status = (sv(r.status) ?? "draft") as ValuationStatus;
      const link = linkTotals.get(id) ?? { total: 0, count: 0 };
      // Certified rows carry a frozen variations_total; drafts use the live links.
      const isCertified = status === "certified" || status === "invoiced";
      const variationsTotal = isCertified
        ? round2(toPounds(mv(r.variations_total)))
        : link.total;
      const figures = resolveValuationFigures(
        {
          id,
          status,
          work_completed_to_date: mv(r.work_completed_to_date),
          materials_on_site: mv(r.materials_on_site),
          deductions: mv(r.deductions),
          vat_rate: mv(r.vat_rate),
          variations_total: mv(r.variations_total),
          gross_valuation: mv(r.gross_valuation),
          previous_certified_gross: mv(r.previous_certified_gross),
          net_certified_this: mv(r.net_certified_this),
          retention_percent: mv(r.retention_percent),
        },
        cumulation,
        variationsTotal,
        retentionPercent,
      );
      return {
        id,
        sequence: Number(r.sequence ?? 0),
        status,
        periodStart: sv(r.period_start),
        periodEnd: sv(r.period_end),
        valuationDate: sv(r.valuation_date) ?? "",
        notes: sv(r.notes),
        invoiceId: sv(r.invoice_id),
        variationsTotal,
        variationCount: link.count,
        figures,
      };
    });

    // Retention position — DERIVED by the existing authority from THIS job's
    // invoices (status owns certification) + releases.
    const jobInvoices = invRes.rows
      .filter((i) => sv(i.job_id) === jobId)
      .map((i) => ({ status: String(i.status ?? ""), amount: mv(i.amount) }));
    const jobReleases = relRes.rows
      .filter((rr) => sv(rr.job_id) === jobId)
      .map((rr) => ({ amount: mv(rr.amount) }));
    const retention = computeRetentionPosition({
      ratePercent: retentionPercent,
      invoices: jobInvoices,
      releases: jobReleases,
    });

    return {
      jobId,
      retentionPercent,
      retention,
      lines,
      certifiedToDate: sumCertifiedBase(cumulation),
      loadError,
    };
  } catch {
    return emptyView(jobId, true);
  }
}
