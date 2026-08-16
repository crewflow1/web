import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Resend delivery-EVENTS adapter (MP Wave R4 · Communications audit).
 *
 * The EDGE for outbound delivery telemetry: Resend POSTs a signed webhook for
 * each lifecycle event of a sent email (delivered / opened / clicked / bounced /
 * complained / delivery_delayed). This module is signature + parse + normalize,
 * nothing more — it adds no business logic and no store of its own, exactly like
 * the inbound-email and Meta-WhatsApp adapters it sits beside.
 *
 * SECURITY — Resend signs webhooks with the SVIX scheme (the same one Resend's
 * own SDK verifies): three headers (`svix-id`, `svix-timestamp`, `svix-signature`)
 * and an HMAC-SHA256, keyed by the endpoint secret (`whsec_<base64>`), over the
 * signed content `"<id>.<timestamp>.<rawBody>"`, base64-encoded. The
 * `svix-signature` header is a space-separated list of `v1,<base64>` tokens (a
 * secret rotation ships two). Verification is FAIL-CLOSED on every unhappy path:
 * missing secret/headers, a stale timestamp (replay), a non-base64 signature, a
 * length mismatch, or any crypto throw is authentication FAILURE — never a pass.
 * The secret is read at call time so a deploy can rotate it and a test can drive
 * it via vi.stubEnv.
 */

// ---------------------------------------------------------------------------
// Signature verification (the auth boundary)
// ---------------------------------------------------------------------------

/** Reject a delivery whose signed timestamp is older/newer than this — replay guard. */
export const RESEND_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type ResendSignatureHeaders = {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
};

/**
 * Verify a Resend/Svix webhook signature against the exact raw body. Returns
 * true only when a `v1` signature in the header matches the HMAC of
 * `"<id>.<timestamp>.<rawBody>"` under the endpoint secret AND the timestamp is
 * within tolerance. The caller MUST pass the untouched raw body — the signature
 * is over the bytes, not a re-serialized object.
 */
export function verifyResendSignature(input: {
  headers: ResendSignatureHeaders;
  rawBody: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const rawSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!rawSecret) return false;

  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature) return false;

  // Replay guard — the timestamp is part of the signed material, so a stale
  // (or absurdly future) delivery is refused before any HMAC work.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? RESEND_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) return false;

  // The endpoint secret is `whsec_<base64>`; the HMAC key is the DECODED base64.
  const secretB64 = rawSecret.startsWith("whsec_") ? rawSecret.slice("whsec_".length) : rawSecret;
  let key: Buffer;
  try {
    key = Buffer.from(secretB64, "base64");
    if (key.length === 0) return false;
  } catch {
    return false;
  }

  let expected: Buffer;
  try {
    const signedContent = `${id}.${timestamp}.${input.rawBody}`;
    const digestB64 = createHmac("sha256", key).update(signedContent, "utf8").digest("base64");
    expected = Buffer.from(digestB64, "base64");
  } catch {
    return false;
  }

  // The header carries one or more space-separated `v1,<base64>` tokens. Any
  // match (constant-time) is a pass — a rotation legitimately ships two.
  for (const token of signature.split(" ")) {
    const [version, value] = token.split(",", 2);
    if (version !== "v1" || !value) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (provided.length !== expected.length) continue;
    try {
      if (timingSafeEqual(provided, expected)) return true;
    } catch {
      // length mismatch already handled; any throw is a non-match, keep scanning.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Payload parsing + normalization
// ---------------------------------------------------------------------------

/**
 * The canonical Resend webhook envelope. Resend nests the email under `data`
 * with an `email_id`; `to` is an array. Everything is optional at the schema
 * level so a shape drift is caught downstream as unusable, not a parse throw.
 */
const resendEventSchema = z
  .object({
    type: z.string().optional(),
    created_at: z.string().optional(),
    data: z
      .object({
        email_id: z.string().optional(),
        id: z.string().optional(),
        to: z.union([z.array(z.string()), z.string()]).optional(),
        from: z.string().optional(),
        subject: z.string().optional(),
        // click events carry a `click` sub-object with the link.
        click: z.record(z.string(), z.unknown()).optional(),
        // bounce events carry a `bounce` sub-object.
        bounce: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ResendEventPayload = z.infer<typeof resendEventSchema>;

/** Parse the raw body into a permissive Resend envelope, or null when unusable. */
export function parseResendEventPayload(rawBody: string): ResendEventPayload | null {
  try {
    const json = JSON.parse(rawBody);
    const parsed = resendEventSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The known Resend event types the audit read model interprets. */
export const RESEND_EVENT_TYPES = [
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "delivery_delayed",
  "sent",
] as const;

/** A single Resend delivery event, normalized for the comm_events ledger. */
export type NormalizedResendEvent = {
  /** The provider's message id (`data.email_id`) — the join key to messages.provider_id. */
  provider_message_id: string | null;
  /** The normalized event type without the `email.` prefix (delivered/opened/…). */
  event_type: string;
  /** The recipient address, if present. */
  recipient: string | null;
  /** The provider's event timestamp (ISO), else null (the handler falls back to now()). */
  occurred_at: string | null;
};

function firstRecipient(to: string[] | string | undefined): string | null {
  if (!to) return null;
  if (Array.isArray(to)) return to.length > 0 ? String(to[0]) : null;
  return String(to);
}

/**
 * Normalize one Resend envelope. Strips the `email.` prefix from the type
 * (`email.opened` -> `opened`), resolves the message id and first recipient.
 * Never throws — a payload with no email id / type is surfaced (nulls/empty) so
 * the handler rejects it cleanly rather than ingesting an unusable event.
 */
export function normalizeResendEvent(payload: ResendEventPayload): NormalizedResendEvent {
  const rawType = typeof payload.type === "string" ? payload.type : "";
  const eventType = rawType.startsWith("email.") ? rawType.slice("email.".length) : rawType;
  const data = payload.data ?? {};
  return {
    provider_message_id: data.email_id ?? data.id ?? null,
    event_type: eventType,
    recipient: firstRecipient(data.to),
    occurred_at: typeof payload.created_at === "string" ? payload.created_at : null,
  };
}
