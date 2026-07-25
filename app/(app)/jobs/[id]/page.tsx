import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateJob, deleteJob } from "../actions";
import { JobForm } from "../_form";
import { listCustomersForOrg, listStaffForOrg } from "../_form-helpers";
import { PhotoGallery } from "./_photo-gallery";
import { ConfirmForm } from "@/components/forms/ConfirmForm";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { JobAssetsSection } from "./_job-assets";
import { JobDocumentsPanel } from "./_job-documents";
import { formatGbp } from "@/lib/jobs/commercial-position";
import { computeCommercialCash } from "@/lib/commercial/cash";
import {
  computeJobProfitability,
  marginPillClass,
} from "@/lib/profitability/compute";
import {
  computeRetentionPosition,
  maxReleasable,
} from "@/lib/retentions/compute";
import { setJobRetentionRate, recordRetentionRelease } from "../retention-actions";
import { computeRetentionSchedule } from "@/lib/retentions/schedule";
import { RetentionScheduleSection } from "./_retention-schedule";
import { computeCommittedCosts, hasCommittedCosts } from "@/lib/purchase-orders/committed";
import { resolveJobAddress, formatAddressLines } from "@/lib/address";
import { MapActions } from "@/components/maps/MapActions";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

/**
 * Job edit page.
 *
 * Update + delete are admin-only at the DB (RLS). If a non-admin submits
 * the form, RLS returns 0 rows affected and the action redirects with
 * `?error=update_denied`.
 */
