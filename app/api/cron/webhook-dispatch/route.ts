import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { outboundWebhooksEnabled } from "@/lib/webhooks/flags";
import { fanOutPendingEvents, runDeliveryPass } from "@/server/services/webhook-dispatch";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow — Outbound webhook dispatcher (Train A).
 *
 *   GET /api/cron/webhook-dispatch
 *
 * One run does two passes: (1) advance the `outbound_webhooks` spine consumer,
 * fanning matched events into pending deliveries; (2) claim + sign + POST due
 * deliveries through the SSRF-vetted, DNS-pinned fetch, with exponential backoff
 * and a per-endpoint circuit breaker.
 *
 * DARK BY DEFAULT: with NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS off this returns 204
 * with ZERO database work — the flag is checked immediately after the Bearer gate,
 * before any admin client is built or any RPC is issued. Even when the flag is on,
 * no delivery is created for an org until it has an ACTIVE (verified) endpoint, so
 * CI (flag off, no endpoints) egresses nothing.
 *
 * MUST run on the Node.js runtime: the delivery pass uses node:dns, node:crypto,
 * and an undici Agent with a custom lookup for DNS-rebind pinning.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Dark gate — zero DB work before the flag flips. No body on a 204.
  if (!outboundWebhooksEnabled()) {
    return new NextResponse(null, { status: 204 });
  }

  const { status, payload } = await withCronTelemetry("webhook-dispatch", async () => {
    const fan = await fanOutPendingEvents();
    const delivery = await runDeliveryPass();
    return { ok: fan.ok && delivery.ok, fan, delivery };
  });
  return NextResponse.json(payload, { status });
}
