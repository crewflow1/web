/**
 * Voice Telephony (Wave 8) — shared, vendor-neutral types.
 *
 * The webhook routes normalise each provider's raw payload into these shapes
 * before anything touches the database, so the service and state machine never
 * see a Twilio- or Vapi-specific field. Mirrors the receptionist's channel-
 * agnostic ingestion contract (lib/receptionist/types.ts).
 */

/** The telephony providers this build knows how to route. */
export const VOICE_PROVIDERS = ["twilio", "vapi"] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number];

/** Call direction. Wave 8 ingests INBOUND only; outbound stays a future seam. */
export const CALL_DIRECTIONS = ["inbound", "outbound"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/**
 * The call-lifecycle vocabulary — identical to the `call_events.event_type`
 * CHECK in migration 20261098000000. Kept here as the single TypeScript source
 * of truth so a source drift from the DB CHECK is a compile error, and the
 * security suite pins the two lists agree.
 */
export const CALL_EVENT_TYPES = [
  "initiated",
  "ringing",
  "answered",
  "in_progress",
  "transferred",
  "completed",
  "no_answer",
  "busy",
  "failed",
  "canceled",
] as const;
export type CallEventType = (typeof CALL_EVENT_TYPES)[number];

/** The terminal states — a call that reached one is over and advances no further. */
export const TERMINAL_CALL_EVENTS = [
  "completed",
  "no_answer",
  "busy",
  "failed",
  "canceled",
] as const satisfies readonly CallEventType[];

export function isCallEventType(v: unknown): v is CallEventType {
  return typeof v === "string" && (CALL_EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * One inbound call event, normalised out of a provider webhook. `providerCallId`
 * is the correlation key across an entire call's events (Twilio CallSid / Vapi
 * call id); `providerEventId` disambiguates one event within that call for
 * idempotent redelivery. `raw` preserves the original payload for the audit row.
 */
export type NormalizedInboundCall = {
  provider: VoiceProviderId;
  /** Correlation key for the whole call (Twilio CallSid / Vapi call id). */
  providerCallId: string;
  /** The CALLER's number (E.164), when the provider supplied it. */
  from: string | null;
  /** The DIALED number (E.164) — the routing key an org is resolved from. */
  to: string | null;
  /** The lifecycle transition this event represents. */
  status: CallEventType;
  /** The provider's own id for THIS event, for idempotent redelivery. Nullable. */
  providerEventId: string | null;
  /** When the provider says the event occurred. Falls back to receipt time. */
  occurredAt: string;
  /** The untouched provider payload, persisted on the audit row. */
  raw: Record<string, unknown>;
};

/**
 * The provider seam. A concrete provider VERIFIES an inbound request against its
 * own signature scheme (fail-closed) and PARSES a verified body into the neutral
 * shape above. It constructs no SDK at module scope and reads its credential at
 * call time, so an unconfigured build imports it harmlessly.
 */
export type VoiceProvider = {
  readonly id: VoiceProviderId;
  /** Fail-closed signature check over the RAW body. False on any doubt. */
  verify(input: {
    signature: string | null | undefined;
    url: string;
    rawBody: string;
    params: Record<string, string>;
    /**
     * Vapi's shared-secret header (`X-Vapi-Secret`) — the PRIMARY Vapi scheme.
     * Ignored by providers that verify a different way (e.g. Twilio's URL+params
     * signature). Optional so the shared seam stays vendor-neutral.
     */
    secret?: string | null;
    /** The `Authorization` header (`Bearer <secret>`) — an accepted Vapi alias. */
    authorization?: string | null;
  }): Promise<boolean>;
  /** Normalise a VERIFIED webhook body, or null when it is unusable. */
  parse(input: {
    rawBody: string;
    params: Record<string, string>;
  }): NormalizedInboundCall | null;
};
