import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { CHECK_LEVELS, CHECK_LEVEL_LABELS } from "@/lib/assets/inspection-template";
import { createTemplate } from "../../template-actions";

export const metadata = { title: "New inspection template · CrewFlow" };

export default async function NewTemplatePage() {
  await requireOrgContext();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href="/assets/templates" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
          ← Templates
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">New inspection template</h1>
        <p className="mt-1 text-sm text-slate-600">
          Start as a draft, add sections and items, then publish version 1. Only a
          published version can start inspections.
        </p>
      </header>

      <form action={createTemplate} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <label className="block text-xs font-medium text-slate-600">
          Name
          <input
            name="name"
            required
            maxLength={160}
            placeholder="e.g. 360° excavator pre-use check"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="block text-xs font-medium text-slate-600">
          Description
          <textarea
            name="description"
            rows={2}
            maxLength={1000}
            placeholder="What this checklist covers and when to use it"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="block text-xs font-medium text-slate-600">
          Check level
          <select
            name="check_level"
            defaultValue="pre_use_check"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          >
            {CHECK_LEVELS.map((l) => (
              <option key={l} value={l}>
                {CHECK_LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] font-normal text-slate-500">
            CrewFlow is the record for pre-use checks and recorded inspections.
            Thorough examinations (e.g. LOLER) record the external examiner&apos;s
            report — CrewFlow never issues certificates.
          </span>
        </label>
        <label className="block text-xs font-medium text-slate-600">
          Applies to categories
          <input
            name="categories"
            maxLength={400}
            placeholder="e.g. Plant / machinery, Lifting — comma-separated; empty = all assets"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
          Create draft
        </button>
      </form>
    </div>
  );
}
