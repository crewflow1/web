import "server-only";
import { createClient } from "@/lib/supabase/server";
import { round2, toPounds } from "@/lib/money";
import { computeCommercialCash } from "@/lib/commercial/cash";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeGetPaidSummary, type GetPaidSummary } from "@/lib/billing/summary";
import { deriveStageStatus } from "@/lib/billing/plan";
import type { StageStatus } from "@/lib/billing/types";

/**
 * Load a job's billing plan + the reconciled "Get Paid" summary.
 *
 * COMPOSES the existing authorities — computeCommercialCash (cash) and
 * computeRetentionPosition (retention) — and never re-sums invoices/payments.
 * RLS-scoped (the caller's JWT). Best-effort: any failure returns an empty view
 * rather than throwing, so this additive surface can't break the job page.
 */

type Row = Record<string, unknown>;
/** Permissive, self-returning view of the query builder (billing tables aren't in the generated types). */
type AnyB = PromiseLike<{ data: Row[] | null }> & {
  select: (c: string) => AnyB;
  eq: (k: string, v: unknown) => AnyB;
  order: (k: string, o: { ascending: boolean }) => AnyB;
  maybeSingle: () => PromiseLike<{ data: Row | null }>;
};
type LooseClient = { from: (t: string) => AnyB };
/** Cast an untyped Row value to the money-ish shape toPounds accepts. */
const mv = (v: unknown) => v as number | string | null;

export interface BillingStageView {
  id: string;
  sequence: number;
  name: string;
  kind: string;
  basis: string;
  percent: number | null;
  amount: number;
  vatRate: number;
  vatAmount: number;
  gross: number;
  dueDate: string | null;
  retentionApplies: boolean;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: StageStatus;
}

export interface JobBillingView {
  plan: { id: string; structure: string; basisAmount: number; status: string } | null;
  stages: BillingStageView[];
  summary: GetPaidSummary;
  /** Planned (un-invoiced) stages, for the ready-to-invoice signal. */
  readyStages: { name: string; amount: number }[];
  jobHasCustomer: boolean;
  /** Ex-VAT contract value (Σ accepted quote subtotals) — prefills a new plan's basis. */
  suggestedBasisNet: number;
}

const EMPTY_SUMMARY: GetPaidSummary = {
  contractNet: 0, scheduledNet: 0, unscheduledNet: 0, hasPlan: false,
  billed: 0, received: 0, outstanding: 0, overdue: 0, stillToBill: 0,
  retentionHeld: 0, collectableNow: 0,
};

const ACCEPTED = "accepted";

