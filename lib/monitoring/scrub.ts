/**
 * Error-monitoring — event scrubbing (PII / token redaction).
 *
 * The one thing that MUST run on every event before it leaves the process.
 * Sentry captures exception context automatically — request headers, cookies,
 * query strings, extra data — and that context is exactly where a CrewFlow
 * request carries secrets: `Authorization: Bearer …`, the Supabase anon/service
 * keys, session cookies, an `?api_key=` on a webhook, a customer's email in a
 * form body. Shipping any of that to a third party is a data-protection breach,
 * so this scrubber is wired into `beforeSend` AND `beforeSendTransaction` on all
 * three sentry.*.config.ts files and redacts before the event is serialised.
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

/**
 * Key SHAPES whose values are secret, beyond the exact names above. The exact
 * list alone missed every provider's webhook-signature and shared-secret header
 * this app actually receives — `stripe-signature`, `x-twilio-signature`,
 * `x-hub-signature-256`, `svix-signature`, `x-webhook-secret`, and the Bearer on
 * the cron routes is only caught because it rides `authorization`.
 *
 * Anchored on word boundaries (`-`, `_`, `.`, start, end) on purpose: a bare
 * substring match on "token" would redact `input_tokens` / `max_tokens`, which
 * are counts we want when triaging an AI failure, and "key" would redact
 * `idempotency_key`-style identifiers wholesale.
 */
const SENSITIVE_KEY_SHAPE =
  /(^|[-_.])(secret|password|passwd|authorization|cookie|signature|credentials?|apikey|bearer)([-_.0-9]|$)|api[-_]key|(^|[-_.])(access|refresh|id|auth|csrf|session|verify|bypass)[-_]token($|[-_.])|[-_]token$|private[-_]key|service[-_]role|encryption[-_]key/i;

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEYS.includes(key.toLowerCase()) || SENSITIVE_KEY_SHAPE.test(key);

/**
 * CAPABILITY TOKENS IN THE URL PATH. Four public surfaces authenticate with a
 * bearer token that IS a path segment — the customer portal, the worker portal,
 * the public quote page and the asset-label scan. Query-string redaction never
 * sees them, so every error raised on those routes used to ship a working
 * portal link to the monitoring vendor in `request.url`, the transaction name
 * and navigation breadcrumbs. The segment after the prefix is replaced; the
 * rest of the path (which page of the portal) is kept for triage.
 *
 * The prefix must START the path — string start, after whitespace/quote, or
 * directly after a URL origin — so a filesystem path in a stack message
 * (`/Users/a/b`) or a deeper route (`/api/v1/q/x`) is left alone. A
 * parameterised route NAME (`/q/[token]`, `/q/:token`) is not a secret and is
 * what Sentry groups on, so it is left alone too.
 */
const PATH_TOKEN_RE =
  /((?:^|[\s"'(=]|https?:\/\/[^/\s"']+)\/(?:customer-portal|worker-portal|q|a)\/)(?![[:])([^/?#\s"'<>)]+)/g;

/** Redact capability tokens carried as path segments. Exported for tests + reuse. */
export function redactPathTokens(value: string): string {
  return value.replace(PATH_TOKEN_RE, `$1${REDACTED}`);
}

/** An email address anywhere in free text. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** An international-format phone number (E.164: `+` then 8–15 digits). */
const PHONE_RE = /\+\d{8,15}\b/g;

/**
 * Scrub free text that a human or a database wrote and that Sentry carries
 * verbatim: exception messages (`duplicate key … (email)=(a@b.com)`), console
 * breadcrumbs, log messages. Key-name redaction cannot see inside a string, so
 * the identifiers are masked by SHAPE instead. Deliberately narrow — email
 * addresses, `+`-prefixed phone numbers and capability-token paths only — so
 * stack traces, ids and timings stay intact and an error remains diagnosable.
 */
export function scrubText(value: string): string {
  return redactPathTokens(value).replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
}

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
function redactUrl(input: string): string {
  // Path-borne capability tokens first, then sensitive query params.
  const raw = redactPathTokens(input);
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
 * Strip sensitive query params from any URL-valued field in a flat data bag —
 * e.g. a transaction span's `http.url` / `url`. Keys are matched loosely (any
 * key containing "url"); non-string values are left untouched.
 */
function redactUrlFields(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    // `to` / `from` are how navigation breadcrumbs carry the route.
    if (typeof v === "string" && /url|^to$|^from$|^target$|href/i.test(key)) obj[key] = redactUrl(v);
  }
}

/** Strip path tokens from a route-name field (a transaction / culprit, a span description). */
function redactTextField(holder: Record<string, unknown>, key: string): void {
  const v = holder[key];
  if (typeof v === "string") holder[key] = redactPathTokens(v);
}

