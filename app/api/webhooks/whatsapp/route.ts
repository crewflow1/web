import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import * as Sentry from "@sentry/nextjs";
import {
  verifyMetaSignature,
  parseMetaWebhookPayload,
} from "@/lib/comms/providers/meta-whatsapp";
import {
  processMetaWhatsAppPayload,
  isWhatsAppInboundLive,
} from "@/server/services/whatsapp-webhook-handler";

/**
 * Meta WhatsApp Business Cloud API webhook — the inbound edge.
 *
 * GET  — Meta's subscription verification handshake. Echoes `hub.challenge`
 *        iff `hub.mode=subscribe` AND `hub.verify_token` matches
 *        WHATSAPP_VERIFY_TOKEN. Fails closed otherwise (403).
 *
 * POST — a delivery. The ONLY authentication is the X-Hub-Signature-256 HMAC
 *        over the RAW body (Meta signs the exact bytes), so we:
 *          1. rate-limit before any work (cheap abuse cutoff),
 *          2. read the raw body with request.text() — NEVER JSON-parse first,
 *             or the signature can't be verified,
 *          3. verifyMetaSignature (fail-closed) BEFORE parsing,
 *          4. parse + hand the envelope to processMetaWhatsAppPayload, which
 *             claims (idempotent/replay-safe), routes by phone_number_id and
 *             hands each message to the unchanged processInboundEnquiry core.
 *
 *        Always 200 on a *verified* delivery, even when individual items fail —
 *        Meta retries on non-2xx, and the per-item claim ledger already makes a
 *        redelivery safe, so we must not ask Meta to replay the whole batch for
 *        one bad item. A verification failure is 401/403; that IS a signal Meta
 *        should not retry with the same (forged/misconfigured) request.
 *
 * DARK by default: the whole integration is gated behind
 * NEXT_PUBLIC_FEATURE_WHATSAPP. With the flag off (or the app secret / verify
 * token unset) every path fails closed and touches no tenant data.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — Meta subscription verification (hub.challenge). */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isWhatsAppInboundLive()) {
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 404 });
  }
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;

  // Fail closed: unset token, wrong mode, or mismatch → 403, no challenge echo.
  if (!expected || mode !== "subscribe" || !token || token !== expected) {
    return new NextResponse("forbidden", { status: 403 });
  }
  // Meta expects the raw challenge string echoed with 200.
  return new NextResponse(challenge ?? "", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/** POST — a verified WhatsApp delivery (messages and/or statuses). */
export async function POST(request: Request): Promise<NextResponse> {
  // Maintenance-window gate: during a cutover, return a retry-safe 503 so the
  // provider (Stripe/Meta/Twilio) re-delivers after the window instead of
  // treating the event as handled. Inert unless MAINTENANCE_MODE=on.
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }
  // Rate limit before auth — abusive senders are cut off cheaply.
  const rl = enforce(request, "whatsapp_webhook", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  if (!isWhatsAppInboundLive()) {
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 404 });
  }

  // Raw body FIRST — signature is over the exact bytes; JSON-parsing first breaks it.
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  // THE auth boundary — fail-closed HMAC before we parse or act.
  if (!verifyMetaSignature({ signature, rawBody })) {
    return NextResponse.json(
      { ok: false, error: "invalid_signature" },
      { status: 401 },
    );
  }

  const env = parseMetaWebhookPayload(rawBody);
  if (!env) {
    // Signed but unparseable → 200 (do not make Meta retry a malformed body we
    // will never accept), but log for telemetry.
    console.warn("[whatsapp-webhook] verified but unparseable payload");
    return NextResponse.json({ ok: true, messages: 0, statuses: 0 });
  }

  try {
    const result = await processMetaWhatsAppPayload(env);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // A whole-batch failure (not a per-item one) → 500 so Meta retries; the
    // claim ledger makes the retry idempotent.
    Sentry.captureException(e, { tags: { route: "webhooks/whatsapp" } });
    console.error("[whatsapp-webhook] batch processing failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown_error" },
      { status: 500 },
    );
  }
}
