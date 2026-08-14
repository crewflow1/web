import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Provider-agnostic INBOUND EMAIL adapter (P2 Communications).
 *
 * This is the EDGE for email: it verifies the request, then translates a
 * normalised email-delivery payload into the channel-agnostic shape the
 * ALREADY-MERGED ingestion core consumes (processInboundEnquiry →
 * resolveConversation → …). It adds no business logic and no store of its own —
 * it is signature + parse + normalize, nothing more, exactly like the Meta
 * WhatsApp adapter it is modelled on.
 *
 * SECURITY: like the Meta webhook (and unlike the shared-secret
 * /api/receptionist/inbound route), the inbound-email webhook authenticates each
 * request by HMAC-SHA256 over the RAW body against a shared secret
 * (INBOUND_EMAIL_WEBHOOK_SECRET). This is deliberately PROVIDER-AGNOSTIC: any
 * mail provider (Mailgun / Postmark / SendGrid / Resend inbound) — or a thin
 * per-provider adapter in front of it — POSTs the normalised JSON delivery and
 * signs the exact bytes with the shared secret. verifyInboundEmailSignature is
 * fail-closed and reads the secret at call time (a deploy can rotate it; a test
 * drives it via vi.stubEnv). No secret, no signature, a length/format mismatch,
 * or any crypto error is authentication FAILURE — never a pass.
 */

// ---------------------------------------------------------------------------
// Signature verification (the auth boundary)
// ---------------------------------------------------------------------------

/**
 * Verify an `x-crewflow-email-signature: sha256=<hex>` header against an
 * HMAC-SHA256 of the exact raw request body, keyed by INBOUND_EMAIL_WEBHOOK_SECRET.
 *
 * Fail-closed on every unhappy path: missing secret, missing/blank signature,
 * wrong prefix, non-hex, length mismatch, or a crypto throw. Uses timingSafeEqual
 * so a mismatch leaks no timing signal. The caller MUST pass the untouched raw
 * body (the signature is over the bytes, not a re-serialized object).
 */