/** Full free-text scrub (path tokens + emails + phone numbers) of a message field. */
function scrubTextField(holder: Record<string, unknown>, key: string): void {
  const v = holder[key];
  if (typeof v === "string") holder[key] = scrubText(v);
}

/** scrubText over every string value of a shallow record (breadcrumb `data`). */
function scrubStringValues(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string") obj[key] = scrubText(v);
  }
}

/**
 * Sentry `beforeSend` hook — redact secrets/PII, then return the event.
 *
 * Never returns null: we scrub the event, we do not suppress the error report.
 * Wrapped so a bug in redaction can NEVER stop an event from being reported
 * with SOMETHING — but if scrubbing itself throws we fail CLOSED and drop the
 * event rather than risk shipping un-scrubbed context.
 */
export function scrubEvent<T extends object>(event: T): T | null {
  try {
    // Operate on a MinimalEvent VIEW of the event so the hook is assignable to
    // Sentry's `beforeSend` (whose ErrorEvent has no string index signature)
    // while we still mutate the one underlying object and return it unchanged.
    const e = event as MinimalEvent;
    const seen = new WeakSet<object>();

    if (e.request) {
      const req = e.request;
      if (req.headers) redactObject(req.headers, seen);
      if (req.cookies && typeof req.cookies === "object") redactObject(req.cookies, seen);
      // A raw cookie string is entirely secret — never partially report it.
      if (typeof req.cookies === "string") req.cookies = REDACTED;
      if (req.data !== undefined) req.data = redactObject(req.data, seen);
      if (typeof req.query_string === "string") req.query_string = redactUrl(req.query_string);
      if (typeof req.url === "string") req.url = redactUrl(req.url);
    }

    if (e.extra) redactObject(e.extra, seen);
    if (e.contexts) redactObject(e.contexts, seen);
    if (e.tags) redactObject(e.tags, seen);

    // Transaction (performance) events carry spans; each span's `data` can hold
    // secret-keyed values and URL fields (e.g. `http.url`) with sensitive query
    // params. Redact them too so `beforeSendTransaction` is meaningful. Errors
    // have no spans, so this is a no-op for them.
    const spans = (e as { spans?: unknown }).spans;
    if (Array.isArray(spans)) {
      for (const span of spans) {
        const data = span && typeof span === "object" ? (span as { data?: unknown }).data : undefined;
        if (data && typeof data === "object") {
          redactObject(data, seen);
          redactUrlFields(data as Record<string, unknown>);
        }
      }
    }

    // The transaction / culprit name is the route — on a token-in-path surface
    // an un-parameterised one carries the token itself.
    redactTextField(e as Record<string, unknown>, "transaction");
    redactTextField(e as Record<string, unknown>, "culprit");
    // The event message and structured log message are free text that a
    // database or our own logging wrote — emails / phone numbers ride in it.
    scrubTextField(e as Record<string, unknown>, "message");
    const logentry = (e as { logentry?: unknown }).logentry;
    if (logentry && typeof logentry === "object") scrubTextField(logentry as Record<string, unknown>, "message");

    // Breadcrumbs: navigation + fetch/xhr crumbs record URLs (and sometimes
    // request data) for the minutes BEFORE the error — untouched until now.
    const crumbs = (e as { breadcrumbs?: unknown }).breadcrumbs;
    const crumbList = Array.isArray(crumbs)
      ? crumbs
      : crumbs && typeof crumbs === "object" && Array.isArray((crumbs as { values?: unknown }).values)
        ? ((crumbs as { values: unknown[] }).values)
        : [];
    for (const crumb of crumbList) {
      if (!crumb || typeof crumb !== "object") continue;
      const c = crumb as Record<string, unknown>;
      scrubTextField(c, "message");
      if (c.data && typeof c.data === "object") {
        redactObject(c.data, seen);
        redactUrlFields(c.data as Record<string, unknown>);
        scrubStringValues(c.data as Record<string, unknown>);
      }
    }

    // Exception messages + span descriptions are free text that routinely embed
    // the failing URL ("GET /customer-portal/<token>/invoices 500"); exception
    // values also carry the offending value Postgres echoes ("Key (email)=(…)").
    const exc = (e as { exception?: { values?: unknown } }).exception;
    if (exc && Array.isArray(exc.values)) {
      for (const v of exc.values) {
        if (v && typeof v === "object") scrubTextField(v as Record<string, unknown>, "value");
      }
    }
    if (Array.isArray(spans)) {
      for (const span of spans) {
        if (span && typeof span === "object") redactTextField(span as Record<string, unknown>, "description");
      }
    }
    if (e.tags) redactUrlFields(e.tags);

    // Drop user PII we never need to triage an error: keep only a stable id.
    if (e.user && typeof e.user === "object") {
      const id = e.user.id;
      e.user = id === undefined ? {} : { id };
    }

    return event;
  } catch {
    // Fail closed: if we cannot guarantee the event is scrubbed, do not send it.
    return null;
  }
}
