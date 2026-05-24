import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInvoiceEmail } from "@/lib/email/send-invoice";
import { isCronAuthorised } from "@/lib/cron/auth";
import { env } from "@/lib/env";
import type { ReminderStage } from "@/lib/email/templates/reminders";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily cron — four-stage invoice reminders.
 *
 * For each invoice with status != 'paid' AND sent_at IS NOT NULL,
 * for each stage in [3, 7, 14, 21] days since sent_at:
 *   - if today is within the stage window
 *     (stage_days <= days_since_sent < stage_days + WINDOW_DAYS)
 *   - and no invoice_reminders row exists for (invoice, stage)
 *   - send the stage email + insert the reminder row
 *
 * Stop-on-paid is enforced by the status filter — paid invoices are
 * never scanned. Backfill safety: invoices older than the latest stage
 * window won't fire anything (no spam on system rollout).
 */

const WINDOW_DAYS = 2; // tolerate one missed cron run

const STAGE_DAYS: Record<Exclude<ReminderStage, "manual">, number> = {
  day_3: 3,
  day_7: 7,
  day_14: 14,
  day_21: 21,
};

type CandidateRow = {
  id: string;
  org_id: string;
  number: string;
  status: string;
  sent_at: string;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  due_date: string | null;
  paid_at: string | null;
  notes: string | null;
  quote_id: string | null;
  quote: {
    customer: { email: string | null } | null;
  } | null;
};

export async function GET(request: Request) {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.RESEND_API_KEY) {
    // Skip cleanly — telemetry still records the run so the ops
    // dashboard sees "this cron is running, just no-opping on env".
    const skipResult = await withCronTelemetry("invoice-reminders", async () => ({
      ok: true,
      skipped: true,
      reason: "no_resend_key",
    }));
    return NextResponse.json(skipResult.payload, { status: skipResult.status });
  }

  const { status, payload } = await withCronTelemetry(
    "invoice-reminders",
    async () => runReminders(),
  );
  return NextResponse.json(payload, { status });
}

async function runReminders() {
  const admin = createAdminClient();
  const now = Date.now();

  const stats = {
    scanned: 0,
    sent: 0,
    skipped_no_email: 0,
    skipped_already_sent: 0,
    skipped_out_of_window: 0,
    failed: 0,
  };

  // Iterate stages in ascending order — within one cron run we send at
  // most one stage per invoice. If multiple stages match, the smallest
  // wins (most polite). Larger stages will fire on subsequent runs.
  for (const stage of ["day_3", "day_7", "day_14", "day_21"] as const) {
    const days = STAGE_DAYS[stage];
    const upperIso = new Date(now - days * 86_400_000).toISOString();
    const lowerIso = new Date(now - (days + WINDOW_DAYS) * 86_400_000).toISOString();

    // Candidates: not paid + sent_at within [lower, upper]. The
    // "already sent" check is a second query per candidate because PG
    // doesn't easily expose anti-join in PostgREST.
    const { data: rowsRaw, error } = await admin
      .from("invoices")
      .select(
        `
          id, org_id, number, status, sent_at, amount, vat_total, total,
          due_date, paid_at, notes, quote_id,
          quote:quotes ( customer:customers ( email ) )
        `,
      )
      .neq("status", "paid")
      .not("sent_at", "is", null)
      .lte("sent_at", upperIso)
      .gte("sent_at", lowerIso)
      .limit(500);
    const rows = rowsRaw as unknown as CandidateRow[] | null;

    if (error) {
      console.error("[cron/invoice-reminders] query failed", { stage, error });
      stats.failed++;
      continue;
    }

    for (const inv of rows ?? []) {
      stats.scanned++;

      // Check if this stage already fired for this invoice.
      const { count: existing } = await admin
        .from("invoice_reminders")
        .select("id", { count: "exact", head: true })
        .eq("invoice_id", inv.id)
        .eq("stage", stage);
      if ((existing ?? 0) > 0) {
        stats.skipped_already_sent++;
        continue;
      }

      if (!inv.quote?.customer?.email) {
        stats.skipped_no_email++;
        continue;
      }

      const result = await sendInvoiceEmail(admin, inv.id, {
        kind: "reminder",
        reminder_stage: stage,
      });

      if (!result.sent) {
        stats.failed++;
        console.warn("[cron/invoice-reminders] send failed", {
          id: inv.id,
          stage,
          reason: result.reason,
          detail: result.detail,
        });
        continue;
      }

      // Insert the reminder row (the trigger writes to activity_log).
      const { error: insErr } = await admin
        .from("invoice_reminders")
        .insert({
          invoice_id: inv.id,
          org_id: inv.org_id,
          stage,
          recipient: result.to,
          email_id: result.emailId,
        });
      if (insErr) {
        stats.failed++;
        console.error("[cron/invoice-reminders] insert reminder row failed", {
          id: inv.id,
          stage,
          insErr,
        });
        continue;
      }

      stats.sent++;
    }
  }

  return { ok: true, ...stats };
}
