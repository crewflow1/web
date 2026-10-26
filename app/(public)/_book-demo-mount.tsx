"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";

/**
 * Lazy-mount shell for the book-demo modal.
 *
 * The full dialog (`BookDemoModal`, ~380 lines of client JS) used to be
 * statically mounted in both public layouts, so it shipped in the first-load
 * bundle of every marketing/SEO page even though it only ever appears after a
 * user fires `crewflow:open-book-demo` (via <BookDemoButton/>). This shell is
 * tiny and always mounted: it listens for that same event and imports the
 * dialog on the FIRST open, then re-fires the event so the just-mounted dialog
 * opens and captures return-focus exactly as it did before.
 *
 * Behaviour-identical: every open still flows through the `crewflow:open-book-demo`
 * event and the dialog's own open handler. The only change is that the very
 * first open pays a one-off async chunk fetch (a few KB) before the overlay
 * appears — imperceptible, user-initiated, and with no layout shift (the dialog
 * is a fixed overlay that renders nothing until open). Subsequent opens go
 * straight through the already-mounted dialog's listener.
 */
export function BookDemoModalMount() {
  const [Modal, setModal] = useState<ComponentType | null>(null);
  const loadStartedRef = useRef(false);

  useEffect(() => {
    function onOpen() {
      // Once the dialog module is loaded it mounts its own event listener and
      // owns every subsequent open, so the shell only ever loads it once.
      if (loadStartedRef.current) return;
      loadStartedRef.current = true;
      void import("./_book-demo-modal").then((m) => {
        setModal(() => m.BookDemoModal);
        // The dialog just mounted and missed the event that triggered this
        // load. Re-fire on the next frame — after React has committed the mount
        // and the dialog's listener is attached — so it opens and records the
        // trigger element for focus-return, identical to the always-mounted path.
        requestAnimationFrame(() =>
          window.dispatchEvent(new Event("crewflow:open-book-demo")),
        );
      });
    }
    window.addEventListener("crewflow:open-book-demo", onOpen);
    return () => window.removeEventListener("crewflow:open-book-demo", onOpen);
  }, []);

  return Modal ? <Modal /> : null;
}
