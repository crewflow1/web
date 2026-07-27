"use client";

import { useState } from "react";
import { uploadBlueprint, uploadRevision } from "./actions";
import { DISCIPLINES, DISCIPLINE_LABELS } from "@/lib/blueprints/schema";

/**
 * Blueprint Centre client surfaces — upload forms + a native drawing viewer.
 * No client PDF/canvas dependency: images render inline via <img>, PDFs via a
 * native <iframe> preview (desktop) with a guaranteed Open/Download link (the
 * real affordance on mobile, where in-frame PDF is unreliable).
 */

const fileAccept = "application/pdf,image/jpeg,image/png,image/webp";
const inputCls =
  "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none";

export function AddDrawingForm({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
      >
        + Add drawing
      </button>
    );
  }
  return (
    <form action={uploadBlueprint.bind(null, jobId)} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">Add a drawing</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Drawing number</span>
          <input name="drawing_number" required placeholder="e.g. A-201" className={inputCls} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Title</span>
          <input name="title" required placeholder="e.g. Ground Floor Plan" className={inputCls} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Discipline</span>
          <select name="discipline" className={inputCls} defaultValue="">
            <option value="">—</option>
            {DISCIPLINES.map((d) => <option key={d} value={d}>{DISCIPLINE_LABELS[d]}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Revision</span>
          <input name="revision" required placeholder="e.g. Rev A / P01" className={inputCls} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Revision date</span>
          <input name="revision_date" type="date" className={inputCls} />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Notes <span className="font-normal text-slate-400">(optional)</span></span>
        <input name="notes" className={inputCls} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Drawing file <span className="font-normal text-slate-400">(PDF or image, up to 50 MB)</span></span>
        <input name="file" type="file" accept={fileAccept} required className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium" />
      </label>
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Upload drawing</button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
      </div>
    </form>
  );
}

export function AddRevisionForm({ jobId, blueprintId }: { jobId: string; blueprintId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
        Add revision
      </button>
    );
  }
  return (
    <form action={uploadRevision.bind(null, jobId, blueprintId)} className="mt-3 grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3">
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-slate-700">Revision</span>
        <input name="revision" required placeholder="Rev B" className={inputCls} />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-slate-700">Revision date</span>
        <input name="revision_date" type="date" className={inputCls} />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-slate-700">Notes</span>
        <input name="notes" className={inputCls} />
      </label>
      <label className="block text-xs sm:col-span-3">
        <span className="mb-1 block font-medium text-slate-700">Drawing file</span>
        <input name="file" type="file" accept={fileAccept} required className="block w-full text-sm" />
      </label>
      <div className="sm:col-span-3 flex gap-2">
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">Upload revision</button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
      </div>
    </form>
  );
}

