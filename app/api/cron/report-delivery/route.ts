import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorised } from "@/lib/cron/auth";
import { env } from "@/lib/env";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { formatDayKeyUK } from "@/lib/time/format";
import { sendEmail } from "@/lib/email/send";
import { buildReportDocument } from "@/lib/reports/report-data";
import { documentToCsv } from "@/lib/reports/documents";
import {
  loadReportOrg,
  renderReportPdf,
  reportFilenameStem,
} from "@/lib/reports/export-render";
import type { ReportsDb } from "@/lib/reports/aggregates";
import {
  listActiveSubscriptionsForDelivery,
  markSubscriptionRun,
  type ReportSubscription,
  type SubscriptionsClient,
} from "@/lib/reports/subscriptions";

// react-pdf renders on Node, not edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each due subscription renders a report (a PDF is CPU-heavy) and does a Resend
// round-trip. Give the run the full Vercel Pro budget rather than the short
// default, which would kill it mid-list.
export const maxDuration = 300;

/**
 * Daily cron — scheduled report delivery.
 *
 * Drains `report_subscriptions`: for each ACTIVE subscription due today it
 * composes the SAME deterministic report the export routes build
 * (buildReportDocument → the compute authorities), renders it to the requested
 * format (PDF via the shared branded ReportPdf, or CSV via documentToCsv) and
 * emails it as an attachment through the shared `sendEmail` (self-loop-guarded).
 *
 * CADENCE GATE (deterministic, London day):
 *   daily   → every run
 *   weekly  → Mondays
 *   monthly → the 1st
 * A subscription already delivered today (last_run_on = today) is skipped.
 *
 * FAIRNESS / SELF-DRAINING: candidates come back ordered by last_run_on ASC
 * NULLS FIRST (stalest / never-run first), and each processed subscription's
 * last_run_on advances to today — so a delivered (or definitively-processed)
 * subscription LEAVES the day's candidate set and, if a pass is ever killed
 * mid-list by maxDuration, the next tick resumes from the stalest tail rather
 * than re-servicing the head. See the cron-fairness-guard ALLOWLIST entry.
 *
 * DARK-SAFE: with no RESEND_API_KEY the run no-ops WITHOUT advancing any cursor,
 * so every subscription is delivered on its first cadence occurrence AFTER email
 * is configured — the subscribe UI can be used today and activation is a config
 * flip, no code change.
 */
export async function GET(request: Request) {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!env.RESEND_API_KEY) {
    // Skip cleanly (dark). Telemetry still records the run; NO cursor advances,
    // so nothing is "consumed" while delivery is dark.
    const skip = await withCronTelemetry("report-delivery", async () => ({
      ok: true,
      skipped: true,
      reason: "no_resend_key",
    }));
    return NextResponse.json(skip.payload, { status: skip.status });
  }

  const { status, payload } = await withCronTelemetry("report-delivery", () =>
    runReportDelivery(),
  );
  return NextResponse.json(payload, { status });
}

/** Is a subscription due on the given London day? */
export function isSubscriptionDue(
  sub: Pick<ReportSubscription, "cadence" | "last_run_on">,
  todayKey: string,
): boolean {
  if (sub.last_run_on === todayKey) return false; // already delivered today
  switch (sub.cadence) {
    case "daily":
      return true;
    case "weekly": {
      // Monday. Noon-anchored so no timezone edge flips the weekday.
      const dow = new Date(`${todayKey}T12:00:00Z`).getUTCDay();
      return dow === 1;
    }
    case "monthly":
      return todayKey.slice(8, 10) === "01";
    default:
      return false;
  }
}

async function runReportDelivery() {
  const admin = createAdminClient();
  const now = new Date();
  const todayKey = formatDayKeyUK(now);

  const stats = {
    scanned: 0,
    sent: 0,
    skipped_not_due: 0,
    failed: 0,
  };

  const subs = await listActiveSubscriptionsForDelivery(
    admin as unknown as SubscriptionsClient,
  );

  // Sequential: a PDF render is CPU-bound, so overlapping them buys little and
  // costs memory. The fairness cursor makes a truncated pass safe to resume.
  for (const sub of subs) {
    stats.scanned++;
    if (!isSubscriptionDue(sub, todayKey)) {
      stats.skipped_not_due++;
      continue;
    }

    try {
      const doc = await buildReportDocument(admin as unknown as ReportsDb, sub.org_id, sub.report_key, {
        now,
      });
      const stem = reportFilenameStem(sub.report_key, doc.generatedAt);

      let content: Buffer;
      let filename: string;
      if (sub.format === "csv") {
        content = Buffer.from(documentToCsv(doc), "utf8");
        filename = `${stem}.csv`;
      } else {
        const org = await loadReportOrg(admin as unknown as ReportsDb, sub.org_id);
        content = await renderReportPdf(doc, org);
        filename = `${stem}.pdf`;
      }

      const result = await sendEmail({
        to: sub.recipients,
        subject: `${doc.title} — ${todayKey}`,
        html:
          `<p>Your scheduled <strong>${escapeHtml(doc.title)}</strong> report is attached ` +
          `(${sub.format.toUpperCase()}).</p>` +
          `<p style="color:#64748b;font-size:12px">Generated ${escapeHtml(doc.generatedAt.slice(0, 10))} by CrewFlow. ` +
          `To change or stop this delivery, open Reports in CrewFlow.</p>`,
        text: `Your scheduled ${doc.title} report is attached (${sub.format.toUpperCase()}). Generated ${doc.generatedAt.slice(0, 10)} by CrewFlow.`,
        attachments: [{ filename, content }],
      });

      if (result.sent) {
        stats.sent++;
      } else {
        stats.failed++;
        console.warn("[cron/report-delivery] send failed", {
          id: sub.id,
          reason: result.reason,
        });
      }
    } catch (err) {
      stats.failed++;
      console.error("[cron/report-delivery] render/send threw", {
        id: sub.id,
        report: sub.report_key,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Advance the self-draining cursor after a definitive outcome (sent OR a
    // failure this pass). A daily failure retries tomorrow; a weekly/monthly
    // failure retries on its next cadence occurrence. Advancing here is what
    // makes a delivered subscription leave the day's candidate set.
    const { error: markErr } = await markSubscriptionRun(
      admin as unknown as SubscriptionsClient,
      sub.id,
      todayKey,
    );
    if (markErr) {
      console.error("[cron/report-delivery] cursor advance failed", { id: sub.id, markErr });
    }
  }

  return { ok: true, ...stats };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
