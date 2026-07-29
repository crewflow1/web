"use client";

import { createCertificate } from "./actions";
import { StateForm } from "@/components/forms/StateForm";
import type { CertContent } from "@/lib/completion-certificates/schema";

/**
 * Draft completion-certificate form. Every field is customer-facing by design
 * (no cost/margin/internal inputs), so the frozen snapshot cannot leak internals.
 *
 * Posts through <StateForm> (FormState + full-document navigation) — see
 * components/forms/StateForm.tsx for why `redirect()` is unsafe at this depth.
 */
export function CertificateForm({
  jobId,
  defaults,
}: {
  jobId: string;
  defaults: Partial<CertContent>;
}) {
  return (
    <StateForm action={createCertificate.bind(null, jobId)} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Practical completion date</span>
          <input
            type="date"
            name="completion_date"
            required
            defaultValue={defaults.completion_date ?? ""}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Defects liability (months)</span>
          <input
            type="number"
            name="defects_liability_months"
            min={0}
            max={120}
            step={1}
            defaultValue={defaults.defects_liability_months ?? 12}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Works completed</span>
        <textarea
          name="works_description"
          required
          rows={3}
          placeholder="Describe the works reaching practical completion…"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Handover notes <span className="font-normal text-slate-400">(optional)</span></span>
        <textarea name="handover_notes" rows={2} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Retention note <span className="font-normal text-slate-400">(optional)</span></span>
          <input name="retention_note" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Signatory name <span className="font-normal text-slate-400">(optional)</span></span>
          <input name="signatory_name" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none" />
        </label>
      </div>
      <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
        Create draft certificate
      </button>
    </StateForm>
  );
}