export default async function EditJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;

  const { ctx } = await requireOrgContext();
  // Private job documents are owner/admin only. We compute this here and pass
  // it down so the panel can gate the private-area FETCH (not just the render),
  // keeping private rows out of a staff member's RSC payload.
  const canViewPrivate =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();
  const { data: job } = await supabase
    .from("jobs")
    .select(
      `
        id, status, scheduled_date, notes, customer_id, assigned_to, recurring,
        site_address_line1, site_address_line2, site_city, site_county, site_postcode, site_country,
        customer:customers ( id, name, address_line1, address_line2, city, county, postcode, country )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!job) notFound();

  const [customers, staff, invoicesForJob, financesForJob, variationsForJob, baseQuotesForJob] = await Promise.all([
    listCustomersForOrg(),
    listStaffForOrg(),
    supabase
      .from("invoices")
      .select(
        "id, number, status, amount, vat_total, total, due_date, job_id, quote_id, quote:quotes ( variation_number )",
      )
      .eq("job_id", job.id),
    supabase
      .from("finances")
      .select("id, amount, vat_total, category, created_at, job_id, purchase_order_id")
      .eq("job_id", job.id),
    // Variations on this job (any status).
    supabase
      .from("quotes")
      .select(
        "id, number, variation_number, status, subtotal, vat_total, total, accepted_at, declined_at, created_at, notes, public_token",
      )
      .eq("job_id", job.id)
      .not("variation_number", "is", null)
      .order("variation_number", { ascending: true }),
    // Base contract quote(s) for this job — the accepted quote with no
    // variation_number is the original agreed value (Programme B: revised value).
    supabase
      .from("quotes")
      .select("status, total, variation_number")
      .eq("job_id", job.id)
      .is("variation_number", null),
  ]);

  // Cast: job_id is in the 20260520150000 migration but not yet in
  // the generated Supabase types.
  type InvRow = {
    id: string;
    job_id: string | null;
    amount: number | string | null;
    status: string;
    total: number | string | null;
    due_date: string | null;
    quote?: { variation_number: number | null } | null;
  };
  type FinRow = {
    job_id: string | null;
    amount: number | string | null;
    vat_total?: number | string | null;
    category: string | null;
    purchase_order_id?: string | null;
  };
  type VarRow = {
    id: string;
    number: string;
    variation_number: number;
    status: string;
    subtotal: number | string | null;
    vat_total: number | string | null;
    total: number | string | null;
    accepted_at: string | null;
    declined_at: string | null;
    created_at: string;
    notes: string | null;
    public_token: string | null;
  };
  const invRows = (invoicesForJob.data ?? []) as unknown as InvRow[];
  const finRows = (financesForJob.data ?? []) as unknown as FinRow[];
  const varRows = (variationsForJob.data ?? []) as unknown as VarRow[];
  const baseQuoteRows = (baseQuotesForJob.data ?? []) as unknown as Array<{
    status: string;
    total: number | string | null;
    variation_number: number | null;
  }>;

  const profit = computeJobProfitability(job.id, invRows, finRows);

  // Retention (Programme C) — the rate lives on the job, releases in the ledger.
  // Neither is in the generated Supabase types yet; the held figure is DERIVED.
  const [retentionMeta, retentionReleases, jobPurchaseOrders] = await Promise.all([
    (
      supabase.from("jobs" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: {
              retention_percent: number | string | null;
              practical_completion_date: string | null;
              defects_liability_months: number | string | null;
              retention_first_release_pct: number | string | null;
            } | null }>;
          };
        };
      }
    )
      .select("retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct")
      .eq("id", job.id)
      .maybeSingle(),
    (
      supabase.from("retention_releases" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            order: (
              k: string,
              o: { ascending: boolean },
            ) => Promise<{ data: Array<{ id: string; amount: number | string | null; released_on: string; note: string | null }> | null }>;
          };
        };
      }
    )
      .select("id, amount, released_on, note")
      .eq("job_id", job.id)
      .order("released_on", { ascending: false }),
    // Committed costs (Programme C) — the job's purchase orders. Not yet typed.
    (
      supabase.from("purchase_orders" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => Promise<{ data: Array<{ status: string; total: number | string | null }> | null }>;
        };
      }
    )
      .select("status, total")
      .eq("job_id", job.id),
  ]);
  const committed = computeCommittedCosts(jobPurchaseOrders.data ?? []);

  // Programme D — the ledger-truthful cash position (received/outstanding from
  // real payments, not invoice status). One indexed read, empty-guarded.
  const invIds = invRows.map((i) => i.id);
  const jobPayments = invIds.length
    ? await supabase.from("invoice_payments").select("invoice_id, amount").in("invoice_id", invIds)
    : { data: [] as Array<{ invoice_id: string; amount: number | string | null }> };
  const commercialCash = computeCommercialCash({
    quotes: [
      ...baseQuoteRows,
      ...varRows.map((v) => ({ status: v.status, total: v.total, variation_number: v.variation_number })),
    ],
    invoices: invRows.map((i) => ({ id: i.id, status: i.status, total: i.total, due_date: i.due_date })),
    payments: (jobPayments.data ?? []).map((p) => ({ invoice_id: p.invoice_id, amount: p.amount })),
  });

  // Billed (actual): supplier bills recorded against this job's POs — finances
  // rows carrying a purchase_order_id. Closes committed → actual on the job P&L.
  const poBilledRows = finRows.filter((r) => r.purchase_order_id);
  const billedActual =
    Math.round(
      poBilledRows.reduce((s, r) => s + Number(r.amount ?? 0) + Number(r.vat_total ?? 0), 0) * 100,
    ) / 100;
  const retentionReleaseRows = retentionReleases.data ?? [];
  const retention = computeRetentionPosition({
    ratePercent: retentionMeta.data?.retention_percent ?? 0,
    invoices: invRows.map((i) => ({ status: i.status, amount: i.amount })),
    releases: retentionReleaseRows,
  });
  const isAdmin = canViewPrivate; // owner/admin — matches jobs UPDATE RLS
  // Members see the panel once retention is live; admins always see it so they
  // can set the contract rate in the first place.
  const showRetention =
    retention.isActive || retentionReleaseRows.length > 0 || isAdmin;

  // Retention release schedule (Programme C extension) — DERIVED forecast of
  // when held retention is due back. Terms live on the job.
  const retentionScheduleTerms = {
    practicalCompletionDate: retentionMeta.data?.practical_completion_date ?? null,
    defectsLiabilityMonths: Number(retentionMeta.data?.defects_liability_months ?? 12),
    firstReleasePct: Number(retentionMeta.data?.retention_first_release_pct ?? 50),
  };
  const retentionSchedule = computeRetentionSchedule({
    position: retention,
    ...retentionScheduleTerms,
  });

  // Original vs Variations breakdown — split invoice revenue by whether
  // the source quote has variation_number set.
  let originalRevenue = 0;
  let variationRevenue = 0;
  for (const inv of invRows) {
    const amt = Number(inv.amount ?? 0);
    if (inv.quote?.variation_number !== null && inv.quote?.variation_number !== undefined) {
      variationRevenue += amt;
    } else {
      originalRevenue += amt;
    }
  }
  const totalCommitted = originalRevenue + variationRevenue;

  // Lifecycle (delete) still redirects with ?error. Update form errors
  // surface inline via useActionState inside JobForm.
  const errorMessage = error
    ? error === "delete_failed"
      ? "Couldn't delete the job."
      : error === "delete_denied"
        ? "Only admins/owners can delete jobs."
        : decodeURIComponent(error)
    : null;

  const updateAction = updateJob.bind(null, job.id);
  const deleteAction = deleteJob.bind(null, job.id);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/jobs" className="hover:text-slate-900">
          Jobs
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-slate-900">
          {job.customer?.name ?? "Job"}
        </span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Edit job</h1>
      </header>

      {/* Programme D — cash-first commercial strip (ledger-truthful). Links to
          the full unified commercial position + lifecycle timeline. */}
      {(commercialCash.billed > 0 || commercialCash.revised > 0) ? (
        <Link
          href={`/jobs/${job.id}/commercial`}
          className="block rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500">Outstanding</div>
                <div className="text-2xl font-bold text-slate-900">{formatGbp(commercialCash.outstanding)}</div>
              </div>
              {commercialCash.overdue > 0 ? (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-red-500">Overdue</div>
                  <div className="text-2xl font-bold text-red-700">{formatGbp(commercialCash.overdue)}</div>
                </div>
              ) : null}
              <div className="text-sm text-slate-500">
                {formatGbp(commercialCash.received)} received of {formatGbp(commercialCash.billed)} billed ·
                contract {formatGbp(commercialCash.revised)}
              </div>
            </div>
            <span className="text-sm font-medium text-slate-600">Commercial →</span>
          </div>
        </Link>
      ) : null}

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {saved === "retention_rate" || saved === "retention_release" || saved === "retention_schedule" ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {saved === "retention_rate"
            ? "Retention rate saved."
            : saved === "retention_schedule"
              ? "Release schedule saved."
              : "Retention release recorded."}
        </div>
      ) : null}

      {(() => {
        const jobAddress = resolveJobAddress(
          job,
          Array.isArray(job.customer) ? job.customer[0] : job.customer,
        );
        if (!jobAddress) return null;
        const lines = formatAddressLines(jobAddress);
        return (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Site address</h2>
            <address className="mt-2 not-italic text-sm text-slate-600">
              {lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </address>
            <MapActions address={jobAddress} className="mt-3" />
          </section>
        );
      })()}

      {(() => {
        const recurring =
          (job.recurring as { pattern?: string; end_date?: string } | null) ??
          null;
        return (
          <JobForm
            action={updateAction}
            submitLabel="Save changes"
            cancelHref="/jobs"
            customers={customers}
            staff={staff}
            defaults={{
              customer_id: job.customer_id ?? "",
              assigned_to: job.assigned_to ?? "",
              status: job.status,
              scheduled_date: job.scheduled_date ?? "",
              recurring_pattern: recurring?.pattern ?? "",
              recurring_end_date: recurring?.end_date ?? "",
              notes: job.notes ?? "",
              site_address_line1: job.site_address_line1 ?? "",
              site_address_line2: job.site_address_line2 ?? "",
              site_city: job.site_city ?? "",
              site_county: job.site_county ?? "",
              site_postcode: job.site_postcode ?? "",
              site_country: job.site_country ?? "",
            }}
          />
        );
      })()}

      <PhotoGallery jobId={job.id} />

      {/* Full commercial position + lifecycle timeline live at /commercial
          (linked from the cash strip above). The old status-based position
          panel was removed — it double-counted partly-paid invoices as fully
          collected; the strip now shows the ledger-truthful figure. */}

      {/* Retention (Programme C) — contract holdback held & released. */}
      {showRetention ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">Retention</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              {retention.ratePercent}% of certified value
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Held back from certified (non-draft) invoices as security, released at completion
            and end of defects. Calculated on the ex-VAT works value.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PositionCell label="Accrued" value={formatGbp(retention.accrued)} />
            <PositionCell label="Released" value={formatGbp(retention.released)} />
            <PositionCell
              label="Held"
              value={formatGbp(retention.held)}
              strong
              tone={retention.held > 0 ? "amber" : undefined}
            />
            <PositionCell
              label="Status"
              value={retention.isFullyReleased ? "Fully released" : retention.held > 0 ? "Outstanding" : "—"}
            />
          </dl>

          <RetentionScheduleSection
            jobId={job.id}
            schedule={retentionSchedule}
            isAdmin={isAdmin}
            current={retentionScheduleTerms}
          />

          {retentionReleaseRows.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Release history
              </h3>
              <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                {retentionReleaseRows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="text-slate-600">
                      {r.released_on}
                      {r.note ? <span className="text-slate-400"> · {r.note}</span> : null}
                    </span>
                    <span className="font-medium text-slate-900">{formatGbp(r.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {isAdmin ? (
            <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <form action={setJobRetentionRate.bind(null, job.id)} className="flex items-end gap-2">
                <label className="flex-1 text-xs font-medium text-slate-600">
                  Retention rate (%)
                  <input
                    type="number"
                    name="retention_percent"
                    min={0}
                    max={100}
                    step="0.5"
                    defaultValue={retention.ratePercent}
                    className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
                  />
                </label>
                <button
                  type="submit"
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Save rate
                </button>
              </form>

              {retention.isActive && maxReleasable(retention) > 0 ? (
                <form action={recordRetentionRelease.bind(null, job.id)} className="flex items-end gap-2">
                  <label className="flex-1 text-xs font-medium text-slate-600">
                    Record release (£)
                    <input
                      type="number"
                      name="amount"
                      min="0.01"
                      max={maxReleasable(retention)}
                      step="0.01"
                      placeholder={maxReleasable(retention).toFixed(2)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    Release
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Original / Variations / Total breakdown — the CEO-asked tile */}
      {(originalRevenue > 0 || variationRevenue > 0 || varRows.length > 0) ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">
              Job value
            </h2>
            <Link
              href={`/jobs/${job.id}/variations/new`}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              + Add variation
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Original</dt>
              <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                {GBP.format(originalRevenue)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Variations</dt>
              <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                {variationRevenue > 0 ? "+" : ""}
                {GBP.format(variationRevenue)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Total</dt>
              <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                {GBP.format(totalCommitted)}
              </dd>
            </div>
            {profit ? (
              <>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Profit</dt>
                  <dd
                    className={`mt-0.5 text-lg font-semibold ${profit.gross_profit < 0 ? "text-red-700" : "text-slate-900"}`}
                  >
                    {GBP.format(profit.gross_profit)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Margin</dt>
                  <dd className="mt-0.5">
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-sm font-semibold ${marginPillClass(profit.band)}`}
                    >
                      {profit.margin_pct === null ? "—" : `${profit.margin_pct}%`}
                    </span>
                  </dd>
                </div>
              </>
            ) : null}
            {hasCommittedCosts(committed) ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Committed (POs)</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                  {GBP.format(committed.committed)}
                </dd>
                <p className="text-xs text-slate-400">
                  {committed.count} order{committed.count === 1 ? "" : "s"}
                  {committed.received > 0 ? ` · ${GBP.format(committed.received)} received` : ""}
                </p>
              </div>
            ) : null}
            {billedActual > 0 ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Billed (actual)</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                  {GBP.format(billedActual)}
                </dd>
                <p className="text-xs text-slate-400">
                  {poBilledRows.length} bill{poBilledRows.length === 1 ? "" : "s"}
                  {committed.committed > 0
                    ? ` · ${Math.round((billedActual / committed.committed) * 100)}% of committed`
                    : ""}
                </p>
              </div>
            ) : null}
          </dl>

          {varRows.length > 0 ? (
            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Variations
              </div>
              <ul className="mt-2 divide-y divide-slate-100">
                {varRows.map((v) => {
                  const label = `Variation #${String(v.variation_number).padStart(3, "0")}`;
                  const statusColor =
                    v.status === "accepted"
                      ? "bg-green-100 text-green-800"
                      : v.status === "declined"
                        ? "bg-red-100 text-red-800"
                        : "bg-slate-100 text-slate-700";
                  const title = v.notes?.split("\n")[0]?.slice(0, 80) ?? label;
                  return (
                    <li key={v.id} className="flex items-center gap-3 py-2 text-sm">
                      <Link
                        href={`/quotes/${v.id}`}
                        className="min-w-0 flex-1 truncate hover:underline"
                      >
                        <span className="font-medium text-slate-900">{label}</span>
                        <span className="ml-2 text-slate-600">{title}</span>
                      </Link>
                      <span className="text-sm font-semibold text-slate-900">
                        {GBP.format(Number(v.total ?? 0))}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColor}`}
                      >
                        {v.status}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {!(originalRevenue > 0 || variationRevenue > 0 || varRows.length > 0) ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
          <div className="flex items-center justify-between gap-3">
            <p>
              No invoices linked yet. Once you link an invoice to this job
              (Invoice → <em>Link to job</em>), you can add variation orders
              here.
            </p>
            <Link
              href={`/jobs/${job.id}/variations/new`}
              className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              + Add variation
            </Link>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Profitability</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/finances/new?job_id=${job.id}`}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            >
              + Add cost
            </Link>
            {profit ? (
              <span
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${marginPillClass(profit.band)}`}
              >
                {profit.margin_pct === null
                  ? "no revenue yet"
                  : `${profit.margin_pct}% margin`}
              </span>
            ) : null}
          </div>
        </div>
        {!profit ? (
          <p className="mt-3 text-sm text-slate-500">
            No invoices or finance entries linked to this job yet. Open an
            invoice and pick this job under <em>Link to job</em>, and log
            finances against this job, to see profitability.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Revenue</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {GBP.format(profit.revenue)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Costs</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {GBP.format(profit.costs_total)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Gross profit</div>
                <div
                  className={`mt-1 text-lg font-semibold ${profit.gross_profit < 0 ? "text-red-700" : "text-slate-900"}`}
                >
                  {GBP.format(profit.gross_profit)}
                </div>
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Costs by category
              </div>
              <ul className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Labour</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.labour)}
                  </div>
                </li>
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Materials</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.materials)}
                  </div>
                </li>
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Subcontractors</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.subcontractors)}
                  </div>
                </li>
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Misc</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.misc)}
                  </div>
                </li>
              </ul>
            </div>
            <p className="text-[11px] text-slate-500">
              Revenue and costs are net of VAT. Margin bands: green &gt; 30%,
              amber 15–30%, red &lt; 15%.
            </p>
          </div>
        )}
      </section>

      <JobAssetsSection jobId={job.id} />

      <JobDocumentsPanel jobId={job.id} canViewPrivate={canViewPrivate} />

      <AttachmentsPanel targetTable="jobs" targetId={job.id} />

      {job.status === "completed" && job.customer_id ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
          <p className="text-sm font-medium text-emerald-900">
            Job&rsquo;s done — ask for a review
          </p>
          <p className="mt-1 text-xs text-emerald-800">
            We&rsquo;ll schedule a request the customer can act on at the right
            moment. Pick the platform and a delay.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/reviews/new?customer_id=${job.customer_id}&job_id=${job.id}`}
              className="inline-block rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              Request a review
            </Link>
            <Link
              href={`/jobs/${job.id}/certificate`}
              className="inline-block rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-50"
            >
              Completion certificate
            </Link>
          </div>
        </section>
      ) : null}

      <ConfirmForm
        action={deleteAction}
        confirm="Delete this job? Linked photos and timesheet references go too. This can't be undone."
        className="rounded-xl border border-red-200 bg-red-50/50 p-4 block"
      >
        <p className="text-sm font-medium text-red-900">Delete this job</p>
        <p className="mt-1 text-xs text-red-700">
          Removes the job and any linked photo references. Only admins/owners
          can delete.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
        >
          Delete job
        </button>
      </ConfirmForm>
    </div>
  );
}

function PositionCell({
  label,
  value,
  sub,
  strong,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
  tone?: "amber";
}) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 ${strong ? "text-lg font-bold text-slate-900" : "text-sm font-semibold text-slate-800"}`}>
        {value}
      </dd>
      {sub ? <dd className="text-[11px] text-slate-500">{sub}</dd> : null}
    </div>
  );
}
