import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import {
  OVERDUE_COLLECTABLE_STATUSES,
  invoiceBusinessToday,
} from "@/lib/invoices/overdue";
import { mapWithConcurrency } from "@/lib/async/concurrent";

/**
 * Overdue-invoice automation scheduler.
 *
 * Finds invoices that satisfy the canonical derived overdue authority
 * (lib/invoices/overdue.ts) and fires the EXISTING tenant automation event
 * `invoice.overdue` through the now-concurrency-safe dispatcher. Nothing here
 * writes invoice status, touches invoice_reminders, or calls the CrewFlow
 * subscription-billing emitter — those are deliberately not this domain.
 *
 * Why a dedicated route, not a pass on the reminders cron: reminders are
 * customer-email CADENCE (measured from sent_at, one row per stage, recorded as
 * `invoice.reminder_sent`); overdue is a derived business CONDITION (measured
 * from due_date). They have different audiences and different audit meaning, and
 * conflating them is the mistake discovery already caught.
 *
 * Idempotency is entirely the dispatcher's. The correlation id is
 * `invoice.overdue:invoices:{id}` — invoice-scoped, so an invoice fires the
 * automation ONCE, EVER. Repeated daily scans re-dispatch the same identity and
 * the dispatcher's atomic claim makes every repeat a no-op; concurrent scans
 * race on the same claim and exactly one wins. This scheduler therefore holds no
 * state of its own and needs no dedupe table.
 *
 * V1 semantics — once-ever, no re-arming: if an invoice's due_date is later
 * extended and it lapses again, it does NOT re-fire, because the completed
 * automation_runs row for that correlation id is terminal. Re-arming is a
 * deliberate future product decision, not an omission.
 */

/** Bounded fan-out — dispatch is a few DB round-trips per invoice. */
const DISPATCH_CONCURRENCY = 5;

/** Scan page size. The dispatcher dedupes, so a re-scan of the same page is safe. */
const SCAN_LIMIT = 1000;

export type OverdueScanSummary = {
  eligible: number;
  dispatched: number;
  skipped_already: number;
  failed: number;
};

type OverdueInvoiceRow = { id: string; org_id: string };

/**
 * One scan pass.
 *
 * The eligibility predicate lives in the QUERY and mirrors isInvoiceOverdue()
 * exactly:
 *   - status ∈ OVERDUE_COLLECTABLE_STATUSES  → paid & draft excluded (a balance
 *     is owed and it is collectable); `paid` is the trigger-owned "settled"
 *     signal, so no payments join is needed;
 *   - due_date < today                        → future-due excluded, and the
 *     `.lt` on a NOT-DISTINCT column also drops NULL due_dates (missing due date
 *     excluded);
 * so payment BEFORE a scan (status → paid, or due_date still ahead) means the
 * row is never selected and never dispatched. Payment AFTER dispatch changes
 * only invoice_payments + the trigger-owned status; the automation_runs row is
 * untouched, so lifecycle state cannot be corrupted by this scheduler.
 */
export async function runOverdueScan(
  now: Date = new Date(),
): Promise<OverdueScanSummary> {
  const admin = createAdminClient();
  const todayIso = invoiceBusinessToday(now);

  const { data, error } = await admin
    .from("invoices")
    .select("id, org_id")
    .in("status", [...OVERDUE_COLLECTABLE_STATUSES])
    .lt("due_date", todayIso)
    .limit(SCAN_LIMIT);

  if (error) {
    // Surfaced, not swallowed — the caller (withCronTelemetry) turns a throw
    // into a 500 + telemetry row, and the next daily run simply retries.
    throw new Error(`overdue scan query failed: ${error.message}`);
  }

  const rows = (data ?? []) as OverdueInvoiceRow[];
  const summary: OverdueScanSummary = {
    eligible: rows.length,
    dispatched: 0,
    skipped_already: 0,
    failed: 0,
  };

  await mapWithConcurrency(rows, DISPATCH_CONCURRENCY, async (inv) => {
    // The dispatcher owns idempotency + concurrency. We pass the existing
    // tenant event only; the invoice_overdue_alert rule (create_alert +
    // create_notification) is already wired to it.
    const result = await dispatchAutomation({
      type: "invoice.overdue",
      org_id: inv.org_id,
      source_table: "invoices",
      source_id: inv.id,
      payload: { invoice_id: inv.id },
    });

    const ran = result.ran.find((r) => r.rule_id === "invoice_overdue_alert");
    if (!ran) return; // no matching rule (shouldn't happen) — nothing to count
    if (ran.status === "ok") summary.dispatched++;
    else if (ran.status === "skipped") summary.skipped_already++;
    else summary.failed++;
  });

  return summary;
}
