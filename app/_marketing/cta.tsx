"use client";

/**
 * Marketing "Book a demo" trigger.
 *
 * Dispatches the SAME global event the existing <BookDemoButton> uses
 * (`crewflow:open-book-demo`), so the unchanged <BookDemoModal> opens and
 * the /api/demo funnel is preserved exactly. This component exists only to
 * give the dark/gold marketing theme full styling control via className.
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
      onClick={() =>
        window.dispatchEvent(new Event("crewflow:open-book-demo"))
      }
    >
      {children}
    </button>
  );
}
