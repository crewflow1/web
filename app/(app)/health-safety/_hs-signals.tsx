import Link from "next/link";
import type { HsSignal } from "@/lib/health-safety/signals";

/**
 * Health & Safety "needs attention" panel — renders the deterministic action
 * signals (draft RAMS, review overdue, permits expiring/expired, active jobs
 * without a RAMS, critical residual risk). Colour reinforces the tone; the label
 * carries the meaning (a11y). Hidden entirely when nothing needs attention.
 */

const TONE: Record<HsSignal["tone"], string> = {
  danger: "border-red-200 bg-red-50 text-red-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-slate-200 bg-slate-50 text-slate-700",
};

const TONE_ICON: Record<HsSignal["tone"], string> = { danger: "●", warn: "▲", info: "○" };

export function HealthSafetySignals({ signals }: { signals: HsSignal[] }) {
  if (signals.length === 0) return null;
  return (
    <section
      aria-labelledby="hs-signals-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 id="hs-signals-heading" className="text-sm font-semibold text-slate-900">
        Needs attention
      </h2>
      <ul className="mt-3 space-y-2">
        {signals.map((sig) => (
          <li key={sig.id}>
            <Link
              href={sig.href}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 transition hover:brightness-[0.97] ${TONE[sig.tone]}`}
            >
              <span aria-hidden className="mt-0.5 text-xs">{TONE_ICON[sig.tone]}</span>
              <span>
                <span className="block text-sm font-semibold">{sig.title}</span>
                <span className="mt-0.5 block text-xs opacity-90">{sig.body}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
