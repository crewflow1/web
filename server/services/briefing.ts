import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { invoiceBusinessToday, invoiceDaysOverdue, isInvoiceOverdue } from "@/lib/invoices/overdue";
import { computeRetentionDueRollup } from "@/lib/retentions/rollup";
import { buildOrgCash } from "./org-cash";
import { buildHealthSafetySnapshot } from "./health-safety-snapshot";
import { loadScheduleConflicts, loadScheduleWeatherSignal } from "./schedule-integrity";
import { buildFleetComplianceRollup } from "./fleet-snapshot";
import { loadLowStockSignal, type StockClient } from "./stock";
import { loadCisHmrcSignal, type CashOutClient } from "./org-cash-out";
import { loadSupplierBillVarianceSignal, type PoMatchingClient } from "./po-matching";
import { rollupKind } from "@/lib/schedule/conflicts";
import {
  composeBriefing,
  composeWeatherSection,
  type BriefingInput,
  type WeatherBriefingSection,
} from "@/lib/briefing/compose";
import { summariseBriefing, type BriefingSummary } from "@/lib/briefing/narrative";
import type { BriefingItem } from "@/lib/briefing/types";

/**
 * Assemble the Daily Briefing for one org+user.
 *
 * COMPOSES existing live signals — it introduces no new business rules. Every
 * read is RLS-scoped (the caller's JWT) and additionally pins org_id where the
 * table is read through the loose client. The heavy per-entity reads are PAGED
 * (fetchAllRows) so a busy org is never silently truncated at the 1000-row cap.
 *
 * Best-effort by construction: any failure degrades to an empty briefing rather
 * than throwing, so this additive dashboard section can NEVER break the existing
 * dashboard render (mirrors the dashboard's "use whatever came back" posture).
 */

const DAY_MS = 86_400_000;
const QUOTE_STALE_DAYS = 5;
const LEAD_COLD_DAYS = 14;
const LEAD_MIN_VALUE = 2000;
const COMPLIANCE_WINDOW_DAYS = 30;

export interface DailyBriefing {
  items: BriefingItem[];
  summary: BriefingSummary;
  /**
   * WEATHER — a non-ranked status section (never a ranked item, to avoid
   * wallpaper). Dark today: an honest "not connected" line, never a false
   * all-clear. See lib/briefing/compose.ts → composeWeatherSection.
   */
  weather: WeatherBriefingSection;
  generatedAt: string;
}

/** The honest dark weather section — used on the failure path. */
const DARK_WEATHER_SECTION: WeatherBriefingSection = composeWeatherSection({
  available: false,
  statusLine: "",
  assessedJobs: 0,
  insufficientJobs: 0,
  risks: [],
});

type Row = Record<string, unknown>;
/**
 * A permissive, self-returning view of the PostgREST query builder — enough to
 * express the handful of RLS-scoped read chains below without fighting the
 * generated `Database` types (some columns/tables here aren't in the generated
 * types yet). Mirrors the loose-cast approach in health-safety-snapshot.ts.
 */
type AnyBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => AnyBuilder;
  order: (k: string, o: { ascending: boolean }) => AnyBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  eq: (k: string, v: unknown) => AnyBuilder;
  is: (k: string, v: null) => AnyBuilder;
  not: (k: string, op: string, v: null) => AnyBuilder;
  gte: (k: string, v: unknown) => AnyBuilder;
  lte: (k: string, v: unknown) => AnyBuilder;
  in: (k: string, v: unknown[]) => AnyBuilder;
};
type LooseClient = { from: (t: string) => AnyBuilder };

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read every row of a paged select. LOUD-OR-WHOLE: a read error THROWS
 * readFailure (mirrors buildHealthSafetySnapshot) so it propagates to
 * buildDailyBriefing's outer catch and the WHOLE briefing degrades to its
 * honest empty state. It must never return a PARTIAL set: fetchAllRows hands
 * back the rows-so-far PLUS the error on a mid-page failure, and swallowing
 * that error would collapse ONE signal to count=0 (a false all-clear on
 * overdue invoices / follow-up quotes / cold leads / retention) while every
 * other signal renders healthy — the silent under-count this loader shipped.
 */
