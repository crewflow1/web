import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NotificationRow } from "./types";

/**
 * CrewFlow — Email queue stub (HQ-8).
 *
 * Reality: no email provider wired yet. This module inserts a row
 * into `notification_email_queue` with status='queued' for every
 * call. A future PR will:
 *
 *   1. Add Postmark/Resend credentials to Vercel env.
 *   2. Replace the no-op `sendNow()` with a real provider call.
 *   3. Add a cron to drain the queue (`status=queued AND scheduled_for <= now`).
 *
 * Today the cron does NOT exist — rows sit in the table as a
 * persistent record of what WOULD have been sent. This is what the
 * directive calls "email-ready architecture, do NOT send real
 * emails yet".
 *
 * Service-role only.
 */

export type EmailQueueRow = {
  id: string;
  notification_id: string | null;
  org_id: string;
  user_id: string | null;
  to_email: string;
  reply_to_email: string | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  status: "queued" | "sent" | "failed" | "skipped";
  retry_count: number;
  last_error: string | null;
  provider: string | null;
  provider_message_id: string | null;
  created_at: string;
  scheduled_for: string;
  sent_at: string | null;
  failed_at: string | null;
  updated_at: string;
};

/**
 * Queue an email derived from a notification row. Idempotent on
 * (notification_id) — passing the same notification twice is a
 * no-op (insert may collide but we don't care; the queue treats
 * a duplicate as ALREADY queued).
 */
export async function queueNotificationEmail(input: {
  notification: NotificationRow;
  to_email: string;
  reply_to_email?: string | null;
  scheduled_for?: string;
}): Promise<EmailQueueRow | null> {
  const { notification: n, to_email, reply_to_email, scheduled_for } = input;
  const payload = {
    notification_id: n.id,
    org_id: n.org_id,
    user_id: n.user_id,
    to_email,
    reply_to_email: reply_to_email ?? null,
    subject: n.title,
    body_text: buildPlainBody(n),
    body_html: null,
    status: "queued" as const,
    retry_count: 0,
    last_error: null,
    provider: null,
    provider_message_id: null,
    scheduled_for: scheduled_for ?? new Date().toISOString(),
  };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("notification_email_queue" as never)
    .insert(payload as never)
    .select(
      "id, notification_id, org_id, user_id, to_email, reply_to_email, subject, body_text, body_html, status, retry_count, last_error, provider, provider_message_id, created_at, scheduled_for, sent_at, failed_at, updated_at" as never,
    )
    .single();
  if (error) {
    console.error(
      "[notification-email] queue insert failed",
      error.message ?? String(error),
    );
    return null;
  }
  return data as unknown as EmailQueueRow;
}

/**
 * Stub sender. Returns `{ status: 'skipped' }` because no provider
 * is configured yet — and prints a clear log line so anyone
 * grepping production logs sees that the email pipeline is in
 * stubbed mode. When the provider PR lands, this body becomes the
 * actual API call.
 */
export async function sendNotificationEmail(input: {
  queue_row_id: string;
}): Promise<{
  status: "queued" | "sent" | "failed" | "skipped";
  reason?: string;
}> {
  console.log(
    "[notification-email] sendNotificationEmail (STUB)",
    "id=" + input.queue_row_id,
    "provider=none",
  );
  // Mark the row as 'skipped' so a future cron loop doesn't keep
  // picking it up indefinitely. The notification still exists in
  // the notifications table — only the email is skipped.
  const admin = createAdminClient();
  await admin
    .from("notification_email_queue" as never)
    .update({
      status: "skipped",
      last_error: "no_provider_configured",
    } as never)
    .eq("id" as never, input.queue_row_id);
  return { status: "skipped", reason: "no_provider_configured" };
}

function buildPlainBody(n: NotificationRow): string {
  const parts: string[] = [];
  parts.push(n.title);
  if (n.body) parts.push("\n" + n.body);
  if (n.action_url) {
    parts.push("\n\nLink: https://crewflow.uk" + n.action_url);
  }
  parts.push(
    "\n\n— CrewFlow\nManage notifications: https://crewflow.uk/notifications",
  );
  return parts.join("");
}
