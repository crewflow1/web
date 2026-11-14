/**
 * Error-monitoring — consent gate for the BROWSER transport.
 *
 * The browser Sentry SDK sends more than error reports. On every page load its
 * default `BrowserSession` integration posts a `session` envelope (release
 * health: a random session id, release, environment, user agent), and — if
 * tracing is ever switched back on — sampled `transaction` / `span` envelopes
 * (page-speed traces). Those are usage and performance STATISTICS, sent for
 * every visitor whether or not anything went wrong.
 *
 * The line this module draws, and why:
 *
 *   ALWAYS SENT (no consent)      error reports — `event` items and what
 *                                 belongs to them (`attachment`), plus anything
 *                                 the user explicitly submits (`feedback`,
 *                                 `user_report`). They fire only when a fault
 *                                 actually occurs in a page the visitor asked
 *                                 for, use no cookie or device storage, are
 *                                 PII-scrubbed (lib/monitoring/scrub.ts), and
 *                                 detecting technical faults is part of running
 *                                 the service at all.
 *
 *   CONSENT REQUIRED              everything else — `session(s)`, `transaction`,
 *   (category: performance)       `span`, `profile*`, `replay_*`, `client_report`,
 *                                 and any item type added by a future SDK.
 *                                 Routine telemetry about how the site is used
 *                                 and how fast it is; the service works without
 *                                 it, so it is not "strictly necessary".
 *
 * The gate is an ALLOW-LIST and sits at the single choke point every envelope
 * passes through, so it cannot be bypassed by enabling an integration, raising
 * a sample rate, or upgrading the SDK: an item type this file has never heard
 * of is dropped until consent says otherwise. Consent is read live per send, so
 * a withdrawal takes effect on the very next envelope without a reload.
 *
 * Pure and SDK-free (typed structurally, like scrub.ts) so the security/unit
 * tiers can reason about it in isolation. Used only by sentry.client.config.ts —
 * the server and edge runtimes have no visitor device to protect.
 */

/** Envelope item types that are sent without consent. Everything else is gated. */
export const ALWAYS_ALLOWED_ITEM_TYPES: readonly string[] = [
  "event",
  "attachment",
  "feedback",
  "user_report",
];

/** A Sentry envelope, structurally: `[headers, [[itemHeader, payload], …]]`. */
export type MinimalEnvelope = readonly [
  unknown,
  ReadonlyArray<readonly [{ type?: unknown }, unknown]>,
];

/** The slice of a Sentry transport this gate wraps. */
export type MinimalTransport<E, R> = {
  send: (envelope: E) => PromiseLike<R>;
  flush: (timeout?: number) => PromiseLike<boolean>;
};

function itemType(item: readonly [{ type?: unknown }, unknown]): string {
  const t = item?.[0]?.type;
  return typeof t === "string" ? t : "";
}

/**
 * Strip consent-gated items out of an envelope.
 *
 * With `performanceAllowed` the envelope passes through untouched. Without it,
 * only {@link ALWAYS_ALLOWED_ITEM_TYPES} survive; returns null when nothing is
 * left, meaning "send nothing at all". Never mutates the input.
 */
export function filterEnvelopeForConsent<E extends MinimalEnvelope>(
  envelope: E,
  performanceAllowed: boolean,
): E | null {
  if (performanceAllowed) return envelope;
  const items = envelope[1].filter((item) =>
    ALWAYS_ALLOWED_ITEM_TYPES.includes(itemType(item)),
  );
  if (items.length === 0) return null;
  if (items.length === envelope[1].length) return envelope;
  return [envelope[0], items] as unknown as E;
}

/**
 * Wrap a transport so every envelope is filtered through the consent gate.
 * `isPerformanceAllowed` is called per send; if it throws, consent is treated
 * as NOT given (fail closed). A fully-filtered envelope resolves as a no-op
 * success so the SDK neither retries nor reports it as a transport failure.
 */
export function makeConsentGatedTransport<E extends MinimalEnvelope, R>(
  inner: MinimalTransport<E, R>,
  isPerformanceAllowed: () => boolean,
): MinimalTransport<E, R> {
  return {
    send(envelope: E): PromiseLike<R> {
      let allowed = false;
      try {
        allowed = isPerformanceAllowed() === true;
      } catch {
        allowed = false;
      }
      const filtered = filterEnvelopeForConsent(envelope, allowed);
      if (filtered === null) return Promise.resolve({} as R);
      return inner.send(filtered);
    },
    flush: (timeout?: number) => inner.flush(timeout),
  };
}
