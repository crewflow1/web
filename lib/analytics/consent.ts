/**
 * Cookie-consent decision logic — pure + isomorphic (no DOM, no server-only).
 *
 * This module is the single source of truth for the launch-critical consent
 * guarantees, expressed as pure functions so they can be unit-tested without
 * a browser:
 *
 *   1. NOTHING optional runs unless its category is CONFIGURED *and* the user
 *      has EXPLICITLY granted that category → {@link categoryAllowed} (and the
 *      analytics-only shorthand {@link analyticsAllowed}).
 *   2. We never nag with a banner when there is nothing to consent to (no
 *      optional category configured) or once the user has already chosen
 *      → {@link needsDecision}.
 *   3. The choice is a RECORD — policy version + timestamp + per-category
 *      booleans — so it can be audited, updated, withdrawn and re-requested
 *      when the categories change → {@link ConsentRecord}.
 *
 * Categories are driven by what is actually wired in this build, not by a
 * generic CMP template:
 *
 *   analytics    PostHog product analytics. "Configured" = a PostHog key exists.
 *   performance  Sentry session health + performance traces. "Configured" =
 *                the browser Sentry SDK will initialise (DSN set, non-dev env).
 *                Sentry ERROR reports are NOT in this category — see
 *                lib/monitoring/consent-transport.ts for the reasoning.
 *
 * There is deliberately no "marketing" category: the build contains no
 * advertising, conversion or retargeting tag. Adding one means adding a
 * category here (and bumping {@link CONSENT_VERSION} so existing visitors are
 * asked again) — never loading it under an existing category.
 */

export const CONSENT_COOKIE = "cf_cookie_consent";
/** Persist the choice for a year (typical cookie-consent retention). */
export const CONSENT_MAX_AGE_SEC = 60 * 60 * 24 * 365;

/**
 * Version of the consent notice + category set. Bump whenever a category is
 * added or what a category covers materially changes: a stored record with an
 * older version that granted anything is then treated as needing a fresh
 * decision ({@link needsDecision}).
 *
 *   1 — legacy binary cookie (`granted` / `denied`), product analytics only.
 *   2 — category-level record (analytics, performance) with timestamp.
 */
export const CONSENT_VERSION = 2;

export type ConsentState = "granted" | "denied";

/** The optional (consent-required) categories, in display order. */
export const CONSENT_CATEGORIES = ["analytics", "performance"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export type ConsentCategories = Record<ConsentCategory, boolean>;

export type ConsentRecord = {
  /** The {@link CONSENT_VERSION} the choice was made under. */
  version: number;
  /** When the choice was made (ISO-8601, UTC). Null for a legacy v1 cookie. */
  decidedAt: string | null;
  categories: ConsentCategories;
};

/** Every optional category off — the default, and what "Reject all" stores. */
export function allDenied(): ConsentCategories {
  return { analytics: false, performance: false };
}

/** Every optional category on — what "Accept all" stores. */
export function allGranted(): ConsentCategories {
  return { analytics: true, performance: true };
}

/** Narrow an arbitrary legacy (v1) cookie value to a known state, else null. */
export function parseConsent(
  raw: string | null | undefined,
): ConsentState | null {
  if (raw === "granted") return "granted";
  if (raw === "denied") return "denied";
  return null;
}

/**
 * Parse a stored consent value into a record, else null (no valid choice).
 *
 * Accepts the current format — `v<version>.t<unix-seconds>.<category><0|1>…`,
 * e.g. `v2.t1794609958.analytics1.performance0` (cookie-safe, no encoding) —
 * and the legacy v1 values. A legacy `granted` only ever covered product
 * analytics, so it maps to analytics-only; nothing can be inferred for a
 * category the visitor was never shown.
 *
 * Fails CLOSED: anything malformed, a category token that is not exactly 0/1,
 * or an unknown shape yields null / false — never an accidental grant.
 */
export function parseConsentRecord(
  raw: string | null | undefined,
): ConsentRecord | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  const legacy = parseConsent(raw);
  if (legacy) {
    return {
      version: 1,
      decidedAt: null,
      categories: { ...allDenied(), analytics: legacy === "granted" },
    };
  }

  const parts = raw.split(".");
  if (parts.length < 2) return null;
  const versionMatch = /^v(\d{1,4})$/.exec(parts[0] ?? "");
  const timeMatch = /^t(\d{1,12})$/.exec(parts[1] ?? "");
  if (!versionMatch || !timeMatch) return null;
  const version = Number(versionMatch[1]);
  const seconds = Number(timeMatch[1]);
  if (!Number.isInteger(version) || version < 2) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const categories = allDenied();
  for (const token of parts.slice(2)) {
    const m = /^([a-z]+)([01])$/.exec(token);
    if (!m) return null; // malformed token → no valid record (fail closed)
    const name = m[1] as ConsentCategory;
    if ((CONSENT_CATEGORIES as readonly string[]).includes(name)) {
      categories[name] = m[2] === "1";
    }
    // unknown (future/removed) category names are ignored, never granted.
  }

  return {
    version,
    decidedAt: new Date(seconds * 1000).toISOString(),
    categories,
  };
}

