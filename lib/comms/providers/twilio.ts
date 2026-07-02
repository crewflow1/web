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

      const res = await client.messages.create({
        to: message.to,
        from,
        body: message.body,
      });

      // The provider must hand back a message sid (the correlation key). Its
      // absence is a degraded acceptance — throw so the service records `failed`.
      if (!res.sid) {
        throw new Error("twilio: send returned no message sid");
      }
      // Surface Twilio's synchronous lifecycle status (e.g. "queued"/"accepted")
      // alongside the sid, so the transport records the provider's outcome at
      // acceptance, correlated by the message id (Directive #018 R6). The terminal
      // delivery receipt arrives asynchronously and is out of this send's scope.
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
