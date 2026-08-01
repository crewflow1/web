/**
 * Outbound-webhooks feature gate (Train A) — the global dark switch.
 *
 * `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS` defaults OFF. While off:
 *   • the webhook-dispatch cron 204-no-ops BEFORE any DB work (zero egress), and
 *   • the settings UI renders read-only "coming soon" copy instead of the manager.
 *
 * This is the GLOBAL flip; the SECOND, per-org flip is having an ACTIVE (verified)
 * endpoint — fan-out only targets status='active' endpoints, and an endpoint only
 * reaches 'active' after a signed ping is acknowledged. In CI neither flip is set,
 * so nothing egresses.
 *
 * Reads process.env directly (not the validated `env` object) so it is edge-safe
 * and usable from both server and client components — NEXT_PUBLIC_* is inlined at
 * build time in the client bundle.
 */
export function outboundWebhooksEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS === "true";
}
