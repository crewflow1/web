/**
 * CrewFlow HQ — Communication Layer: the provider seam (types).
 *
 * CEO Directive 010, Phase 4. The shared DELIVERY substrate every AI employee
 * inherits (docs/bible/decisions/0003-communication-layer.md). This module is the
 * pure data contract — NO `server-only`, NO I/O, NO vendor SDK — so the state
 * machine, the policy helpers, the service, and the tests share ONE vocabulary and
 * depend on the INTERFACE, never a vendor. It mirrors `lib/ai/text/types.ts`'s
 * role: the seam that makes "every provider replaceable" (a CEO success criterion)
 * true in code, not in convention.
 *
 * Two seams carry the "plug-in, never a dependency" rule, identical to the text and
 * embedding seams:
 *   - `getEmailProvider()` (in ./index) returns `null` when nothing is configured —
 *     `deliverDraft` then records a terminal `failed`/no_provider attempt and sends
 *     NOTHING. That null is the whole graceful-degradation contract, and the path CI
 *     exercises (CI sets no provider key).
 *   - `provider.send()` THROWS on a provider failure (network, auth, rate-limit) so
 *     the service records a `failed` attempt and owns retry. It never half-succeeds:
 *     either the provider accepted the message (resolve) or it did not (throw).
 *
 * A message is only ever delivered when an Approval Engine row is `approved`. This
 * module knows nothing of that gate — it is enforced in SQL and mirrored in the
 * service. Here is purely the shape of "hand an accepted message to a provider".
 */

// ---------------------------------------------------------------------
// Channels. V1 ships email; SMS/voice slot into this union later, reusing the
// same artifact, state machine, and audit — one layer, many channels.
// ---------------------------------------------------------------------

export const COMM_CHANNELS = ["email"] as const;
export type CommChannel = (typeof COMM_CHANNELS)[number];

/** The stable identity of a delivery provider+channel. Recorded per attempt for observability. */
export type CommProviderInfo = {
  /** Vendor id, lowercase. e.g. "resend". */
  provider: string;
  /** The channel this provider carries. */
  channel: CommChannel;
};

/**
 * One outbound message, already assembled from an APPROVED draft. Pure data — the
 * provider turns this into a vendor API call. `html` is the rendered body; `text`
 * is the plaintext alternative; `from`/`replyTo` are optional per-send overrides.
 */
export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
};

/**
 * The provider ACCEPTED the message for delivery. This is acceptance, NOT delivery
 * — the recipient's server has not yet confirmed receipt. The asynchronous outcome
 * (delivered / bounced / complained) arrives later via `recordDeliveryEvent`. The
 * `providerMessageId` is the correlation key that ties that later webhook back to
 * the row.
 */
export type EmailAcceptance = {
  /** The provider's id for this message — the correlation key for delivery events. */
  providerMessageId: string;
};

/**
 * The one interface the Communication Layer knows. Implementations live behind the
 * config-driven factory (./index); the service never imports a vendor SDK directly,
 * so swapping Resend for another vendor is configuration + a sibling file, never a
 * change to the service.
 */
export interface EmailProvider {
  /** Identity of what this provider sends — drives the per-attempt metadata. */
  readonly info: CommProviderInfo;
  /**
   * Hand one assembled message to the provider. Resolves with the provider's
   * acceptance (a message id), or THROWS on any provider failure (network, auth,
   * rate-limit, rejection) so the service records a `failed` attempt and owns retry.
   */
  send(message: EmailMessage): Promise<EmailAcceptance>;
}

// ---------------------------------------------------------------------
// SMS (Directive #018 R5 — the FIRST outbound transport). The receptionist's
// missed-call text-back rides this seam. It mirrors the email shapes exactly — a
// provider+channel identity, one assembled message, an acceptance carrying the
// provider's correlation id, and the one `send`-or-throw interface — so the
// canonical service depends on the INTERFACE, never on Twilio. Kept as a SEPARATE
// `channel: "sms"`-literal family rather than widening COMM_CHANNELS, because that
// email channel union is welded to the hq_communications delivery state machine
// (approval-gated, email-only CHECK); the receptionist transport is its own
// append-only ledger (ai_reply_transports) and must not perturb that contract.
// ---------------------------------------------------------------------

/** The stable identity of an SMS provider. Recorded per attempt for observability. */
export type SmsProviderInfo = {
  /** Vendor id, lowercase. e.g. "twilio". */
  provider: string;
  /** Always "sms" — the literal that keeps this family distinct from email. */
  channel: "sms";
};

