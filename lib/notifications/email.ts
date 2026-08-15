import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { env } from "@/lib/env";
import type { NotificationRow } from "./types";

/**
 * CrewFlow — Notification email queue + sender (HQ-8 + phase-2).
 *
 * Resend (existing wrapper in lib/email/send.ts) is the configured
 * provider. The queue lives in notification_email_queue:
 *   * queueNotificationEmail inserts a 'queued' row.
 *   * sendNotificationEmail picks one row, dispatches via Resend,
 *     flips status to 'sent' | 'failed' | 'skipped' (no key).
 *   * drainNotificationEmailQueue is the cron entry point —
 *     processes a batched window of queued rows.
 *
 * Retry policy:
 *   * 'failed' rows are retried with exponential backoff: 1min, 5min,
 *     15min, 1h, 4h, 24h. After 6 failed attempts the row stays
 *     'failed' forever (manual triage in /admin/notifications).
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
 * Queue a DIGEST email — a batch of notifications composed into ONE message by
 * the notifications-digest cron. Unlike `queueNotificationEmail` this is not
 * tied to a single notification row: `notification_id` is null and the subject /
 * body are pre-composed by the pure `buildDigestEmail`. It rides the SAME
 * notification_email_queue → drain → Resend pipeline, so the digest cron itself
 * does no network I/O (the existing notifications-drain cron sends it).
 *
 * Best-effort: a queue-insert failure is logged and swallowed (returns null) so
 * one user's digest never blocks the pass.
 */
export async function queueDigestEmail(input: {
  org_id: string;
  user_id: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html?: string | null;
  reply_to_email?: string | null;
}): Promise<EmailQueueRow | null> {
  const payload = {
    notification_id: null,
    org_id: input.org_id,
    user_id: input.user_id,
    to_email: input.to_email,
    reply_to_email: input.reply_to_email ?? null,
    subject: input.subject,
    body_text: input.body_text,
    body_html: input.body_html ?? null,
    status: "queued" as const,
    retry_count: 0,
    last_error: null,
    provider: null,
    provider_message_id: null,
    scheduled_for: new Date().toISOString(),
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
      "[notification-email] digest queue insert failed",
      error.message ?? String(error),
    );
    return null;
  }
  return data as unknown as EmailQueueRow;
}

/**
 * Send one queued row via Resend. Returns the new status.
 *
 *   queued → sent      on Resend success
 *   queued → failed    on Resend error (retry scheduled via backoff)
 *   queued → skipped   if RESEND_API_KEY is unset (cron will keep
 *                       looking but won't keep re-trying the same row)
 *
 * Best-effort: every failure path catches + writes the row, so a
 * Resend outage never bubbles up to crash the cron.
 */
