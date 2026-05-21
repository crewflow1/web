"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Reusable "send this link to your client" panel.
 *
 * Rendered on the quote detail (/quotes/[id]) and customer detail
 * (/customers/[id]) pages. The actual link is built upstream — this
 * component just gives the operator every reasonable way to push it
 * out:
 *
 *   - Click-to-open primary link
 *   - Copy with a "Copied!" success state
 *   - Open in new tab
 *   - Email (mailto:) with a sensible subject + body
 *   - WhatsApp (wa.me/?text=...) with a pre-filled message
 *   - Mobile native share (navigator.share) when supported
 *
 * Keeps a single source of truth for the surface so we don't have
 * three flavours of "copy this link" drifting across the app.
 */

type Props = {
  /** Heading text — defaults to the CEO-directive copy. */
  title?: string;
  /** Short helper line under the heading. */
  hint?: string;
  /** Fully qualified URL — must be absolute (https://...) for share targets. */
  url: string;
  /** Used in the email subject + WhatsApp body. */
  subject?: string;
  /** Used in the email body + WhatsApp body before the URL. */
  bodyText?: string;
};

export function ShareLinkPanel({
  title = "Send this link to your client",
  hint,
  url,
  subject = "Your link from CrewFlow",
  bodyText,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  // navigator.share is only present in secure contexts on mobile — feature-
  // detect after mount to avoid an SSR/hydration mismatch.
  useEffect(() => {
    setCanShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard API can fail in non-secure contexts. Fall back to a
      // text-selection prompt so the operator at least sees the URL.
      window.prompt("Copy this link", url);
    }
  }, [url]);

  const onNativeShare = useCallback(async () => {
    if (!canShare) return;
    try {
      await navigator.share({ title: subject, text: bodyText ?? "", url });
    } catch {
      // User cancelled or share failed — silently ignore. The other
      // buttons are still available.
    }
  }, [canShare, subject, bodyText, url]);

  const bodyPrefix = bodyText ? `${bodyText}\n\n` : "";
  const mailtoHref = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    `${bodyPrefix}${url}`,
  )}`;
  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(`${bodyPrefix}${url}`)}`;

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {hint ? (
          <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
        ) : null}
      </div>

      <div className="space-y-3 p-4">
        {/* Big tappable link row */}
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Open the share link in a new tab"
          >
            {url}
          </a>
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copy link to clipboard"
            className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-xs font-semibold text-white shadow-sm transition ${
              copied
                ? "bg-emerald-600 hover:bg-emerald-700"
                : "bg-slate-900 hover:bg-slate-800"
            }`}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <span aria-hidden>↗</span> Open
          </a>
          <a
            href={mailtoHref}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <span aria-hidden>✉</span> Email
          </a>
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-100"
          >
            <span aria-hidden>💬</span> WhatsApp
          </a>
          {canShare ? (
            <button
              type="button"
              onClick={onNativeShare}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <span aria-hidden>⤴</span> Share…
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
