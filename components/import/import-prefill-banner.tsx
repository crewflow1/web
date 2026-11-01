/**
 * FEATURE 2 — the banner shown atop a create form that was prefilled from an
 * imported document. Server-safe (no client hooks), so a /new server component
 * can render it directly. It is a REMINDER, never a claim that anything is
 * saved: the operator still reviews and saves through the normal workflow.
 */

import { Sparkles, FileText } from "lucide-react";

export function ImportPrefillBanner({
  engine,
  recordLabel,
}: {
  engine: string;
  recordLabel: string;
}) {
  if (engine === "vision") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <Sparkles aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
        <span>
          Prefilled from your document. These are suggestions — check every field, fix anything
          wrong, then save the {recordLabel} as usual. Nothing was saved automatically.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <FileText aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <span>
        Your document was uploaded, but AI reading isn&rsquo;t enabled on this account, so no
        values were filled in. Please complete the {recordLabel} form below.
      </span>
    </div>
  );
}