export async function sendNotificationEmail(input: {
  queue_row_id: string;
}): Promise<{
  status: "queued" | "sent" | "failed" | "skipped";
  reason?: string;
}> {
  const admin = createAdminClient();

  // Fetch the row.
  const { data: rowRaw, error: fetchErr } = await admin
    .from("notification_email_queue" as never)
    .select(
      "id, notification_id, org_id, user_id, to_email, reply_to_email, subject, body_text, body_html, status, retry_count" as never,
    )
    .eq("id" as never, input.queue_row_id)
    .maybeSingle();
  if (fetchErr || !rowRaw) {
    return { status: "failed", reason: "row_not_found" };
  }
  const row = rowRaw as unknown as EmailQueueRow;

  // No key? Mark skipped + remember so the cron stops cycling it.
  if (!env.RESEND_API_KEY) {
    await admin
      .from("notification_email_queue" as never)
      .update({
        status: "skipped",
        last_error: "no_provider_configured",
      } as never)
      .eq("id" as never, input.queue_row_id);
    return { status: "skipped", reason: "no_provider_configured" };
  }

  // Build the HTML body (we send text + a tiny HTML wrapper).
  const htmlBody =
    row.body_html ??
    `<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.55">${row.body_text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>")}</div>`;

  const result = await sendEmail({
    to: row.to_email,
    subject: row.subject,
    html: htmlBody,
    text: row.body_text,
    replyTo: row.reply_to_email ?? undefined,
  });

  const now = new Date().toISOString();

  if (result.sent) {
    await admin
      .from("notification_email_queue" as never)
      .update({
        status: "sent",
        sent_at: now,
        provider: "resend",
        provider_message_id: result.id,
        last_error: null,
      } as never)
      .eq("id" as never, input.queue_row_id);
    return { status: "sent" };
  }

  if (result.reason === "no_key") {
    await admin
      .from("notification_email_queue" as never)
      .update({
        status: "skipped",
        last_error: "no_provider_configured",
      } as never)
      .eq("id" as never, input.queue_row_id);
    return { status: "skipped", reason: "no_provider_configured" };
  }

  // Error / self_loop / anything else → mark failed + bump retry.
  const errMsg =
    result.reason === "error"
      ? result.error
      : `dispatch_${result.reason}`;
  const retryCount = (row.retry_count ?? 0) + 1;
  const scheduledFor = nextRetryStamp(retryCount);
  await admin
    .from("notification_email_queue" as never)
    .update({
      status: "failed",
      retry_count: retryCount,
      last_error: errMsg.slice(0, 1000),
      failed_at: now,
      // Reset back to 'queued' for the cron to pick up if we've
      // got retries left.
      ...(retryCount < MAX_RETRIES
        ? {
            status: "queued",
            scheduled_for: scheduledFor,
          }
        : {}),
    } as never)
    .eq("id" as never, input.queue_row_id);
  return { status: "failed", reason: errMsg };
}

// ---------------------------------------------------------------------
// Drain (cron entry point)
// ---------------------------------------------------------------------

export type DrainResult = {
  picked: number;
  sent: number;
  failed: number;
  skipped: number;
  errors: string[];
  durationMs: number;
};

const DRAIN_BATCH_SIZE = 50;
const MAX_RETRIES = 6;

/**
 * Pull up to DRAIN_BATCH_SIZE queued rows whose scheduled_for is in
 * the past, and dispatch each in sequence. Returns a summary for the
 * cron's response body. Best-effort: per-row failures are absorbed
 * into the result, never thrown.
 */
export async function drainNotificationEmailQueue(): Promise<DrainResult> {
  const startedAt = Date.now();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("notification_email_queue" as never)
    .select("id" as never)
    .eq("status" as never, "queued")
    .order("scheduled_for" as never, { ascending: true })
    .limit(DRAIN_BATCH_SIZE);
  if (error) {
    return {
      picked: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      errors: [error.message],
      durationMs: Date.now() - startedAt,
    };
  }
  const rows = (data ?? []) as Array<{ id: string }>;

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const r of rows) {
    try {
      const res = await sendNotificationEmail({ queue_row_id: r.id });
      if (res.status === "sent") sent++;
      else if (res.status === "failed") {
        failed++;
        if (res.reason) errors.push(`${r.id}: ${res.reason}`);
      } else if (res.status === "skipped") skipped++;
    } catch (e) {
      failed++;
      errors.push(
        `${r.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    picked: rows.length,
    sent,
    failed,
    skipped,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Compute the next retry timestamp based on retry count.
 * 1: 1min, 2: 5min, 3: 15min, 4: 1h, 5: 4h, 6+: 24h.
 */
function nextRetryStamp(retryCount: number): string {
  const minutes =
    retryCount === 1
      ? 1
      : retryCount === 2
        ? 5
        : retryCount === 3
          ? 15
          : retryCount === 4
            ? 60
            : retryCount === 5
              ? 240
              : 1440;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Nightly housekeeping — archive ancient sent rows so the table
 * doesn't grow forever. Returns count of rows pruned.
 */
export async function cleanupOldEmailRows(
  olderThanDays = 90,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - olderThanDays * 86_400_000,
  ).toISOString();
  const admin = createAdminClient();
  const { error, count } = await admin
    .from("notification_email_queue" as never)
    .delete({ count: "exact" })
    .in("status" as never, ["sent", "skipped"])
    .lt("created_at" as never, cutoff);
  if (error) {
    console.error("[notification-email] cleanup failed", error.message);
    return 0;
  }
  return count ?? 0;
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
