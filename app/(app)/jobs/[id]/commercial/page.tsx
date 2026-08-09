import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { formatGbp } from "@/lib/money";
import type { TimeEntry } from "@/lib/time/compute";
import {
  buildJobCostInput,
  lifetimeHoursSource,
} from "@/lib/profitability/job-cost-input";
import { loadOrgHourlyPay } from "@/lib/profitability/labour-rates";
import { computeCommercialCash } from "@/lib/commercial/cash";
import { buildCommercialTimeline } from "@/lib/commercial/timeline";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeCommittedCosts } from "@/lib/purchase-orders/committed";
import {
  computeJobProfitability,
  marginBand,
  marginPillClass,
  type CostBucket,
} from "@/lib/profitability/compute";
import { computeJobCommercialPosition } from "@/lib/jobs/commercial-position";
import {
  computeJobBudgetPosition,
  hasBudgetPosition,
  varianceTone,
  type JobBudgetPosition,
  type VariationCostEstimate,
} from "@/lib/jobs/budget";
import { loadCurrentJobBudget, type JobBudgetClient } from "@/server/services/job-budget";
import { CommercialTimeline } from "./_commercial-timeline";
import { BudgetForm, type CurrentBudget } from "./_budget-form";

/**
 * Unified commercial lifecycle (Programme D) — one authoritative, cash-first
 * answer to "how much money is still coming to me on this job, and how much is
 * late?", plus the chronological commercial audit trail.
 *
 * A read-model: it composes the existing pure modules (cash / retention /
 * committed / profitability / timeline) over data read through the tenant
 * client (`createClient()`), so RLS + impersonation-awareness are the tenancy
 * boundary. It must NEVER reach for the service-role admin client (that would
 * drop RLS on cost/PO/finance data) — pinned by a security source-contract test.
 *
 * `retention_releases` / `purchase_orders` / `jobs.retention_percent` are not in
 * the generated Supabase types yet, so those reads are cast — the established
 * job-page idiom; the casts are TypeScript-only and do not change the RLS-scoped
 * runtime client.
 */
