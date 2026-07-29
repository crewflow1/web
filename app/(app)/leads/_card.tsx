import Link from "next/link";
import { moveLeadStage } from "./actions";
import {
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_URGENCY_STYLES,
  type LeadStage,
  type LeadUrgency,
} from "@/lib/leads/schema";

/**
 * Pipeline card for a single lead.
 *
 * The "Move →" form is a server-side dropdown — submitting the form
 * fires moveLeadStage. Cheap, works on mobile, no client JS required.
 * For a full drag-drop polish pass we'd swap this for a tap-to-pick
 * sheet on small screens and HTML5 drag on desktop.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 0,
});

export type PipelineLead = {
  id: string;
  service: string | null;
  source: string;
  urgency: string | null;
  postcode: string | null;
  estimated_value: number | null;
  status: LeadStage;
  last_activity_at: string;
  customer_name: string | null;
  assigned_name: string | null;
};

export function LeadCard({ lead }: { lead: PipelineLead }) {
  const moveAction = moveLeadStage.bind(null, lead.id);
  const urgency = (lead.urgency ?? "normal") as LeadUrgency;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <Link
        href={`/leads/${lead.id}`}
        className="block hover:text-slate-900"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-900">
              {lead.customer_name ?? "Unknown customer"}
            </div>
            <div className="truncate text-xs text-slate-500">
              {lead.service ?? "—"}
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${LEAD_URGENCY_STYLES[urgency] ?? "bg-slate-100 text-slate-600"}`}
          >
            {urgency}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500">
          <span className="truncate">
            {lead.assigned_name ?? "Unassigned"}
          </span>
          <span className="shrink-0 font-medium text-slate-900">
            {lead.estimated_value ? GBP.format(lead.estimated_value) : "—"}
          </span>
        </div>

        <div className="mt-1 text-[11px] text-slate-500">
          {lead.source} · {lead.postcode ?? "—"} · {lead.last_activity_at.slice(0, 10)}
        </div>
      </Link>

      {/* Stage mover */}
      <form action={moveAction} className="mt-2 flex items-center gap-1.5">
        <label className="sr-only" htmlFor={`stage-${lead.id}`}>
          Move stage
        </label>
        <select
          id={`stage-${lead.id}`}
          name="status"
          defaultValue={lead.status}
          className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
        >
          {LEAD_STAGES.map((s) => (
            <option key={s} value={s}>
              {LEAD_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800"
        >
          Move
        </button>
      </form>
    </li>
  );
}