async function pagedRows(db: LooseClient, table: string, cols: string, orderKey: string, orgId: string): Promise<Row[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) => {
    // org_id-PINNED, not RLS-only: current_org_ids() returns EVERY org a viewer
    // belongs to, so a dual-org member would otherwise see BOTH orgs' invoices /
    // quotes / retention / leads BLENDED on one org's dashboard briefing (the M2
    // P0 class). Plus a unique `id` tiebreaker (fetchAllRows needs a total order;
    // a non-unique FK sort key can drop/duplicate rows at a page edge).
    const base = db.from(table).select(cols).eq("org_id", orgId).order(orderKey, { ascending: true });
    return (orderKey === "id" ? base : base.order("id", { ascending: true })).range(from, to);
  });
  if (error) throw readFailure(`briefing: ${table}`, error as SupabaseReadError);
  return data;
}

export async function buildDailyBriefing(
  orgId: string,
  userId: string,
  now: Date = new Date(),
): Promise<DailyBriefing> {
  const generatedAt = now.toISOString();
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const todayIso = invoiceBusinessToday(now); // YYYY-MM-DD (UTC calendar day)
    const tomorrowIso = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
    const complianceCutoffIso = new Date(now.getTime() + COMPLIANCE_WINDOW_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const quoteStaleBeforeIso = new Date(now.getTime() - QUOTE_STALE_DAYS * DAY_MS).toISOString();
    const leadColdBeforeIso = new Date(now.getTime() - LEAD_COLD_DAYS * DAY_MS).toISOString();

    const [
      invoiceRows,
      quoteRows,
      retentionJobRows,
      retentionReleaseRows,
      jobsTomorrowRes,
      complianceRes,
      leadRows,
      hs,
      scheduleConflictRows,
      fleetRollup,
      lowStock,
      cisDueToHmrc,
      supplierBillVariance,
      scheduleWeather,
      dismissRes,
    ] = await Promise.all([
      pagedRows(db, "invoices", "id, status, total, amount, due_date, job_id", "id", orgId),
      pagedRows(db, "quotes", "id, total, sent_at, accepted_at, declined_at", "id", orgId),
      pagedRows(
        db, "jobs",
        "id, retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct",
        "id", orgId,
      ),
      pagedRows(db, "retention_releases", "job_id, amount", "job_id", orgId),
      db.from("jobs").select("id").eq("org_id", orgId).eq("scheduled_date", tomorrowIso).is("assigned_to", null),
      // COMPLIANCE EXPIRING — the only expiry signal, so completeness matters:
      // F-1 the read was unpaginated AND had NO lower date bound, so once an org
      // accumulated >1000 compliance documents the 1000-row page could be filled
      // entirely by long-expired historical docs and every genuinely-upcoming
      // expiry would fall off the end — an all-clear on a document that expires
      // next week. Now bounded to [today, cutoff] (the exact window the loop
      // below counts) AND paged, so the upcoming set can never be crowded out.
      fetchAllRows<Row>((from, to) =>
        db
          .from("compliance_documents")
          .select("id, expires_at")
          .eq("org_id", orgId)
          .not("expires_at", "is", null)
          .gte("expires_at", todayIso)
          .lte("expires_at", complianceCutoffIso)
          .order("expires_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      pagedRows(db, "leads", "id, status, estimated_value, created_at", "id", orgId),
      buildHealthSafetySnapshot(orgId),
      // LANE C — deterministic schedule conflicts. Read-only and self-limiting
      // (a fortnight window, org-pinned, best-effort), so it joins the existing
      // parallel batch rather than adding a serial hop.
      loadScheduleConflicts(orgId, now),
      // TRAIN C — deterministic vehicle compliance (MOT / insurance / road tax /
      // service). Org-pinned and best-effort like the rest of this batch, so a
      // fleet-less org contributes nothing and a failed read emits no lines.
      buildFleetComplianceRollup(orgId, todayIso),
      // O3 OPERATIONAL STOCK — items at or below their own reorder level.
      // Org-pinned and best-effort like the rest of this batch: an org that
      // tracks no stock contributes nothing, and a failed read emits no line
      // rather than a false all-clear. Detection only — nothing is ordered.
      loadLowStockSignal(supabase as unknown as StockClient, orgId),
      // H2-CASH M4 MONEY-OUT — CIS you withheld and owe HMRC, with the statutory
      // deadline. TWO org-pinned reads (not the whole money-out wave), reusing
      // /cash's own `computeCisHmrcDue` so the two surfaces cannot disagree. The
      // ledger is admin-only at the database, so a non-admin viewer gets no
      // signal rather than a false nil — the same fail-quiet posture as lowStock.
      loadCisHmrcSignal(supabase as unknown as CashOutClient, orgId, todayIso),
      // H2-COMMERCIAL THREE-WAY MATCH — purchase orders where ordered, delivered
      // and invoiced disagree. Org-pinned and best-effort like the rest of this
      // batch: a company with no purchase orders contributes nothing, and a
      // failed read emits no line rather than a false all-clear. Detection only
      // — no bill is credited and no cost is posted.
      loadSupplierBillVarianceSignal(supabase as unknown as PoMatchingClient, orgId),
      // WEATHER (orthogonal axis). Read through the governed accessor, so it is
      // dark and honestly "unavailable" in every environment today — a single
      // readiness check with ZERO database access until a provider is bound.
      // Best-effort like the rest of this batch: a failure yields the honest
      // unavailable signal, never a false all-clear.
      loadScheduleWeatherSignal(orgId, now),
      // ACTIVE-org pin: the write side stamps `org_id: ctx.org.id`, and
      // `item_key` is a generic string ("overdue_invoices", …), so an unpinned
      // read let a dismissal made in one org silently hide the SAME briefing
      // line in the viewer's other org. Every sibling read in this batch is
      // already org-pinned; this one was the exception.
      db.from("briefing_dismissals").select("item_key").eq("org_id", orgId).eq("user_id", userId).eq("dismissed_on", todayIso),
    ]);

    // LOUD-OR-WHOLE for the direct (non-pagedRows) reads in the batch above.
    // Each returns { data, error }; a swallowed error would zero one signal — a
    // false all-clear on upcoming compliance-document expiry (the ONLY expiry
    // signal) or on unassigned jobs tomorrow — while the rest of the briefing
    // renders healthy, or (dismissals) silently drop the viewer's dismissals.
    // Throw so the WHOLE briefing degrades to the honest empty state instead.
    if (complianceRes.error) throw readFailure("briefing: compliance documents", complianceRes.error as SupabaseReadError);
    if (jobsTomorrowRes.error) throw readFailure("briefing: jobs unassigned tomorrow", jobsTomorrowRes.error as SupabaseReadError);
    if (dismissRes.error) throw readFailure("briefing: dismissals", dismissRes.error as SupabaseReadError);

    // --- Overdue invoices --------------------------------------------------
    let overdueCount = 0;
    let overdueTotal = 0;
    let overdueMaxDays = 0;
    for (const inv of invoiceRows) {
      const judge = { status: inv.status as string | null, due_date: inv.due_date as string | null };
      if (!isInvoiceOverdue(judge, todayIso)) continue;
      overdueCount += 1;
      overdueTotal += num(inv.total);
      overdueMaxDays = Math.max(overdueMaxDays, invoiceDaysOverdue(judge, todayIso) ?? 0);
    }

    // --- Retention due back (reuses the job-page derivation) ---------------
    const retentionRollup = computeRetentionDueRollup({
      jobs: retentionJobRows.map((j) => ({
        id: String(j.id),
        ratePercent: j.retention_percent as number | string | null,
        practicalCompletionDate: (j.practical_completion_date as string | null) ?? null,
        defectsLiabilityMonths: j.defects_liability_months as number | string | null,
        firstReleasePct: j.retention_first_release_pct as number | string | null,
      })),
      invoices: invoiceRows.map((i) => ({
        job_id: (i.job_id as string | null) ?? null,
        status: String(i.status ?? ""),
        amount: i.amount as number | string | null,
      })),
      releases: retentionReleaseRows.map((r) => ({
        job_id: (r.job_id as string | null) ?? null,
        amount: r.amount as number | string | null,
      })),
      now,
    });

    // --- Quotes to follow up ----------------------------------------------
    let followUpCount = 0;
    let followUpTotal = 0;
    let followUpOldest = 0;
    for (const q of quoteRows) {
      const sentAt = q.sent_at as string | null;
      if (!sentAt || q.accepted_at || q.declined_at) continue;
      if (sentAt >= quoteStaleBeforeIso) continue; // still fresh
      followUpCount += 1;
      followUpTotal += num(q.total);
      followUpOldest = Math.max(followUpOldest, Math.floor((now.getTime() - Date.parse(sentAt)) / DAY_MS));
    }

    // --- Cold high-value leads --------------------------------------------
    let coldCount = 0;
    let coldValue = 0;
    for (const l of leadRows) {
      const status = String(l.status ?? "new");
      if (status !== "new" && status !== "contacted") continue;
      const value = num(l.estimated_value);
      if (value < LEAD_MIN_VALUE) continue;
      const createdAt = l.created_at as string | null;
      if (!createdAt || createdAt >= leadColdBeforeIso) continue;
      coldCount += 1;
      coldValue += value;
    }

    // --- Compliance expiring ----------------------------------------------
    const complianceRows = (complianceRes.data ?? []) as Row[];
    let soonestDays: number | null = null;
    for (const c of complianceRows) {
      const exp = c.expires_at as string | null;
      if (!exp || exp < todayIso) continue; // already expired handled elsewhere; count upcoming only
      const d = Math.max(0, Math.round((Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY_MS));
      soonestDays = soonestDays == null ? d : Math.min(soonestDays, d);
    }
    const complianceCount = complianceRows.filter((c) => {
      const exp = c.expires_at as string | null;
      return exp != null && exp >= todayIso;
    }).length;

    const dismissedKeys = new Set(((dismissRes.data ?? []) as Row[]).map((d) => String(d.item_key)));

    // H2-CASH M3: reuse the ONE org-cash authority (never a second computation) so
    // the briefing's ready-to-invoice + forecast numbers are IDENTICAL to /cash.
    // buildOrgCash is itself best-effort (returns an empty view on failure), so a
    // billing-tables-absent env degrades to zero signals rather than throwing.
    const orgCash = await buildOrgCash(orgId, now);
    const readyTotal = orgCash.summary.readyToInvoice;
    const readyJobCount = new Set(orgCash.readyStages.map((s) => s.jobId)).size;
    const cashDueSoon = orgCash.forecast.dueNext7;
    const unscheduledTotal = orgCash.forecast.unscheduled;
    const unscheduledJobCount = orgCash.unscheduledJobs.length;

    const input: BriefingInput = {
      now,
      overdue: { count: overdueCount, totalAmount: overdueTotal, maxDaysOverdue: overdueMaxDays },
      followUpQuotes: { count: followUpCount, totalAmount: followUpTotal, oldestDaysStale: followUpOldest },
      jobsTomorrowUnassigned: ((jobsTomorrowRes.data ?? []) as Row[]).length,
      permitsExpiredLive: hs.permitsExpiredLive,
      permitsExpiringSoon: hs.permitsExpiringSoon,
      ramsReviewOverdue: hs.ramsReviewOverdue,
      activeJobsNoCurrentRams: hs.activeJobsNoCurrentRams,
      toolboxAwaitingAck: hs.toolboxAwaitingAck,
      complianceExpiring: { count: complianceCount, soonestDays },
      coldLeads: { count: coldCount, totalValue: coldValue },
      retentionDue: { dueNow: retentionRollup.dueNow, dueJobCount: retentionRollup.dueJobCount },
      readyToInvoice: { totalAmount: readyTotal, jobCount: readyJobCount },
      cashDueSoon,
      unscheduled: { totalAmount: unscheduledTotal, jobCount: unscheduledJobCount },
      cisDueToHmrc,
      scheduleConflicts: {
        doubleBooked: rollupKind(scheduleConflictRows, "staff_double_booked"),
        leaveClashes: rollupKind(scheduleConflictRows, "leave_clash"),
        // From day 2 only — `jobs_unassigned_tomorrow` above owns today+tomorrow,
        // so the two operations lines are disjoint and never double-count a job.
        unassignedLater: rollupKind(scheduleConflictRows, "job_unassigned", { fromDaysAway: 2 }),
      },
      fleetCompliance: fleetRollup,
      lowStock,
      supplierBillVariance,
      dismissedKeys,
    };

    const items = composeBriefing(input);
    // Weather section — the schedule signal's facts, worded by the pure composer.
    // Dark today ⇒ an honest "not connected" line, never a false all-clear.
    const weather = composeWeatherSection({
      available: scheduleWeather.available,
      statusLine: scheduleWeather.statusLine,
      assessedJobs: scheduleWeather.assessedJobs,
      insufficientJobs: scheduleWeather.insufficientJobs,
      risks: scheduleWeather.risks.map((r) => ({
        label: r.label,
        day: r.day,
        district: r.district,
        verdict: r.verdict,
        conditions: r.conditions,
      })),
    });
    return { items, summary: summariseBriefing(items, now), weather, generatedAt };
  } catch (err) {
    // Additive section — never break the dashboard. Log and show empty. The
    // weather section degrades to its honest "not connected" line, never green.
    console.warn("[briefing] buildDailyBriefing failed; showing empty briefing", err);
    return {
      items: [],
      summary: summariseBriefing([], now),
      weather: DARK_WEATHER_SECTION,
      generatedAt,
    };
  }
}
