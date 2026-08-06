import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

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

export async function jobsPerWeek(orgId: string, weeks = 8): Promise<JobsPerWeek[]> {
  const supabase = await createClient();
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
): Promise<RevenuePerMonth[]> {
  const supabase = await createClient();
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months + 1);
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

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
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i);
    const m = startOfMonth(d);
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
): Promise<VatPerQuarter[]> {
  const supabase = await createClient();
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - quarters * 3 + 1);
  since.setUTCDate(1);

  // Output VAT: paid invoices' VAT collected. Input VAT: VAT paid out
  // recorded against finance entries.
  const [invRes, finRes] = await Promise.all([
    fetchAllRows<{
      paid_at: string | null;
      vat_total: number | null;
      status: string | null;
    }>((from, to) =>
      supabase
        .from("invoices")
        .select("id, paid_at, vat_total, status")
        .eq("org_id", orgId)
        .eq("status", "paid")
        .gte("paid_at", since.toISOString())
        .order("paid_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{ created_at: string; vat_total: number | null }>((from, to) =>
      supabase
        .from("finances")
        .select("id, created_at, vat_total")
        .eq("org_id", orgId)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const buckets = new Map<string, VatPerQuarter>();
  for (let i = quarters - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i * 3);
    const q = startOfQuarter(d);
    buckets.set(isoDate(q), {
      quarter: isoDate(q),
      output_vat: 0,
      input_vat: 0,
      net_vat: 0,
    });
  }

  if (invRes.error) throw readFailure("reports: VAT invoices", invRes.error);
  if (finRes.error) throw readFailure("reports: VAT finances", finRes.error);
  for (const inv of invRes.data ?? []) {
    if (!inv.paid_at) continue;
    const key = isoDate(startOfQuarter(new Date(inv.paid_at)));
    const slot = buckets.get(key);
    if (!slot) continue;
    slot.output_vat += Number(inv.vat_total ?? 0);
  }
  for (const f of finRes.data ?? []) {
    const key = isoDate(startOfQuarter(new Date(f.created_at)));
    const slot = buckets.get(key);
    if (!slot) continue;
    slot.input_vat += Number(f.vat_total ?? 0);
  }
  for (const slot of buckets.values()) {
    slot.net_vat = Math.round((slot.output_vat - slot.input_vat) * 100) / 100;
  }
  return Array.from(buckets.values());
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
): Promise<TopCustomer[]> {
  const supabase = await createClient();

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
