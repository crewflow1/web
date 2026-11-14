/**
 * Browser-side consent store — the thin DOM layer over lib/analytics/consent.ts.
 *
 * Reads/writes the consent cookie and announces changes with a window event so
 * every consumer (the banner, the settings dialog, the analytics loader) stays
 * in step without a React context spanning the root layout. All decisions live
 * in the pure module; this file only touches `document` / `window`, and every
 * function is a safe no-op outside the browser or when cookies are blocked.
 */

import {
  type ConsentCategories,
  type ConsentCategory,
  type ConsentRecord,
  buildConsentRecord,
  categoryAllowed,
  configuredCategories,
  isFirstPartySurface,
  readConsentRecordFromCookieString,
  serializeConsentCookie,
} from "@/lib/analytics/consent";
import { monitoringEnabled } from "@/lib/monitoring/readiness";

/** Fired on `window` after a choice is stored. `detail` is the new record. */
export const CONSENT_CHANGED_EVENT = "crewflow:consent-changed";
/** Fire on `window` to open the cookie-settings dialog from anywhere. */
export const OPEN_COOKIE_SETTINGS_EVENT = "crewflow:open-cookie-settings";

/**
 * The optional categories this build can actually run. `NEXT_PUBLIC_*` values
 * are inlined at build time, so this is a constant per deployment — and it uses
 * the SAME predicate as sentry.client.config.ts, so "is there a performance
 * category to offer" can never drift from "will Sentry initialise".
 */
export function clientConfiguredCategories(): ConsentCategory[] {
  return configuredCategories({
    posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    monitoringEnabled: monitoringEnabled({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      env: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    }),
  });
}

/** The stored consent record, or null (no choice / cookies unreadable). */
export function readStoredConsent(): ConsentRecord | null {
  if (typeof document === "undefined") return null;
  try {
    return readConsentRecordFromCookieString(document.cookie);
  } catch {
    return null;
  }
}

/**
 * Is this optional category allowed RIGHT NOW on THIS page? Configured, granted
 * in the stored record, and not an external (portal / quote / worker / enquiry)
 * surface. Read live on every call so a withdrawal takes effect immediately.
 */
export function categoryAllowedNow(category: ConsentCategory): boolean {
  if (typeof window === "undefined") return false;
  let pathname = "/";
  try {
    pathname = window.location.pathname;
  } catch {
    return false;
  }
  if (!isFirstPartySurface(pathname)) return false;
  return categoryAllowed(
    readStoredConsent(),
    category,
    clientConfiguredCategories(),
  );
}

/**
 * Persist a choice (current version + timestamp) and announce it. Returns the
 * record that was stored. If cookies are blocked there is nothing to persist —
 * the in-memory record is still returned so the UI can close, and because
 * nothing was stored every gate keeps reading "no consent".
 */
export function storeConsent(categories: Partial<ConsentCategories>): ConsentRecord {
  const record = buildConsentRecord(categories);
  if (typeof document === "undefined") return record;
  try {
    document.cookie = serializeConsentCookie(record, {
      secure: window.location.protocol === "https:",
    });
  } catch {
    /* cookies blocked — nothing to persist */
  }
  try {
    window.dispatchEvent(
      new CustomEvent<ConsentRecord>(CONSENT_CHANGED_EVENT, { detail: record }),
    );
  } catch {
    /* never let an announcement failure break the choice */
  }
  return record;
}

/** Open the cookie-settings dialog (footer link, settings page, …). */
export function openCookieSettings(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT));
}
