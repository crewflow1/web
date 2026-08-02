import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Voice Telephony (Wave 8) — the Vapi inbound-voice provider.
 *
 * Vapi delivers JSON server messages and (when a secret is configured) signs the
 * RAW body with an HMAC-SHA256 the receiver recomputes. `verifyVapiSignature`
 * reads VAPI_WEBHOOK_SECRET AT CALL TIME (never the frozen env singleton), fails
 * closed on a missing secret / missing signature / any crypto error, and
 * compares in constant time. `parseVapiWebhook` is pure and never throws.
 *
 * No SDK is imported — verification is stdlib crypto, parsing is JSON.
 */

import {
  isCallEventType,
  type CallEventType,
  type NormalizedInboundCall,
  type VoiceProvider,
} from "../types";

/**
 * Verify a Vapi webhook: HMAC-SHA256 of the raw body under VAPI_WEBHOOK_SECRET,
 * compared to the signature header in constant time. Fails closed on ANY doubt.
 */
export function verifyVapiSignature(input: {
  signature: string | null | undefined;
  rawBody: string;
}): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret || !input.signature) return false;
  try {
    const expected = createHmac("sha256", secret).update(input.rawBody, "utf8").digest("hex");
    // Accept a bare hex digest or a `sha256=<hex>` form.
    const provided = input.signature.trim().replace(/^sha256=/i, "");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Map Vapi's status vocabulary onto the neutral event types. */
export function mapVapiStatus(
  rawStatus: string | undefined | null,
  endedReason?: string | undefined | null,
): CallEventType | null {
  const s = (rawStatus ?? "").trim().toLowerCase();
  switch (s) {
    case "queued":
    case "ringing":
      return "ringing";
    case "in-progress":
    case "in_progress":
      return "in_progress";
    case "forwarding":
    case "transferred":
      return "transferred";
    case "ended": {
      const r = (endedReason ?? "").toLowerCase();
      if (r.includes("no-answer") || r.includes("no_answer")) return "no_answer";
      if (r.includes("busy")) return "busy";
      if (r.includes("failed") || r.includes("error")) return "failed";
      if (r.includes("cancel")) return "canceled";
      return "completed";
    }
    default:
      return isCallEventType(s) ? s : null;
  }
}

type VapiBody = {
  message?: {
    type?: string;
    status?: string;
    endedReason?: string;
    timestamp?: string | number;
    call?: {
      id?: string;
      customer?: { number?: string };
      phoneNumber?: { number?: string };
    };
    phoneNumber?: { number?: string };
    customer?: { number?: string };
  };
};

/** Parse a VERIFIED Vapi webhook body into the neutral shape, or null. */
export function parseVapiWebhook(input: {
  rawBody: string;
  params: Record<string, string>;
}): NormalizedInboundCall | null {
  let body: VapiBody;
  try {
    body = JSON.parse(input.rawBody) as VapiBody;
  } catch {
    return null;
  }
  const msg = body?.message;
  if (!msg) return null;

  const call = msg.call;
  const providerCallId = call?.id?.trim();
  if (!providerCallId) return null;

  const status = mapVapiStatus(msg.status, msg.endedReason);
  if (!status) return null;

  // Caller: the customer's number. Dialed: the Vapi phone number reached.
  const from = (call?.customer?.number ?? msg.customer?.number ?? "").trim() || null;
  const to =
    (call?.phoneNumber?.number ?? msg.phoneNumber?.number ?? "").trim() || null;

  const occurredAt = (() => {
    const t = msg.timestamp;
    if (typeof t === "number") return new Date(t).toISOString();
    if (typeof t === "string" && t.trim()) {
      const parsed = Date.parse(t);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
    return new Date().toISOString();
  })();

  return {
    provider: "vapi",
    providerCallId,
    from,
    to,
    status,
    // One audit row per (call, status) — the natural idempotency key, since Vapi
    // redelivers the same status-update rather than carrying a per-event id.
    providerEventId: status,
    occurredAt,
    raw: (body as Record<string, unknown>) ?? {},
  };
}

export function createVapiVoiceProvider(): VoiceProvider {
  return {
    id: "vapi",
    verify: async (input) =>
      verifyVapiSignature({ signature: input.signature, rawBody: input.rawBody }),
    parse: (input) => parseVapiWebhook(input),
  };
}
