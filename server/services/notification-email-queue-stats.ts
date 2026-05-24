import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Lightweight stats for the notification_email_queue — surfaced on
 * /admin/notifications so the operator can see provider health at
 * a glance.
 *
 * Service-role only.
 */

export type EmailQueueStats = {
  queued: number;
  sent_24h: number;
  failed_24h: number;
  skipped: number;
  /** Rows that have hit retry_count >= 6 — manual triage candidates. */
  permanent_failures: number;
  recent_failures: ReadonlyArray<{
    id: string;
    to_email: string;
    subject: string;
    last_error: string | null;
    retry_count: number;
    failed_at: string | null;
  }>;
};

export async function getEmailQueueStats(): Promise<EmailQueueStats> {
  const admin = createAdminClient();
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

  const [queuedRes, sent24hRes, failed24hRes, skippedRes, permanentRes, recentFailuresRes] =
    await Promise.all([
      admin
        .from("notification_email_queue" as never)
        .select("id" as never, { count: "exact", head: true })
        .eq("status" as never, "queued"),
      admin
        .from("notification_email_queue" as never)
        .select("id" as never, { count: "exact", head: true })
        .eq("status" as never, "sent")
        .gte("sent_at" as never, since24h),
      admin
        .from("notification_email_queue" as never)
        .select("id" as never, { count: "exact", head: true })
        .eq("status" as never, "failed")
        .gte("failed_at" as never, since24h),
      admin
        .from("notification_email_queue" as never)
        .select("id" as never, { count: "exact", head: true })
        .eq("status" as never, "skipped"),
      admin
        .from("notification_email_queue" as never)
        .select("id" as never, { count: "exact", head: true })
        .eq("status" as never, "failed")
        .gte("retry_count" as never, 6),
      admin
        .from("notification_email_queue" as never)
        .select(
          "id, to_email, subject, last_error, retry_count, failed_at" as never,
        )
        .eq("status" as never, "failed")
        .order("failed_at" as never, { ascending: false })
        .limit(10),
    ]);

  return {
    queued: queuedRes.count ?? 0,
    sent_24h: sent24hRes.count ?? 0,
    failed_24h: failed24hRes.count ?? 0,
    skipped: skippedRes.count ?? 0,
    permanent_failures: permanentRes.count ?? 0,
    recent_failures: (recentFailuresRes.data ?? []) as Array<{
      id: string;
      to_email: string;
      subject: string;
      last_error: string | null;
      retry_count: number;
      failed_at: string | null;
    }>,
  };
}
