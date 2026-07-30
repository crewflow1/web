import type { HoldPointWarning } from "@/lib/quality/itp";

/**
 * The hold-point WARN seam, rendered.
 *
 * This component is the ONLY thing an open hold point does to the UI: it warns.
 * No control anywhere in /quality is disabled, hidden or refused because a hold
 * point is open — recording an inspection out of sequence stays possible, and
 * the database stamps it permanently (`hold_point_breach`) so the fact survives.
 * See lib/quality/itp.ts holdPointWarnings for the reasoning and the H&S
 * precedent it follows.
 *
 * Colour reinforces the tone; the label always carries the meaning (a11y).
 */

const TONE: Record<HoldPointWarning["tone"], string> = {
  danger: "border-red-200 bg-red-50 text-red-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
};

const TONE_ICON: Record<HoldPointWarning["tone"], string> = { danger: "●", warn: "▲" };

export function HoldPointWarnings({ warnings }: { warnings: HoldPointWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section aria-labelledby="quality-warn-heading" className="space-y-2">
      <h2 id="quality-warn-heading" className="sr-only">
        Outstanding quality warnings
      </h2>
      <ul className="space-y-2">
        {warnings.map((w) => (
          <li
            key={w.id}
            className={`flex items-start gap-2 rounded-xl border px-4 py-3 ${TONE[w.tone]}`}
          >
            <span aria-hidden className="mt-0.5 text-xs">
              {TONE_ICON[w.tone]}
            </span>
            <span>
              <span className="block text-sm font-semibold">{w.title}</span>
              <span className="mt-0.5 block text-xs opacity-90">{w.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
