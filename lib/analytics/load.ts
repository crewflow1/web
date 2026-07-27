/**
 * The ONLY place product analytics (PostHog) is ever initialised.
 *
 * Nothing else in the app calls `posthog.init`, so "no analytics before
 * consent" is enforced here, in one auditable spot. The function:
 *
 *   - runs only in the browser;
 *   - refuses unless a PostHog key is configured;
 *   - refuses unless the consent cookie is "granted";
 *   - is idempotent (a second call is a no-op once started);
 *   - never throws — analytics must never be able to break a page.
 *
 * `posthog-js` is loaded via dynamic import so it stays out of the main
 * bundle and never executes for users who haven't opted in.
 */

import {
  analyticsAllowed,
  analyticsConfigured,
  readConsentFromCookieString,
} from "@/lib/analytics/consent";

let started = false;

export async function loadAnalyticsIfAllowed(): Promise<void> {
  if (started) return;
  if (typeof window === "undefined") return;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const configured = analyticsConfigured(key);
  if (!configured) return;

  let consent = null;
  try {
    consent = readConsentFromCookieString(document.cookie);
  } catch {
    consent = null;
  }
  if (!analyticsAllowed(consent, configured)) return;

  // Mark started before the await so concurrent callers don't double-init.
  started = true;
  try {
    const posthog = (await import("posthog-js")).default;
    posthog.init(key as string, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com",
      capture_pageview: true,
      // Don't hoover arbitrary form inputs / clicks — privacy-preserving and
      // avoids accidentally capturing customer business data.
      autocapture: false,
      disable_session_recording: true,
      person_profiles: "identified_only",
    });
  } catch (e) {
    // Roll back so a transient import failure can be retried on the next call.
    started = false;
    console.error("[analytics] PostHog init failed", e);
  }
}
