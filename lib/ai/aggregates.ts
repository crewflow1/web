import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  invoiceBusinessToday,
  invoiceDaysOverdue,
  isInvoiceOverdue,
} from "@/lib/invoices/overdue";
import type {
  ActivitySummaryResponse,
  LeadInsightsResponse,
  QuoteFunnel,
  StalledQuote,
  StalledInvoice,
} from "./types";

/**
 * Server-only helpers that compute the deterministic insight payloads.
 *
 * Everything runs under the caller's JWT (RLS-scoped). When the LLM
 * lands the prose `summary` field gets populated by a separate code
 * path; until then it's null.
 */

const DAY_MS = 86_400_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

export async function computeActivitySummary(
  orgId: string,
  windowDays = 7,
): Promise<ActivitySummaryResponse> {
  const supabase = await createClient();
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString();

  // --- 1) action counts within the window, bucketed by prefix --------------
  //     + daily volume time series with per-prefix breakdown.
  const { data: actions } = await supabase
    .from("activity_log")
    .select("action, created_at")
    .gte("created_at", since);

  const prefixCounts = new Map<string, number>();
  const dailyMap = new Map<string, { count: number; by_prefix: Record<string, number> }>();
  // Pre-fill every day in the window so flat days show as 0 in the chart.
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS);
    dailyMap.set(d.toISOString().slice(0, 10), { count: 0, by_prefix: {} });
  }
  for (const row of actions ?? []) {
    const prefix = row.action.split(".")[0] ?? "other";
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    const dayKey = row.created_at.slice(0, 10);
    const slot = dailyMap.get(dayKey);
    if (slot) {
      slot.count++;
      slot.by_prefix[prefix] = (slot.by_prefix[prefix] ?? 0) + 1;
    }
  }
  const action_counts = Array.from(prefixCounts.entries())
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count);
  const daily_volume = Array.from(dailyMap.entries()).map(([date, agg]) => ({
    date,
    count: agg.count,
    by_prefix: agg.by_prefix,
  }));

  // --- 2) quote funnel + latencies -----------------------------------------
  const { data: quotes } = await supabase
    .from("quotes")
    .select(
      "id, number, total, sent_at, viewed_at, accepted_at, declined_at, customer:customers ( name )",
    );

  let sent = 0;
  let viewed = 0;
  let accepted = 0;
  let declined = 0;
  const viewToAcceptSec: number[] = [];
  const sentToAcceptSec: number[] = [];
  for (const q of quotes ?? []) {
    if (q.sent_at) sent++;
    if (q.viewed_at) viewed++;
    if (q.accepted_at) accepted++;
    if (q.declined_at) declined++;
    if (q.viewed_at && q.accepted_at) {
      viewToAcceptSec.push(
        Math.max(0, Math.round((+new Date(q.accepted_at) - +new Date(q.viewed_at)) / 1000)),
      );
    }
    if (q.sent_at && q.accepted_at) {
      sentToAcceptSec.push(
        Math.max(0, Math.round((+new Date(q.accepted_at) - +new Date(q.sent_at)) / 1000)),
      );
    }
  }

  // L3: conversion = win rate among DECIDED quotes (accepted vs
  // accepted+declined), matching the dashboard's definition in
  // app/(app)/dashboard/page.tsx. The previous formula divided accepted by
  // `sent`, which (a) rendered "—" when quotes were accepted without a
  // recorded sent_at, and (b) could exceed 100% (QA observed 133%) when more
  // quotes were accepted than were marked sent. accepted ≤ accepted+declined
  // by construction, so this is bounded to 0–100; Math.min is belt-and-braces.
  const decided = accepted + declined;
  const quote_funnel: QuoteFunnel = {
    sent,
    viewed,
    accepted,
    declined,
    conversion_pct:
      decided === 0
        ? null
        : Math.min(100, Math.round((accepted / decided) * 100)),
    median_view_to_accept_sec: median(viewToAcceptSec),
    avg_sent_to_accept_sec: avg(sentToAcceptSec),
  };

  // --- 3) stalled quotes: sent > 7d, never viewed --------------------------
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const quotes_unviewed_7d: StalledQuote[] = [];
  for (const q of quotes ?? []) {
    if (
      q.sent_at &&
      q.sent_at < sevenDaysAgo &&
      !q.viewed_at &&
      !q.accepted_at &&
      !q.declined_at
    ) {
      const daysStale = Math.floor((Date.now() - +new Date(q.sent_at)) / DAY_MS);
      quotes_unviewed_7d.push({
        id: q.id,
        number: q.number ?? "—",
        customer_name: q.customer?.name ?? null,
        total: Number(q.total ?? 0),
        sent_at: q.sent_at,
        days_stale: daysStale,
        href: `/quotes/${q.id}`,
      });
    }
  }
  quotes_unviewed_7d.sort((a, b) => b.days_stale - a.days_stale);

  // --- 4) overdue invoices -------------------------------------------------
  // Uses the one authority (lib/invoices/overdue.ts). This previously ran its
  // own definition — `sent_at < now-30d && !paid_at`, with days_overdue
  // measured from sent_at — which is a different question: 30 days after
  // SENDING is not overdue under 60-day terms, and it ignored due_date
  // entirely. The dashboard meanwhile used due_date, so the two surfaces
  // disagreed about which invoices were overdue and by how long.
  const todayIso = invoiceBusinessToday();
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, number, status, total, sent_at, due_date, paid_at");

  const invoices_overdue_30d: StalledInvoice[] = [];
  for (const inv of invoices ?? []) {
    if (!isInvoiceOverdue(inv, todayIso)) continue;
    invoices_overdue_30d.push({
      id: inv.id,
      number: inv.number ?? "—",
      total: Number(inv.total ?? 0),
      sent_at: inv.sent_at,
      due_date: inv.due_date,
      // Days past the DEADLINE now, not days since sending.
      days_overdue: invoiceDaysOverdue(inv, todayIso) ?? 0,
      href: `/invoices/${inv.id}`,
    });
  }
  invoices_overdue_30d.sort((a, b) => b.days_overdue - a.days_overdue);

  // --- 5) staff leaderboard — most completed jobs --------------------------
  // Use jobs.assigned_to since "who is credited with closing the job"
  // is the assignment, not whoever clicked the status button.
  const { data: jobs } = await supabase
    .from("jobs")
    .select("status, assigned_to, assigned:users!jobs_assigned_to_fkey ( id, full_name, email )");

  const leaderMap = new Map<
    string,
    { user_id: string | null; name: string; completed_jobs: number }
  >();
  for (const j of jobs ?? []) {
    if (j.status !== "completed") continue;
    const userId = j.assigned_to ?? null;
    const key = userId ?? "unassigned";
    const name =
      j.assigned?.full_name ?? j.assigned?.email ?? "Unassigned";
    const prev = leaderMap.get(key);
    if (prev) prev.completed_jobs++;
    else leaderMap.set(key, { user_id: userId, name, completed_jobs: 1 });
  }
  const staff_leaders = Array.from(leaderMap.values())
    .sort((a, b) => b.completed_jobs - a.completed_jobs)
    .slice(0, 10);

  return {
    org_id: orgId,
    window_days: windowDays,
    summary: null, // populated by the route handler if LLM + cache says so
    cache: "disabled", // route handler overrides on hit / miss
    action_counts,
    daily_volume,
    key_metrics: {
      total_events: actions?.length ?? 0,
      quote_funnel,
      staff_leaders,
    },
    stalled_actions: {
      quotes_unviewed_7d,
      invoices_overdue_30d,
    },
  };
}