export function verifyInboundEmailSignature(input: {
  signature: string | null | undefined;
  rawBody: string;
}): boolean {
  const secret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
  if (!secret) return false;
  const sig = input.signature;
  if (!sig || !sig.startsWith("sha256=")) return false;

  const provided = sig.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  try {
    const expected = createHmac("sha256", secret)
      .update(input.rawBody, "utf8")
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    // timingSafeEqual throws on length mismatch — treat as failure, never a pass.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Payload parsing (permissive — tolerate common provider field-name variants)
// ---------------------------------------------------------------------------

/**
 * The canonical inbound-email delivery envelope. Providers name fields
 * differently, so the schema accepts a superset and the normaliser (below)
 * resolves the variants. Every field is optional at the schema level — a missing
 * `from`/`to`/`message_id` is caught downstream as an unusable delivery, not a
 * parse throw (we tolerate the unknown; providers add fields).
 */
const attachmentMetaSchema = z
  .object({
    filename: z.string().optional(),
    name: z.string().optional(),
    content_type: z.string().optional(),
    contentType: z.string().optional(),
    type: z.string().optional(),
    size: z.union([z.number(), z.string()]).optional(),
    length: z.union([z.number(), z.string()]).optional(),
  })
  .partial()
  .passthrough();

const inboundEmailSchema = z
  .object({
    // Sender address variants.
    from: z.string().optional(),
    sender: z.string().optional(),
    // Destination (routing) address variants.
    to: z.string().optional(),
    recipient: z.string().optional(),
    // Subject.
    subject: z.string().optional(),
    // Body variants.
    text: z.string().optional(),
    "body-plain": z.string().optional(),
    html: z.string().optional(),
    "body-html": z.string().optional(),
    // Stable per-message id variants.
    message_id: z.string().optional(),
    messageId: z.string().optional(),
    "Message-Id": z.string().optional(),
    "message-id": z.string().optional(),
    // Provider timestamp variants (ISO string or unix seconds).
    timestamp: z.union([z.string(), z.number()]).optional(),
    date: z.string().optional(),
    // Attachments metadata (v1: metadata only — no bytes fetched/stored).
    attachments: z.array(attachmentMetaSchema).optional(),
  })
  .passthrough();

export type InboundEmailPayload = z.infer<typeof inboundEmailSchema>;

/** Parse the raw body into a permissive inbound-email envelope, or null when unusable. */
export function parseInboundEmailPayload(rawBody: string): InboundEmailPayload | null {
  try {
    const json = JSON.parse(rawBody);
    const parsed = inboundEmailSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalization → the channel-agnostic ingestion shape
// ---------------------------------------------------------------------------

/** Attachment descriptor — metadata only in v1 (bytes are a later, gated ring). */
export type InboundEmailAttachment = {
  filename: string | null;
  content_type: string | null;
  size: number | null;
};

/** A single inbound email, normalized for processInboundEnquiry. */
export type NormalizedInboundEmail = {
  /** The destination address (normalised: trimmed, lowercased, bare addr-spec) — the routing key to an org. */
  to_address: string | null;
  /** The sender address (normalised) — becomes the conversation contact_ref / caller. */
  from_address: string | null;
  /** The provider's stable per-message id (RFC 5322 Message-ID) — the idempotency key. */
  message_id: string | null;
  /** The email subject, if any. */
  subject: string | null;
  /** Human-readable body: the plain text, else stripped HTML, else empty. */
  body_text: string;
  /** Subject + body composed into the single raw_text the extractor reads. */
  raw_text: string;
  /** Provider timestamp (ISO string or unix-seconds string), when present. */
  provider_timestamp: string | null;
  /** Whether the email carried at least one attachment (metadata only in v1). */
  has_attachments: boolean;
  /** Per-attachment metadata descriptors (no bytes). */
  attachments: InboundEmailAttachment[];
};

/**
 * Strip an RFC 5322 address down to its bare addr-spec and normalise it: prefer
 * the `<addr@host>` angle-bracket form when a display name is present, else the
 * whole string, then trim + lowercase. Returns null for an empty/absent value.
 * (Local-part case is technically significant in RFC 5321, but every practical
 * mail system treats it case-insensitively; lowercasing gives a stable routing
 * key and matches the normalisation the routes table stores.)
 */
export function normalizeEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? raw).trim().toLowerCase();
  return addr === "" ? null : addr;
}

/** Best-effort plain text from an HTML body — strip tags + collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function firstString(...vals: (unknown)[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function coerceSize(...vals: (unknown)[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

/**
 * Turn one parsed inbound-email envelope into the normalized shape. Resolves the
 * provider field-name variants, prefers plain text over stripped HTML, composes
 * subject + body into raw_text, and reduces attachments to bytes-free metadata.
 * Never throws — a delivery with no usable id is surfaced (message_id null) so the
 * handler can reject it cleanly rather than ingesting an un-dedupable event.
 */
export function normalizeInboundEmail(
  payload: InboundEmailPayload,
): NormalizedInboundEmail {
  const toAddress = normalizeEmailAddress(firstString(payload.to, payload.recipient));
  const fromAddress = normalizeEmailAddress(firstString(payload.from, payload.sender));
  const messageId = firstString(
    payload.message_id,
    payload.messageId,
    payload["Message-Id"],
    payload["message-id"],
  );
  const subject = firstString(payload.subject);

  const plain = firstString(payload.text, payload["body-plain"]);
  const html = firstString(payload.html, payload["body-html"]);
  const bodyText = plain ?? (html ? htmlToText(html) : "");

  const attachmentsRaw = payload.attachments ?? [];
  const attachments: InboundEmailAttachment[] = attachmentsRaw.map((a) => ({
    filename: firstString(a.filename, a.name),
    content_type: firstString(a.content_type, a.contentType, a.type),
    size: coerceSize(a.size, a.length),
  }));

  // Subject + body → the single raw_text the extractor reads. Bounded like the
  // other channels (20k) so a giant email can't bloat the enquiry row.
  const composed = [subject ? `Subject: ${subject}` : null, bodyText]
    .filter((s): s is string => s !== null && s !== "")
    .join("\n\n");

  const providerTimestamp = firstString(
    typeof payload.timestamp === "number" ? String(payload.timestamp) : payload.timestamp,
    payload.date,
  );

  return {
    to_address: toAddress,
    from_address: fromAddress,
    message_id: messageId,
    subject,
    body_text: bodyText.slice(0, 20_000),
    raw_text: composed.slice(0, 20_000),
    provider_timestamp: providerTimestamp,
    has_attachments: attachments.length > 0,
    attachments,
  };
}
