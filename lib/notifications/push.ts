import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { getPreferencesForUserKeys } from "@/server/services/notification-preferences-service";
import { resolvePushDelivery } from "./preferences";
import {
  buildPushPayload,
  type NotificationRow,
  type PushSubscriptionRecord,
} from "./types";
import {
  buildVapidAuthHeader,
  encryptWebPushPayload,
  type VapidKeys,
} from "./webpush";

/**
 * CrewFlow — Web Push channel (IO half). VAPID + RFC 8291 aes128gcm, no native
 * shell, no third-party dependency (lib/notifications/webpush.ts is the encoder).
 *
 * TWO-SWITCH DARK, refuse-before-send:
 *   * SWITCH 1 (config): VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY. Unset ⇒ the whole
 *     channel is DARK — `getVapidKeys()` returns null, so `enqueuePushForNotifications`
 *     enqueues NOTHING and `drainPushQueue` marks any stray row 'skipped'. No key,
 *     no send. Activation = set the keys.
 *   * SWITCH 2 (opt-in): a per-user push subscription must exist AND the user's
 *     per-category push preference must be on (default on, opt-down; critical
 *     always sends). No subscription ⇒ nothing to send.
 *
 * Delivery mirrors the email pipeline: emit ENQUEUES (network-free) onto
 * push_deliveries; the push-drain cron DISPATCHES with exponential-backoff retry.
 * Service-role for the queue + send; user-JWT (RLS) for subscription CRUD.
 */

// ---------------------------------------------------------------------
// Config (SWITCH 1)
// ---------------------------------------------------------------------

/**
 * Resolve the configured VAPID keys, or null when the channel is DARK. Requires
 * BOTH keys; a half-configured deploy is treated as dark (fail-closed) rather
 * than attempting a send that can only fail.
 */
export function getVapidKeys(): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    // A `mailto:`/`https:` sender identity is REQUIRED by RFC 8292; default to
    // the internal contact so a deploy that sets keys but forgets the subject
    // still produces a valid header.
    subject: env.VAPID_SUBJECT || "mailto:hello@crewflow.uk",
  };
}

/** True when the Web Push channel is configured (SWITCH 1). */
export function isPushConfigured(): boolean {
  return getVapidKeys() !== null;
}

/** The client needs the PUBLIC key (only) to call `pushManager.subscribe`. */
export function getPushPublicKey(): string | null {
  return getVapidKeys()?.publicKey ?? null;
}

// ---------------------------------------------------------------------
// Subscription CRUD (user-JWT, RLS-gated, own rows only)
// ---------------------------------------------------------------------

/**
 * Upsert the caller's Web Push subscription. Runs on the USER JWT so the own-row
 * RLS policy is the real boundary; `org_id`/`user_id` are pinned from the
 * authenticated context by the caller (never client input). Upsert on `endpoint`
 * so a re-subscribe (same browser) refreshes keys in place rather than
 * duplicating. Returns true on success.
 */
export async function savePushSubscription(
  orgId: string,
  userId: string,
  sub: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("push_subscriptions" as never)
    .upsert(
      {
        org_id: orgId,
        user_id: userId,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        user_agent: sub.userAgent ?? null,
        last_used_at: null,
      } as never,
      { onConflict: "endpoint" } as never,
    );
  if (error) {
    console.error("[push] savePushSubscription failed", error);
    return false;
  }
  return true;
}

/**
 * Delete the caller's subscription by endpoint (unsubscribe). User-JWT: the RLS
 * delete policy confines it to the caller's own rows, and we additionally pin
 * org_id + user_id at the call site for defence in depth. Returns true on
 * success (a no-op delete of an already-gone row is still success).
 */
