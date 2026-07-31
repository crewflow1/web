"use client";

import { createWarranty } from "./actions";
import { StateForm } from "@/components/forms/StateForm";
import { WARRANTY_KINDS } from "@/lib/warranties/schema";
import { WARRANTY_KIND_LABELS } from "@/lib/warranties/schedule";

/**
 * New-warranty form.
 *
 * There is deliberately NO start-date and NO expiry input. Both are derived from
 * the frozen completion date on the job's issued completion certificate, so a
 * field here would create a second completion date free to disagree with the
 * certificate the customer was served.
 *
 * Every field on this form is customer-facing — the portal renders title, cover,
 * exclusions, provider, reference and the servicing notes verbatim. There is no
 * internal-notes field for that reason: a box whose contents were secret on one
 * screen and public on another is exactly the defect the portal jobs page had.
 *
 * Posts through <StateForm> (FormState + full-document navigation) — see
 * components/forms/StateForm.tsx for why `redirect()` is unsafe at this depth.
 */
export function WarrantyForm({ jobId }: { jobId: string }) {
  return (
    <StateForm action={createWarranty.bind(null, jobId)} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Title</span>
          <input
            name="title"
            required
            maxLength={200}
            placeholder="e.g. Workmanship warranty"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Type</span>
          <select
            name="kind"
            defaultValue="workmanship"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          >
            {WARRANTY_KINDS.map((k) => (
              <option key={k} value={k}>
                {WARRANTY_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">
          What it covers{" "}
          <span className="font-normal text-slate-500">(the customer sees this)</span>
        </span>
        <textarea
          name="cover"
          required
          rows={3}
          maxLength={4000}
          placeholder="e.g. All labour and workmanship on the roof covering, flashings and rainwater goods."
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">
          What it doesn&apos;t cover{" "}
          <span className="font-normal text-slate-500">(optional, also shown)</span>
        </span>
        <textarea
          name="exclusions"
          rows={2}
          maxLength={4000}
          placeholder="e.g. Storm damage, misuse, or work by others."
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Period (months)</span>
          <input
            type="number"
            name="period_months"
            required
            min={1}
            max={600}
            step={1}
            defaultValue={12}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Service every{" "}
            <span className="font-normal text-slate-500">(months, optional)</span>
          </span>
          <input
            type="number"
            name="service_interval_months"
            min={1}
            max={120}
            step={1}
            placeholder="e.g. 12"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Provider <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <input
            name="provider"
            maxLength={200}
            placeholder="e.g. Vaillant"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Reference <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <input
            name="reference"
            maxLength={120}
            placeholder="Policy / serial number"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Servicing notes <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <input
            name="service_notes"
            maxLength={2000}
            placeholder="e.g. Annual service by a Gas Safe engineer"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
      </div>

      <button
        type="submit"
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
      >
        Add warranty
      </button>
    </StateForm>
  );
}
