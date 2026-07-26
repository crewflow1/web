import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobBilling, type BillingStageView } from "@/server/services/billing";
import { formatGbp } from "@/lib/money";
import type { StageStatus } from "@/lib/billing/types";
import {
  createBillingPlan,
  addBillingStage,
  generateStageInvoice,
  deleteBillingStage,
  cancelBillingPlan,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<StageStatus, string> = {
  planned: "bg-slate-100 text-slate-600",
  invoiced: "bg-blue-100 text-blue-700",
  part_paid: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};
const STATUS_LABEL: Record<StageStatus, string> = {
  planned: "Planned",
  invoiced: "Invoiced",
  part_paid: "Part paid",
  paid: "Paid",
  overdue: "Overdue",
};

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-bold ${accent ?? "text-slate-900"}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default async function JobBillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const { ctx } = await requireOrgContext();
  const isManager = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const b = await loadJobBilling(ctx.org.id, jobId);
  const s = b.summary;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Get paid</h1>
          <p className="mt-1 text-sm text-slate-600">
            How this job is billed — deposits, stages and what you&rsquo;re owed.
          </p>
        </div>
        <Link href={`/jobs/${jobId}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          ← Back to job
        </Link>
      </header>

      {!b.jobHasCustomer ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          This job has no customer yet. Set a customer on the job before generating invoices.
        </div>
      ) : null}

      {/* ── Get Paid summary ─────────────────────────────────────────── */}
      <section aria-label="Money summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contract (ex-VAT)" value={formatGbp(s.contractNet)} hint={s.hasPlan ? `${formatGbp(s.scheduledNet)} scheduled` : "no plan yet"} />
        <Stat label="Billed to date" value={formatGbp(s.billed)} hint={`${formatGbp(s.stillToBill)} still to bill`} />
        <Stat label="Received" value={formatGbp(s.received)} accent="text-green-700" />
        <Stat label="Collectable now" value={formatGbp(s.collectableNow)} accent="text-slate-900" hint={s.retentionWithheldFromCollectable > 0 ? `${formatGbp(s.retentionWithheldFromCollectable)} retention still withheld` : undefined} />
      </section>
      {(s.outstanding > 0 || s.overdue > 0) ? (
        <section aria-label="Debtor detail" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Outstanding (gross)" value={formatGbp(s.outstanding)} />
          <Stat label="Overdue" value={formatGbp(s.overdue)} accent={s.overdue > 0 ? "text-red-700" : undefined} />
          <Stat label="Retention held" value={formatGbp(s.retentionHeld)} hint="due back later, not overdue" />
          <Stat label="Unscheduled" value={formatGbp(b.forecast.unscheduled)} hint="contract, no stage & no invoice" />
        </section>
      ) : null}

      {/* ── Cash outlook (M3) — honest due vs planned vs unscheduled ────── */}
      {(b.forecast.overdue > 0 || b.forecast.due.next7 + b.forecast.due.next30 + b.forecast.due.later > 0 || b.forecast.plannedTotal > 0 || b.forecast.unscheduled > 0) ? (
        <section aria-label="Cash outlook" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Due — next 7 days" value={formatGbp(b.forecast.due.next7)} hint="invoiced &amp; due" />
          <Stat label="Due — next 30 days" value={formatGbp(b.forecast.due.next7 + b.forecast.due.next30)} hint="invoiced &amp; due" />
          <Stat label="Planned billing" value={formatGbp(b.forecast.plannedCapped)} hint="agreed stages, not yet invoiced" />
          <Stat label="Unscheduled" value={formatGbp(b.forecast.unscheduled)} accent={b.forecast.unscheduled > 0 ? "text-amber-700" : undefined} hint="no stage, no invoice" />
        </section>
      ) : null}

      {/* ── Plan ─────────────────────────────────────────────────────── */}
      {!b.plan ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Set up how you&rsquo;ll get paid</h2>
          <p className="mt-1 text-sm text-slate-600">Pick a structure and the ex-VAT contract value; then add the stages.</p>
          {isManager ? (
            <form action={createBillingPlan} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="job_id" value={jobId} />
              <label className="text-sm">
                <span className="block text-slate-600">Structure</span>
                <select name="structure" className="mt-1 min-h-[40px] rounded-md border border-slate-300 bg-white px-3 text-sm" defaultValue="deposit_balance">
                  <option value="full">Full payment</option>
                  <option value="deposit_balance">Deposit + balance</option>
                  <option value="staged">Stage payments</option>
                  <option value="milestone">Milestones</option>
                  <option value="progress">Progress (ad-hoc)</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-slate-600">Contract value (ex-VAT)</span>
                <input name="basis_amount" type="number" step="0.01" min="0" defaultValue={b.suggestedBasisNet || undefined}
                  className="mt-1 min-h-[40px] w-40 rounded-md border border-slate-300 px-3 text-sm" placeholder="0.00" />
              </label>
              <button type="submit" className="inline-flex min-h-[40px] items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800">
                Create plan
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-500">Only an owner or admin can set up a billing plan.</p>
          )}
        </section>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-4">
            <h2 className="text-base font-semibold text-slate-900">Payment schedule</h2>
            <span className="text-sm text-slate-500">Contract {formatGbp(b.plan.basisAmount)} · scheduled {formatGbp(s.scheduledNet)} · {formatGbp(s.unscheduledNet)} left</span>
          </div>

          {b.stages.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No stages yet — add a deposit or a stage below.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {b.stages.map((st: BillingStageView) => (
                <li key={st.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[st.status]}`}>{STATUS_LABEL[st.status]}</span>
                      <span className="text-sm font-semibold text-slate-900">{st.name}</span>
                      {st.kind === "deposit" ? <span className="text-xs text-slate-400">deposit</span> : null}
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">
                      {formatGbp(st.amount)} + {formatGbp(st.vatAmount)} VAT = <span className="font-medium">{formatGbp(st.gross)}</span>
                      {st.dueDate ? ` · due ${st.dueDate}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {st.invoiceId ? (
                      <Link href={`/invoices/${st.invoiceId}`} className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50">
                        {st.invoiceNumber ?? "View invoice"}
                      </Link>
                    ) : isManager ? (
                      <>
                        <form action={generateStageInvoice}>
                          <input type="hidden" name="job_id" value={jobId} />
                          <input type="hidden" name="stage_id" value={st.id} />
                          <button type="submit" disabled={!b.jobHasCustomer} className="inline-flex min-h-[36px] items-center rounded-md bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40">
                            Generate invoice
                          </button>
                        </form>
                        <form action={deleteBillingStage}>
                          <input type="hidden" name="job_id" value={jobId} />
                          <input type="hidden" name="stage_id" value={st.id} />
                          <button type="submit" aria-label={`Remove ${st.name}`} className="inline-flex min-h-[36px] items-center rounded-md px-2 text-xs font-medium text-slate-400 hover:text-red-600">Remove</button>
                        </form>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {isManager ? (
            <div className="border-t border-slate-100 p-4">
              <form action={addBillingStage} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="job_id" value={jobId} />
                <input type="hidden" name="plan_id" value={b.plan.id} />
                <label className="text-sm">
                  <span className="block text-xs text-slate-500">Name</span>
                  <input name="name" required maxLength={120} placeholder="Deposit / First fix" className="mt-0.5 min-h-[40px] w-40 rounded-md border border-slate-300 px-3 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-slate-500">Kind</span>
                  <select name="kind" className="mt-0.5 min-h-[40px] rounded-md border border-slate-300 bg-white px-2 text-sm" defaultValue="stage">
                    <option value="deposit">Deposit</option>
                    <option value="stage">Stage</option>
                    <option value="balance">Balance (remainder)</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-slate-500">Basis</span>
                  <select name="basis" className="mt-0.5 min-h-[40px] rounded-md border border-slate-300 bg-white px-2 text-sm" defaultValue="fixed">
                    <option value="fixed">£ fixed</option>
                    <option value="percent">% of contract</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-slate-500">Amount / %</span>
                  <input name="amount" type="number" step="0.01" min="0" placeholder="£" className="mt-0.5 min-h-[40px] w-24 rounded-md border border-slate-300 px-2 text-sm" />
                  <input name="percent" type="number" step="0.01" min="0" max="100" placeholder="%" className="mt-0.5 ml-1 min-h-[40px] w-16 rounded-md border border-slate-300 px-2 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-slate-500">VAT</span>
                  <select name="vat_rate" className="mt-0.5 min-h-[40px] rounded-md border border-slate-300 bg-white px-2 text-sm" defaultValue="20">
                    <option value="20">20%</option>
                    <option value="5">5%</option>
                    <option value="0">0%</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-slate-500">Due</span>
                  <input name="due_date" type="date" className="mt-0.5 min-h-[40px] rounded-md border border-slate-300 px-2 text-sm" />
                </label>
                <button type="submit" className="inline-flex min-h-[40px] items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50">+ Add stage</button>
              </form>
              <form action={cancelBillingPlan} className="mt-3">
                <input type="hidden" name="job_id" value={jobId} />
                <input type="hidden" name="plan_id" value={b.plan.id} />
                <button type="submit" className="text-xs font-medium text-slate-400 hover:text-red-600">Cancel this plan</button>
              </form>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
