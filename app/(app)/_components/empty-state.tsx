import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Empty state — consistent treatment across list pages.
 *
 * Used when a table or section has zero rows. Surfaces a clear next
 * action so users never see a dead end. Designed to live inside the
 * same bordered card the list would render, so the page layout
 * doesn't jump between empty and populated states.
 */

export function EmptyState({
  icon,
  title,
  body,
  primary,
  secondary,
}: {
  /** Optional emoji or single SVG character; rendered ~2× the body text. */
  icon?: string;
  title: string;
  body: ReactNode;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon ? (
        <div aria-hidden className="mb-3 text-3xl">
          {icon}
        </div>
      ) : null}
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <div className="mt-1 max-w-md text-sm text-slate-600">{body}</div>
      {primary || secondary ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          {primary ? (
            <Link
              href={primary.href}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              {primary.label}
            </Link>
          ) : null}
          {secondary ? (
            <Link
              href={secondary.href}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              {secondary.label}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
