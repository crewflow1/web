"use client";

/**
 * Marketing "Book a demo" trigger.
 *
 * Dispatches the SAME global event the existing app uses
 * (`crewflow:open-book-demo`), so the unchanged <BookDemoModal> opens and
 * the /api/demo (demo_requests) funnel is preserved exactly. This exists
 * only so the dark/gold marketing theme gets full styling control via
 * className. No mailto, no new endpoint.
 */

import type { ReactNode } from "react";

export function BookDemoCta({
  className,
  children = "Book a demo",
  ariaLabel,
}: {
  className?: string;
  children?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={className}
      onClick={() => window.dispatchEvent(new Event("crewflow:open-book-demo"))}
    >
      {children}
    </button>
  );
}
