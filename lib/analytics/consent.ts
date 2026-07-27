/**
 * Cookie-consent decision logic — pure + isomorphic (no DOM, no server-only).
 *
 * This module is the single source of truth for two launch-critical
 * guarantees, expressed as pure functions so they can be unit-tested without
 * a browser:
 *
 *   1. NO product analytics run unless analytics are CONFIGURED *and* the user
 *      has EXPLICITLY granted consent  → {@link analyticsAllowed}.
 *   2. We never nag with a banner when there is nothing to consent to (no
 *      analytics configured) or once the user has already chosen
 *      → {@link shouldShowBanner}.
 *
 * "Configured" means a PostHog key is present in the environment. Today the
 * key is unset, so the banner stays dormant and only essential cookies are
 * set — which is exactly what the privacy policy states. The moment a key is
 * added, the banner appears and analytics stay off until opt-in.
 */

export const CONSENT_COOKIE = "cf_cookie_consent";
/** Persist the choice for a year (typical cookie-consent retention). */
export const CONSENT_MAX_AGE_SEC = 60 * 60 * 24 * 365;

export type ConsentState = "granted" | "denied";

/** Narrow an arbitrary cookie value to a known consent state, else null. */
export function parseConsent(
  raw: string | null | undefined,
): ConsentState | null {
  if (raw === "granted") return "granted";
  if (raw === "denied") return "denied";
  return null;
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

/** Show the consent banner only when analytics COULD run and no choice exists. */
export function shouldShowBanner(
  consent: ConsentState | null,
  configured: boolean,
): boolean {
  return configured && consent === null;
}

/**
 * The load-bearing guarantee: analytics may initialise ONLY when configured
 * AND explicitly granted. Anything else (no key, no choice, or denied) → false.
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
 * must never mount there.
 */
export function isFirstPartySurface(pathname: string): boolean {
  if (pathname === "/q" || pathname.startsWith("/q/")) return false;
  if (pathname === "/customer-portal" || pathname.startsWith("/customer-portal/"))
    return false;
  return true;
}

/** Read + narrow the consent cookie from a `document.cookie` string (client). */
export function readConsentFromCookieString(
  cookieString: string,
): ConsentState | null {
  if (!cookieString) return null;
  const prefix = `${CONSENT_COOKIE}=`;
  const entry = cookieString
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!entry) return null;
  return parseConsent(decodeURIComponent(entry.slice(prefix.length)));
}

/** Serialise a `document.cookie` write for a consent choice (client). */
export function serializeConsentCookie(state: ConsentState): string {
  return `${CONSENT_COOKIE}=${state}; path=/; max-age=${CONSENT_MAX_AGE_SEC}; SameSite=Lax`;
}
