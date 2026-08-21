import Link from "next/link";
import { PILLARS } from "@/lib/marketing/pillars";

/**
 * The six pillars, as a calm typographic index — name, one line, a link.
 * No numbering furniture, no capability chips, no monospace: the breadth
 * speaks for itself when it is given room.
 */
export function PillarsIndex() {
  return (
    <section className=" bg-navy-950">
      <div className="mx-auto max-w-cf px-5 py-28 sm:px-7 sm:py-36">
        <h2 className="max-w-[18ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
          Six parts of the business
        </h2>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-mut">
          Enter something once and it flows through the rest — win the work, run
          the job, prove the site, get paid.
        </p>

        <div className="mt-12 flex flex-col gap-2">
          {PILLARS.map((p) => (
            <Link
              key={p.slug}
              href={`/product/${p.slug}`}
              className="group -mx-4 flex items-baseline justify-between gap-6 rounded-xl px-4 py-5 transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-500 sm:gap-12"
            >
              <div className="min-w-0">
                <h3 className="font-display text-2xl font-bold tracking-[-0.015em] text-ink transition-colors group-hover:text-gold-500 sm:text-3xl">
                  {p.label}
                </h3>
                <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink-mut sm:text-base">
                  {p.summary}
                </p>
              </div>
              <span
                aria-hidden="true"
                className="mt-1 shrink-0 text-2xl text-ink-dim transition-all group-hover:translate-x-1 group-hover:text-gold-500"
              >
                →
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
