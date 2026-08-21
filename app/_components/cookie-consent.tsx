"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type ConsentState,
  analyticsAllowed,
  analyticsConfigured,
  isFirstPartySurface,
  readConsentFromCookieString,
  serializeConsentCookie,
  shouldShowBanner,
} from "@/lib/analytics/consent";
import { loadAnalyticsIfAllowed } from "@/lib/analytics/load";

/**
 * GDPR / PECR cookie-consent banner.
 *
 * Behaviour:
 *   - Renders nothing on the server and on first client paint, then decides in
 *     an effect, so there is never a hydration mismatch.
 *   - Stays DORMANT unless product analytics are actually configured (a PostHog
 *     key is set). Today there is no key, so only essential cookies are set and
 *     this never appears, matching the privacy policy.
 *   - Never mounts on the customer portal or public quote pages (first-party
 *     surfaces only), honouring the policy's "no tracking cookies for end
 *     customers" promise.
 *   - On a returning visitor who already opted in, it boots analytics straight
 *     away; on first visit it offers Accept / Reject and persists the choice.
 *
 * Mounted once in the root layout.
 */
export function CookieConsent() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const configured = analyticsConfigured(process.env.NEXT_PUBLIC_POSTHOG_KEY);
    if (!configured) return;
    if (!isFirstPartySurface(pathname)) return;

    let consent: ConsentState | null = null;
    try {
      consent = readConsentFromCookieString(document.cookie);
    } catch {
      consent = null;
    }

    // Returning visitor who already granted → start analytics now.
    if (analyticsAllowed(consent, configured)) {
      void loadAnalyticsIfAllowed();
    }
    setVisible(shouldShowBanner(consent, configured));
  }, [pathname]);

  if (!visible) return null;

  function choose(state: ConsentState) {
    try {
      document.cookie = serializeConsentCookie(state);
    } catch {
      /* If cookies are blocked there is nothing to persist; just hide. */
    }
    setVisible(false);
    if (state === "granted") void loadAnalyticsIfAllowed();
  }

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-[60] px-4 pb-4 sm:px-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-5 text-sm text-slate-200 shadow-2xl sm:flex-row sm:items-center sm:justify-between">
        <p className="leading-6">
          We use essential cookies to run CrewFlow. With your permission we&apos;d
          also like to use optional product analytics to improve the app.{" "}
          <Link
            href="/privacy"
            className="font-medium text-white underline underline-offset-2 hover:text-slate-100"
          >
            Privacy policy
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-3">
          <button
            type="button"
            onClick={() => choose("denied")}
            className="rounded-lg border border-slate-600 px-4 py-2 font-medium text-slate-200 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => choose("granted")}
            className="rounded-lg bg-white px-4 py-2 font-semibold text-slate-900 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
