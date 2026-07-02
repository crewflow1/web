/**
 * Phase A — AI Receptionist shared types.
 *
 * `InboundChannel` matches the `inbound_enquiries.channel` CHECK.
 * The processor (server-side) ingests a normalised `InboundEnquiry`
 * payload regardless of which adapter (Twilio / WhatsApp Business
 * API / Meta Messenger / manual) produced it.
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
};

export type InboundExtraction = {
  summary: string;
  confidence: number;
  job_type: string | null;
  urgency: InboundUrgency | null;
  postcode: string | null;
  budget_gbp: number | null;
};
