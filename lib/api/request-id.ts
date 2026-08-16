/**
 * Request correlation id — one stable id per HTTP request, emitted as the
 * `x-request-id` response header and threaded onto the forwarded request so
 * route handlers / server code can echo it (see lib/api/respond.ts) and Sentry
 * can tag it (see middleware.ts).
 *
 * This module is intentionally dependency-free and framework-free so it can be
 * imported from the Edge middleware AND unit-tested as a pure function.
 */

/** The canonical header name. Lower-case — Headers are case-insensitive, but a
 * single spelling keeps greps + tests unambiguous. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * A conservative allow-list for an INBOUND request id we are willing to reuse.
 *
 * We accept a caller/proxy-supplied id (so a trace spanning several services
 * shares one id) ONLY when it looks like an opaque token: URL-safe characters,
 * bounded length. This is a security control, not cosmetics — the id is written
 * into response headers and Sentry tags and may be logged, so an unvalidated
 * inbound value is a header-injection / log-forging / log-poisoning vector. A
 * value that fails the check is DISCARDED and a fresh id is minted.
 *
 * The pattern excludes CR/LF, spaces, and structural characters, so it can
 * never smuggle a second header line or break a log record. Length is bounded
 * so an attacker cannot inflate every log line. UUIDv4 (36 chars) fits well
 * inside the 200-char ceiling.
 */
const SAFE_INBOUND_ID = /^[A-Za-z0-9._-]{8,200}$/;

/**
 * Resolve the request id for a request: reuse a well-formed inbound
 * `x-request-id`, otherwise mint a fresh RFC-4122 v4 UUID.
 *
 * Pure + deterministic given its input except for the mint path (which is a
 * cryptographically-random UUID). Never throws.
 */
export function resolveRequestId(inbound: string | null | undefined): string {
  if (inbound && SAFE_INBOUND_ID.test(inbound)) return inbound;
  return crypto.randomUUID();
}

/** True when a string is a request id we would accept from an inbound header. */
export function isAcceptableRequestId(value: string | null | undefined): boolean {
  return typeof value === "string" && SAFE_INBOUND_ID.test(value);
}
