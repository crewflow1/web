import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  computeVatQuarter,
  endOfQuarterExclusiveIso,
  resolveFlatRateForPeriod,
} from "@/lib/tax/compute";
import { readOrgSettings } from "@/lib/org-config/service";
import {
  gatherVatQuarterInputs,
  type VatInputsDb,
} from "@/server/services/vat-quarter-inputs";

/**
 * Reports module — pure SQL aggregates for the /reports page.
 *
 * All queries run under the caller's JWT (RLS-gated) AND are pinned to the
 * ACTIVE org. The pin is load-bearing, not defence-in-depth: RLS's
 * `current_org_ids()` returns EVERY org the viewer belongs to, so an unpinned
 * read made every figure on /reports — jobs per week, revenue per month, VAT
 * per quarter, top customers — the SUM of both of a dual-org owner's companies,
 * with the other company's customer names listed by revenue. Same defect class
 * as #456/#459/#461/#463/#464; the caller passes `ctx.org.id`.
 *
 * Aggregation is done in TypeScript over fetched rows. Every read pages through
 * `fetchAllRows` (chunks STRICTLY below the 1000-row PostgREST cap, with a
 * unique `id` tiebreak on the ordering so no page boundary can drop or repeat a
 * row). A bare `.select()` here is NOT safe at any volume: the moment an org
 * crosses ~1000 matching rows PostgREST silently returns only the first page,
 * so revenue/VAT/job/customer figures would under-report with no error — the
 * F-1 silent-truncation class. For the much-later era where a single org carries
 * tens of thousands of rows per entity these should move to DB-side SQL
 * aggregates / RPC views, but that is deliberate, separate work.
 */

/**
 * Injectable Supabase client. The page/export routes pass nothing (each
 * function builds its own user-JWT client, RLS-gated); the delivery cron passes
 * the SERVICE-ROLE admin client so it can render a report for an org it has no
 * JWT for. Either way every read below is org-pinned in-statement, so the
 * admin path (RLS bypassed) never blends orgs. Typed as the ssr server client
 * so the existing typed reads below compile unchanged; the cron passes the
 * service-role client cast to this type.
 */
export type ReportsDb = Awaited<ReturnType<typeof createClient>>;

export type JobsPerWeek = {
  /** Monday of the week (ISO date). */
  week_start: string;
  total: number;
  completed: number;
};

export type RevenuePerMonth = {
  /** First of the month (ISO date). */
  month: string;
  revenue: number;
};

export type VatPerQuarter = {
  /** First day of the quarter (ISO date). */
  quarter: string;
  output_vat: number;
  input_vat: number;
  net_vat: number;
};

export type TopCustomer = {
  id: string;
  name: string;
  revenue: number;
  invoice_count: number;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
}

export async function jobsPerWeek(
  orgId: string,
  weeks = 8,
  db?: ReportsDb,
): Promise<JobsPerWeek[]> {
  const supabase = db ?? (await createClient());

  // DB-side grouped aggregate (A6). This used to fetch EVERY job scheduled in the
  // window (paged under the 1000-row cap) and group/count in TypeScript into ~8
  // weekly buckets — the read scaled with the org's job volume for a fixed-size
  // chart. `reports_jobs_per_week` does the `count … group by week` in SQL and
  // returns only the pre-filled, oldest-first bucket rows the chart renders. The
  // semantics are PRESERVED EXACTLY (all UTC): week_start = ISO-Monday of
  // scheduled_date, window = scheduled_date >= today_utc - weeks*7 days, every week
  // pre-filled to 0, rows outside the window dropped — identical to the loop below
  // it replaces. The window is day-1-safe (never overflows on a 29/30/31).
  //
  // The RPC is SECURITY DEFINER and org-guarded (current_org_ids()/42501, see
  // supabase/migrations/20261240000000_reports_windowed_aggregates_rpc.sql) and
  // org-filtered by orgId; the page/export routes call it on the user-JWT client,
  // the delivery cron on the service-role client (guard skips service_role,
  // p_org_id still scopes it).
  const { data, error } = await supabase.rpc("reports_jobs_per_week", {
    p_org_id: orgId,
    p_weeks: weeks,
  });
  // Loud fail: pre-filled buckets make an errored read indistinguishable from
  // a genuinely quiet period — an all-zero chart must mean zero, not "failed".
  if (error) throw readFailure("reports: jobs per week", error);

  return (data ?? []).map((row) => ({
    week_start: row.week_start,
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
  }));
}

