import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { sendInvoiceEmail } from "@/lib/email/send-invoice";
import { isCronAuthorised } from "@/lib/cron/auth";
import { env } from "@/lib/env";
import type { ReminderStage } from "@/lib/email/templates/reminders";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { mapWithConcurrency } from "@/lib/async/concurrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each reminder re-renders a PDF + does a Resend round-trip, so a busy day
// at scale can mean hundreds of sends in one run. Give the function the
// full Vercel Pro budget (300s) rather than the short default, which would
// kill the run mid-list and leave later candidates unprocessed.
export const maxDuration = 300;

// In-flight sends per stage. Bounded so we overlap network/DB latency
// without tripping Resend's per-second rate limit or exhausting the
// Postgres connection pool. A rate-limited send fails soft (counted, then
// retried on the next daily run), so this never has to be aggressive.
const SEND_CONCURRENCY = 3;

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
  // Direct customer anchor (Issue #349 Phase 1) — preferred over the quote path.
  customer: { email: string | null } | null;
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

    // Candidates: not paid + sent_at within [lower, upper].
    //
    // COMPLETE read (F-1). The old `.limit(500)` silently STARVED reminders once
    // the standing candidate backlog for a stage crossed 500 globally (this is a
    // cross-org admin scan) — the same class as the invoice.overdue scan that
    // starved on `.limit(1000)`. Page the whole candidate set; the per-stage
    // dedupe below + the partial unique index prevent any double-send.
    const { data: rowsRaw, error } = await fetchAllRows((from, to) =>
      admin
        .from("invoices")
        .select(
          `
          id, org_id, number, status, sent_at, amount, vat_total, total,
          due_date, paid_at, notes, quote_id,
          customer:customers!invoices_customer_org_fkey ( email ),
          quote:quotes ( customer:customers ( email ) )
        `,
        )
        .neq("status", "paid")
        .not("sent_at", "is", null)
        .lte("sent_at", upperIso)
        .gte("sent_at", lowerIso)
        .order("id", { ascending: true })
        .range(from, to),
    );
    const rows = rowsRaw as unknown as CandidateRow[] | null;

    if (error) {
      console.error("[cron/invoice-reminders] query failed", { stage, error });
      stats.failed++;
      continue;
    }
    if (!rows || rows.length === 0) continue;

    // "Already sent for this stage?" — ONE batched query over the whole
    // candidate set instead of a per-candidate count query (the old N+1).
    // The partial unique index invoice_reminders_unique_auto_stage
    // (invoice_id, stage) where stage <> 'manual' is the insert-time
    // backstop; this query just avoids re-sending what we already recorded.
    const candidateIds = rows.map((inv) => inv.id);
    const { data: existingRaw, error: exErr } = await admin
      .from("invoice_reminders")
      .select("invoice_id")
      .eq("stage", stage)
      .in("invoice_id", candidateIds);
    if (exErr) {
      console.error("[cron/invoice-reminders] existence check failed", { stage, exErr });
      stats.failed++;
      continue;
    }
    const alreadySent = new Set(
      (existingRaw as { invoice_id: string }[] | null ?? []).map((r) => r.invoice_id),
    );

    // Partition synchronously so the stat counters stay deterministic;
    // only the email send + row insert run concurrently below.
    const pending: CandidateRow[] = [];
    for (const inv of rows) {
      stats.scanned++;
      if (alreadySent.has(inv.id)) {
        stats.skipped_already_sent++;
        continue;
      }
      // Prefer the invoice's own customer (Issue #349 Phase 1) so an orphaned
      // invoice (quote deleted) is still chased instead of silently skipped.
      if (!(inv.customer?.email ?? inv.quote?.customer?.email)) {
        stats.skipped_no_email++;
        continue;
      }
      pending.push(inv);
    }

    await mapWithConcurrency(pending, SEND_CONCURRENCY, async (inv) => {
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
        return;
      }

      // Insert the reminder row (the AFTER INSERT trigger writes the
      // activity_log entry — which is why we insert only AFTER a confirmed
      // send, never speculatively).
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
        // 23505 = unique violation on invoice_reminders_unique_auto_stage:
        // another run/path already recorded this (invoice, stage). The
        // email did go out, but we did NOT newly record a reminder, so
        // treat it as already-sent rather than a hard failure.
        if ((insErr as { code?: string }).code === "23505") {
          stats.skipped_already_sent++;
          return;
        }
        stats.failed++;
        console.error("[cron/invoice-reminders] insert reminder row failed", {
          id: inv.id,
          stage,
          insErr,
        });
        return;
      }

      stats.sent++;
    });
  }

  return { ok: true, ...stats };
}
