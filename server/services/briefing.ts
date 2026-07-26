import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { invoiceBusinessToday, invoiceDaysOverdue, isInvoiceOverdue } from "@/lib/invoices/overdue";
import { computeRetentionDueRollup } from "@/lib/retentions/rollup";
import { buildHealthSafetySnapshot } from "./health-safety-snapshot";
import { composeBriefing, type BriefingInput } from "@/lib/briefing/compose";
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
  generatedAt: string;
}

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
  lte: (k: string, v: unknown) => AnyBuilder;
};
type LooseClient = { from: (t: string) => AnyBuilder };

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Read every row of a paged select, swallowing errors to a partial/empty set. */
async function pagedRows(db: LooseClient, table: string, cols: string, orderKey: string): Promise<Row[]> {
  const { data } = await fetchAllRows<Row>((from, to) =>
    db.from(table).select(cols).order(orderKey, { ascending: true }).range(from, to),
  );
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
      dismissRes,
    ] = await Promise.all([
      pagedRows(db, "invoices", "id, status, total, amount, due_date, job_id", "id"),
      pagedRows(db, "quotes", "id, total, sent_at, accepted_at, declined_at", "id"),
      pagedRows(
        db, "jobs",
        "id, retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct",
        "id",
      ),
      pagedRows(db, "retention_releases", "job_id, amount", "job_id"),
      db.from("jobs").select("id").eq("scheduled_date", tomorrowIso).is("assigned_to", null),
      db.from("compliance_documents").select("id, expires_at").not("expires_at", "is", null).lte("expires_at", complianceCutoffIso),
      pagedRows(db, "leads", "id, status, estimated_value, created_at", "id"),
      buildHealthSafetySnapshot(orgId),
      db.from("briefing_dismissals").select("item_key").eq("user_id", userId).eq("dismissed_on", todayIso),
    ]);

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
      dismissedKeys,
    };

    const items = composeBriefing(input);
    return { items, summary: summariseBriefing(items, now), generatedAt };
  } catch (err) {
    // Additive section — never break the dashboard. Log and show all-clear.
    console.warn("[briefing] buildDailyBriefing failed; showing empty briefing", err);
    return { items: [], summary: summariseBriefing([], now), generatedAt };
  }
}
