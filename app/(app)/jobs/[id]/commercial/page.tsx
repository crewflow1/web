import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { formatGbp } from "@/lib/money";
import { computeCommercialCash } from "@/lib/commercial/cash";
import { buildCommercialTimeline } from "@/lib/commercial/timeline";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeCommittedCosts } from "@/lib/purchase-orders/committed";
import { computeJobProfitability, marginPillClass } from "@/lib/profitability/compute";
import { CommercialTimeline } from "./_commercial-timeline";

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

  const [quotesRes, invoicesRes, financesRes] = await Promise.all([
    supabase
      .from("quotes")
      .select("id, number, variation_number, status, total, accepted_at, declined_at, created_at, public_token")
      .eq("job_id", id),
    supabase
      .from("invoices")
      .select("id, number, status, amount, total, due_date, created_at, sent_at, job_id")
      .eq("job_id", id),
    supabase.from("finances").select("id, amount, category, created_at, job_id").eq("job_id", id),
  ]);

  type QuoteRow = {
    id: string; number: string | null; variation_number: number | null; status: string;
    total: number | string | null; accepted_at: string | null; declined_at: string | null;
    created_at: string | null; public_token: string | null;
  };
  type InvRow = {
    id: string; number: string | null; status: string; amount: number | string | null;
    total: number | string | null; due_date: string | null; created_at: string | null;
    sent_at: string | null; job_id: string | null;
  };
  type FinRow = { id: string; amount: number | string | null; category: string | null; created_at: string | null; job_id: string | null };

  const quotes = (quotesRes.data ?? []) as unknown as QuoteRow[];
  const invoices = (invoicesRes.data ?? []) as unknown as InvRow[];
  const finances = (financesRes.data ?? []) as unknown as FinRow[];
  const invoiceIds = invoices.map((i) => i.id);

  // Payment ledger (the cash truth) — one indexed `.in()`, empty-guarded.
  const paymentsRes = invoiceIds.length
    ? await supabase.from("invoice_payments").select("invoice_id, amount, paid_at, reference").in("invoice_id", invoiceIds)
    : { data: [] as Array<{ invoice_id: string; amount: number | string | null; paid_at: string | null; reference: string | null }> };
  const payments = (paymentsRes.data ?? []) as unknown as Array<{
    invoice_id: string; amount: number | string | null; paid_at: string | null; reference: string | null;
  }>;

  // Untyped-on-main reads (cast; still RLS-scoped at runtime).
  const [retMeta, retReleases, pos] = await Promise.all([
    (supabase.from("jobs" as never) as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: { retention_percent: number | string | null } | null }> } };
    }).select("retention_percent").eq("id", id).maybeSingle(),
    (supabase.from("retention_releases" as never) as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => Promise<{ data: Array<{ id: string; amount: number | string | null; released_on: string | null }> | null }> };
    }).select("id, amount, released_on").eq("job_id", id),
    (supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => Promise<{ data: Array<{ id: string; number: string | null; total: number | string | null; status: string; created_at: string | null; supplier: { name: string } | null }> | null }> };
    }).select("id, number, total, status, created_at, supplier:suppliers ( name )").eq("job_id", id),
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
  const committed = computeCommittedCosts(purchaseOrders.map((p) => ({ status: p.status, total: p.total })));
  const profit = computeJobProfitability(
    id,
    invoices.map((i) => ({ job_id: i.job_id, amount: i.amount })),
    finances.map((f) => ({ job_id: f.job_id, amount: f.amount, category: f.category })),
  );
  const costsTotal = profit?.costs_total ?? 0;
  const grossProfit = profit?.gross_profit ?? 0;
  const marginPct = profit?.margin_pct ?? null;
  const marginBandValue = profit?.band ?? "neutral";

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
        <p className="mt-3 text-[11px] text-slate-400">Cash figures include VAT — the amounts that move through the bank.</p>
      </section>

      {/* Internal exposure — never customer-facing. */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Cost &amp; profit</h2>
          <span className="text-[11px] uppercase tracking-wide text-slate-400">internal · excl. VAT</span>
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile
            label="Committed (POs)"
            value={formatGbp(committed.committed)}
            // Warehouse M1 split part-deliveries out of "on order": an order
            // half of which is already on site is neither purely awaited nor
            // received, and telling the owner it is either would be a lie.
            sub={
              [
                committed.onOrder > 0 ? `${formatGbp(committed.onOrder)} on order` : null,
                committed.partiallyReceived > 0
                  ? `${formatGbp(committed.partiallyReceived)} part-received`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
          />
          <Tile label="Actual cost" value={formatGbp(costsTotal)} />
          <Tile label="Gross profit" value={formatGbp(grossProfit)} />
          <Tile label="Margin" value={marginPct == null ? "—" : `${marginPct.toFixed(1)}%`} pill={marginPillClass(marginBandValue)} />
        </dl>
      </section>

      {/* The commercial lifecycle timeline. */}
      <CommercialTimeline events={timeline} />
    </div>
  );
}

function Tile({
  label, value, sub, strong, tone, pill,
}: {
  label: string; value: string; sub?: string; strong?: boolean; tone?: "amber"; pill?: string;
}) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 ${strong ? "text-lg font-bold" : "text-base font-semibold"} ${tone === "amber" ? "text-amber-700" : "text-slate-900"}`}>
        {pill ? <span className={`inline-block rounded-full px-2 py-0.5 text-sm font-semibold ${pill}`}>{value}</span> : value}
      </dd>
      {sub ? <dd className="mt-0.5 text-[11px] text-slate-400">{sub}</dd> : null}
    </div>
  );
}