export async function computeLeadInsights(
  orgId: string,
  windowDays = 30,
): Promise<LeadInsightsResponse> {
  const supabase = await createClient();
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString();

  const { data: leads } = await supabase
    .from("leads")
    .select("id, status, source, estimated_value, created_at")
    .gte("created_at", since);

  const funnel = {
    new: 0,
    contacted: 0,
    qualified: 0,
    quoted: 0,
    won: 0,
    lost: 0,
    job_booked: 0,
  };
  let pipelineForecast = 0;
  const bySource = new Map<string, { total: number; won: number; lost: number }>();

  for (const l of leads ?? []) {
    const status = (l.status ?? "new") as keyof typeof funnel;
    if (status in funnel) funnel[status]++;
    if (
      status === "new" ||
      status === "contacted" ||
      status === "qualified" ||
      status === "quoted"
    ) {
      pipelineForecast += Number(l.estimated_value ?? 0);
    }
    const src = l.source ?? "other";
    const prev = bySource.get(src) ?? { total: 0, won: 0, lost: 0 };
    prev.total++;
    if (status === "won" || status === "job_booked") prev.won++;
    if (status === "lost") prev.lost++;
    bySource.set(src, prev);
  }

  const won = funnel.won + funnel.job_booked;
  const lost = funnel.lost;
  const conversion_pct =
    won + lost === 0 ? null : Math.round((won / (won + lost)) * 100);

  const source_close_rates = Array.from(bySource.entries())
    .map(([source, agg]) => ({
      source,
      total: agg.total,
      won: agg.won,
      lost: agg.lost,
      close_pct:
        agg.won + agg.lost === 0
          ? null
          : Math.round((agg.won / (agg.won + agg.lost)) * 100),
    }))
    .sort((a, b) => b.total - a.total);

  return {
    org_id: orgId,
    window_days: windowDays,
    summary: null,
    cache: "disabled", // overridden by the route handler on hit/miss
    funnel,
    conversion_pct,
    source_close_rates,
    pipeline_forecast: pipelineForecast,
  };
}
