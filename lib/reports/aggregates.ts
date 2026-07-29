import "server-only";
import { createClient } from "@/lib/supabase/server";

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
 * Aggregation is done in TypeScript over fetched rows; with <5000 rows per
 * entity per org (the MVP target volume) this comfortably outperforms multiple
 * round-trips and avoids needing dedicated RPC views.
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

  const { data } = await supabase
    .from("jobs")
    .select("status, scheduled_date")
    .eq("org_id", orgId)
    .gte("scheduled_date", since);

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

  const { data } = await supabase
    .from("invoices")
    .select("paid_at, total, status")
    .eq("org_id", orgId)
    .eq("status", "paid")
    .gte("paid_at", since.toISOString());

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
    slot.revenue += Number(inv.total ?? 0);
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
    supabase
      .from("invoices")
      .select("paid_at, vat_total, status")
      .eq("org_id", orgId)
      .eq("status", "paid")
      .gte("paid_at", since.toISOString()),
    supabase
      .from("finances")
      .select("created_at, vat_total")
      .eq("org_id", orgId)
      .gte("created_at", since.toISOString()),
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

export async function topCustomersByRevenue(
  orgId: string,
  limit = 10,
): Promise<TopCustomer[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("invoices")
    .select(
      `
        total, status,
        quote:quotes (
          customer:customers ( id, name )
        )
      `,
    )
    .eq("org_id", orgId)
    .eq("status", "paid");

  const byCustomer = new Map<string, TopCustomer>();
  for (const inv of data ?? []) {
    const c = inv.quote?.customer;
    if (!c?.id) continue;
    const prev = byCustomer.get(c.id) ?? {
      id: c.id,
      name: c.name ?? "—",
      revenue: 0,
      invoice_count: 0,
    };
    prev.revenue += Number(inv.total ?? 0);
    prev.invoice_count++;
    byCustomer.set(c.id, prev);
  }
  return Array.from(byCustomer.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}
