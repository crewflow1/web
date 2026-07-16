import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SmsDeliveryReceipt } from "../types";
import { isSmsDeliveryStatus } from "../types";

/**
 * Meta WhatsApp Business (Cloud API) inbound adapter.
 *
 * This is the EDGE for WhatsApp: it verifies Meta's request, then translates the
 * Meta webhook envelope into the channel-agnostic shape the ALREADY-MERGED
 * ingestion core consumes (processInboundEnquiry → resolveConversation → …).
 * It adds no business logic and no store of its own — it is signature + parse +
 * normalize, nothing more.
 *
 * SECURITY: unlike the shared-secret /api/receptionist/inbound route, the Meta
 * webhook authenticates each request by HMAC-SHA256 over the RAW body against the
 * app secret. verifyMetaSignature is fail-closed and reads the secret at call
 * time (a deploy can rotate it; a test drives it via vi.stubEnv), mirroring
 * verifyTwilioSignature. No secret, no signature, a length/format mismatch, or
 * any crypto error is authentication FAILURE — never a pass.
 */

// ---------------------------------------------------------------------------
// Signature verification (the auth boundary)
// ---------------------------------------------------------------------------

/**
 * Verify Meta's `X-Hub-Signature-256: sha256=<hex>` header against an HMAC-SHA256
 * of the exact raw request body, keyed by WHATSAPP_APP_SECRET.
 *
 * Fail-closed on every unhappy path: missing secret, missing/blank signature,
 * wrong prefix, non-hex, length mismatch, or a crypto throw. Uses timingSafeEqual
 * so a mismatch leaks no timing signal. The caller MUST pass the untouched raw
 * body (Meta signs the bytes, not a re-serialized object).
 */
export function verifyMetaSignature(input: {
  signature: string | null | undefined;
  rawBody: string;
}): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
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
// Payload parsing (permissive — Meta adds fields; we tolerate the unknown)
// ---------------------------------------------------------------------------

const metaEnvelopeSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z
          .array(
            z.object({
              field: z.string().optional(),
              value: z
                .object({
                  messaging_product: z.string().optional(),
                  metadata: z
                    .object({
                      display_phone_number: z.string().optional(),
                      phone_number_id: z.string().optional(),
                    })
                    .partial()
                    .optional(),
                  contacts: z
                    .array(
                      z.object({
                        wa_id: z.string().optional(),
                        profile: z.object({ name: z.string().optional() }).partial().optional(),
                      }),
                    )
                    .optional(),
                  messages: z.array(z.record(z.unknown())).optional(),
                  statuses: z.array(z.record(z.unknown())).optional(),
                })
                .partial()
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export type MetaWebhookEnvelope = z.infer<typeof metaEnvelopeSchema>;

/** Parse the raw body into a permissive Meta envelope, or null when unusable. */
export function parseMetaWebhookPayload(rawBody: string): MetaWebhookEnvelope | null {
  try {
    const json = JSON.parse(rawBody);
    const parsed = metaEnvelopeSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalization → the channel-agnostic ingestion shape
// ---------------------------------------------------------------------------

/** A single inbound WhatsApp message, normalized for processInboundEnquiry. */
export type NormalizedWhatsAppMessage = {
  /** Meta's phone_number_id — the routing key to an org. */
  phone_number_id: string | null;
  /** Meta message id (wamid.*) — the idempotency key. */
  wamid: string;
  /** Sender wa_id — becomes the conversation contact_ref. */
  caller: string | null;
  /** Sender display name (pushname), when present. */
  contact_name: string | null;
  /** Human-readable text: body / caption / interactive title, or a media placeholder. */
  raw_text: string;
  /** Meta message type (text/image/document/audio/video/location/contacts/…). */
  message_type: string;
  /** Whether the message carried media (an id we could later fetch). */
  has_media: boolean;
  /** Provider timestamp (unix seconds as string), when present. */
  provider_timestamp: string | null;
};

/** A single WhatsApp status transition, normalized. */
export type NormalizedWhatsAppStatus = {
  phone_number_id: string | null;
  wamid: string;
  status: string;
  receipt: SmsDeliveryReceipt | null;
};

const MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker", "voice"]);

/**
 * Turn one raw Meta message object into a normalized message. Text-bearing types
 * yield their text; media yields a deterministic placeholder + descriptor so the
 * lead still gets a summary with ZERO media dependency (media bytes are a later,
 * gated ring). Returns null when the object has no usable id.
 */
function normalizeOneMessage(
  msg: Record<string, unknown>,
  phoneNumberId: string | null,
  contactName: string | null,
): NormalizedWhatsAppMessage | null {
  const wamid = typeof msg.id === "string" ? msg.id : null;
  if (!wamid) return null;
  const type = typeof msg.type === "string" ? msg.type : "unknown";
  const from = typeof msg.from === "string" ? msg.from : null;
  const ts = typeof msg.timestamp === "string" ? msg.timestamp : null;

  let text = "";
  let hasMedia = false;
  if (type === "text" && isRecord(msg.text) && typeof msg.text.body === "string") {
    text = msg.text.body;
  } else if (isRecord(msg.interactive)) {
    text = readInteractiveTitle(msg.interactive) ?? "[interactive reply]";
  } else if (isRecord(msg.button) && typeof msg.button.text === "string") {
    text = msg.button.text;
  } else if (type === "location" && isRecord(msg.location)) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    text = `[location: ${String(lat)},${String(lng)}]`;
  } else if (type === "contacts") {
    text = "[contact card]";
  } else if (MEDIA_TYPES.has(type)) {
    hasMedia = true;
    const caption = readMediaCaption(msg[type]);
    text = caption ? `[${type}] ${caption}` : `[${type}]`;
  } else {
    text = `[${type} message]`;
  }

  return {
    phone_number_id: phoneNumberId,
    wamid,
    caller: from,
    contact_name: contactName,
    raw_text: text.slice(0, 20_000),
    message_type: type,
    has_media: hasMedia,
    provider_timestamp: ts,
  };
}

/**
 * Extract every inbound message from a Meta envelope, each carrying its
 * phone_number_id (from the enclosing change metadata) for routing.
 */
export function normalizeMetaMessages(
  env: MetaWebhookEnvelope,
): NormalizedWhatsAppMessage[] {
  const out: NormalizedWhatsAppMessage[] = [];
  for (const entry of env.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      // The first contact's pushname is the sender's display name.
      const contactName = value.contacts?.[0]?.profile?.name ?? null;
      for (const msg of value.messages ?? []) {
        const n = normalizeOneMessage(msg, phoneNumberId, contactName);
        if (n) out.push(n);
      }
    }
  }
  return out;
}

/** Extract every delivery/read status transition from a Meta envelope. */
export function normalizeMetaStatuses(
  env: MetaWebhookEnvelope,
): NormalizedWhatsAppStatus[] {
  const out: NormalizedWhatsAppStatus[] = [];
  for (const entry of env.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      for (const st of value.statuses ?? []) {
        const wamid = typeof st.id === "string" ? st.id : null;
        const status = typeof st.status === "string" ? st.status : null;
        if (!wamid || !status) continue;
        out.push({
          phone_number_id: phoneNumberId,
          wamid,
          status,
          receipt: parseMetaWhatsAppStatus(st),
        });
      }
    }
  }
  return out;
}

/**
 * Translate one WhatsApp status object into the provider-neutral
 * {@link SmsDeliveryReceipt} the existing receipt ledger correlates by
 * providerMessageId — or null when the status has no delivery-ledger equivalent
 * (WhatsApp 'read' has no SMS analogue; it is dropped, not recorded as unknown).
 */
export function parseMetaWhatsAppStatus(
  st: Record<string, unknown>,
): SmsDeliveryReceipt | null {
  const id = typeof st.id === "string" ? st.id : null;
  const raw = typeof st.status === "string" ? st.status.toLowerCase() : null;
  if (!id || !raw) return null;
  // WhatsApp: sent | delivered | read | failed → the SMS vocabulary (read → drop).
  const mapped = raw === "read" ? null : raw;
  if (!mapped || !isSmsDeliveryStatus(mapped)) return null;
  const errors = st.errors;
  const errorCode =
    Array.isArray(errors) && isRecord(errors[0]) && errors[0].code != null
      ? String(errors[0].code)
      : null;
  return {
    providerMessageId: id,
    status: mapped,
    providerStatus: mapped !== raw ? raw : null,
    errorCode,
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readInteractiveTitle(interactive: Record<string, unknown>): string | null {
  const br = interactive.button_reply;
  if (isRecord(br) && typeof br.title === "string") return br.title;
  const lr = interactive.list_reply;
  if (isRecord(lr) && typeof lr.title === "string") return lr.title;
  return null;
}

function readMediaCaption(media: unknown): string | null {
  if (isRecord(media) && typeof media.caption === "string") return media.caption;
  return null;
}
