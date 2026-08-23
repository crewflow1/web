import { Badge } from "@/components/ui/badge";
import {
  PRESENTATION_STATES,
  PRESENTATION_META,
  type PresentationBadge,
} from "@/lib/hq/presentation-state";

/**
 * The one decision/work state pill (product UX rebuild, HQ phase). Renders a
 * PresentationBadge from lib/hq/presentation-state — the single vocabulary the
 * Decision area (approvals · decisions · sagas · tasks · "what needs you")
 * speaks. Server-safe; colour never carries meaning alone — the label is always
 * present.
 */
export function DecisionStateBadge({
  badge,
  className,
}: {
  badge: PresentationBadge;
  className?: string;
}) {
  return (
    <Badge tone={badge.tone} className={className}>
      {badge.label}
      {badge.urgent ? " · escalated" : ""}
    </Badge>
  );
}

/**
 * The learnable legend — the eight-word language explained once. Native
 * `<details>` (no client JS). Drop it at the foot of a decision surface so the
 * vocabulary is teachable, and so the honest nuances (Ready = granted but not
 * run; a decision's Completed = the call is recorded) are stated plainly.
 */
export function DecisionStateLegend() {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white text-sm shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-medium text-slate-700 hover:text-slate-900">
        <span>What these states mean</span>
        <span className="text-slate-400 transition group-open:rotate-180" aria-hidden>
          ⌄
        </span>
      </summary>
      <ul className="space-y-2.5 border-t border-slate-100 px-4 py-3">
        {PRESENTATION_STATES.map((s) => (
          <li key={s} className="flex items-start gap-3">
            <span className="w-32 shrink-0">
              <Badge tone={PRESENTATION_META[s].tone}>{PRESENTATION_META[s].label}</Badge>
            </span>
            <span className="text-slate-600">{PRESENTATION_META[s].blurb}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
