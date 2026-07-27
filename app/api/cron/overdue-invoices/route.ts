import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runOverdueScan } from "@/lib/invoices/overdue-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Overdue is a whole-fleet scan + a bounded dispatch per invoice; give it the
// same headroom as the other invoice cron so a busy day can't be cut off
// mid-list. Well within the 15-minute claim lease.
export const maxDuration = 300;

/**
 * Daily cron — overdue-invoice automation.
 *
 * Finds invoices overdue by the canonical authority (lib/invoices/overdue.ts)
 * and fires the existing tenant `invoice.overdue` automation through the
 * concurrency-safe dispatcher. All idempotency lives in the dispatcher (one
 * automation_runs claim per invoice-scoped correlation id), so repeated and
 * concurrent runs cannot double-dispatch. See lib/invoices/overdue-scheduler.ts.
 *
 * Deliberately NOT here: no invoice_reminders write, no status mutation, no
 * CrewFlow subscription-billing notification.
 */
export async function GET(request: Request) {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }

  const result = await withCronTelemetry("overdue-invoices", async () => {
    const summary = await runOverdueScan();
    return { ok: true, ...summary };
  });

  return NextResponse.json(result.payload, { status: result.status });
}