export async function revenuePerMonth(
  orgId: string,
  months = 12,
  db?: ReportsDb,
): Promise<RevenuePerMonth[]> {
  const supabase = db ?? (await createClient());

  // DB-side grouped aggregate (A6). This used to fetch EVERY paid invoice in the
  // window (paged under the 1000-row cap) and sum in TypeScript into ~12 monthly
  // buckets — the read scaled with the org's paid-invoice volume for a fixed-size
  // chart. `reports_revenue_per_month` does the `sum(amount) … group by month` in
  // SQL and returns only the pre-filled, oldest-first bucket rows the chart renders.
  // The semantics are PRESERVED EXACTLY (all UTC):
  //   - Revenue is EX-VAT. `invoices.amount` is the net subtotal; `invoices.total`
  //     is a stored generated column = amount + vat_total (GROSS — it includes the
  //     VAT collected on HMRC's behalf, never the business's turnover). The RPC
  //     sums `amount`, never `total` (summing `total` overstated revenue ~20% and
  //     disagreed with /insights + /dashboard — lib/intelligence/concentration.ts
  //     owns the rule).
  //   - month = first-of-month (UTC) of paid_at; window = paid_at >=
  //     first-of-(current_month - (months-1)); every month pre-filled to 0.
  //   - The window is day-1-normalised, so it can never overflow on a 29/30/31
  //     `now` (the C48 class) and always yields exactly `months` distinct buckets.
  //
  // The RPC is SECURITY DEFINER and org-guarded (current_org_ids()/42501, see
  // supabase/migrations/20261240000000_reports_windowed_aggregates_rpc.sql) and
  // org-filtered by orgId; the page/export routes call it on the user-JWT client,
  // the delivery cron on the service-role client (guard skips service_role,
  // p_org_id still scopes it).
  const { data, error } = await supabase.rpc("reports_revenue_per_month", {
    p_org_id: orgId,
    p_months: months,
  });
  if (error) throw readFailure("reports: revenue per month", error);

  return (data ?? []).map((row) => ({
    month: row.month,
    revenue: Number(row.revenue ?? 0), // ex-VAT, never gross `total`
  }));
}

export async function vatPerQuarter(
  orgId: string,
  quarters = 4,
  db?: ReportsDb,
): Promise<VatPerQuarter[]> {
  const supabase = db ?? (await createClient());
  // Day-1-normalised UTC base (see revenuePerMonth): the mutable-Date idiom would
  // overflow on a 31st. startOfQuarter flooring later absorbs the slip here, but
  // build it safely for consistency with the revenue path.
  const now = new Date();
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (quarters * 3 - 1), 1),
  );

  // SINGLE VAT AUTHORITY. This trend used to sum `invoices.vat_total` over
  // status='paid' invoices, which drifted from every other VAT surface: the
  // payment trigger stamps `invoices.paid_at` ONLY on FULL settlement, so a
  // status-gated sum dropped ALL partial/deposit/instalment output VAT (and
  // omitted domestic reverse charge entirely) — understating the /reports
  // net-VAT-liability trend against /dashboard, /tax, the quarterly PDF and the
  // frozen HMRC 9-box return. It now routes EACH quarter window through the same
  // authority those surfaces use — `gatherVatQuarterInputs` (cash-basis
  // invoice_payments ledger + frozen reverse-charge totals, PAGED + loud) then
  // the pure `computeVatQuarter` — so the fourth VAT surface reconciles exactly.
  //
  // Input VAT (box 4) follows the org's basis (CF-1): CASH from the supplier-payment
  // ledger (per window, from gatherVatQuarterInputs) under the cash scheme, ACCRUAL
  // on logged finance rows under standard. For the accrual path, finances are read
  // ONCE over the whole span (PAGED + loud) and each window's compute re-gates them
  // on created_at; the cash path ignores this finances arg (box 4/7 come from the
  // ledger) — no separate summing, no double-count, no drop.
  const finRes = await fetchAllRows<{
    created_at: string;
    vat_total: number | null;
    amount: number | null;
  }>((from, to) =>
    supabase
      .from("finances")
      .select("id, created_at, vat_total, amount")
      .eq("org_id", orgId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (finRes.error) throw readFailure("reports: VAT finances", finRes.error);
  const finances = finRes.data ?? [];

  // The quarter windows, day-1-normalised (never overflow on a 31st).
  const quarterStarts: string[] = [];
  for (let i = quarters - 1; i >= 0; i--) {
    const q = startOfQuarter(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i * 3, 1)),
    );
    quarterStarts.push(isoDate(q));
  }

  // Per-window: gather the cash-basis ledger + reverse-charge totals through the
  // authority (SAME call shape as the /tax page and the quarterly-PDF route),
  // then compute boxes 1/4/5 with the one pure function. The EXCLUSIVE upper
  // bound keeps a next-quarter payment out.
  // The org's scheme + FRS config so this trend reconciles with /tax, /dashboard,
  // the PDF and the frozen return. Read ONCE; each quarter re-resolves FRS on its
  // own start (effective-date gating handles quarters before FRS began). Cash +
  // disabled FRS ⇒ inert opts ⇒ the trend is byte-for-byte the pre-scheme figures.
  const orgSettings = await readOrgSettings(supabase, orgId);
  const vatDb = supabase as unknown as VatInputsDb;
  const rows = await Promise.all(
    quarterStarts.map(async (quarterStartIso) => {
      const quarterEndExclusiveIso = endOfQuarterExclusiveIso(quarterStartIso);
      const inputs = await gatherVatQuarterInputs(
        vatDb,
        orgId,
        quarterStartIso,
        quarterEndExclusiveIso,
        orgSettings.vat_scheme,
      );
      const vat = computeVatQuarter(
        inputs.invoicePayments,
        finances,
        quarterStartIso,
        quarterEndExclusiveIso,
        inputs.reverseCharge.vat,
        {
          scheme: orgSettings.vat_scheme,
          accrualInvoices: inputs.accrualInvoices,
          flatRate: resolveFlatRateForPeriod(orgSettings.flat_rate_config, quarterStartIso),
          // CF-1: cash-scheme box 4 is payment-based (supplier-payment ledger);
          // undefined under standard ⇒ accrual.
          supplierPayments: inputs.supplierPayments,
          reverseChargeNet: inputs.reverseCharge.net,
        },
      );
      return {
        quarter: quarterStartIso,
        output_vat: vat.output_vat,
        input_vat: vat.input_vat,
        net_vat: vat.net_payable,
      } satisfies VatPerQuarter;
    }),
  );
  return rows;
}

