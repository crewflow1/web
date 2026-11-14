/**
 * The ONLY place product analytics (PostHog) is ever initialised — and stopped.
 *
 * Nothing else in the app calls `posthog.init`, so "no analytics before
 * consent" is enforced here, in one auditable spot. {@link loadAnalyticsIfAllowed}:
 *
 *   - runs only in the browser;
 *   - refuses unless a PostHog key is configured;
 *   - refuses unless the consent record grants the analytics category;
 *   - refuses on external surfaces (customer portal, public quote, worker
 *     portal, public enquiry form);
 *   - is idempotent (a second call is a no-op once capturing);
 *   - never throws — analytics must never be able to break a page.
 *
 * {@link stopAnalytics} is the withdrawal path: it stops capture in the running
 * page and deletes every analytics cookie / storage key from the device, so
 * withdrawing consent is as effective as never having given it.
 *
 * PostHog itself is initialised OPTED-OUT by default (no capture, no
 * persistence) and only opted in once our own consent check has passed. That
 * gives a second, vendor-level gate: if the stored opt-in is ever cleared —
 * which is exactly what withdrawal does — the SDK falls back to "off".
 *
 * `posthog-js` is loaded via dynamic import so it stays out of the main
 * bundle and never executes for users who haven't opted in.
 */

import {
  analyticsAllowed,
  analyticsConfigured,
  cookieDomainCandidates,
  isAnalyticsStorageKey,
  isFirstPartySurface,
  readConsentFromCookieString,
} from "@/lib/analytics/consent";
import { setAnalyticsSink } from "@/lib/analytics/events";
import { sanitizeAnalyticsProperties } from "@/lib/analytics/sanitize-url";

/** The slice of the PostHog client this module drives. */
type AnalyticsClient = {
  capture: (event: string, properties?: Record<string, unknown>) => unknown;
  opt_in_capturing: (options?: { captureEventName?: string | null | false }) => void;
  opt_out_capturing: () => void;
  clear_opt_in_out_capturing: () => void;
};

/** `posthog.init` has been called in this page (it cannot be un-initialised). */
let started = false;
/** The initialised client, once the dynamic import has resolved. */
let client: AnalyticsClient | null = null;
/** The client is currently opted in and the `trackEvent` sink is attached. */
let capturing = false;

function currentPathname(): string {
  try {
    return window.location?.pathname ?? "/";
  } catch {
    return "/";
  }
}

/** Configured + consented + first-party surface — re-read live on every call. */
function allowedNow(): boolean {
  const configured = analyticsConfigured(process.env.NEXT_PUBLIC_POSTHOG_KEY);
  if (!configured) return false;
  let consent = null;
  try {
    consent = readConsentFromCookieString(document.cookie);
  } catch {
    consent = null;
  }
  if (!analyticsAllowed(consent, configured)) return false;
  return isFirstPartySurface(currentPathname());
}

/** Opt the initialised client in and attach the `trackEvent` sink. Idempotent. */
function resume(): void {
  const posthog = client;
  if (!posthog || capturing) return;
  capturing = true;
  // Sends the initial $pageview (capture_pageview) now that capture is on. No
  // synthetic "$opt_in" event — the consent record lives in our own cookie.
  posthog.opt_in_capturing({ captureEventName: false });
  // Register the capture sink so `trackEvent` can send — only now, after a
  // consent-gated opt-in. Until this runs, every trackEvent call is a no-op.
  setAnalyticsSink((event, properties) => {
    try {
      posthog.capture(event, properties);
    } catch {
      // never let a capture failure surface to the user
    }
  });
}

export async function loadAnalyticsIfAllowed(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!allowedNow()) return;

  if (started) {
    // Already initialised in this page (e.g. consent withdrawn then re-given
    // without a reload) → just switch capture back on.
    try {
      resume();
    } catch (e) {
      capturing = false;
      console.error("[analytics] PostHog resume failed", e);
    }
    return;
  }

  // Mark started before the await so concurrent callers don't double-init.
  started = true;
  try {
    const posthog = (await import("posthog-js")).default;
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com",
      capture_pageview: true,
      // Vendor-level default-deny: no capture and no cookie/localStorage until
      // `opt_in_capturing()` below, and again the moment the opt-in is cleared.
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      // Mask resource UUIDs out of captured URLs ($current_url/$pathname/…) so a
      // pageview for /jobs/<uuid> never ships the id. See lib/analytics/sanitize-url.ts.
      sanitize_properties: (properties) => sanitizeAnalyticsProperties(properties),
      // Defence in depth for a soft navigation from the app onto an external
      // surface while the SDK is running: drop every event raised there, so a
      // portal / quote / worker token in the URL can never be captured.
      before_send: (event) =>
        isFirstPartySurface(currentPathname()) ? event : null,
      // Don't hoover arbitrary form inputs / clicks — privacy-preserving and
      // avoids accidentally capturing customer business data.
      autocapture: false,
      disable_session_recording: true,
      person_profiles: "identified_only",
    });
    client = posthog as unknown as AnalyticsClient;
    // Consent may have been withdrawn while the SDK was downloading.
    if (!allowedNow()) return;
    resume();
  } catch (e) {
    // Roll back so a transient import failure can be retried on the next call.
    if (!client) started = false;
    capturing = false;
    console.error("[analytics] PostHog init failed", e);
  }
}

/**
 * Delete every analytics-vendor cookie and storage key from this device.
 * Cookies are expired for each domain they could have been set on (PostHog
 * uses the registrable parent domain by default). Never throws.
 */
export function purgeAnalyticsStorage(): void {
  if (typeof document === "undefined") return;
  try {
    const names = document.cookie
      .split(";")
      .map((c) => c.trim().split("=")[0] ?? "")
      .filter((name) => name.length > 0 && isAnalyticsStorageKey(name));
    const domains = cookieDomainCandidates(window.location?.hostname ?? "");
    for (const name of names) {
      for (const domain of domains) {
        document.cookie =
          `${name}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT` +
          (domain ? `; domain=${domain}` : "");
      }
    }
  } catch {
    /* cookies unavailable — nothing to clear */
  }
  for (const pick of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      const store = pick();
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && isAnalyticsStorageKey(key)) keys.push(key);
      }
      for (const key of keys) store.removeItem(key);
    } catch {
      /* storage blocked — nothing to clear */
    }
  }
}

/**
 * Withdraw analytics: detach the `trackEvent` sink, opt the running client out
 * (which also disables + removes its persistence), clear the vendor's stored
 * opt flag so it falls back to its opted-out default, then purge any analytics
 * key left on the device. Safe to call when analytics never started — it then
 * just clears leftovers from an earlier visit. Never throws.
 */
export function stopAnalytics(): void {
  if (typeof window === "undefined") return;
  setAnalyticsSink(null);
  capturing = false;
  if (client) {
    try {
      client.opt_out_capturing();
      client.clear_opt_in_out_capturing();
    } catch {
      // never let an SDK failure block the storage purge below
    }
  }
  purgeAnalyticsStorage();
}
