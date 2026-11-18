/**
 * Stripe-webhook backlog probe for `/api/health`.
 *
 * The problem it closes: `/api/webhooks/stripe` stores every event in `billing_events` and
 * stamps `processed_at` only when the handler finished. A handler that keeps failing (a bad
 * deploy, a schema drift, a database outage) leaves the row with `processed_at` NULL — Stripe
 * retries for up to three days and then gives up, and until now NOTHING raised an alert: a
 * paid checkout that never activated its company, or a cancellation that never applied, was
 * only visible to someone reading the table. This probe makes "a Stripe event has been stuck
 * for more than half an hour" OBSERVABLE from the outside, so the independent monitor
 * (`.github/workflows/outage-monitor.yml`) can raise an issue and email the founder.
 *
 * Same doctrine as `backup-freshness.ts`: reads `process.env` directly, imports no SDK, is
 * edge-safe, and CAN NEVER THROW. Every failure collapses to `{ stuck: null }` ("unknown"),
 * which must never gate the endpoint's `ok` and never raise an alert by itself.
 *
 * Credential posture: `billing_events` is service-role-only. One indexed read
 * (`billing_events_unprocessed_idx`), only `id` is selected, at most `CAP + 1` rows, and the
 * ONLY thing published is a small capped integer. No event ids, types, companies or errors.
 */

export type BillingWebhookBacklog = {
  /**
   * Stripe events received more than 30 minutes ago that are still unprocessed, capped at 5.
   * `null` = UNKNOWN (missing config, timeout, query failure) — "cannot tell", never "stuck".
   */
  stuck: number | null;
};

const PROBE_TIMEOUT_MS = 2000;
/** A live delivery finishes in seconds; Stripe's first retries land within minutes. */
export const STUCK_AFTER_MINUTES = 30;
export const STUCK_CAP = 5;

/** The only value that may be published. Exported for unit tests; pure. */
export function capStuckCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), STUCK_CAP);
}

/** Never throws, never rejects, never gates health `ok`. */
export async function probeBillingWebhookBacklog(): Promise<BillingWebhookBacklog> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { stuck: null };

  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${url}/rest/v1/billing_events?select=id&processed_at=is.null&created_at=lt.${encodeURIComponent(cutoff)}&limit=${STUCK_CAP + 1}`,
      {
        method: "GET",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
        cache: "no-store",
      },
    );
    if (res.status !== 200) return { stuck: null };
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return { stuck: null };
    return { stuck: capStuckCount(rows.length) };
  } catch {
    return { stuck: null };
  } finally {
    clearTimeout(timer);
  }
}
