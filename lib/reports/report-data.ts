import "server-only";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { formatDayKeyUK } from "@/lib/time/format";
import {
  jobsPerWeek,
  revenuePerMonth,
  vatPerQuarter,
  topCustomersByRevenue,
  type ReportsDb,
} from "./aggregates";
import {
  computeAllJobsProfitability,
  profitByMonth,
  type JobProfitability,
} from "@/lib/profitability/compute";
import {
  gatherCashTimeline,
  type ForecastingClient,
} from "@/server/services/forecasting";
import {
  gatherUtilisation,
  type IntelligenceClient,
} from "@/server/services/intelligence";
import { UTILISATION_WINDOW_DAYS } from "@/server/services/intelligence";
import { trailingDayWindow } from "@/lib/intelligence/window";
import { bucketPipelineLeads, type RawPipelineLead } from "@/app/(app)/leads/pipeline";
import { LEAD_STAGES, LEAD_STAGE_LABELS, type LeadStage } from "@/lib/leads/schema";
import type { ReportKey } from "./registry";
import {
  overviewToDocument,
  profitToDocument,
  cashflowToDocument,
  utilisationToDocument,
  pipelineToDocument,
  type ReportDocument,
  type PipelineStageRow,
} from "./documents";

/**
 * REPORT DATA — the READ + COMPOSE layer for every /reports report.
 *
 * FETCHES AND COMPOSES; decides nothing. Each builder pages the underlying
 * ledgers (org-pinned, loud, F-1-safe via `fetchAllRows`) and hands the rows to
 * the EXISTING compute authority — it never re-derives a figure:
 *
 *   overview     → lib/reports/aggregates (jobs/revenue/VAT/top customers)
 *   profit       → lib/profitability/compute (computeAllJobsProfitability + profitByMonth)
 *   cashflow     → server/services/forecasting.gatherCashTimeline (→ computeCashTimeline)
 *   utilisation  → server/services/intelligence.gatherUtilisation (→ computeUtilisation)
 *   pipeline     → app/(app)/leads/pipeline.bucketPipelineLeads
 *
 * The compute output is mapped to the ONE `ReportDocument` shape
 * (lib/reports/documents), so the page, the PDF and the CSV all render the same
 * numbers.
 *
 * CLIENT-INJECTED. The page/export routes pass a user-JWT client (RLS-gated);
 * the delivery cron passes the SERVICE-ROLE admin client so it can render a
 * report for an org it holds no JWT for. Every read is org-pinned in-statement,
 * so the admin path (RLS bypassed) never blends orgs — the #456-class discipline.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------

async function buildProfitDocument(
  client: ReportsDb,
  orgId: string,
  now: Date,
): Promise<ReportDocument> {
  const [jobsRes, invRes, finRes, custRes] = await Promise.all([
    fetchAllRows<{
      id: string;
      customer_id: string | null;
      site_city: string | null;
      site_postcode: string | null;
      site_address_line1: string | null;
    }>((from, to) =>
      client
        .from("jobs")
        .select("id, customer_id, site_city, site_postcode, site_address_line1")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{
      job_id: string | null;
      amount: number | string | null;
      created_at: string | null;
      paid_at: string | null;
    }>((from, to) =>
      client
        .from("invoices")
        .select("id, job_id, amount, created_at, paid_at")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{
      job_id: string | null;
      amount: number | string | null;
      category: string | null;
      created_at: string | null;
    }>((from, to) =>
      client
        .from("finances")
        .select("id, job_id, amount, category, created_at")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{ id: string; name: string | null }>((from, to) =>
      client
        .from("customers")
        .select("id, name")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  if (jobsRes.error) throw readFailure("reports: profit jobs", jobsRes.error);
  if (invRes.error) throw readFailure("reports: profit invoices", invRes.error);
  if (finRes.error) throw readFailure("reports: profit finances", finRes.error);
  if (custRes.error) throw readFailure("reports: profit customers", custRes.error);

  const jobs = jobsRes.data ?? [];
  const invoices = invRes.data ?? [];
  const finances = finRes.data ?? [];
  const customerName = new Map((custRes.data ?? []).map((c) => [c.id, c.name ?? "—"]));

  const perJob = computeAllJobsProfitability(jobs, invoices, finances);
  const labelFor = (jobId: string): string => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return `Job ${jobId.slice(0, 8)}`;
    const name = job.customer_id ? customerName.get(job.customer_id) : null;
    const site = job.site_city ?? job.site_postcode ?? job.site_address_line1 ?? null;
    const parts = [name, site].filter((p): p is string => !!p && p !== "—");
    return parts.length > 0 ? parts.join(" · ") : `Job ${jobId.slice(0, 8)}`;
  };
  const labelled: Array<JobProfitability & { label: string }> = perJob.map((j) => ({
    ...j,
    label: labelFor(j.job_id),
  }));

  // Revenue counted when the invoice was ISSUED (created_at), matching the
  // dashboard's profit series so the two agree.
  const months = profitByMonth(invoices, finances, 12, "created_at", now);

  return profitToDocument({
    months,
    jobs: labelled,
    meta: { generatedAt: now.toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Overview (the four /reports aggregates)
// ---------------------------------------------------------------------------

async function buildOverviewDocument(
  client: ReportsDb,
  orgId: string,
  now: Date,
): Promise<ReportDocument> {
  const [jobs, revenue, vat, top] = await Promise.all([
    jobsPerWeek(orgId, 8, client),
    revenuePerMonth(orgId, 12, client),
    vatPerQuarter(orgId, 4, client),
    topCustomersByRevenue(orgId, 10, client),
  ]);
  return overviewToDocument({
    jobs,
    revenue,
    vat,
    top,
    meta: { generatedAt: now.toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Cashflow (reuses the forecasting cash-timeline authority)
// ---------------------------------------------------------------------------

async function buildCashflowDocument(
  client: ReportsDb,
  orgId: string,
  now: Date,
): Promise<ReportDocument> {
  const todayKey = formatDayKeyUK(now);
  const timeline = await gatherCashTimeline(
    client as unknown as ForecastingClient,
    orgId,
    now,
    todayKey,
  );
  return cashflowToDocument({ timeline, meta: { generatedAt: now.toISOString() } });
}

// ---------------------------------------------------------------------------
// Utilisation (reuses the intelligence utilisation authority)
// ---------------------------------------------------------------------------

async function buildUtilisationDocument(
  client: ReportsDb,
  orgId: string,
  now: Date,
): Promise<ReportDocument> {
  const window = trailingDayWindow(now, UTILISATION_WINDOW_DAYS);
  const utilisation = await gatherUtilisation(
    client as unknown as IntelligenceClient,
    orgId,
    window,
    now.getTime(),
  );
  return utilisationToDocument({ utilisation, meta: { generatedAt: now.toISOString() } });
}

// ---------------------------------------------------------------------------
// Pipeline (reuses the leads bucketing authority)
// ---------------------------------------------------------------------------

async function buildPipelineDocument(
  client: ReportsDb,
  orgId: string,
  now: Date,
): Promise<ReportDocument> {
  const { data, error } = await fetchAllRows<RawPipelineLead>((from, to) =>
    client
      .from("leads")
      .select(
        `
        id, status, source, urgency, postcode, service, estimated_value,
        last_activity_at, customer_id, assigned_to,
        customer:customers ( id, name ),
        assigned:users!leads_assigned_to_fkey ( id, full_name, email )
      `,
      )
      .eq("org_id", orgId)
      .neq("status", "archived")
      .order("last_activity_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("reports: pipeline leads", error);

  const { byStage, totalValue } = bucketPipelineLeads((data ?? []) as RawPipelineLead[]);

  const stages: PipelineStageRow[] = (LEAD_STAGES as readonly LeadStage[]).map((stage) => {
    const leads = byStage[stage];
    const value = round2(leads.reduce((s, l) => s + (l.estimated_value ?? 0), 0));
    return { stage, label: LEAD_STAGE_LABELS[stage], count: leads.length, value };
  });

  return pipelineToDocument({
    stages,
    totalValue: round2(totalValue),
    meta: { generatedAt: now.toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Build the document for one report key. The single entry point the export
 * routes and the delivery cron both call, so a report is composed the SAME way
 * whether it is downloaded on demand or emailed on a schedule.
 */
export async function buildReportDocument(
  client: ReportsDb,
  orgId: string,
  key: ReportKey,
  opts: { now?: Date } = {},
): Promise<ReportDocument> {
  const now = opts.now ?? new Date();
  switch (key) {
    case "overview":
      return buildOverviewDocument(client, orgId, now);
    case "profit":
      return buildProfitDocument(client, orgId, now);
    case "cashflow":
      return buildCashflowDocument(client, orgId, now);
    case "utilisation":
      return buildUtilisationDocument(client, orgId, now);
    case "pipeline":
      return buildPipelineDocument(client, orgId, now);
    default: {
      // Exhaustiveness: a new ReportKey must add a case here.
      const _never: never = key;
      throw new Error(`unknown report key: ${String(_never)}`);
    }
  }
}
