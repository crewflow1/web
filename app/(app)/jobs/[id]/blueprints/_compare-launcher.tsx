"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { CompareVersion } from "@/lib/blueprints/compare";

/**
 * "Compare revisions" trigger. Opens the full-screen comparison via
 * next/dynamic({ssr:false}) — so pdf.js (loaded by the two DrawingRenderSurfaces)
 * stays out of SSR and the shared bundle, exactly like the single viewer. Only
 * rendered when a drawing has ≥2 versions (nothing to compare otherwise).
 */

const BlueprintCompare = dynamic(() => import("./_compare"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/95 text-sm text-white">Loading comparison…</div>,
});

export function CompareLauncher(props: {
  jobId: string;
  blueprintId: string;
  drawingNumber: string;
  title: string;
  versions: CompareVersion[];
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  if (props.versions.length < 2) return null;
  const close = () => { setOpen(false); btnRef.current?.focus(); };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
      >
        Compare revisions
      </button>
      {open ? <BlueprintCompare {...props} onClose={close} /> : null}
    </>
  );
}