/**
 * One outbound SMS, already assembled from an ENFORCED, auto-sendable reply. Pure
 * data — the provider turns this into a vendor API call. `to` is the E.164
 * destination; `body` is the message text; `from` is an optional per-send sender
 * override (the provider defaults it to TWILIO_SMS_FROM).
 */
export type SmsMessage = {
  to: string;
  body: string;
  from?: string;
};

/**
 * The provider ACCEPTED the SMS for delivery — acceptance, NOT receipt. The
 * `providerMessageId` is the correlation key a later delivery receipt would carry
 * back. Mirrors `EmailAcceptance`, plus the synchronous lifecycle `status` the
 * provider returns AT acceptance (Twilio: "queued" / "accepted" / "sending"), which
 * the transport records against the message id (Directive #018 R6, "record provider
 * outcomes where supported"). The ASYNCHRONOUS terminal receipt (delivered / failed /
 * undelivered) arrives later via the status-callback webhook the R7 receiver route
 * ingests — which the R8 send asks Twilio to POST by setting a `statusCallback` on the
 * request; this optional field carries only what the send call resolves with,
 * correlated by `providerMessageId`.
 */
export type SmsAcceptance = {
  /** The provider's id for this message — the correlation key for delivery events. */
  providerMessageId: string;
  /** The provider's synchronous lifecycle status at acceptance, when it reports one. */
  status?: string | null;
};

/**
 * The one interface the SMS transport knows. The implementation lives behind the
 * config-driven factory (./index `getSmsProvider`); the service never imports a
 * vendor SDK directly, so swapping Twilio for another vendor is configuration + a
 * sibling file, never a change to the service.
 */
export interface SmsProvider {
  /** Identity of what this provider sends — drives the per-attempt metadata. */
  readonly info: SmsProviderInfo;
  /**
   * Hand one assembled SMS to the provider. Resolves with the provider's
   * acceptance (a message id), or THROWS on any provider failure (network, auth,
   * rate-limit, rejection) so the service records a `failed` attempt and owns retry.
   */
  send(message: SmsMessage): Promise<SmsAcceptance>;
}

// ---------------------------------------------------------------------
// WhatsApp (Directive #018 R6 — the SECOND outbound transport). The receptionist's
// WhatsApp reply rides this seam, mirroring the SMS family EXACTLY — a
// provider+channel identity, one assembled message, an acceptance carrying the
// provider's correlation id (Meta's `wamid`), and the one `send`-or-throw interface
// — so the canonical transport depends on the INTERFACE, never on Meta. Kept as a
// SEPARATE `channel: "whatsapp"`-literal family (not a widening of the SMS family)
// so the two channels can NEVER be confused at the type level: a `WhatsAppProvider`
// is not assignable where an `SmsProvider` is expected, which is the type-system half
// of the "WhatsApp never falls back to SMS" guarantee.
//
// DARK in this ring: `getWhatsAppProvider()` (in ./index) returns `null` — no Meta
// sender is wired yet — so the transport records a terminal `failed`/no_provider
// attempt on `channel='whatsapp'` and SENDS NOTHING. This is the interface + the
// mocked-contract the outbound ring (a real Meta Cloud API sender) implements.
// ---------------------------------------------------------------------

/** The stable identity of a WhatsApp provider. Recorded per attempt for observability. */
export type WhatsAppProviderInfo = {
  /** Vendor id, lowercase. e.g. "meta". */
  provider: string;
  /** Always "whatsapp" — the literal that keeps this family distinct from SMS. */
  channel: "whatsapp";
};

/**
 * One outbound WhatsApp message, already assembled from an ENFORCED, auto-sendable
 * (or human-approved) reply. Pure data — the provider turns this into a Graph API
 * call. `to` is the recipient (E.164 or wa_id form; the adapter normalises); `body`
 * is the message text; `from` is an optional per-send sender override (the provider
 * defaults it to the configured business phone number id).
 */
export type WhatsAppMessage = {
  to: string;
  body: string;
  from?: string;
};

/**
 * The provider ACCEPTED the WhatsApp message for delivery — acceptance, NOT receipt.
 * The `providerMessageId` is Meta's `wamid`, the correlation key a later delivery/read
 * receipt carries back. Mirrors {@link SmsAcceptance}, including the synchronous
 * `status` a provider may report at acceptance.
 */
