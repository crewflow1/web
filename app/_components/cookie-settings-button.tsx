"use client";

import { openCookieSettings } from "@/lib/analytics/consent-client";

/**
 * The persistent "Cookie settings" entry point — how a visitor reviews, updates
 * or withdraws their cookie choice at any time (withdrawing must be as easy as
 * giving). Render it in a footer; it opens the settings dialog owned by
 * `CookieConsent` in the root layout via a window event, so it works from any
 * server or client component without prop-drilling.
 *
 * A real <button> (it performs an action, it does not navigate) styled by the
 * caller to sit alongside that surface's footer links.
 */
export function CookieSettingsButton({
  className,
  children = "Cookie settings",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-cookie-settings-trigger=""
      onClick={openCookieSettings}
      className={className}
    >
      {children}
    </button>
  );
}
