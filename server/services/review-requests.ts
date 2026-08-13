import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import type { NotificationCreate } from "@/lib/notifications/types";

/**
 * Phase H — Review requests.
 *
 * After a completed job, the operator schedules a review request
 * with delay 0/3/7 days for a chosen platform (google / facebook /
 * trustpilot / other).
 *
 * Lifecycle:
 *   - scheduled  → created by operator
 *   - sent       → cron fires when send_at reached; notification +
 *                  audit; status flips to 'sent'
 *   - completed  → operator marks customer left a review (manual)
 *   - ignored    → cron determines after N days post-send (future)
 *   - cancelled  → operator cancels before send
 */

export const REVIEW_PLATFORMS = ["google", "facebook", "trustpilot", "other"] as const;
export type ReviewPlatform = (typeof REVIEW_PLATFORMS)[number];

export type CreateReviewRequestInput = {
  customer_id: string;
  job_id?: string | null;
  platform: ReviewPlatform;
  delay_days: 0 | 3 | 7;
  notes?: string | null;
};

export async function createReviewRequest(
  input: CreateReviewRequestInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { ctx, user } = await requireOrgContext();
  const tenant = await createClient();

  const sendAt = new Date(Date.now() + input.delay_days * 86_400_000).toISOString();

  const { data, error } = await tenant
    .from("review_requests" as never)
    .insert({
      org_id: ctx.org.id,
      customer_id: input.customer_id,
      job_id: input.job_id ?? null,
      platform: input.platform,
      delay_days: input.delay_days,
      send_at: sendAt,
      status: "scheduled",
      requested_by: user.id,
      notes: input.notes ?? null,
    } as never)
    .select("id")
    .single();
  if (error || !data) {
    console.error("[review-requests] insert failed", error);
    return { ok: false, error: error?.message ?? "insert_failed" };
  }
  const id = (data as { id: string }).id;

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "review_request.created",
    targetTable: "review_requests",
    targetId: id,
    metadata: {
      platform: input.platform,
      delay_days: input.delay_days,
      customer_id: input.customer_id,
    },
  });
  return { ok: true, id };
}

export async function markReviewCompleted(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ctx, user } = await requireOrgContext();
  const tenant = await createClient();
  // ACTIVE-org pin: review_requests' RLS is org_id in current_org_ids(), which
  // admits every org the caller belongs to. Mirrors reviews/actions.ts, which
  // pins .eq("org_id", ctx.org.id) on every by-id write.
  const { error } = await tenant
    .from("review_requests" as never)
    .update({ status: "completed", completed_at: new Date().toISOString() } as never)
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) return { ok: false, error: error.message };
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "review_request.completed",
    targetTable: "review_requests",
    targetId: id,
    metadata: null,
  });
  return { ok: true };
}

export async function cancelReviewRequest(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ctx, user } = await requireOrgContext();
  const tenant = await createClient();
  // ACTIVE-org pin (see markReviewCompleted).
  const { error } = await tenant
    .from("review_requests" as never)
    .update({ status: "cancelled" } as never)
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) return { ok: false, error: error.message };
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "review_request.cancelled",
    targetTable: "review_requests",
    targetId: id,
    metadata: null,
  });
  return { ok: true };
}

/**
 * Cron-side fire: pick scheduled requests with send_at <= now, emit
 * notification to the operator (so they can send the link manually),
 * stamp status='sent'. Idempotent — the status filter ensures we
 * never re-send a fired row.
 */
export async function runReviewRequestSends(): Promise<{ scanned: number; sent: number; errors: number }> {
  const admin = createAdminClient();
  const stats = { scanned: 0, sent: 0, errors: 0 };

  type Row = {
    id: string;
    org_id: string;
    customer_id: string | null;
    platform: string;
    send_at: string;
  };
  // PAGED (F-1): this is a CROSS-ORG cron scan of every DUE scheduled request,
  // and EVERY row is sent this tick (rows.length → stats.scanned, then a per-row
  // send loop). A bare read is clamped at PostgREST max_rows=1000, so once more
  // than 1000 review requests fall due in one tick the overflow would never be
  // sent (a silent delivery gap this cast-form read hid from the clamp guard
  // until the C66 `;`-windowing de-vacuum). Compute `now` ONCE so the paged
  // window is stable, and order by (send_at asc, id asc) for a total order.
  type ReviewCronQuery = PromiseLike<{ data: Row[] | null; error: { message: string } | null }> & {
    select: (cols: string) => ReviewCronQuery;
    eq: (k: string, v: unknown) => ReviewCronQuery;
    lte: (k: string, v: string) => ReviewCronQuery;
    order: (k: string, o: { ascending: boolean }) => ReviewCronQuery;
    range: (from: number, to: number) => ReviewCronQuery;
  };
  const nowIso = new Date().toISOString();
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    (
      admin.from("review_requests" as never) as unknown as {
        select: (cols: string) => ReviewCronQuery;
      }
    )
      .select("id, org_id, customer_id, platform, send_at")
      .eq("status", "scheduled")
      .lte("send_at", nowIso)
      .order("send_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );

  if (error) {
    console.error("[review-requests] cron query failed", error);
    return { ...stats, errors: 1 };
  }
  const rows = data ?? [];
  stats.scanned = rows.length;

  for (const r of rows) {
    try {
      await (admin.from("review_requests" as never) as unknown as {
        update: (row: unknown) => {
          eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
        };
      })
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", r.id);

      const note: NotificationCreate = {
        org_id: r.org_id,
        user_id: null,
        audience: "customer",
        type: "review_request.ready",
        category: "system",
        priority: "low",
        title: `Send the ${r.platform} review request now`,
        body: "The delay you scheduled has elapsed — share the link with the customer.",
        action_url: `/reviews`,
        source_module: "review_requests",
        source_id: r.id,
        metadata: { platform: r.platform },
      };
      await emitNotifications([note]);
      stats.sent++;
    } catch (e) {
      console.error("[review-requests] per-row error", r.id, e);
      stats.errors++;
    }
  }
  return stats;
}
