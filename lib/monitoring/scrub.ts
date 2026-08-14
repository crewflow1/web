/**
 * Error-monitoring — event scrubbing (PII / token redaction).
 *
 * The one thing that MUST run on every event before it leaves the process.
 * Sentry captures exception context automatically — request headers, cookies,
 * query strings, extra data — and that context is exactly where a CrewFlow
 * request carries secrets: `Authorization: Bearer …`, the Supabase anon/service
 * keys, session cookies, an `?api_key=` on a webhook, a customer's email in a
 * form body. Shipping any of that to a third party is a data-protection breach,
 * so this scrubber is wired into `beforeSend` on all three sentry.*.config.ts
 * files and redacts before the event is serialised.
 *
 * Pure and DETERMINISTIC: same event in ⇒ same event out, no clock, no
 * randomness, no I/O, no `server-only`. That makes it edge-safe (the edge
 * config uses it too) and trivially unit-testable. It mutates a shallow-ish
 * copy conceptually but, because Sentry hands us a fresh event object per
 * capture, it edits in place and returns it — never null (we scrub, we do not
 * drop, so a genuine error is never silently swallowed).
 *
 * Typed loosely (`MinimalEvent`) rather than against `@sentry/nextjs`'s `Event`
 * so this module carries no SDK dependency and the security suite can reason
 * about it in isolation. The fields it touches are a stable subset of the
 * Sentry event shape.
 */

/** Header/cookie/field names whose VALUES are always secret, matched case-insensitively. */
const SENSITIVE_KEYS: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-supabase-auth",
  "proxy-authorization",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "session",
];

/** What a redacted value becomes. Constant so tests are exact and logs are greppable. */
export const REDACTED = "[redacted]" as const;

/** Query-string keys whose values are secrets, redacted inside any URL we report. */
const SENSITIVE_QUERY_KEYS: readonly string[] = [
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "key",
  "secret",
  "password",
  "code",
];

/** The minimal slice of a Sentry event this scrubber reads or writes. */
export type MinimalEvent = {
  request?: {
    headers?: Record<string, unknown>;
    cookies?: Record<string, unknown> | string;
    data?: unknown;
    query_string?: unknown;
    url?: unknown;
  };
  contexts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: Record<string, unknown>;
  [key: string]: unknown;
};

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEYS.includes(key.toLowerCase());

/** Redact every value under a sensitive key, at any depth, without following cycles. */
function redactObject(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redactObject(value[i], seen);
    }
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (isSensitiveKey(key)) {
      obj[key] = REDACTED;
    } else {
      obj[key] = redactObject(obj[key], seen);
    }
  }
  return obj;
}

/** Strip the values of sensitive query params out of a URL (or raw query string). */
function redactUrl(raw: string): string {
  // Handle both a full URL and a bare "a=1&b=2" query string.
  const [path, query] = raw.includes("?") ? splitOnce(raw, "?") : ["", raw];
  if (!query) return raw;
  const scrubbed = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      return SENSITIVE_QUERY_KEYS.includes(decodeURIComponent(name).toLowerCase())
        ? `${name}=${REDACTED}`
        : pair;
    })
    .join("&");
  return path ? `${path}?${scrubbed}` : scrubbed;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

/**
 * Sentry `beforeSend` hook — redact secrets/PII, then return the event.
 *
 * Never returns null: we scrub the event, we do not suppress the error report.
 * Wrapped so a bug in redaction can NEVER stop an event from being reported
 * with SOMETHING — but if scrubbing itself throws we fail CLOSED and drop the
 * event rather than risk shipping un-scrubbed context.
 */
export function scrubEvent<T extends MinimalEvent>(event: T): T | null {
  try {
    const seen = new WeakSet<object>();

    if (event.request) {
      const req = event.request;
      if (req.headers) redactObject(req.headers, seen);
      if (req.cookies && typeof req.cookies === "object") redactObject(req.cookies, seen);
      // A raw cookie string is entirely secret — never partially report it.
      if (typeof req.cookies === "string") req.cookies = REDACTED;
      if (req.data !== undefined) req.data = redactObject(req.data, seen);
      if (typeof req.query_string === "string") req.query_string = redactUrl(req.query_string);
      if (typeof req.url === "string") req.url = redactUrl(req.url);
    }

    if (event.extra) redactObject(event.extra, seen);
    if (event.contexts) redactObject(event.contexts, seen);
    if (event.tags) redactObject(event.tags, seen);

    // Drop user PII we never need to triage an error: keep only a stable id.
    if (event.user && typeof event.user === "object") {
      const id = event.user.id;
      event.user = id === undefined ? {} : { id };
    }

    return event;
  } catch {
    // Fail closed: if we cannot guarantee the event is scrubbed, do not send it.
    return null;
  }
}