/**
 * The synthetic bucket for paid revenue whose customer can't be resolved at all
 * — neither via `invoices.customer_id` nor a surviving `quote.customer`. This is
 * a REAL row in the ranking, never a dropped one: silently `continue`-skipping
 * it would understate a customer's rank AND shrink the org's total paid revenue,
 * so the report would fail to reconcile against revenuePerMonth. Same discipline
 * as lib/intelligence/concentration.ts's explicit "Unattributed" bucket. The id
 * is a sentinel (used only as a list key / de-dupe key), not a customer id.
 */
export const UNATTRIBUTED_CUSTOMER_ID = "__unattributed__";
export const UNATTRIBUTED_CUSTOMER_LABEL = "Unattributed";

export async function topCustomersByRevenue(
  orgId: string,
  limit = 10,
  db?: ReportsDb,
): Promise<TopCustomer[]> {
  const supabase = db ?? (await createClient());

  // DB-side grouped aggregate (R2). This used to fetch EVERY paid invoice (no
  // date bound — all-time) AND EVERY customer for the org, then group/sum/sort
  // in TypeScript — both reads scaling with the lifetime ledger for a 10-row
  // ranking. `reports_top_customers_by_revenue` does the `sum, count group by
  // resolved customer … order by revenue desc limit N` in SQL and returns only
  // the N rows rendered. The resolution rule is PRESERVED EXACTLY by the RPC:
  //   - invoices.customer_id FIRST (denormalised anchor, 20260915);
  //   - the quote->customer link (quotes.customer_id) as the pre-backfill
  //     fallback when customer_id is null;
  //   - paid revenue that resolves to NEITHER is grouped into one Unattributed
  //     bucket (RPC returns customer_id = null), NEVER dropped — so Σ(revenue
  //     over all buckets) still equals the paid-invoice total and the ranking
  //     reconciles with revenuePerMonth (same ex-VAT `amount`, same status).
  // Revenue is EX-VAT (`amount`), never the gross generated `total`.
  //
  // The RPC is SECURITY DEFINER and org-guarded (current_org_ids()/42501, see
  // supabase/migrations/20261237000000_reports_top_customers_rpc.sql) and
  // org-filtered by orgId; the page/export routes call it on the user-JWT
  // client, the delivery cron on the service-role client (guard skips
  // service_role, p_org_id still scopes it).
  const { data, error } = await supabase.rpc("reports_top_customers_by_revenue", {
    p_org_id: orgId,
    p_limit: limit,
  });
  if (error) throw readFailure("reports: top customers", error);

  return (data ?? []).map((row) => {
    // The Unattributed bucket comes back as a null customer id; map it to the
    // sentinel id + label this module owns (identical to the prior behaviour).
    const attributed = row.customer_id != null;
    return {
      id: attributed ? row.customer_id! : UNATTRIBUTED_CUSTOMER_ID,
      name: attributed ? (row.name ?? "—") : UNATTRIBUTED_CUSTOMER_LABEL,
      revenue: Number(row.revenue ?? 0),
      invoice_count: Number(row.invoice_count ?? 0),
    } satisfies TopCustomer;
  });
}
