import Link from "next/link";
import { PILLARS } from "@/lib/marketing/pillars";
import { CoordTag } from "@/components/marketing/setting-out";

/**
 * Beat 4 — the six pillars, as a construction "drawing register" (index), not a
 * six-card grid. Outcome-first per pillar, capability chips, and "Explore →" to
 * the pillar page (progressive disclosure). Breadth presented as structure.
 */
export function PillarsIndex() {
  return (
    <section className="relative border-t border-white/5 bg-navy-900">
      <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
        <CoordTag>The platform · six pillars</CoordTag>
        <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
          One system. Six parts of the business.
        </h2>
        <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-mut">
          Enter something once and it flows through the rest — win the work, run
          the job, prove the site, get paid, and keep the crew and kit organised.
        </p>

        <ol className="mt-12 border-t border-white/10">
          {PILLARS.map((p) => (
            <li key={p.slug}>
              <Link
                href={`/product/${p.slug}`}
                className="group grid grid-cols-1 gap-3 border-b border-white/10 py-7 transition-colors hover:bg-white/[0.02] focus-visible:outline-none focus-visible:bg-white/[0.03] md:grid-cols-[3rem_1fr_auto] md:items-baseline md:gap-8"
              >
                <span className="font-mono text-sm tabular-nums text-gold-500">{p.n}</span>
                <span className="min-w-0">
                  <span className="font-display text-xl font-bold text-ink">{p.label}</span>
                  <span className="mt-1.5 block max-w-2xl text-[15px] leading-relaxed text-ink-mut">
                    {p.summary}
                  </span>
                  <span className="mt-3.5 flex flex-wrap gap-1.5">
                    {p.capabilities.slice(0, 5).map((c) => (
                      <span
                        key={c.name}
                        className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-ink-dim"
                      >
                        {c.name}
                      </span>
                    ))}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="hidden items-center gap-1.5 self-center whitespace-nowrap font-mono text-xs uppercase tracking-wider text-ink-dim transition-colors group-hover:text-gold-500 md:inline-flex"
                >
                  Explore{" "}
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
