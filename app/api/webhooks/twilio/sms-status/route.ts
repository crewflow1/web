import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import {
  verifyTwilioSignature,
  parseTwilioSmsStatusCallback,
} from "@/lib/comms/providers/twilio";
import { recordSmsDeliveryReceipt } from "@/server/services/receptionist";

/**
 * CrewFlow — Twilio SMS status-callback receiver (Directive #018 R7).
 *
 *   POST /api/webhooks/twilio/sms-status
 *
 * The asynchronous half of the receptionist's outbound SMS lifecycle. The `send`
 * adapter (R6) resolved with the provider's ACCEPTANCE (a message sid + a synchronous
 * "queued"/"accepted" status); the message's TERMINAL fate (delivered / undelivered /
 * failed) arrives here later, over Twilio's status callback, correlated by that same
 * sid. This route is the ONLY inbound door for that receipt.
 *
 * The mandated flow, in order:
 *   Provider → Authenticated Callback → Provider Verification → Transport Lookup →
 *   Correlation → Lifecycle Update → Audit Recording.
 *
 * 1. AUTHENTICATE. Twilio signs the exact request URL + sorted POST params with the
 *    account auth token (HMAC-SHA1, base64) in `X-Twilio-Signature`. We reuse the
 *    SAME SDK-owned verification model the Stripe route uses — NOT a weaker bearer.
 *    A missing OR invalid signature is a hard 401; an unconfigured auth token fails
 *    closed to 401 (we cannot authenticate, so we do not trust). No side effect runs
 *    before the signature passes.
 * 2. NORMALISE. `parseTwilioSmsStatusCallback` translates the raw params into the
 *    provider-neutral receipt, or NULL when the payload is malformed or carries a
 *    status outside the canonical vocabulary → 400.
 * 3. CORRELATE + RECORD. `recordSmsDeliveryReceipt` resolves the SENT transport by the
 *    provider message id and APPENDS an idempotent receipt row (never mutating the
 *    transport). An unknown message id is recorded nowhere → 404. A duplicate callback
 *    is an idempotent 200 no-op.
 *
 * This route opens NO new outbound door: it never constructs a provider, never sends,
 * never writes a transport, and emits no event. It reads a signed inbound callback and
 * delegates the single persistence path to the canonical service.
 *
 * Returns:
 *   200 { ok:true, recorded:true, duplicate, status, terminal }
 *   400 { ok:false, error:"unsupported_or_malformed_callback" }
 *   401 { ok:false, error:"signature_verification_failed" }
 *   404 { ok:false, error:"unknown_message" }
 *   500 { ok:false, error:string }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "lhr1";

/**
 * The exact URL Twilio signed. Prefer the configured public callback URL
 * (`TWILIO_STATUS_CALLBACK_URL`) — authoritative behind a proxy that rewrites
 * host/proto — else reconstruct it from the forwarded request headers. Read at CALL
 * TIME (not the frozen env singleton), so a deploy can set it and a test can drive it.
 */
function callbackUrl(request: Request): string {
  const configured = process.env.TWILIO_STATUS_CALLBACK_URL?.trim();
  if (configured) return configured;

  const parsed = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto") ?? parsed.protocol.replace(/:$/, "");
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    parsed.host;
  return `${proto}://${host}${parsed.pathname}${parsed.search}`;
}

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
  // Twilio delivers an application/x-www-form-urlencoded body. Read it raw — the
  // signature is computed over these exact params, so we must not let anything
  // re-encode them before verification.
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));

  // 1. AUTHENTICATE. Missing token, missing signature, or a bad signature all fail
  //    closed to 401 — an unauthenticated callback is never trusted, and no side
  //    effect runs before this passes.
  const signature = request.headers.get("x-twilio-signature");
  const authentic = await verifyTwilioSignature({
    signature,
    url: callbackUrl(request),
    params,
  });
  if (!authentic) {
    return NextResponse.json(
      { ok: false, error: "signature_verification_failed" },
      { status: 401 },
    );
  }

  // 2. NORMALISE. A malformed payload or a status outside the canonical vocabulary
  //    is a 400 — we never record an unknown status.
  const receipt = parseTwilioSmsStatusCallback(params);
  if (!receipt) {
    return NextResponse.json(
      { ok: false, error: "unsupported_or_malformed_callback" },
      { status: 400 },
    );
  }

  // 3. CORRELATE + RECORD. The single server-side persistence path: transport lookup
  //    → correlation → idempotent append. An unknown message id records nothing (404);
  //    a write error throws (500 → Twilio retries); success is 200 (duplicate = no-op).
  try {
    const result = await recordSmsDeliveryReceipt(receipt);
    if (!result.recorded) {
      return NextResponse.json(
        { ok: false, error: "unknown_message" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      recorded: true,
      duplicate: result.duplicate,
      status: result.status,
      terminal: result.terminal,
    });
  } catch (e) {
    console.error(
      "[twilio-sms-status] receipt persistence failed",
      receipt.providerMessageId,
      receipt.status,
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "unknown_error",
      },
      { status: 500 },
    );
  }
}
