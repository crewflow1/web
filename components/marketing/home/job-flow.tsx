import { CoordTag } from "@/components/marketing/setting-out";

/**
 * Signature moment — "One job, end to end."
 *
 * A single illustrative job travels the full CrewFlow spine: Lead → Quote →
 * Accepted → Site (RAMS/diary/drawings) → Variation → Valuation → Invoice →
 * Cash → Control. The stations the trade-app crowd omits (Site, Variation,
 * Valuation) are the whole point — they're what proves this is an ERP.
 *
 * Static + reduced-motion-safe by construction (a finished setting-out diagram).
 * Scroll-reveal + line-draw motion is layered on separately without changing
 * this baseline. Figures are an ILLUSTRATIVE worked example, labelled as such —
 * not a customer metric.
 */

const STATIONS = [
  { n: "01", label: "Lead", note: "Enquiry logged" },
  { n: "02", label: "Quote", note: "Line-item + VAT" },
  { n: "03", label: "Accepted", note: "e-signed → job" },
  { n: "04", label: "Site", note: "RAMS · diary · drawings" },
  { n: "05", label: "Variation", note: "Captured, not lost" },
  { n: "06", label: "Retention", note: "Held & released" },
  { n: "07", label: "Invoice", note: "Chases itself" },
  { n: "08", label: "Cash", note: "Bank transfer" },
  { n: "09", label: "Control", note: "Margin, live" },
];

export function JobFlow() {
  return (
    <section className="relative border-t border-white/5">
      <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
        <CoordTag>Example job · Kitchen extension, Belfast</CoordTag>
        <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
          One job, end to end.
        </h2>
        <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-mut">
          You enter it once. CrewFlow carries it from the first call to the
          bank — including the site and commercial work that wins bigger jobs.
        </p>

        {/* Desktop: horizontal setting-out rail */}
        <ol className="relative mt-16 hidden grid-cols-9 lg:grid" aria-label="How a job flows through CrewFlow">
          <span
            aria-hidden="true"
            className="jf-rail absolute left-[5.55%] right-[5.55%] top-[6px] h-px bg-gradient-to-r from-blueprint via-blueprint to-gold-500"
          />
          {STATIONS.map((s, i) => {
            const last = i === STATIONS.length - 1;
            return (
              <li key={s.n} className="relative flex flex-col items-center px-1.5 text-center">
                <span
                  aria-hidden="true"
                  className={`relative z-10 h-3.5 w-3.5 rounded-full border-2 ${
                    last ? "border-gold-500 bg-gold-500" : "border-blueprint bg-navy-950"
                  }`}
                />
                <span className="mt-4 font-mono text-[10px] tabular-nums text-ink-dim">{s.n}</span>
                <span className="mt-1.5 font-display text-sm font-bold text-ink">{s.label}</span>
                <span className="mt-1 text-xs leading-snug text-ink-dim">{s.note}</span>
              </li>
            );
          })}
        </ol>

        {/* Mobile: vertical setting-out rail */}
        <ol className="relative mt-12 lg:hidden" aria-label="How a job flows through CrewFlow">
          <span
            aria-hidden="true"
            className="jf-rail-v absolute bottom-3 left-[6px] top-2 w-px bg-gradient-to-b from-blueprint via-blueprint to-gold-500"
          />
          {STATIONS.map((s, i) => {
            const last = i === STATIONS.length - 1;
            return (
              <li key={s.n} className="relative flex gap-4 pb-7 last:pb-0">
                <span
                  aria-hidden="true"
                  className={`relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                    last ? "border-gold-500 bg-gold-500" : "border-blueprint bg-navy-950"
                  }`}
                />
                <span className="min-w-0">
                  <span className="font-mono text-[10px] tabular-nums text-ink-dim">{s.n}</span>
                  <span className="ml-2 font-display text-base font-bold text-ink">{s.label}</span>
                  <span className="mt-0.5 block text-sm text-ink-dim">{s.note}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