/** Serialise a record to the cookie VALUE (see {@link parseConsentRecord}). */
export function serializeConsentValue(record: ConsentRecord): string {
  const ms = record.decidedAt ? Date.parse(record.decidedAt) : Number.NaN;
  const seconds = Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  const cats = CONSENT_CATEGORIES.map(
    (c) => `${c}${record.categories[c] ? 1 : 0}`,
  ).join(".");
  return `v${record.version}.t${seconds}.${cats}`;
}

/** Build a current-version record for a set of category choices. */
export function buildConsentRecord(
  categories: Partial<ConsentCategories>,
  now: Date = new Date(),
): ConsentRecord {
  const next = allDenied();
  for (const c of CONSENT_CATEGORIES) next[c] = categories[c] === true;
  return {
    version: CONSENT_VERSION,
    decidedAt: now.toISOString(),
    categories: next,
  };
}

/**
 * Analytics are "configured" only when a non-empty PostHog key exists. Callers
 * pass `process.env.NEXT_PUBLIC_POSTHOG_KEY` (inlined into client bundles by
 * Next at build time) so this stays a pure, testable function.
 */
export function analyticsConfigured(
  posthogKey: string | null | undefined,
): boolean {
  return typeof posthogKey === "string" && posthogKey.trim().length > 0;
}

/**
 * Which optional categories have something behind them in this build/env.
 * Only these are offered in the UI; a category with no vendor configured is
 * never shown and can never be "allowed".
 */
export function configuredCategories(args: {
  posthogKey: string | null | undefined;
  /** Will the browser Sentry SDK initialise? (lib/monitoring/readiness.ts) */
  monitoringEnabled: boolean;
}): ConsentCategory[] {
  const out: ConsentCategory[] = [];
  if (analyticsConfigured(args.posthogKey)) out.push("analytics");
  if (args.monitoringEnabled) out.push("performance");
  return out;
}

/** True when the record granted at least one optional category. */
function grantedAnything(record: ConsentRecord): boolean {
  return CONSENT_CATEGORIES.some((c) => record.categories[c]);
}

/**
 * Should the consent banner be shown?
 *
 *   - Never when nothing optional is configured (nothing to consent to).
 *   - Always when no valid choice is stored.
 *   - Again when the stored choice predates {@link CONSENT_VERSION} AND it
 *     granted something — the categories changed, so the old "yes" does not
 *     cover the new notice. A stored full rejection is NOT re-prompted: "no to
 *     everything optional" still means no, and re-asking would be nagging.
 */
export function needsDecision(
  record: ConsentRecord | null,
  configured: readonly ConsentCategory[],
): boolean {
  if (configured.length === 0) return false;
  if (record === null) return true;
  return record.version < CONSENT_VERSION && grantedAnything(record);
}

/**
 * The load-bearing guarantee, per category: a category may run ONLY when it is
 * configured AND the stored record explicitly granted it. No record, a denied
 * category, or an unconfigured category → false.
 */
