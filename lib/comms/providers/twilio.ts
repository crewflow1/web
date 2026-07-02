import "server-only";

/**
 * CrewFlow HQ — Communication Layer: the Twilio SMS provider (Directive #018 R5).
 *
 * The V1 implementation of the `SmsProvider` seam — the receptionist's FIRST
 * outbound transport (missed-call text-back). It does NOT introduce a second
 * messaging stack; it is the thin vendor adapter the seam calls, translating a
 * Twilio send into the seam's contract:
 *   - the provider ACCEPTED the message  → resolve with the provider message id (sid).
 *   - the provider degraded (misconfig / vendor error / no sid) → THROW, so the
 *     canonical service records a terminal `failed` attempt and owns retry.
 *
 * The send also REQUESTS the message's asynchronous delivery receipts by setting a
 * `statusCallback` on the Twilio request (Directive #018 R8) — the public URL of the
 * R7 receiver route — so Twilio POSTs each lifecycle transition (delivered / failed /
 * undelivered) back, correlated by that same sid. That closes the Provider → Delivery
 * Receipt edge; the receipt's authentication and ingestion live in the two helpers
 * below and the receiver route, not in this send.
 *
 * "Prefer extension over replacement" (a permanent engineering rule): Twilio is a
 * plug-in behind the factory (./index `getSmsProvider`), never imported by the
 * service. The SDK is loaded LAZILY (dynamic import, exactly as lib/email/send.ts
 * loads Resend) so it never enters a bundle that does not send SMS, and so the unit
 * suite can exercise the seam's null path without the vendor present.
 */

import { env } from "@/lib/env";
import { isSmsDeliveryStatus } from "../types";
import type {
  SmsAcceptance,
  SmsDeliveryReceipt,
  SmsMessage,
  SmsProvider,
  SmsProviderInfo,
} from "../types";

const INFO: SmsProviderInfo = { provider: "twilio", channel: "sms" };

/**
 * The path Twilio POSTs delivery receipts to — the R7 receiver route
 * (`app/api/webhooks/twilio/sms-status/route.ts`). Kept as ONE constant so the
 * send-side callback URL and the route it points at can never silently drift.
 */
export const SMS_STATUS_CALLBACK_PATH = "/api/webhooks/twilio/sms-status";

/**
 * Resolve the PUBLIC URL Twilio should POST this message's delivery receipts to, or
 * NULL when no public origin is knowable (Directive #018 R8).
 *
 * This is the send-side twin of the receiver route's `callbackUrl()`, and it MUST
 * resolve to the identical string that route verifies against: Twilio signs the exact
 * URL we hand it here, and the route authenticates that same URL on the way back, so
 * the two share ONE precedence and a mismatch would fail the signature check:
 *   1. `TWILIO_STATUS_CALLBACK_URL` (trimmed) — the authoritative public URL behind a
 *      proxy that rewrites host/proto. When set, send and verify use it verbatim, so
 *      the signature match is guaranteed.
 *   2. else `NEXT_PUBLIC_APP_URL` (trailing slash stripped) + the callback path — which
 *      equals the route's header-reconstructed URL whenever the app's public origin is
 *      the host Twilio reaches (the production case).
 *   3. else NULL — no `statusCallback` is requested; the send still succeeds, we simply
 *      do not ask for receipts (there is no route we could truthfully name).
 *
 * Read from `process.env` at CALL TIME (not the frozen env singleton), the same
 * runtime-toggle convention `verifyTwilioSignature` and the route's `callbackUrl` use,
 * so a deploy can set it and a test can drive it via `vi.stubEnv`.
 */
export function resolveTwilioStatusCallbackUrl(): string | null {
  const configured = process.env.TWILIO_STATUS_CALLBACK_URL?.trim();
  if (configured) return configured;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) return `${appUrl.replace(/\/+$/, "")}${SMS_STATUS_CALLBACK_PATH}`;

  return null;
}

/**
 * Build the exact param object handed to `client.messages.create`. Pure and
 * side-effect-free (no SDK, no I/O) so what we ask Twilio to do is unit-testable
 * without the vendor present — it is the ONE place that decides the send's shape.
 *
 * The `statusCallback` is included ONLY when a public URL is resolvable
 * ({@link resolveTwilioStatusCallbackUrl}); its presence is precisely what makes Twilio
 * POST the asynchronous delivery receipts the R7 receiver ingests (Directive #018 R8),
 * closing the Provider → Delivery Receipt edge. When no public origin is knowable the
 * field is omitted and the send still succeeds — we decline to point Twilio at a URL
 * that cannot receive, rather than fail the send.
 */
export function twilioSendPayload(message: {
  to: string;
  from: string;
  body: string;
}): { to: string; from: string; body: string; statusCallback?: string } {
  const statusCallback = resolveTwilioStatusCallbackUrl();
  return {
    to: message.to,
    from: message.from,
    body: message.body,
    ...(statusCallback ? { statusCallback } : {}),
  };
}

