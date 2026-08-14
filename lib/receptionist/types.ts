/**
 * Phase A — AI Receptionist shared types.
 *
 * `InboundChannel` matches the `inbound_enquiries.channel` CHECK.
 * The processor (server-side) ingests a normalised `InboundEnquiry`
 * payload regardless of which adapter (Twilio / WhatsApp Business
 * API / Meta Messenger / inbound email / manual) produced it.
 *
 * AI is read-only. Per Phase 5 safety contract: AI summarises +
 * classifies + creates a lead; it NEVER books, schedules, prices,
 * or commits work.
 */

export const INBOUND_CHANNELS = [
  "phone",
  "sms",
  "whatsapp_msg",
  "whatsapp_call",
  "instagram_dm",
  "facebook_dm",
  "email",
  "manual",
] as const;
export type InboundChannel = (typeof INBOUND_CHANNELS)[number];

export const INBOUND_URGENCY = ["low", "medium", "high", "urgent"] as const;
export type InboundUrgency = (typeof INBOUND_URGENCY)[number];

export const INBOUND_STATUSES = [
  "received",
  "processed",
  "qualified",
  "ignored",
  "failed",
] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];

/**
 * The Voice Receptionist AI's canonical employee slug — the identity seeded in the
 * Capability Registry (migration 20260814000000_voice_receptionist_ai_employee.sql)
 * and stamped onto every reply audit record so the ledger names the AI employee it
 * concerns. Kept here, beside the receptionist's shared vocabulary, as the single
 * TypeScript source of truth for the slug.
 */
export const RECEPTIONIST_EMPLOYEE_SLUG = "voice-receptionist-ai";

export type InboundEnquiryInput = {
  org_id: string;
  channel: InboundChannel;
  /** Free-form transcript / message body. Required when AI summary
   *  is expected; for `whatsapp_call` the audio transcript should
   *  be transcribed by the adapter before reaching this layer. */
  raw_text?: string | null;
  /** Caller identifier — phone number, Instagram handle, etc. */
  caller?: string | null;
  /**
   * A STABLE per-inbound-event id supplied by the channel adapter (e.g. Twilio's
   * `CallSid`). Threaded to the missed-call text-back's idempotency key (Directive
   * #018 R6), so repeated webhook deliveries of the SAME missed call cannot send a
   * second customer message. Absent ⇒ dedup falls back to the freshly-minted enquiry
   * id, which still bounds a single ingestion but cannot correlate replays. Read-only
   * ingestion behaviour is otherwise unchanged.
   */
  dedup_key?: string | null;
  /**
   * The channel provider's stable per-MESSAGE id (Meta wamid / Twilio SID), persisted on
   * the enquiry (Part 11). The downstream idempotency backstop: the partial unique index
   * `(org_id, provider_message_id)` makes a second ingestion of the same provider message a
   * no-op (the handler short-circuits on the 23505). Distinct from `dedup_key`, which is the
   * OUTBOUND-send idempotency key; this is the INBOUND-message identity. Absent for channels
   * that carry no provider message id (phone), leaving the column NULL and unconstrained.
   */
  provider_message_id?: string | null;
  /** The provider's timestamp for the inbound message (WhatsApp), when supplied. */
  provider_timestamp?: string | null;
  /** True when the inbound message carried media (image/document/audio) — metadata only in v1. */
  has_media?: boolean;
};

export type InboundExtraction = {
  summary: string;
  confidence: number;
  job_type: string | null;
  urgency: InboundUrgency | null;
  postcode: string | null;
  budget_gbp: number | null;
};
