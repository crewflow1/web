"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  type ConsentCategories,
  type ConsentCategory,
  type ConsentRecord,
  allDenied,
  allGranted,
} from "@/lib/analytics/consent";
import { FOCUSABLE, nextTrapIndex } from "@/components/ui/focus-trap";

/**
 * Cookie settings — the category-level view of the consent choice.
 *
 * Opened from the banner's "Customise" and from every "Cookie settings" footer
 * link, so it is both the granular first choice and the update / withdraw path.
 *
 * Honest by construction:
 *   - Optional categories start OFF unless the visitor already turned them on.
 *   - Only categories this deployment can actually run are listed.
 *   - "Reject all" and "Accept all" are the same size and style; nothing is
 *     pre-ticked, nudged or hidden behind a second step.
 *
 * Keyboard / screen-reader contract (same as components/ui/modal.tsx, whose
 * focus-trap helpers this reuses): `role="dialog"` + `aria-modal` on the panel,
 * named by its heading, focus moves in on open and back to the trigger on
 * close, Tab is trapped, Escape and the backdrop close without saving, and the
 * page behind does not scroll. Each toggle is a real `role="switch"` button
 * with its state also written as text, so it never relies on colour alone.
 *
 * Styled in the banner's own neutral dark card so it reads the same on the dark
 * marketing site and the light product. Loaded on demand (see cookie-consent).
 */

const CATEGORY_COPY: Record<ConsentCategory, { title: string; body: string }> = {
  analytics: {
    title: "Product analytics",
    body:
      "Usage statistics (PostHog, hosted in the EU) so we can see which pages and " +
      "features get used. Sets a cookie with a random visitor ID. No session " +
      "recording and no advertising.",
  },
  performance: {
    title: "Performance monitoring",
    body:
      "Session-health and page-speed measurements (Sentry) so we can spot a slow " +
      "or unreliable release. Sets no cookies.",
  },
};

const CHOICE_BUTTON =
  "min-h-[44px] rounded-lg border border-slate-500 px-4 py-2 font-semibold text-white " +
  "transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-white";

function formatDecidedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function CookieSettingsDialog({
  record,
  configured,
  onSave,
  onClose,
}: {
  /** The stored choice, if any — seeds the toggles. */
  record: ConsentRecord | null;
  /** The optional categories this deployment can run. */
  configured: readonly ConsentCategory[];
  onSave: (categories: ConsentCategories) => void;
  /** Close without changing anything (Escape, backdrop, ✕). */
  onClose: () => void;
}) {
  const titleId = useId();
  const introId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [choices, setChoices] = useState<ConsentCategories>(() => ({
    ...allDenied(),
    ...(record?.categories ?? {}),
  }));

  // Focus in on open; restore to the trigger on close.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  // The page behind a modal must not scroll under it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const target = nextTrapIndex(
      focusable.length,
      focusable.indexOf(document.activeElement as HTMLElement),
      event.shiftKey,
    );
    if (target === null) return;
    event.preventDefault();
    (focusable[target] ?? panel).focus();
  }

  const decidedOn = formatDecidedAt(record?.decidedAt ?? null);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/70 px-4 py-6 sm:items-center"
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        className="relative max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 text-sm text-slate-200 shadow-2xl sm:p-6"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close cookie settings"
          className="absolute right-3 top-3 rounded-md p-2 text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <span aria-hidden="true">✕</span>
        </button>

        <h2
          ref={headingRef}
          id={titleId}
          tabIndex={-1}
          className="pr-10 text-lg font-semibold text-white outline-none"
        >
          Cookie settings
        </h2>
        <p id={introId} className="mt-2 leading-6 text-slate-300">
          Choose what CrewFlow may use on this device. Anything optional stays
          off unless you switch it on, and you can change your mind here at any
          time.{" "}
          <Link
            href="/privacy#cookies"
            className="font-medium text-white underline underline-offset-2 hover:text-slate-100"
          >
            Privacy policy
          </Link>
          .
        </p>

        <ul className="mt-5 divide-y divide-slate-700 border-y border-slate-700">
          <li className="flex items-start justify-between gap-4 py-4">
            <div>
              <p className="font-semibold text-white">Strictly necessary</p>
              <p className="mt-1 leading-6 text-slate-300">
                Signing in, security, remembering this choice, and reporting a
                fault when something breaks. The site and app can&apos;t run
                without these.
              </p>
            </div>
            <span className="shrink-0 pt-0.5 text-xs font-semibold uppercase tracking-wide text-slate-300">
              Always on
            </span>
          </li>

          {configured.map((category) => {
            const copy = CATEGORY_COPY[category];
            const on = choices[category];
            const labelId = `${titleId}-${category}-label`;
            const bodyId = `${titleId}-${category}-body`;
            return (
              <li
                key={category}
                className="flex items-start justify-between gap-4 py-4"
              >
                <div>
                  <p id={labelId} className="font-semibold text-white">
                    {copy.title}
                  </p>
                  <p id={bodyId} className="mt-1 leading-6 text-slate-300">
                    {copy.body}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-labelledby={labelId}
                  aria-describedby={bodyId}
                  data-consent-category={category}
                  onClick={() =>
                    setChoices((prev) => ({ ...prev, [category]: !prev[category] }))
                  }
                  className="group flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <span
                    aria-hidden="true"
                    className={`relative inline-block h-6 w-11 rounded-full border transition-colors ${
                      on
                        ? "border-white bg-white"
                        : "border-slate-400 bg-slate-800"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-[18px] w-[18px] rounded-full transition-[left] ${
                        on ? "left-[22px] bg-slate-900" : "left-0.5 bg-slate-300"
                      }`}
                    />
                  </span>
                  <span
                    aria-hidden="true"
                    className="w-6 text-xs font-semibold uppercase tracking-wide text-slate-200"
                  >
                    {on ? "On" : "Off"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {configured.length === 0 ? (
          <p className="mt-4 leading-6 text-slate-300">
            CrewFlow only uses strictly necessary cookies right now, so there is
            nothing optional to switch on or off.
          </p>
        ) : null}

        {decidedOn ? (
          <p className="mt-4 text-xs text-slate-400">
            Your current choice was saved on {decidedOn}.
          </p>
        ) : null}

        {configured.length > 0 ? (
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => onSave(allDenied())}
              className={CHOICE_BUTTON}
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={() => onSave(allGranted())}
              className={CHOICE_BUTTON}
            >
              Accept all
            </button>
            <button
              type="button"
              onClick={() => onSave(choices)}
              className="col-span-2 min-h-[44px] rounded-lg bg-white px-4 py-2 font-semibold text-slate-900 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 sm:col-span-1"
            >
              Save choices
            </button>
          </div>
        ) : (
          <div className="mt-5 flex justify-end">
            <button type="button" onClick={onClose} className={CHOICE_BUTTON}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