export function createTwilioSmsProvider(): SmsProvider {
  return {
    info: INFO,
    async send(message: SmsMessage): Promise<SmsAcceptance> {
      const accountSid = env.TWILIO_ACCOUNT_SID;
      const authToken = env.TWILIO_AUTH_TOKEN;
      const from = message.from ?? env.TWILIO_SMS_FROM;

      // Defensive: the factory only hands back this provider when the credentials
      // are present, but the seam contract is THROW-on-failure, so a missing
      // credential here becomes a recorded `failed` attempt, never a silent no-op.
      if (!accountSid || !authToken || !from) {
        throw new Error(
          "twilio: missing account SID, auth token, or sender (TWILIO_SMS_FROM)",
        );
      }

      const { default: twilio } = await import("twilio");
      const client = twilio(accountSid, authToken);

      // Build the request through the pure payload builder — it embeds the
      // `statusCallback` (when a public URL is resolvable) that asks Twilio to POST the
      // asynchronous delivery receipts back to the R7 receiver (Directive #018 R8).
      const res = await client.messages.create(
        twilioSendPayload({ to: message.to, from, body: message.body }),
      );

      // The provider must hand back a message sid (the correlation key). Its
      // absence is a degraded acceptance — throw so the service records `failed`.
      if (!res.sid) {
        throw new Error("twilio: send returned no message sid");
      }
      // Surface Twilio's synchronous lifecycle status (e.g. "queued"/"accepted")
      // alongside the sid, so the transport records the provider's outcome at
      // acceptance, correlated by the message id (Directive #018 R6). The terminal
      // delivery receipt arrives asynchronously at the `statusCallback` the payload
      // requested (Directive #018 R8), correlated by this same sid; this send returns
      // only the acceptance.
      return { providerMessageId: res.sid, status: res.status ?? null };
    },
  };
}

// =====================================================================
// ASYNC DELIVERY RECEIPTS (Directive #018 R7). The terminal fate the send above
// deferred arrives later over Twilio's status-callback webhook. These two standalone
// helpers are the Twilio-specific half of ingesting it — request VERIFICATION and
// callback PARSING — kept beside the send adapter (the one place that knows Twilio),
// so the canonical service stays vendor-free. They add NO new outbound door: neither
// constructs a client nor sends anything; the authenticated webhook route calls them
// to authenticate and normalise an inbound receipt, then hands the pure
// `SmsDeliveryReceipt` to the service for correlation.
// =====================================================================

/**
 * Authenticate a Twilio status-callback request — the SAME verification model the
 * Stripe webhook uses (SDK-owned crypto), NOT a weaker bearer. Twilio signs the exact
 * request URL + sorted POST params with the account auth token (HMAC-SHA1, base64) in
 * the `X-Twilio-Signature` header; `twilio.validateRequest` is the reference verifier.
 *
 * The auth token is read from `process.env` at CALL TIME (not the frozen env
 * singleton), the same runtime-toggle convention `isMissedCallTextbackLive` uses, so a
 * deploy can rotate it and a test can drive it via `vi.stubEnv`. A missing token or a
 * missing signature is a hard FALSE — an unauthenticated callback is never trusted.
 * The SDK is loaded LAZILY (dynamic import), exactly as `send` loads it, so it never
 * enters a bundle that does not verify Twilio callbacks.
 */
export async function verifyTwilioSignature(input: {
  signature: string | null | undefined;
  url: string;
  params: Record<string, string>;
}): Promise<boolean> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !input.signature) return false;
  try {
    const { default: twilio } = await import("twilio");
    return twilio.validateRequest(authToken, input.signature, input.url, input.params);
  } catch {
    // A malformed signature (or an SDK crypto error) is an authentication FAILURE,
    // never a pass — degrade closed.
    return false;
  }
}

/**
 * Translate one Twilio SMS status-callback body into the provider-neutral
 * {@link SmsDeliveryReceipt} the service correlates — or NULL when the payload is
 * malformed or carries a status outside the canonical vocabulary (the route answers
 * such a callback with a 4xx rather than recording an unknown status).
 *
 * Twilio posts `MessageSid` + `MessageStatus` (with legacy `SmsSid` / `SmsStatus`
 * aliases), plus `ErrorCode` on a non-delivery. The status is lower-cased and checked
 * against {@link isSmsDeliveryStatus}; `providerStatus` preserves the raw string only
 * when it differed. It NEVER throws — an unusable payload is a null, which the caller
 * turns into a rejection.
 */
export function parseTwilioSmsStatusCallback(
  params: Record<string, string>,
): SmsDeliveryReceipt | null {
  const providerMessageId = firstNonEmpty(params.MessageSid, params.SmsSid);
  const rawStatus = firstNonEmpty(params.MessageStatus, params.SmsStatus);
  if (!providerMessageId || !rawStatus) return null;

  const status = rawStatus.trim().toLowerCase();
  if (!isSmsDeliveryStatus(status)) return null;

  const errorCode = params.ErrorCode?.trim() || null;
  return {
    providerMessageId,
    status,
    providerStatus: rawStatus === status ? null : rawStatus,
    errorCode,
  };
}

/** The first argument that is a non-empty (trimmed) string, else null. */
function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
