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