export async function deletePushSubscription(
  orgId: string,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("push_subscriptions" as never)
    .delete()
    .eq("endpoint" as never, endpoint as never)
    .eq("org_id" as never, orgId as never)
    .eq("user_id" as never, userId as never);
  if (error) {
    console.error("[push] deletePushSubscription failed", error);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// ENQUEUE (service role, network-free) — called from emitNotifications
// ---------------------------------------------------------------------

const SUB_COLS = "org_id, user_id, endpoint, p256dh, auth, user_agent";

/**
 * Fan a batch of just-persisted notifications out to push_deliveries, network-
 * free. Called from `emitNotifications` after the rows persist. DARK short-
 * circuit first (no VAPID ⇒ nothing enqueued). Then, for every notification, the
 * recipient set is:
 *   * user-directed row (user_id set) → that user, IF they have a subscription;
 *   * org-wide row (user_id null)     → every subscribed member of the org.
 * Each (row, recipient) is kept only when the recipient's per-category push
 * preference resolves ON (default on; critical always). Idempotent: the insert
 * upserts on (notification_id, user_id) and ignores collisions.
 */
export async function enqueuePushForNotifications(
  rows: ReadonlyArray<NotificationRow>,
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!isPushConfigured()) return 0; // SWITCH 1: dark ⇒ enqueue nothing.

  const c = createAdminClient();
  const orgIds = Array.from(new Set(rows.map((r) => r.org_id)));

  // Who CAN receive a push in these orgs (i.e. has a subscription). One paged
  // read; missing = no subscription = skip.
  const { data: subRows, error: subErr } = await fetchAllRows<
    Record<string, unknown>
  >(
    (from, to) =>
      c
        .from("push_subscriptions" as never)
        .select(SUB_COLS as never)
        .in("org_id" as never, orgIds as never)
        .order("org_id" as never, { ascending: true })
        .order("user_id" as never, { ascending: true })
        .order("endpoint" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (subErr) {
    console.error("[push] enqueue: subscription read failed", subErr);
    return 0;
  }

  // Distinct subscribed users per org.
  const subscribedByOrg = new Map<string, Set<string>>();
  for (const s of subRows) {
    const org = s.org_id as string;
    const user = s.user_id as string;
    if (!subscribedByOrg.has(org)) subscribedByOrg.set(org, new Set());
    subscribedByOrg.get(org)!.add(user);
  }
  if (subscribedByOrg.size === 0) return 0; // nobody subscribed in any org.

  // Candidate (row, user) recipients before preference filtering.
  const candidates: Array<{ row: NotificationRow; userId: string }> = [];
  for (const row of rows) {
    const subscribed = subscribedByOrg.get(row.org_id);
    if (!subscribed || subscribed.size === 0) continue;
    if (row.user_id != null) {
      if (subscribed.has(row.user_id)) {
        candidates.push({ row, userId: row.user_id });
      }
    } else {
      for (const userId of subscribed) candidates.push({ row, userId });
    }
  }
  if (candidates.length === 0) return 0;

  // One bulk preference read for every distinct (org,user) recipient.
  const prefKeys = Array.from(
    new Map(
      candidates.map((cd) => [
        `${cd.row.org_id}::${cd.userId}`,
        { org_id: cd.row.org_id, user_id: cd.userId },
      ]),
    ).values(),
  );
  const prefIndex = await getPreferencesForUserKeys(prefKeys);

  const eligible = candidates.filter(({ row, userId }) => {
    const pref =
      prefIndex.get(`${row.org_id}::${userId}::${row.category}`) ?? null;
    return resolvePushDelivery({
      category: row.category,
      priority: row.priority,
      preference: pref,
    });
  });
  if (eligible.length === 0) return 0;

  const payload = eligible.map(({ row, userId }) => ({
    notification_id: row.id,
    org_id: row.org_id,
    user_id: userId,
    category: row.category,
    status: "queued" as const,
    retry_count: 0,
    scheduled_for: new Date().toISOString(),
  }));

  const { error: insErr, count } = await c
    .from("push_deliveries" as never)
    .upsert(payload as never, {
      onConflict: "notification_id,user_id",
      ignoreDuplicates: true,
      count: "exact",
    } as never);
  if (insErr) {
    console.error("[push] enqueue: delivery insert failed", insErr);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------
// SEND — one push to one subscription (RFC 8291 + VAPID)
// ---------------------------------------------------------------------

export type PushSendResult = {
  ok: boolean;
  statusCode: number | null;
  /** Subscription is permanently gone (404/410) — prune it. */
  gone: boolean;
  error?: string;
};

const PUSH_TTL_SECONDS = 24 * 60 * 60; // how long the push service holds it.
const PUSH_SEND_TIMEOUT_MS = 10_000;

/**
 * Encrypt + POST one push to one subscription. Never throws: any failure is
 * returned as `{ ok:false }`. A 404/410 marks the subscription `gone` so the
 * caller prunes it.
 */
export async function sendOnePush(
  keys: VapidKeys,
  sub: PushSubscriptionRecord,
  payloadJson: string,
): Promise<PushSendResult> {
  try {
    const { body } = encryptWebPushPayload({
      payload: payloadJson,
      userPublicKey: sub.p256dh,
      userAuth: sub.auth,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_SEND_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: buildVapidAuthHeader(keys, sub.endpoint),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(PUSH_TTL_SECONDS),
          Urgency: "normal",
        },
        body: new Uint8Array(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // 201/200/202 = accepted. 404/410 = subscription gone (prune).
    if (res.status === 404 || res.status === 410) {
      return { ok: false, statusCode: res.status, gone: true };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, statusCode: res.status, gone: false };
    }
    return {
      ok: false,
      statusCode: res.status,
      gone: false,
      error: `push_service_${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      statusCode: null,
      gone: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------
// DRAIN (cron entry point, service role)
// ---------------------------------------------------------------------

export type PushDrainResult = {
  picked: number;
  sent: number;
  failed: number;
  skipped: number;
  pruned: number;
  errors: string[];
  durationMs: number;
};

const PUSH_DRAIN_BATCH_SIZE = 50;
const PUSH_MAX_RETRIES = 6;

/**
 * Drain up to a batch of queued push_deliveries whose scheduled_for is in the
 * past. DARK double-check first: no VAPID ⇒ mark the batch 'skipped' (a config
 * that was set then cleared can never dispatch a stale row). For each delivery
 * we resolve the recipient's CURRENT subscriptions, send to each, prune gone
 * ones, and settle the row (sent / skipped / failed-with-backoff). Best-effort:
 * a per-row failure is absorbed into the result, never thrown.
 */
export async function drainPushQueue(): Promise<PushDrainResult> {
  const startedAt = Date.now();
  const c = createAdminClient();

  const { data, error } = await c
    .from("push_deliveries" as never)
    .select(
      "id, notification_id, org_id, user_id, category, retry_count" as never,
    )
    .eq("status" as never, "queued")
    .lte("scheduled_for" as never, new Date().toISOString())
    .order("scheduled_for" as never, { ascending: true })
    .limit(PUSH_DRAIN_BATCH_SIZE);
  if (error) {
    return {
      picked: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      pruned: 0,
      errors: [(error as { message?: string }).message ?? String(error)],
      durationMs: Date.now() - startedAt,
    };
  }
  const deliveries = (data ?? []) as Array<{
    id: string;
    notification_id: string;
    org_id: string;
    user_id: string;
    category: string;
    retry_count: number;
  }>;

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let pruned = 0;
  const errors: string[] = [];

  const keys = getVapidKeys();
  if (!keys) {
    // SWITCH 1 lost between enqueue and drain — refuse to send, mark skipped.
    for (const d of deliveries) {
      await settle(c, d.id, "skipped", d.retry_count, "no_vapid_configured");
      skipped++;
    }
    return {
      picked: deliveries.length,
      sent: 0,
      failed: 0,
      skipped,
      pruned: 0,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  // Fetch the source notification rows once for payload composition.
  const notifIds = Array.from(new Set(deliveries.map((d) => d.notification_id)));
  const notifById = await fetchNotificationsForPush(c, notifIds);

  for (const d of deliveries) {
    try {
      const n = notifById.get(d.notification_id);
      if (!n) {
        // Notification vanished (cascade delete) — nothing to send.
        await settle(c, d.id, "skipped", d.retry_count, "notification_missing");
        skipped++;
        continue;
      }

      const subs = await fetchUserSubscriptions(c, d.org_id, d.user_id);
      if (subs.length === 0) {
        await settle(c, d.id, "skipped", d.retry_count, "no_subscription");
        skipped++;
        continue;
      }

      const payloadJson = JSON.stringify(buildPushPayload(n));
      let anySuccess = false;
      let lastErr: string | null = null;
      for (const sub of subs) {
        const result = await sendOnePush(keys, sub, payloadJson);
        if (result.ok) {
          anySuccess = true;
          await touchSubscription(c, sub.endpoint);
        } else if (result.gone) {
          await pruneSubscription(c, sub.endpoint);
          pruned++;
        } else {
          lastErr = result.error ?? `status_${result.statusCode}`;
        }
      }

      if (anySuccess) {
        await settle(c, d.id, "sent", d.retry_count, null);
        sent++;
      } else if (lastErr == null) {
        // Every subscription was gone + pruned — nothing left to deliver to.
        await settle(c, d.id, "skipped", d.retry_count, "all_subscriptions_gone");
        skipped++;
      } else {
        // Transient failure — schedule a backed-off retry (or give up after max).
        const retry = d.retry_count + 1;
        if (retry < PUSH_MAX_RETRIES) {
          await c
            .from("push_deliveries" as never)
            .update({
              status: "queued",
              retry_count: retry,
              last_error: lastErr.slice(0, 1000),
              failed_at: new Date().toISOString(),
              scheduled_for: nextRetryStamp(retry),
            } as never)
            .eq("id" as never, d.id);
        } else {
          await settle(c, d.id, "failed", retry, lastErr);
        }
        failed++;
        errors.push(`${d.id}: ${lastErr}`);
      }
    } catch (e) {
      failed++;
      errors.push(`${d.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    picked: deliveries.length,
    sent,
    failed,
    skipped,
    pruned,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Nightly housekeeping — prune ancient settled rows so the queue doesn't grow
 * forever. Returns count of rows pruned.
 */
export async function cleanupOldPushDeliveries(
  olderThanDays = 30,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - olderThanDays * 86_400_000,
  ).toISOString();
  const c = createAdminClient();
  const { error, count } = await c
    .from("push_deliveries" as never)
    .delete({ count: "exact" })
    .in("status" as never, ["sent", "skipped", "failed"])
    .lt("created_at" as never, cutoff);
  if (error) {
    console.error("[push] cleanup failed", (error as { message?: string }).message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

type PushNotif = {
  id: string;
  title: string;
  body: string | null;
  action_url: string | null;
  category: NotificationRow["category"];
  source_module: string | null;
  source_id: string | null;
};

async function fetchNotificationsForPush(
  c: ReturnType<typeof createAdminClient>,
  ids: string[],
): Promise<Map<string, PushNotif>> {
  const out = new Map<string, PushNotif>();
  if (ids.length === 0) return out;
  const { data, error } = await c
    .from("notifications" as never)
    .select(
      "id, title, body, action_url, category, source_module, source_id" as never,
    )
    .in("id" as never, ids as never);
  if (error) {
    console.error("[push] notification read failed", error);
    return out;
  }
  for (const raw of (data as unknown as Array<Record<string, unknown>>) ?? []) {
    out.set(raw.id as string, {
      id: raw.id as string,
      title: (raw.title as string) ?? "",
      body: (raw.body as string | null) ?? null,
      action_url: (raw.action_url as string | null) ?? null,
      category: (raw.category as NotificationRow["category"]) ?? "other",
      source_module: (raw.source_module as string | null) ?? null,
      source_id: (raw.source_id as string | null) ?? null,
    });
  }
  return out;
}

async function fetchUserSubscriptions(
  c: ReturnType<typeof createAdminClient>,
  orgId: string,
  userId: string,
): Promise<PushSubscriptionRecord[]> {
  const { data, error } = await c
    .from("push_subscriptions" as never)
    .select(SUB_COLS as never)
    .eq("org_id" as never, orgId as never)
    .eq("user_id" as never, userId as never);
  if (error) {
    console.error("[push] subscription read failed", error);
    return [];
  }
  return ((data as unknown as Array<Record<string, unknown>>) ?? []).map((r) => ({
    org_id: r.org_id as string,
    user_id: r.user_id as string,
    endpoint: r.endpoint as string,
    p256dh: r.p256dh as string,
    auth: r.auth as string,
    user_agent: (r.user_agent as string | null) ?? null,
  }));
}

async function settle(
  c: ReturnType<typeof createAdminClient>,
  id: string,
  status: "sent" | "skipped" | "failed",
  retryCount: number,
  lastError: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await c
    .from("push_deliveries" as never)
    .update({
      status,
      retry_count: retryCount,
      last_error: lastError ? lastError.slice(0, 1000) : null,
      ...(status === "sent" ? { sent_at: now } : {}),
      ...(status === "failed" ? { failed_at: now } : {}),
    } as never)
    .eq("id" as never, id);
}

async function pruneSubscription(
  c: ReturnType<typeof createAdminClient>,
  endpoint: string,
): Promise<void> {
  await c
    .from("push_subscriptions" as never)
    .delete()
    .eq("endpoint" as never, endpoint);
}

async function touchSubscription(
  c: ReturnType<typeof createAdminClient>,
  endpoint: string,
): Promise<void> {
  await c
    .from("push_subscriptions" as never)
    .update({ last_used_at: new Date().toISOString() } as never)
    .eq("endpoint" as never, endpoint);
}

/** 1:1min, 2:5min, 3:15min, 4:1h, 5:4h, 6+:24h — mirrors the email backoff. */
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
