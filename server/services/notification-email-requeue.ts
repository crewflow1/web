import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Requeue ONE failed notification email for another delivery attempt.
 *
 * The drain (lib/notifications/email.ts) retries a failed send with
 * exponential backoff by flipping the row back to 'queued' — but after
 * MAX_RETRIES (6) attempts the row stays status='failed' forever and the
 * drain's `.eq("status", "queued")` pick-up query never sees it again.
 * That permanent-failure state is deliberate (a poison address must not
 * cycle forever), which is exactly why un-sticking it is a HUMAN decision:
 * this function is called only from the HQ /admin/notifications action,
 * after the operator has fixed whatever made the sends fail (bad address,
 * Resend outage, DNS…).
 *
 * Reset semantics — everything the drain reads to claim a row:
 *   status        → 'queued'   (the drain's pick-up filter)
 *   scheduled_for → now()      (claimable on the very next drain pass)
 *   retry_count   → 0          (a fresh set of 6 backoff attempts)
 *   failed_at     → null       (no longer counted as a failure by stats)
 *   last_error    → kept       (diagnostic breadcrumb until the next
 *                               attempt overwrites or clears it)
 *
 * Guarded UPDATE: `.eq("status", "failed")` means a row that was already
 * requeued/sent/skipped is untouched — the action is idempotent and can
 * never resurrect an email that already went out.
 *
 * Service-role only. Callers must have passed the HQ superadmin gate.
 */

export type RequeueResult =
  | { ok: true }
  | { ok: false; reason: "not_failed_or_missing" | "db_error"; detail?: string };

type QueueUpdate = {
  update: (row: Record<string, unknown>) => {
    eq: (
      k: string,
      v: string,
    ) => {
      eq: (
        k: string,
        v: string,
      ) => {
        select: (cols: string) => Promise<{
          data: Array<{ id: string }> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

export async function requeueFailedNotificationEmail(
  id: string,
): Promise<RequeueResult> {
  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("notification_email_queue" as never) as unknown as QueueUpdate
  )
    .update({
      status: "queued",
      scheduled_for: new Date().toISOString(),
      retry_count: 0,
      failed_at: null,
    })
    .eq("id", id)
    .eq("status", "failed")
    .select("id");

  if (error) {
    console.error("[notifications] requeue failed", error.message);
    return { ok: false, reason: "db_error", detail: error.message };
  }
  if (!data || data.length === 0) {
    // Not an error — the row is missing, or already queued/sent/skipped.
    return { ok: false, reason: "not_failed_or_missing" };
  }
  return { ok: true };
}