export default async function JobCommercialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const job = await loadJobForOrg<{
    id: string;
    customer: { name: string } | { name: string }[] | null;
  }>(supabase, id, ctx.org.id, "id, customer:customers ( name )");
  if (!job) notFound();

  // F-1: quotes / invoices / finances are all job-scoped SET reads. On a busy
  // job any of them can cross the 1000-row PostgREST cap, and a truncated cost
  // read silently under-states cost and over-states margin/budget. Page every
  // one through fetchAllRows on a unique `id` tiebreak (mirrors the time_entries
  // read below), and throw LOUDLY on a failed read rather than compute on a
  // partial set.
  const [quotesRes, invoicesRes, financesRes] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("quotes")
        // `subtotal` is the EX-VAT contract value. Cost is ex-VAT everywhere in
        // this product, so the cost-value reconciliation must divide by the net
        // contract or every margin it reports is ~20 % out.
        // `cost_*` is the variation's PRICED COST BASIS (20261073) — the cost side
        // of an approved scope change, and the ONLY per-variation cost store there
        // is. `cost_total` is GENERATED from the four parts, so the budget reads it
        // rather than re-keying or re-summing it.
        .select(
          "id, number, variation_number, status, subtotal, total, accepted_at, declined_at, created_at, public_token, " +
            "cost_labour, cost_materials, cost_subcontractors, cost_misc, cost_total",
        )
        .eq("job_id", id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("invoices")
        .select("id, number, status, amount, total, due_date, created_at, sent_at, job_id")
        .eq("job_id", id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // `purchase_order_id` is what links a cost back to the commitment it
    // discharges (20261009). Without it a received-and-billed PO is counted
    // twice — once as committed, once as actual — in the forecast final cost.
    fetchAllRows((from, to) =>
      supabase
        .from("finances")
        .select("id, amount, category, created_at, job_id, purchase_order_id")
        .eq("job_id", id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  if (quotesRes.error) throw readFailure("job commercial: quotes", quotesRes.error);
  if (invoicesRes.error) throw readFailure("job commercial: invoices", invoicesRes.error);
  if (financesRes.error) throw readFailure("job commercial: finances", financesRes.error);

  type QuoteRow = {
    id: string; number: string | null; variation_number: number | null; status: string;
    subtotal: number | string | null;
    total: number | string | null; accepted_at: string | null; declined_at: string | null;
    created_at: string | null; public_token: string | null;
    cost_labour: number | string | null; cost_materials: number | string | null;
    cost_subcontractors: number | string | null; cost_misc: number | string | null;
    cost_total: number | string | null;
  };
  type InvRow = {
    id: string; number: string | null; status: string; amount: number | string | null;
    total: number | string | null; due_date: string | null; created_at: string | null;
    sent_at: string | null; job_id: string | null;
  };
  type FinRow = {
    id: string; amount: number | string | null; category: string | null;
    created_at: string | null; job_id: string | null; purchase_order_id: string | null;
  };

  const quotes = (quotesRes.data ?? []) as unknown as QuoteRow[];
  const invoices = (invoicesRes.data ?? []) as unknown as InvRow[];
  const finances = (financesRes.data ?? []) as unknown as FinRow[];
  const invoiceIds = invoices.map((i) => i.id);

  // Payment ledger (the cash truth) — indexed `.in()`, empty-guarded. F-1: paged
  // so a job with many invoices × many payments can't truncate received cash,
  // and LOUD on error so a failed read never reads as "nothing paid".
  const paymentsRes = invoiceIds.length
    ? await fetchAllRows((from, to) =>
        supabase
          .from("invoice_payments")
          .select("invoice_id, amount, paid_at, reference")
          .in("invoice_id", invoiceIds)
          .order("id", { ascending: true })
          .range(from, to),
      )
    : { data: [] as Array<{ invoice_id: string; amount: number | string | null; paid_at: string | null; reference: string | null }>, error: null };
  if (paymentsRes.error) throw readFailure("job commercial: invoice payments", paymentsRes.error);
  const payments = (paymentsRes.data ?? []) as unknown as Array<{
    invoice_id: string; amount: number | string | null; paid_at: string | null; reference: string | null;
  }>;

  // Untyped-on-main reads (cast; still RLS-scoped at runtime).
  const [retMeta, retReleases, pos] = await Promise.all([
    (supabase.from("jobs" as never) as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: { retention_percent: number | string | null } | null }> } } };
      // ACTIVE-org pin (#456 read-side class): the subject `job` is already
      // pinned via loadJobForOrg above; pin this secondary read too so it is
      // self-scoping and satisfies the read-pin guard.
    }).select("retention_percent").eq("id", id).eq("org_id", ctx.org.id).maybeSingle(),
    (supabase.from("retention_releases" as never) as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => Promise<{ data: Array<{ id: string; amount: number | string | null; released_on: string | null }> | null }> };
    }).select("id, amount, released_on").eq("job_id", id),
    // `subtotal` (ex-VAT) rides along beside `total` (gross): the committed
    // tile AND the forecast both report net. See committed.ts.
    (supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => Promise<{ data: Array<{ id: string; number: string | null; subtotal: number | string | null; total: number | string | null; status: string; created_at: string | null; supplier: { name: string } | null }> | null }> };
    }).select("id, number, subtotal, total, status, created_at, supplier:suppliers ( name )").eq("job_id", id),
  ]);
  const retentionReleases = retReleases.data ?? [];
  const purchaseOrders = pos.data ?? [];

  // ---- Compose the unified position -------------------------------------
  const cash = computeCommercialCash({
    quotes: quotes.map((q) => ({ status: q.status, total: q.total, variation_number: q.variation_number })),
    invoices: invoices.map((i) => ({ id: i.id, status: i.status, total: i.total, due_date: i.due_date })),
    payments: payments.map((p) => ({ invoice_id: p.invoice_id, amount: p.amount })),
  });
  const retention = computeRetentionPosition({
    ratePercent: retMeta.data?.retention_percent ?? 0,
    invoices: invoices.map((i) => ({ status: i.status, amount: i.amount })),
    releases: retentionReleases.map((r) => ({ amount: r.amount })),
  });
  // Bills already posted against each PO, so a received-and-billed order is not
  // counted twice by the forecast. One pass over the finance rows already read —
  // no extra query, and no second read of the ledger.
  const billedByPo = new Map<string, number>();
  for (const f of finances) {
    if (!f.purchase_order_id) continue;
    billedByPo.set(
      f.purchase_order_id,
      Math.round(((billedByPo.get(f.purchase_order_id) ?? 0) + Number(f.amount ?? 0)) * 100) / 100,
    );
  }
  const committed = computeCommittedCosts(
    purchaseOrders.map((p) => ({
      status: p.status,
      total: p.total,
      subtotal: p.subtotal,
      billed: billedByPo.get(p.id) ?? 0,
    })),
  );
  // Bring the per-job cost/profit into line with the dashboard: a job's ACTUAL
  // cost is its `finances` rows PLUS time-tracked labour (gross) PLUS employer NI +
  // pension on-costs on those hours — not `finances` alone. Composing them here via
  // the shared builder is what stops this page from reporting every job with
  // clocked labour as more profitable than it truly is.
  //
  // SCOPE: job-lifetime hours. This is a whole-job commercial/budget view, so every
  // hour ever booked to the job counts — unlike the dashboard's month window, which
  // would silently drop labour worked in earlier months.
  //
  // LOUD reads: a failed labour or pay read must NOT silently drop labour and
  // report the job as more profitable than it is, so both throw rather than
  // coalescing to empty. Pay is read straight from `users` for the worker ids the
  // job's entries name — no PostgREST embed (a bare cross-FK embed PGRST201s the
  // whole query). `users` is global (no org_id): scoping it by ids drawn from the
  // org-pinned `time_entries` read is the documented exception to the org-pin rule.
  // time_entries is paged: a long, well-staffed job can cross the 1000-row cap.
  const teRes = await fetchAllRows((from, to) =>
    supabase
      .from("time_entries")
      .select("id, user_id, job_id, started_at, ended_at, breaks")
      .eq("org_id", ctx.org.id)
      .eq("job_id", id)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (teRes.error) throw readFailure("job commercial: time entries", teRes.error);
  const jobTimeEntries = (teRes.data ?? []) as unknown as TimeEntry[];
  const hourlyByUser = await loadOrgHourlyPay(supabase, ctx.org.id);
  const costInput = buildJobCostInput({
    finances: finances.map((f) => ({ job_id: f.job_id, amount: f.amount, category: f.category })),
    timeEntries: jobTimeEntries,
    hourlyByUser,
    hoursForEntries: lifetimeHoursSource(),
    cycle: "monthly",
  });
  const profit = computeJobProfitability(
    id,
    invoices.map((i) => ({ job_id: i.job_id, amount: i.amount })),
    costInput,
  );
  const costsTotal = profit?.costs_total ?? 0;
  const grossProfit = profit?.gross_profit ?? 0;
  const marginPct = profit?.margin_pct ?? null;

  // ---- The cost baseline (20261072) --------------------------------------
  // The ex-VAT contract taxonomy, for the cost-value reconciliation. `cash`
  // above is the GROSS answer (what moves through the bank); this is the net one
  // (what a cost can be compared with).
  const contract = computeJobCommercialPosition({
    quotes: quotes.map((q) => ({
      status: q.status,
      total: q.total,
      subtotal: q.subtotal,
      variation_number: q.variation_number,
    })),
    invoices: invoices.map((i) => ({ status: i.status, total: i.total })),
  });
  // The cost side of the ACCEPTED variations, straight off the quotes already
  // read — no second table, no second query. Deciding WHICH variations are
  // approved is the contract taxonomy's rule (accepted + has a variation_number),
  // the same predicate `revisedNet` uses above, so value and cost always agree on
  // the same set. A variation with no priced basis has `cost_total` NULL and
  // contributes 0, which is honest: nothing was budgeted for it.
  const variationEstimates: VariationCostEstimate[] = quotes
    .filter((q) => q.variation_number != null && q.status === "accepted")
    .map((q) => ({
      total_cost: q.cost_total,
      labour_cost: q.cost_labour,
      materials_cost: q.cost_materials,
      subcontractors_cost: q.cost_subcontractors,
      misc_cost: q.cost_misc,
    }));
  // Cast: job_budgets is not in the generated types yet (the job-page idiom).
  // TypeScript-only — the runtime client is still the RLS-scoped tenant one.
  const currentBudget = await loadCurrentJobBudget(
    supabase as unknown as JobBudgetClient,
    ctx.org.id,
    id,
  );
  const budget = computeJobBudgetPosition({
    budget: currentBudget,
    approvedVariationEstimates: variationEstimates,
    actualTotal: costsTotal,
    actualByBucket: profit?.costs_by_bucket ?? { labour: 0, materials: 0, subcontractors: 0, misc: 0 },
    remainingCommitted: committed.remaining,
    revisedValueNet: contract.revisedNet,
  });

  // THE marginBand FALLBACK. A per-job target replaces the universal 30/15 bands
  // ONLY when the job's baseline carries one; otherwise `targetMarginPct` is null
  // and marginBand() behaves exactly as it always has.
  const marginBandValue =
    marginPct == null ? "neutral" : marginBand(marginPct, budget.targetMarginPct);

  const canSetBudget =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const currentForForm: CurrentBudget | null = currentBudget
    ? {
        revision: Number(currentBudget.revision ?? 1),
        total: Number(currentBudget.total_cost ?? 0),
        labour: currentBudget.labour_cost == null ? null : Number(currentBudget.labour_cost),
        materials: currentBudget.materials_cost == null ? null : Number(currentBudget.materials_cost),
        subcontractors:
          currentBudget.subcontractors_cost == null ? null : Number(currentBudget.subcontractors_cost),
        misc: currentBudget.misc_cost == null ? null : Number(currentBudget.misc_cost),
        targetMarginPct:
          currentBudget.target_margin_pct == null ? null : Number(currentBudget.target_margin_pct),
      }
    : null;

  const timeline = buildCommercialTimeline({
    quotes,
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, total: i.total, status: i.status, created_at: i.created_at, sent_at: i.sent_at })),
    payments,
    retentionReleases,
    purchaseOrders: purchaseOrders.map((p) => ({ id: p.id, number: p.number, total: p.total, status: p.status, created_at: p.created_at, supplierName: p.supplier?.name ?? null })),
    costs: finances,
  });

  const customerName = (job.customer as unknown as { name: string } | null)?.name ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/jobs" className="hover:text-slate-900">Jobs</Link>
        <span aria-hidden>/</span>
        <Link href={`/jobs/${id}`} className="hover:text-slate-900">{customerName ?? "Job"}</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Commercial</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Commercial position</h1>
        <p className="mt-1 text-sm text-slate-500">
          What you&apos;re owed, what&apos;s late, and the money story of this job — one place.
        </p>
      </header>

      {/* Cash-first hero: the number a builder checks every morning. */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Outstanding</div>
            <div className="text-4xl font-bold text-slate-900">{formatGbp(cash.outstanding)}</div>
            <div className="mt-1 text-sm text-slate-500">
              {formatGbp(cash.received)} received of {formatGbp(cash.billed)} billed
            </div>
          </div>
          {cash.overdue > 0 ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-right">
              <div className="text-xs uppercase tracking-wide text-red-500">Overdue</div>
              <div className="text-2xl font-bold text-red-700">{formatGbp(cash.overdue)}</div>
              <div className="text-xs text-red-600">
                {cash.counts.overdueInvoices} invoice{cash.counts.overdueInvoices === 1 ? "" : "s"} past due
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* Cash waterfall — contract → billed → received → outstanding → to bill. */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Contract &amp; cash</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Contract value" value={formatGbp(cash.revised)} sub={cash.approvedVariations > 0 ? `incl. ${formatGbp(cash.approvedVariations)} variations` : undefined} strong />
          <Tile label="Billed" value={formatGbp(cash.billed)} />
          <Tile label="Still to bill" value={formatGbp(cash.stillToBill)} tone={cash.stillToBill > 0 ? "amber" : undefined} />
          <Tile label="Received" value={formatGbp(cash.received)} />
          <Tile label="Outstanding" value={formatGbp(cash.outstanding)} tone={cash.outstanding > 0 ? "amber" : undefined} />
          <Tile label="Retention held" value={formatGbp(retention.held)} sub={retention.held > 0 ? `${retention.ratePercent}% withheld` : undefined} />
        </dl>
        {cash.pendingVariations > 0 ? (
          <p className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            {cash.counts.pendingVariations} variation{cash.counts.pendingVariations === 1 ? "" : "s"} awaiting a decision
            ({formatGbp(cash.pendingVariations)}) — not in the contract value yet.
          </p>
        ) : null}
        <p className="mt-3 text-[11px] text-slate-500">Cash figures include VAT — the amounts that move through the bank.</p>
      </section>

      {/* Internal exposure — never customer-facing. */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Cost &amp; profit</h2>
          <span className="text-[11px] uppercase tracking-wide text-slate-500">internal · excl. VAT</span>
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile
            label="Committed (POs)"
            // EX-VAT, because this section says so on the tin ("internal ·
            // excl. VAT") and "Actual cost" next door is ex-VAT `finances`.
            // `committed.committed` is the GROSS ordered value
            // (purchase_orders.total = subtotal + vat_total): rendering it here
            // overstated the commitment by up to 20% against the very figure it
            // invites comparison with.
            value={formatGbp(committed.committedNet)}
            // The composition that matters beside "Actual cost" is how much of
            // the commitment is ALREADY in it. The gross delivery split
            // (on-order / part-received) cannot be shown under this header —
            // both buckets are VAT-inclusive — and it lives on the PO list.
            sub={
              [
                committed.billedAgainst > 0 ? `${formatGbp(committed.billedAgainst)} billed` : null,
                committed.remaining > 0 ? `${formatGbp(committed.remaining)} still to come` : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
          />
          <Tile label="Actual cost" value={formatGbp(costsTotal)} />
          <Tile label="Gross profit" value={formatGbp(grossProfit)} />
          <Tile
            label="Margin"
            value={marginPct == null ? "—" : `${marginPct.toFixed(1)}%`}
            pill={marginPillClass(marginBandValue)}
            sub={
              budget.targetMarginPct != null
                ? `vs ${budget.targetMarginPct}% target`
                : undefined
            }
          />
        </dl>
      </section>

      {/* Budget vs actual — the baseline every other cost figure is measured
          against. Absent a baseline this still answers "where does this land?",
          because a forecast needs no plan. */}
      <BudgetPanel jobId={id} budget={budget} canSet={canSetBudget} current={currentForForm} />

      {/* The commercial lifecycle timeline. */}
      <CommercialTimeline events={timeline} />
    </div>
  );
}

function Tile({
  label, value, sub, strong, tone, pill,
}: {
  label: string; value: string; sub?: string; strong?: boolean;
  tone?: "amber" | "good" | "bad" | "neutral"; pill?: string;
}) {
  const toneClass =
    tone === "amber" ? "text-amber-700"
    : tone === "good" ? "text-green-700"
    : tone === "bad" ? "text-red-700"
    : "text-slate-900";
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 truncate ${strong ? "text-lg font-bold" : "text-base font-semibold"} ${toneClass}`}>
        {pill ? <span className={`inline-block rounded-full px-2 py-0.5 text-sm font-semibold ${pill}`}>{value}</span> : value}
      </dd>
      {sub ? <dd className="mt-0.5 text-[11px] text-slate-600">{sub}</dd> : null}
    </div>
  );
}

const BUCKET_LABELS: Record<CostBucket, string> = {
  labour: "Labour",
  materials: "Materials",
  subcontractors: "Subcontractors",
  misc: "Other",
};

/** Signed money, so "£1,200 over" and "£1,200 left" are never confusable. */
function signedGbp(v: number): string {
  if (v === 0) return formatGbp(0);
  return `${v > 0 ? "" : "−"}${formatGbp(Math.abs(v))}`;
}

/**
 * Budget vs actual, forecast final cost, and the cost-value reconciliation.
 *
 * MOBILE FIRST (375px): the tiles are a 2-up grid and the per-bucket breakdown is
 * a definition list rather than a table, so nothing scrolls sideways on a phone.
 *
 * Rendered for EVERY job, including one with no baseline: the forecast and the
 * reconciliation need no plan, and an explicit "no budget set" is the prompt that
 * gets one set. The variance figures stay absent rather than zero — "£0 budget,
 * 100% over" is the lie a default would tell.
 */
function BudgetPanel({
  jobId, budget, canSet, current,
}: {
  jobId: string;
  budget: JobBudgetPosition;
  canSet: boolean;
  current: CurrentBudget | null;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Budget &amp; forecast</h2>
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          internal · excl. VAT
        </span>
      </div>

      {budget.hasBudget ? (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              label="Budget"
              value={formatGbp(budget.revisedBudget)}
              strong
              sub={
                budget.approvedVariationCost > 0
                  ? `incl. ${formatGbp(budget.approvedVariationCost)} approved variations`
                  : `revision ${budget.revision}`
              }
            />
            <Tile label="Spent" value={formatGbp(budget.actual)} />
            <Tile
              label={budget.variance >= 0 ? "Left" : "Over"}
              value={signedGbp(budget.variance)}
              tone={varianceTone(budget.variance)}
              sub={
                budget.variancePct == null ? undefined : `${Math.abs(budget.variancePct).toFixed(1)}% of budget`
              }
            />
            <Tile
              label="Forecast final cost"
              value={formatGbp(budget.forecastFinalCost)}
              tone={budget.forecastOverBudget ? "bad" : undefined}
              sub={
                budget.remainingCommitted > 0
                  ? `spent + ${formatGbp(budget.remainingCommitted)} still on order`
                  : "nothing further on order"
              }
            />
          </dl>

          <p
            className={`mt-3 rounded-md border px-3 py-2 text-xs ${
              budget.forecastOverBudget
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-slate-200 bg-slate-50 text-slate-700"
            }`}
          >
            {budget.forecastOverBudget
              ? `On current commitments this job lands ${formatGbp(Math.abs(budget.forecastVariance))} OVER budget`
              : `On current commitments this job lands ${formatGbp(budget.forecastVariance)} under budget`}
            {budget.forecastVariancePct == null
              ? ""
              : ` (${Math.abs(budget.forecastVariancePct).toFixed(1)}%)`}
            . Money already spent plus orders placed and not yet billed — labour still
            to work and materials not yet ordered are in neither, so treat it as a floor.
          </p>

          {budget.hasBucketDetail ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                By cost type
              </h3>
              <dl className="mt-2 divide-y divide-slate-100">
                {budget.buckets.map((b) => (
                  <div key={b.bucket} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                    <dt className="text-sm font-medium text-slate-900">{BUCKET_LABELS[b.bucket]}</dt>
                    <dd className="text-xs text-slate-600">
                      {formatGbp(b.actual)} of {formatGbp(b.budget ?? 0)}
                    </dd>
                    <dd
                      className={`w-full text-xs font-semibold sm:w-auto ${
                        (b.variance ?? 0) < 0 ? "text-red-700" : "text-slate-700"
                      }`}
                    >
                      {b.variance == null
                        ? "—"
                        : `${signedGbp(b.variance)}${
                            b.variancePct == null ? "" : ` · ${Math.abs(b.variancePct).toFixed(0)}%`
                          }`}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-slate-500">
              No cost-type breakdown on this budget — revise it with a breakdown to see
              labour, materials, subcontractors and other separately.
            </p>
          )}

          {/* Cost vs value: what the plan promised, what the forecast implies. */}
          <div className="mt-4 border-t border-slate-100 pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Against the contract
            </h3>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Tile label="Contract (net)" value={formatGbp(budget.revisedValue)} />
              <Tile
                label="Planned profit"
                value={formatGbp(budget.plannedProfit)}
                sub={
                  budget.plannedMarginPct == null
                    ? undefined
                    : `${budget.plannedMarginPct.toFixed(1)}% planned margin`
                }
              />
              <Tile
                label="Forecast profit"
                value={formatGbp(budget.forecastProfit)}
                tone={budget.forecastProfit < budget.plannedProfit ? "bad" : "good"}
                sub={
                  budget.forecastMarginPct == null
                    ? undefined
                    : `${budget.forecastMarginPct.toFixed(1)}% forecast margin`
                }
              />
            </dl>
          </div>

          {budget.note ? (
            <p className="mt-3 text-[11px] text-slate-500">
              Revision {budget.revision}: {budget.note}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            No budget set. Actual cost and margin are measured against revenue only, so
            there is nothing to tell you whether this job is running over.
          </p>
          {hasBudgetPosition(budget) ? (
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Tile label="Spent" value={formatGbp(budget.actual)} />
              <Tile
                label="Forecast final cost"
                value={formatGbp(budget.forecastFinalCost)}
                sub={
                  budget.remainingCommitted > 0
                    ? `incl. ${formatGbp(budget.remainingCommitted)} still on order`
                    : undefined
                }
              />
              <Tile label="Contract (net)" value={formatGbp(budget.revisedValue)} />
            </dl>
          ) : null}
        </>
      )}

      {canSet ? (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <BudgetForm jobId={jobId} current={current} />
        </div>
      ) : null}
    </section>
  );
}