export async function loadJobBilling(orgId: string, jobId: string): Promise<JobBillingView> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const [planRes, jobRes, invoicesRes, quotesRes, releasesRes] = await Promise.all([
      db.from("job_billing_plans").select("id, structure, basis_amount, status").eq("job_id", jobId).eq("status", "active").maybeSingle(),
      db.from("jobs").select("retention_percent, customer_id").eq("id", jobId).maybeSingle(),
      db.from("invoices").select("id, number, status, total, amount, due_date").eq("job_id", jobId),
      db.from("quotes").select("status, total, subtotal, variation_number").eq("job_id", jobId),
      db.from("retention_releases").select("amount").eq("job_id", jobId),
    ]);

    const plan = planRes.data;
    const invoiceRows = (invoicesRes.data ?? []) as Row[];
    const invoiceIds = invoiceRows.map((i) => String(i.id));

    // Per-invoice paid ledger (Σ invoice_payments) — for cash.received + stage status.
    const paymentsRes = invoiceIds.length
      ? await db.from("invoice_payments").select("invoice_id, amount").eq("org_id", orgId)
      : { data: [] as Row[] };
    const payments = ((paymentsRes.data ?? []) as Row[])
      .filter((p) => invoiceIds.includes(String(p.invoice_id)))
      .map((p) => ({ invoice_id: String(p.invoice_id), amount: p.amount as number | string | null }));
    const paidByInvoice = new Map<string, number>();
    for (const p of payments) {
      paidByInvoice.set(p.invoice_id, round2((paidByInvoice.get(p.invoice_id) ?? 0) + toPounds(p.amount)));
    }

    const cash = computeCommercialCash({
      quotes: ((quotesRes.data ?? []) as Row[]).map((q) => ({
        status: String(q.status ?? ""), total: q.total as number | string | null, variation_number: (q.variation_number as number | null) ?? null,
      })),
      invoices: invoiceRows.map((i) => ({
        id: String(i.id), status: String(i.status ?? ""), total: i.total as number | string | null, due_date: (i.due_date as string | null) ?? null,
      })),
      payments,
    });

    const retention = computeRetentionPosition({
      ratePercent: toPounds((jobRes.data as Row | null)?.retention_percent as number | string | null),
      invoices: invoiceRows.map((i) => ({ status: String(i.status ?? ""), amount: i.amount as number | string | null })),
      releases: ((releasesRes.data ?? []) as Row[]).map((r) => ({ amount: r.amount as number | string | null })),
    });

    const invoiceById = new Map(invoiceRows.map((i) => [String(i.id), i]));
    const stageRows = plan
      ? (((await db.from("job_billing_stages").select("id, sequence, name, kind, basis, percent, amount, vat_rate, due_date, retention_applies, invoice_id").eq("plan_id", String(plan.id)).order("sequence", { ascending: true })).data ?? []) as Row[])
      : [];

    const stages: BillingStageView[] = stageRows.map((s) => {
      const amount = round2(toPounds(mv(s.amount)));
      const vatRate = toPounds(mv(s.vat_rate));
      const vatAmount = round2((amount * vatRate) / 100);
      const invId = (s.invoice_id as string | null) ?? null;
      const inv = invId ? invoiceById.get(invId) : null;
      return {
        id: String(s.id),
        sequence: Number(s.sequence ?? 0),
        name: String(s.name ?? ""),
        kind: String(s.kind ?? "stage"),
        basis: String(s.basis ?? "fixed"),
        percent: (s.percent as number | null) ?? null,
        amount, vatRate, vatAmount, gross: round2(amount + vatAmount),
        dueDate: (s.due_date as string | null) ?? null,
        retentionApplies: Boolean(s.retention_applies ?? true),
        invoiceId: invId,
        invoiceNumber: inv ? String(inv.number ?? "") || null : null,
        status: deriveStageStatus(
          inv ? { status: String(inv.status ?? ""), due_date: (inv.due_date as string | null) ?? null, total: inv.total as number | string | null, paid: paidByInvoice.get(invId!) ?? 0 } : null,
        ),
      };
    });

    const scheduledNet = stages.reduce((acc, s) => round2(acc + s.amount), 0);
    const summary = computeGetPaidSummary({
      cash,
      retentionHeld: retention.held,
      contractNet: plan ? round2(toPounds(mv(plan.basis_amount))) : 0,
      scheduledNet,
      hasPlan: Boolean(plan),
    });

    return {
      plan: plan ? { id: String(plan.id), structure: String(plan.structure), basisAmount: round2(toPounds(mv(plan.basis_amount))), status: String(plan.status) } : null,
      stages,
      summary,
      readyStages: stages.filter((s) => s.status === "planned" && s.amount > 0).map((s) => ({ name: s.name, amount: s.amount })),
      jobHasCustomer: Boolean((jobRes.data as Row | null)?.customer_id),
      suggestedBasisNet: ((quotesRes.data ?? []) as Row[])
        .filter((q) => String(q.status ?? "") === ACCEPTED)
        .reduce((acc, q) => round2(acc + toPounds(q.subtotal as number | string | null)), 0),
    };
  } catch (err) {
    console.warn("[billing] loadJobBilling failed", err);
    return { plan: null, stages: [], summary: EMPTY_SUMMARY, readyStages: [], jobHasCustomer: false, suggestedBasisNet: 0 };
  }
}
