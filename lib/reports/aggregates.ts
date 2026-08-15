import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { computeVatQuarter, endOfQuarterExclusiveIso } from "@/lib/tax/compute";
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

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO-week containing `d` (UTC). */
function startOfWeek(d: Date): Date {
  const dow = d.getUTCDay();
  const daysFromMon = (dow + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMon));
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
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
  const since = new Date(Date.now() - weeks * 7 * DAY_MS).toISOString().slice(0, 10);

  const { data, error } = await fetchAllRows<{
    status: string | null;
    scheduled_date: string | null;
  }>((from, to) =>
    supabase
      .from("jobs")
      .select("id, status, scheduled_date")
      .eq("org_id", orgId)
      .gte("scheduled_date", since)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  // Loud fail: pre-filled buckets make an errored read indistinguishable from
  // a genuinely quiet period — an all-zero chart must mean zero, not "failed".
  if (error) throw readFailure("reports: jobs per week", error);

  // Pre-fill empty buckets so flat-line weeks show as 0 rather than gaps.
  const buckets = new Map<string, JobsPerWeek>();
  const todayWeekStart = startOfWeek(new Date());
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(todayWeekStart);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = isoDate(d);
    buckets.set(key, { week_start: key, total: 0, completed: 0 });
  }

  for (const j of data ?? []) {
    if (!j.scheduled_date) continue;
    const key = isoDate(startOfWeek(new Date(`${j.scheduled_date}T00:00:00Z`)));
    const slot = buckets.get(key);
    if (!slot) continue;
    slot.total++;
    if (j.status === "completed") slot.completed++;
  }
  return Array.from(buckets.values());
}

