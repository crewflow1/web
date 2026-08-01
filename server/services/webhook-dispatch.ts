import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeWebhookFetch } from "@/lib/webhooks/ssrf";
import {
  DELIVERY_ID_HEADER,
  SIGNATURE_HEADER,
  signWebhookPayload,
} from "@/lib/webhooks/signature";
import { redactEnvelope, type WebhookEnvelope } from "@/lib/webhooks/events";

/**
 * Outbound-webhook dispatch service (Train A) — fan-out driver + delivery pass.
 *
 * Two passes, both driven by the webhook-dispatch cron (which owns the feature
 * flag gate and never calls this while dark):
 *
 *   1. fanOutPendingEvents — advances the `outbound_webhooks` spine consumer,
 *      turning matching events into pending webhook_deliveries idempotently (all
 *      the transactional work is in SQL: webhook_dispatch_drain).
 *   2. runDeliveryPass — atomically claims due deliveries, signs + POSTs each
 *      through the SSRF-vetted, DNS-pinned fetch, and records the outcome with
 *      exponential backoff + the circuit breaker.
 *
 * Mirrors the Stripe receiver's verify→claim→idempotent-dispatch→mark shape,
 * turned outbound. Every network call goes through lib/webhooks/ssrf; this module
 * performs NO fetch of its own.
 */

// --- Backoff + breaker constants (pinned by the security suite) ---------------

/** Attempts before a delivery is declared dead. */
export const MAX_ATTEMPTS = 8;
/** Consecutive dead deliveries before an endpoint auto-disables. */
export const FAILURE_THRESHOLD = 5;
/** Cap on a single backoff delay (~6h). */
const MAX_BACKOFF_MINUTES = 360;
/** How many deliveries a single pass claims. */
const CLAIM_BATCH = 50;

/**
 * The retry delay, in minutes, before the given attempt number is tried.
 * Exponential doubling from 1m, capped at ~6h: attempt 1 → 1m, 2 → 2m, 3 → 4m,
 * … 8 → capped 360m. Pure + deterministic (unit-tested).
 */
export function backoffMinutes(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(2 ** (n - 1), MAX_BACKOFF_MINUTES);
}

// --- RPC plumbing (these functions aren't in the generated types) ------------

type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(): Rpc {
  const admin = createAdminClient();
  return admin.rpc.bind(admin) as unknown as Rpc;
}

// --- 1. Fan-out --------------------------------------------------------------

export type FanOutSummary = {
  ok: boolean;
  processed?: number;
  new_offset?: number;
  lag?: number;
  skipped?: string;
  error?: string;
};

/** Advance the spine consumer, fanning matched events into webhook_deliveries. */
export async function fanOutPendingEvents(maxEvents = 500): Promise<FanOutSummary> {
  try {
    const { data, error } = await rpc()("webhook_dispatch_drain", { p_max_events: maxEvents });
    if (error || data == null) {
      return { ok: false, error: error?.message ?? "drain returned nothing" };
    }
    const summary = data as Record<string, unknown>;
    return {
      ok: true,
      processed: Number(summary.processed ?? 0),
      new_offset: Number(summary.new_offset ?? 0),
      lag: Number(summary.lag ?? 0),
      skipped: typeof summary.skipped === "string" ? summary.skipped : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- 2. Delivery pass --------------------------------------------------------

type ClaimedDelivery = {
  delivery_id: string;
  endpoint_id: string;
  org_id: string;
  url: string;
  secret: string;
  verb: string;
  payload: WebhookEnvelope;
  attempt: number;
  event_id: number | null;
  is_ping: boolean;
};

export type DeliveryPassSummary = {
  ok: boolean;
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
  error?: string;
};

async function claimDeliveries(limit: number): Promise<ClaimedDelivery[]> {
  const { data, error } = await rpc()("webhook_claim_deliveries", { p_limit: limit });
  if (error || !Array.isArray(data)) {
    if (error) console.error("[webhook-dispatch] claim failed", error.message);
    return [];
  }
  return data as ClaimedDelivery[];
}

async function markDelivered(id: string, statusCode: number, sentPayload: unknown): Promise<void> {
  const { error } = await rpc()("webhook_mark_delivered", {
    p_delivery_id: id,
    p_status_code: statusCode,
    p_sent_payload: sentPayload,
  });
  if (error) console.error("[webhook-dispatch] mark_delivered failed", error.message);
}

async function markFailed(
  id: string,
  statusCode: number,
  errorText: string,
  attemptJustMade: number,
): Promise<"retried" | "dead"> {
  const dead = attemptJustMade >= MAX_ATTEMPTS;
  const nextAttemptAt = dead
    ? null
    : new Date(Date.now() + backoffMinutes(attemptJustMade + 1) * 60_000).toISOString();
  const { error } = await rpc()("webhook_mark_failed", {
    p_delivery_id: id,
    p_status_code: statusCode,
    p_error: errorText,
    p_dead: dead,
    p_next_attempt_at: nextAttemptAt,
    p_failure_threshold: FAILURE_THRESHOLD,
  });
  if (error) console.error("[webhook-dispatch] mark_failed failed", error.message);
  return dead ? "dead" : "retried";
}

/** Sign + POST one claimed delivery, then record the outcome. */
async function deliverOne(d: ClaimedDelivery): Promise<"delivered" | "retried" | "dead"> {
  // Redact to the per-verb allowlist (defence in depth over the already-curated
  // spine payload), then send EXACTLY that — and re-stamp the row with it.
  const redacted = redactEnvelope(d.payload);
  const body = JSON.stringify(redacted);
  const ts = Math.floor(Date.now() / 1000);

  const result = await safeWebhookFetch(d.url, {
    body,
    headers: {
      [SIGNATURE_HEADER]: signWebhookPayload(d.secret, body, ts),
      [DELIVERY_ID_HEADER]: d.delivery_id,
      "user-agent": "CrewFlow-Webhooks/1.0",
    },
  });

  if (result.ok) {
    await markDelivered(d.delivery_id, result.status, redacted);
    return "delivered";
  }
  return markFailed(
    d.delivery_id,
    result.status,
    result.error ?? `http-${result.status}`,
    d.attempt + 1,
  );
}

/** Claim + deliver a batch of due webhook deliveries. */
export async function runDeliveryPass(limit = CLAIM_BATCH): Promise<DeliveryPassSummary> {
  try {
    const claimed = await claimDeliveries(limit);
    const summary: DeliveryPassSummary = {
      ok: true,
      claimed: claimed.length,
      delivered: 0,
      retried: 0,
      dead: 0,
    };
    // Sequential: each POST is SSRF-vetted + up to 10s, and the batch is bounded.
    for (const d of claimed) {
      const outcome = await deliverOne(d);
      summary[outcome] += 1;
    }
    return summary;
  } catch (e) {
    return { ok: false, claimed: 0, delivered: 0, retried: 0, dead: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
