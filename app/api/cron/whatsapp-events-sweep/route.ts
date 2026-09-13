import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { isWhatsAppInboundLive } from "@/server/services/whatsapp-webhook-handler";
import { sweepWhatsAppWebhookEvents } from "@/server/services/whatsapp-events-sweep";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * WhatsApp failed-event sweep (activation-hardening P2-4).
 *
 *   GET /api/cron/whatsapp-events-sweep
 *
 * Drives one bounded pass of the whatsapp_webhook_events sweep: reclaim rows
 * that are failed or lease-expired (processed_at NULL — the claim protocol's
 * retryable states) and re-run them through the SAME post-claim machinery the
 * live webhook uses; dead-letter after max attempts with an HQ audit line.
 * Without this, a transiently-failed inbound customer message was stranded
 * forever once Meta's own redelivery window closed.
 *
 * DARK SHORT-CIRCUIT BEFORE TELEMETRY (the memory-embed idiom): while
 * NEXT_PUBLIC_FEATURE_WHATSAPP is off the webhook route 404s and no events can
 * exist, so a dark tick answers 204 and writes zero cron_runs rows — the cron
 * is free until the channel activation flips the flag, then full telemetry
 * resumes automatically.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each re-run is a full ingestion pass (extraction, lead, notify); a bounded
// batch of 10 needs headroom.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Cheap dark short-circuit: no flag ⇒ no inbound events ⇒ nothing to sweep.
  if (!isWhatsAppInboundLive()) {
    return new NextResponse(null, { status: 204 });
  }
  const url = new URL(request.url);
  // `limit` bounds rows per invocation — a manual backlog kick can raise it;
  // the scheduled tick uses the service default.
  const limitRaw = Number(url.searchParams.get("limit"));
  const batch = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : undefined;

  const { status, payload } = await withCronTelemetry("whatsapp-events-sweep", async () => {
    const summary = await sweepWhatsAppWebhookEvents(batch ? { batch } : undefined);
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}
