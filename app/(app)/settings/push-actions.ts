"use server";

import { requireOrgContext } from "@/server/auth/session";
import {
  savePushSubscription,
  deletePushSubscription,
} from "@/lib/notifications/push";
import { validateWebhookUrl } from "@/lib/webhooks/ssrf";

/**
 * Settings → Web Push device subscription actions (MP Wave R4).
 *
 * The browser creates the PushSubscription (permission grant + pushManager) and
 * hands us its JSON here to persist / remove. AUTHORISATION: org_id + user_id come
 * from requireOrgContext (the session), NEVER from the client; the upsert/delete
 * run on the user JWT so the own-row RLS policy on push_subscriptions is the real
 * boundary. We accept only the three subscription fields the encoder needs.
 */

export type PushSubscriptionActionResult = { ok: boolean; error?: string };

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export async function savePushSubscriptionAction(input: {
  endpoint: unknown;
  p256dh: unknown;
  auth: unknown;
  userAgent?: unknown;
}): Promise<PushSubscriptionActionResult> {
  const { user, ctx } = await requireOrgContext();

  const endpoint = nonEmptyString(input.endpoint);
  const p256dh = nonEmptyString(input.p256dh);
  const auth = nonEmptyString(input.auth);
  if (!endpoint || !p256dh || !auth) {
    return { ok: false, error: "invalid_subscription" };
  }
  // Only a PUBLIC https push-service endpoint is ever accepted: https, a DNS
  // name (no IP literal), no internal TLD / platform host / private range — the
  // same policy the outbound-webhook URL passes. This is the early, friendly
  // refusal; the BOUNDARY is the vetted send in lib/notifications/push.ts
  // (the table is client-writable, so a row can exist that never came here).
  if (!validateWebhookUrl(endpoint).ok) {
    return { ok: false, error: "invalid_endpoint" };
  }
  const userAgent = nonEmptyString(input.userAgent);

  const ok = await savePushSubscription(ctx.org.id, user.id, {
    endpoint,
    p256dh,
    auth,
    userAgent: userAgent ?? null,
  });
  return ok ? { ok: true } : { ok: false, error: "save_failed" };
}

export async function removePushSubscriptionAction(
  endpoint: unknown,
): Promise<PushSubscriptionActionResult> {
  const { user, ctx } = await requireOrgContext();
  const ep = nonEmptyString(endpoint);
  if (!ep) return { ok: false, error: "invalid_endpoint" };
  const ok = await deletePushSubscription(ctx.org.id, user.id, ep);
  return ok ? { ok: true } : { ok: false, error: "delete_failed" };
}
