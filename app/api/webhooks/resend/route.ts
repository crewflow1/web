import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import * as Sentry from "@sentry/nextjs";
import { verifyResendSignature } from "@/lib/comms/providers/resend-events";
import { processResendEvent, isResendEventsLive } from "@/server/services/resend-events-handler";

/**
 * Resend DELIVERY-EVENTS webhook (MP Wave R4 · Communications audit).
 *
 * POST — one email lifecycle event (delivered / opened / clicked / bounced / …).
 *        The ONLY authentication is the Svix signature Resend ships on every
 *        webhook (svix-id / svix-timestamp / svix-signature), an HMAC-SHA256 over
 *        the RAW body keyed by the endpoint secret. So we:
 *          1. rate-limit before any work (cheap abuse cutoff),
 *          2. REFUSE BEFORE PROCESS: 404 unless the feature is live (two-switch:
 *             the flag AND the secret) — no body is even read while dark,
 *          3. read the raw body with request.text() — NEVER JSON-parse first,
 *             or the signature can't be verified,
 *          4. verifyResendSignature (fail-closed, replay-guarded) BEFORE parsing,
 *          5. record the event IDEMPOTENTLY keyed by the Svix message id.
 *
 *        Always 200 on a *verified* delivery, even when the item is a duplicate —
 *        Resend retries on non-2xx and the (provider, provider_event_id) unique
 *        key already makes a redelivery a no-op, so we must not ask it to replay
 *        an event we durably recorded. A verification failure is 401 — a signal
 *        the provider should NOT retry a forged/misconfigured request.
 *
 * DARK by default behind isResendEventsLive() (NEXT_PUBLIC_FEATURE_RESEND_EVENTS
 * + RESEND_WEBHOOK_SECRET). With either unset every path 404s and touches no data.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // Maintenance-window gate: return a retry-safe 503 so Resend re-delivers after
  // the window rather than treating the event as handled. Inert unless MAINTENANCE_MODE=on.
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }

  // Rate limit before auth — abusive senders are cut off cheaply.
  const rl = enforce(request, "resend_webhook", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  // REFUSE BEFORE PROCESS: while dark (flag off OR secret unset) the surface does
  // not exist — 404 before the body is even read, no data touched.
  if (!isResendEventsLive()) {
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 404 });
  }

  // Raw body FIRST — the signature is over the exact bytes; JSON-parsing first breaks it.
  const rawBody = await request.text();
  const headers = {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  };

  // THE auth boundary — fail-closed HMAC (replay-guarded) before we parse or act.
  if (!verifyResendSignature({ headers, rawBody })) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  try {
    // The Svix message id is the idempotency key. Verification already required it,
    // so it is present here.
    const providerEventId = headers.id as string;
    const result = await processResendEvent({ rawBody, providerEventId });
    if (!result) {
      console.warn("[resend-webhook] verified but unparseable payload");
      return NextResponse.json({ ok: true, recorded: false });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    Sentry.captureException(e, { tags: { route: "webhooks/resend" } });
    console.error("[resend-webhook] processing failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown_error" },
      { status: 500 },
    );
  }
}