export async function revenuePerMonth(
  orgId: string,
  months = 12,
  db?: ReportsDb,
): Promise<RevenuePerMonth[]> {
  const supabase = db ?? (await createClient());
  // Build the window from a DAY-1-NORMALISED UTC base. Mutating a live Date with
  // setUTCMonth WHILE it still holds day 29/30/31 overflows into the next month
  // for shorter target months (setUTCMonth clamps day-of-month AFTER the shift,
  // and the setUTCDate(1) floor happened too late) — so on a 31st the window
  // silently lost/duplicated buckets. Date.UTC() takes the target month with
  // day=1 up front, so the month can never overflow and negative months roll the
  // year back correctly. Same day-safe construction as lib/profitability/compute.ts:261.
  const now = new Date();
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1),
  );

  // Revenue is EX-VAT. `invoices.amount` is the net subtotal; `invoices.total` is
  // a stored generated column = amount + vat_total (GROSS — it includes the VAT
  // collected on HMRC's behalf, which is never the business's turnover). Summing
  // `total` overstated revenue by the VAT rate (~20%) and disagreed with
  // /insights and /dashboard, which both report ex-VAT `amount`
  // (lib/intelligence/concentration.ts documents the rule). Select and sum
  // `amount`, never `total`.
  const { data, error } = await fetchAllRows<{
    paid_at: string | null;
    amount: number | null;
    status: string | null;
  }>((from, to) =>
    supabase
      .from("invoices")
      .select("id, paid_at, amount, status")
      .eq("org_id", orgId)
      .eq("status", "paid")
      .gte("paid_at", since.toISOString())
      .order("paid_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("reports: revenue per month", error);

  const buckets = new Map<string, RevenuePerMonth>();
  for (let i = months - 1; i >= 0; i--) {
    // Day-1-normalised UTC construction (see `since` above): never overflow.
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.set(isoDate(m), { month: isoDate(m), revenue: 0 });
  }

  for (const inv of data ?? []) {
    if (!inv.paid_at) continue;
    const key = isoDate(startOfMonth(new Date(inv.paid_at)));
    const slot = buckets.get(key);
    if (!slot) continue;
    slot.revenue += Number(inv.amount ?? 0); // ex-VAT, never gross `total`
  }
  return Array.from(buckets.values());
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
  // Input VAT (box 4) is ACCRUAL on logged finance rows: computeVatQuarter sums
  // `finances.vat_total` in-window itself, so finances are read ONCE over the
  // whole span (PAGED + loud) and each window's compute re-gates them on
  // created_at — no separate summing, no double-count, no drop.
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
  const vatDb = supabase as unknown as VatInputsDb;
  const rows = await Promise.all(
    quarterStarts.map(async (quarterStartIso) => {
      const quarterEndExclusiveIso = endOfQuarterExclusiveIso(quarterStartIso);
      const inputs = await gatherVatQuarterInputs(
        vatDb,
        orgId,
        quarterStartIso,
        quarterEndExclusiveIso,
      );
      const vat = computeVatQuarter(
        inputs.invoicePayments,
        finances,
        quarterStartIso,
        quarterEndExclusiveIso,
        inputs.reverseCharge.vat,
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

  // Two paged, org-pinned, loud reads (the vatPerQuarter shape):
  //  1. paid invoices — with the DENORMALISED `customer_id` (20260915) read
  //     FIRST, and the quote->customer embed kept only as the pre-backfill
  //     fallback. `invoices_quote_id_fkey` is ON DELETE SET NULL, so a deleted
  //     quote nulls `quote_id`/`quote.customer` while `customer_id` survives —
  //     resolving via the embed ALONE silently dropped that invoice's paid
  //     revenue from the ranking. The migration itself mandates preferring
  //     `customer_id` over walking quote->customer.
  //  2. the org's customers — a separate id->name lookup (the concentration.ts
  //     idiom), so `customer_id` resolves to a display name WITHOUT adding an
  //     invoices->customers embed. `invoices` carries a composite FK to
  //     customers (customer_id, org_id); a bare embed is avoidable noise, and
  //     the separate lookup keeps the resolution rule identical to the sibling
  //     concentration surface.
  const [invRes, custRes] = await Promise.all([
    fetchAllRows<{
      amount: number | null;
      status: string | null;
      customer_id: string | null;
      quote: { customer: { id: string; name: string | null } | null } | null;
    }>((from, to) =>
      supabase
        .from("invoices")
        // Revenue is EX-VAT: select `amount` (net subtotal), never the generated
        // GROSS `total` (= amount + vat_total). Summing `total` overstated every
        // customer's revenue by the VAT rate and disagreed with /insights.
        .select(
          `
          id, amount, status, customer_id,
          quote:quotes (
            customer:customers ( id, name )
          )
        `,
        )
        .eq("org_id", orgId)
        .eq("status", "paid")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{ id: string; name: string | null }>((from, to) =>
      supabase
        .from("customers")
        .select("id, name")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  if (invRes.error) throw readFailure("reports: top customers", invRes.error);
  if (custRes.error) throw readFailure("reports: top customers (names)", custRes.error);

  const customerName = new Map(
    (custRes.data ?? []).map((c) => [c.id, c.name ?? "—"]),
  );

  const byCustomer = new Map<string, TopCustomer>();
  for (const inv of invRes.data ?? []) {
    // customer_id FIRST (denormalised anchor); quote.customer only as fallback;
    // anything that resolves to neither lands in the Unattributed bucket rather
    // than being dropped, so the ranking's total reconciles with paid revenue.
    let id: string;
    let name: string;
    if (inv.customer_id) {
      id = inv.customer_id;
      name = customerName.get(inv.customer_id) ?? "—";
    } else if (inv.quote?.customer?.id) {
      id = inv.quote.customer.id;
      name = inv.quote.customer.name ?? "—";
    } else {
      id = UNATTRIBUTED_CUSTOMER_ID;
      name = UNATTRIBUTED_CUSTOMER_LABEL;
    }
    const prev = byCustomer.get(id) ?? { id, name, revenue: 0, invoice_count: 0 };
    prev.revenue += Number(inv.amount ?? 0); // ex-VAT, never gross `total`
    prev.invoice_count++;
    byCustomer.set(id, prev);
  }
  return Array.from(byCustomer.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}