export type WhatsAppAcceptance = {
  /** The provider's id for this message (Meta `wamid`) — the correlation key for receipts. */
  providerMessageId: string;
  /** The provider's synchronous lifecycle status at acceptance, when it reports one. */
  status?: string | null;
};

/**
 * The one interface the WhatsApp transport knows. The implementation lives behind the
 * config-driven factory (./index `getWhatsAppProvider`); the transport never imports a
 * vendor SDK directly, so wiring the real Meta Cloud API sender is configuration + a
 * sibling file, never a change to the transport.
 */
export interface WhatsAppProvider {
  /** Identity of what this provider sends — drives the per-attempt metadata. */
  readonly info: WhatsAppProviderInfo;
  /**
   * Hand one assembled WhatsApp message to the provider. Resolves with the provider's
   * acceptance (a `wamid`), or THROWS on any provider failure so the transport records
   * a `failed` attempt and owns retry.
   */
  send(message: WhatsAppMessage): Promise<WhatsAppAcceptance>;
}

/**
 * The structural union of every outbound messaging provider the receptionist transport
 * can hold. `transportReply` resolves ONE of these per attempt via
 * `getTransportProvider(channel)` and calls `.send({to, body})` — both members share
 * that shape, so the transport is channel-agnostic at the call site while the union
 * keeps SMS and WhatsApp providers non-interchangeable at the type level.
 */
export type MessagingProvider = SmsProvider | WhatsAppProvider;

// ---------------------------------------------------------------------
// ASYNC DELIVERY RECEIPTS (Directive #018 R7). Acceptance (above) is not delivery:
// the provider reports the message's TERMINAL fate asynchronously, over a status
// callback, correlated by the same `providerMessageId` the acceptance returned. This
// is the provider-neutral vocabulary of that lifecycle — pure data, so the adapter,
// the service, the ledger and the tests share ONE set of status literals and depend
// on the INTERFACE, never on Twilio's raw strings.
// ---------------------------------------------------------------------

/**
 * The canonical SMS delivery lifecycle. Provider-neutral, ordered from acceptance to
 * a terminal fate, instantiated by the Twilio adapter (Twilio's own MessageStatus
 * values map 1:1). The append-only receipt ledger's CHECK pins this exact set, so an
 * unrecognised status can never be recorded — the adapter rejects it upstream as a
 * malformed callback.
 */
export const SMS_DELIVERY_STATUSES = [
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "canceled",
] as const;
export type SmsDeliveryStatus = (typeof SMS_DELIVERY_STATUSES)[number];

/**
 * The TERMINAL delivery states — the provider will not transition out of these. The
 * directive's "known final state" set (delivered / undelivered / failed / canceled).
 * Kept as a subset of {@link SMS_DELIVERY_STATUSES} so the ledger's generated
 * `terminal` column and this constant cannot drift.
 */
export const TERMINAL_SMS_DELIVERY_STATUSES = [
  "delivered",
  "undelivered",
  "failed",
  "canceled",
] as const;
export type TerminalSmsDeliveryStatus = (typeof TERMINAL_SMS_DELIVERY_STATUSES)[number];

/** Narrow an arbitrary string to a canonical SMS delivery status. */
export function isSmsDeliveryStatus(value: unknown): value is SmsDeliveryStatus {
  return (
    typeof value === "string" &&
    (SMS_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** True when a status is a terminal (final) delivery state. */
export function isTerminalSmsDeliveryStatus(
  value: unknown,
): value is TerminalSmsDeliveryStatus {
  return (
    typeof value === "string" &&
    (TERMINAL_SMS_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * One async delivery receipt, parsed from a provider's status callback. Pure data —
 * the provider-specific adapter (e.g. Twilio) translates its raw callback params into
 * this shape, and the canonical service correlates it to the transport it belongs to.
 * `providerMessageId` is the correlation key (the acceptance's id); `status` is the
 * canonical lifecycle status; `providerStatus` preserves the raw string when it
 * differs; `errorCode` carries the provider's failure code when a delivery fails.
 */
export type SmsDeliveryReceipt = {
  /** The provider's message id — the correlation key back to the transport. */
  providerMessageId: string;
  /** The canonical lifecycle status the provider reported. */
  status: SmsDeliveryStatus;
  /** The provider's raw status string, when it differs from the canonical form. */
  providerStatus?: string | null;
  /** The provider's error code for a non-delivery, when it reports one. */
  errorCode?: string | null;
};
