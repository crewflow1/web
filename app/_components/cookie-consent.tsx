"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type ConsentCategories,
  type ConsentCategory,
  type ConsentRecord,
  CONSENT_CATEGORIES,
  allDenied,
  allGranted,
  categoryAllowed,
  isFirstPartySurface,
  needsDecision,
} from "@/lib/analytics/consent";
import {
  OPEN_COOKIE_SETTINGS_EVENT,
  clientConfiguredCategories,
  readStoredConsent,
  storeConsent,
} from "@/lib/analytics/consent-client";
import { loadAnalyticsIfAllowed, stopAnalytics } from "@/lib/analytics/load";

/**
 * The settings dialog is only needed once someone asks for it, so it is loaded
 * on demand and stays out of every page's first-load JS (same pattern as the
 * book-demo modal).
 */
const CookieSettingsDialog = dynamic(
  () =>
    import("./cookie-settings-dialog").then((m) => m.CookieSettingsDialog),
  { ssr: false },
);

/** How each optional category is named in the banner sentence. */
const BANNER_PHRASE: Record<ConsentCategory, string> = {
  analytics: "product analytics",
  performance: "performance monitoring",
};

/** Reject and Accept share ONE style on purpose — neither is the "easy" path. */
const BANNER_CHOICE =
  "min-h-[44px] rounded-lg bg-white px-4 py-2 font-semibold text-slate-900 transition " +
  "hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900";

/**
 * GDPR / PECR cookie consent — banner + settings dialog + enforcement.
 *
 * Behaviour:
 *   - Renders nothing on the server and on first client paint, then decides in
 *     an effect, so there is never a hydration mismatch. The banner is
 *     `position: fixed`, so it never shifts layout and never blocks the page.
 *   - The banner stays DORMANT unless an optional category is actually
 *     configured (PostHog key and/or the browser Sentry SDK). With nothing
 *     configured only essential cookies are set and it never appears.
 *   - Default-denied: nothing optional runs until the visitor says yes. The
 *     banner offers Reject all / Accept all (equal prominence) and Customise
 *     (per-category switches); the choice is stored as a versioned, timestamped
 *     record for a year.
 *   - Update / withdraw: any "Cookie settings" link fires
 *     `crewflow:open-cookie-settings`, which opens the same dialog. Switching a
 *     category off stops it immediately and clears its cookies / storage.
 *   - Never mounts on the customer portal, public quote, worker portal or
 *     public enquiry pages (external surfaces), honouring the policy's "no
 *     tracking cookies for end customers" promise.
 *   - On a returning visitor who already opted in, it boots analytics straight
 *     away.
 *
 * Mounted once in the root layout.
 */
export function CookieConsent() {
  const pathname = usePathname();
  const [bannerDue, setBannerDue] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [record, setRecord] = useState<ConsentRecord | null>(null);
  // Build-time constant (NEXT_PUBLIC_* inlined), so a ref-stable array is fine.
  const [configured] = useState<ConsentCategory[]>(clientConfiguredCategories);
  const customiseRef = useRef<HTMLButtonElement>(null);
  const refocusBanner = useRef(false);

  /** Make the running page match a record: start what is allowed, stop the rest. */
  const enforce = useCallback(
    (next: ConsentRecord | null) => {
      if (categoryAllowed(next, "analytics", configured)) {
        void loadAnalyticsIfAllowed();
      } else {
        // Also clears analytics cookies left by an earlier visit / expired choice.
        stopAnalytics();
      }
      // "performance" needs no start/stop here: the Sentry transport reads the
      // stored record live on every send (lib/monitoring/consent-transport.ts).
    },
    [configured],
  );

  useEffect(() => {
    if (!isFirstPartySurface(pathname)) {
      setBannerDue(false);
      setDialogOpen(false);
      return;
    }
    const stored = readStoredConsent();
    setRecord(stored);
    enforce(stored);
    setBannerDue(needsDecision(stored, configured));
  }, [pathname, configured, enforce]);

  // Any "Cookie settings" entry point opens the dialog via this window event.
  useEffect(() => {
    function open() {
      if (!isFirstPartySurface(window.location.pathname)) return;
      setRecord(readStoredConsent());
      setDialogOpen(true);
    }
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, open);
  }, []);

  // Closing the dialog without a choice re-shows the banner; put focus back on
  // the control that opened it rather than dropping it at the top of the page.
  useEffect(() => {
    if (dialogOpen || !refocusBanner.current) return;
    refocusBanner.current = false;
    customiseRef.current?.focus();
  }, [dialogOpen]);

  function decide(choice: ConsentCategories) {
    // A category can only be granted if it was actually on offer — "Accept all"
    // never pre-authorises something this deployment did not show.
    const offered = allDenied();
    for (const c of CONSENT_CATEGORIES) {
      offered[c] = choice[c] === true && configured.includes(c);
    }
    const stored = storeConsent(offered);
    setRecord(stored);
    setBannerDue(false);
    setDialogOpen(false);
    enforce(stored);
  }

  const bannerVisible = bannerDue && !dialogOpen;
  const optionalList = configured.map((c) => BANNER_PHRASE[c]).join(" and ");

  return (
    <>
      {bannerVisible ? (
        <div
          role="region"
          aria-label="Cookie consent"
          className="fixed inset-x-0 bottom-0 z-[60] px-4 pb-4 sm:px-6"
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-5 text-sm text-slate-200 shadow-2xl lg:flex-row lg:items-center lg:justify-between">
            <p className="leading-6">
              We use essential cookies to run CrewFlow. With your permission
              we&apos;d also like to use optional {optionalList} to improve the
              app.{" "}
              <Link
                href="/privacy#cookies"
                className="font-medium text-white underline underline-offset-2 hover:text-slate-100"
              >
                Privacy policy
              </Link>
              .
            </p>
            <div className="grid shrink-0 grid-cols-2 gap-3 sm:flex">
              <button
                type="button"
                onClick={() => decide(allDenied())}
                className={BANNER_CHOICE}
              >
                Reject all
              </button>
              <button
                type="button"
                onClick={() => decide(allGranted())}
                className={BANNER_CHOICE}
              >
                Accept all
              </button>
              <button
                ref={customiseRef}
                type="button"
                onClick={() => {
                  refocusBanner.current = true;
                  setDialogOpen(true);
                }}
                className="col-span-2 min-h-[44px] rounded-lg border border-slate-500 px-4 py-2 font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Customise
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialogOpen ? (
        <CookieSettingsDialog
          record={record}
          configured={configured}
          onSave={decide}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}
