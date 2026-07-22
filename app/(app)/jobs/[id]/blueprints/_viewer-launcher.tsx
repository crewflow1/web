"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";

/**
 * "View" trigger for a drawing. Opens the full-screen interactive viewer, which
 * is `next/dynamic({ssr:false})` so pdf.js loads ONLY when a drawing is opened —
 * never on the register list, never in the shared bundle, never under SSR.
 * Restores focus to the trigger on close (a11y).
 */
const BlueprintViewer = dynamic(() => import("./_pdf-viewer"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/95">
      <div className="h-40 w-56 animate-pulse rounded bg-slate-700" aria-hidden />
    </div>
  ),
});

export function ViewerLauncher(props: {
  jobId: string;
  versionId: string;
  mime: string;
  label: string;
  drawingNumber: string;
  revision: string;
  supersededNotice: string | null;
  canDeletePins: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); btnRef.current?.focus(); };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
      >
        View
      </button>
      {open ? <BlueprintViewer {...props} onClose={close} /> : null}
    </>
  );
}
