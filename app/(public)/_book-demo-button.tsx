"use client";

/**
 * The button that opens the book-demo modal. Render anywhere on the site.
 *
 * This lives in its own tiny module (not in `_book-demo-modal.tsx`) ON PURPOSE:
 * the button is statically imported on many public/SEO pages (nav, pricing,
 * product, blog, …), so if it shared a file with the full dialog, the dialog's
 * client JS would ride into those pages' first-load bundle too. Keeping the
 * button separate lets the heavy dialog module be imported dynamically (see
 * `_book-demo-mount.tsx`) and stay out of first-load.
 *
 * Contract (unchanged): clicking dispatches the global `crewflow:open-book-demo`
 * event; the mount shell lazy-loads the dialog on the first event and the dialog
 * opens itself via its own listener.
 */
export function BookDemoButton({
  children = "Book a demo",
  className = "inline-flex h-11 items-center rounded-lg bg-gold-500 px-5 text-sm font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("crewflow:open-book-demo"))}
      className={className}
    >
      {children}
    </button>
  );
}