export function categoryAllowed(
  record: ConsentRecord | null,
  category: ConsentCategory,
  configured: readonly ConsentCategory[],
): boolean {
  return (
    configured.includes(category) &&
    record !== null &&
    record.categories[category] === true
  );
}

/** Show the consent banner only when analytics COULD run and no choice exists. */
export function shouldShowBanner(
  consent: ConsentState | null,
  configured: boolean,
): boolean {
  return configured && consent === null;
}

/**
 * Analytics shorthand of {@link categoryAllowed}: analytics may initialise ONLY
 * when configured AND explicitly granted. Anything else (no key, no choice, or
 * denied) → false.
 */
export function analyticsAllowed(
  consent: ConsentState | null,
  configured: boolean,
): boolean {
  return configured && consent === "granted";
}

/**
 * First-party surfaces only. The privacy policy promises the customer portal
 * and public quote pages set NO tracking cookies, so the banner + analytics
 * must never mount there. The same holds for every other surface whose visitor
 * is a CONTRACTOR'S contact rather than a CrewFlow user: the external-worker
 * H&S sign-off portal and the per-company public enquiry form. These carry
 * opaque access tokens in the URL, which must never reach an analytics vendor.
 */
const EXTERNAL_SURFACE_PREFIXES = [
  "/q",
  "/customer-portal",
  "/worker-portal",
  "/l",
] as const;

export function isFirstPartySurface(pathname: string): boolean {
  return !EXTERNAL_SURFACE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** Raw consent cookie value out of a `document.cookie` string, else null. */
function rawConsentFromCookieString(cookieString: string): string | null {
  if (!cookieString) return null;
  const prefix = `${CONSENT_COOKIE}=`;
  const entry = cookieString
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return null; // malformed percent-encoding → no valid choice
  }
}

/** Read the full consent record from a `document.cookie` string (client). */
export function readConsentRecordFromCookieString(
  cookieString: string,
): ConsentRecord | null {
  return parseConsentRecord(rawConsentFromCookieString(cookieString));
}

/**
 * Read the ANALYTICS-category state from a `document.cookie` string (client):
 * `granted` / `denied` once a choice exists, null when there is none. Works for
 * both the legacy v1 cookie and the current record.
 */
export function readConsentFromCookieString(
  cookieString: string,
): ConsentState | null {
  const record = readConsentRecordFromCookieString(cookieString);
  if (!record) return null;
  return record.categories.analytics ? "granted" : "denied";
}

/**
 * Serialise a `document.cookie` write for a consent record (client). `secure`
 * should be true on https origins so the record is never sent in clear text.
 */
export function serializeConsentCookie(
  record: ConsentRecord,
  opts: { secure?: boolean } = {},
): string {
  return (
    `${CONSENT_COOKIE}=${serializeConsentValue(record)}; path=/; ` +
    `max-age=${CONSENT_MAX_AGE_SEC}; SameSite=Lax` +
    (opts.secure ? "; Secure" : "")
  );
}

// ---------------------------------------------------------------------------
// Withdrawal clean-up — which device storage belongs to a consent category.
// ---------------------------------------------------------------------------

/**
 * True for a cookie / localStorage / sessionStorage key written by the
 * analytics vendor (PostHog: `ph_<key>_posthog`, `ph_<key>_window_id`,
 * `__ph_opt_in_out_<key>`, …). Used to clear them when consent is withdrawn.
 * No first-party key uses these prefixes (ours are `cf-`, `cf_`, `crewflow-`,
 * `sb-`, `active_org_id`).
 */
export function isAnalyticsStorageKey(key: string): boolean {
  return key.startsWith("ph_") || key.startsWith("__ph_");
}

/**
 * Every `domain=` a cookie for this host could have been set with, so an
 * expiring write can match it (a cookie is only deleted by a write with the
 * SAME domain + path). PostHog sets its cookie on the registrable parent
 * domain (`.crewflow.uk`) by default. The empty string is the host-only cookie.
 */
export function cookieDomainCandidates(hostname: string): string[] {
  const out = [""];
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return out;
  const labels = hostname.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const d = labels.slice(i).join(".");
    out.push(d, `.${d}`);
  }
  return out;
}
