import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { round2, toPounds } from "@/lib/money";
import { computeRetentionDueRollup } from "@/lib/retentions/rollup";
import {
  computeOrgCashSummary,
  buildCashQueues,
  type OrgCashInvoice,
  type OrgCashSummary,
  type CashQueueItem,
} from "@/lib/commercial/org-cash";

/**
 * H2-CASH M2 — the org-wide "Get Paid" view.
 *
 * RLS-scoped, PAGED reads composing the existing authorities (invoice ledger +
 * computeRetentionDueRollup + billing stages). No new cash engine, no re-summed
 * outstanding. Best-effort: any failure returns an empty view, never throwing.
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
export interface OrgCashView {
  summary: OrgCashSummary;
  queues: { overdue: CashQueueItem[]; dueSoon: CashQueueItem[]; partPaid: CashQueueItem[] };
  recentlyPaid: RecentPayment[];
  readyStages: ReadyStage[];
}

const EMPTY: OrgCashView = {
  summary: {
    owedNow: 0, overdue: 0, dueThisWeek: 0, dueThisMonth: 0, retentionHeld: 0,
    retentionDueNow: 0, collectableNow: 0, readyToInvoice: 0, overdueCount: 0, invoiceCount: 0,
  },
  queues: { overdue: [], dueSoon: [], partPaid: [] },
  recentlyPaid: [],
  readyStages: [],
};

async function paged(db: LooseClient, table: string, cols: string, orderKey: string): Promise<Row[]> {
  const { data } = await fetchAllRows<Row>((from, to) =>
    db.from(table).select(cols).order(orderKey, { ascending: true }).range(from, to),
  );
  return data;
}

export async function buildOrgCash(orgId: string, now: Date = new Date()): Promise<OrgCashView> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const [invoiceRows, paymentRows, jobRows, customerRows, releaseRows, planRows] = await Promise.all([
      paged(db, "invoices", "id, number, status, total, amount, due_date, job_id, paid_at", "id"),
      paged(db, "invoice_payments", "invoice_id, amount, paid_at", "invoice_id"),
      paged(db, "jobs", "id, customer_id, retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct", "id"),
      paged(db, "customers", "id, name", "id"),
      paged(db, "retention_releases", "job_id, amount", "job_id"),
      paged(db, "job_billing_plans", "id, status", "id"),
    ]);

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

    // Retention held/due across the org — reuse the authority.
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

    // Ready-to-invoice: planned (un-invoiced) stages of ACTIVE plans.
    const activePlanIds = planRows.filter((p) => String(p.status) === "active").map((p) => String(p.id));
    let readyStages: ReadyStage[] = [];
    if (activePlanIds.length > 0) {
      const stageRows = (await db.from("job_billing_stages").select("job_id, name, amount, plan_id, invoice_id").is("invoice_id", null).in("plan_id", activePlanIds)).data ?? [];
      readyStages = stageRows
        .filter((s) => toPounds(mv(s.amount)) > 0)
        .map((s) => ({ jobId: String(s.job_id), jobLabel: jobLabel.get(String(s.job_id)) ?? null, name: String(s.name ?? ""), amount: round2(toPounds(mv(s.amount))) }));
    }
    const readyToInvoice = readyStages.reduce((acc, s) => round2(acc + s.amount), 0);

    const summary = computeOrgCashSummary({ invoices, retentionHeld: rollup.totalHeld, retentionDueNow: rollup.dueNow, readyToInvoice, now });
    const queues = buildCashQueues({ invoices, now });

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

    return { summary, queues, recentlyPaid, readyStages };
  } catch (err) {
    console.warn("[org-cash] buildOrgCash failed", err);
    return EMPTY;
  }
}
