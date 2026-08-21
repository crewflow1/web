import Link from "next/link";
import { PILLARS } from "@/lib/marketing/pillars";

/**
 * The six pillars, as a calm typographic index: name, one line, a taste of the
 * capabilities inside, a link. The capability line signals the real breadth
 * (this is far more than a job app) without turning the homepage into a
 * directory, the complete map lives on /product.
 */
export function PillarsIndex() {
  return (
    <section className="bg-navy-950">
      <div className="mx-auto max-w-cf px-5 py-28 sm:px-7 sm:py-36">
        <h2 className="max-w-[18ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
          Far more than a job app
        </h2>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-mut">
          Six connected parts of the business. Enter something once and it flows
          through the rest, win the work, run the site, prove it&apos;s safe,
          control the money, and keep the crew and kit legal.
        </p>

        <div className="mt-14 flex flex-col gap-1">
          {PILLARS.map((p) => (
            <Link
              key={p.slug}
              href={`/product/${p.slug}`}
              className="group -mx-4 rounded-xl px-4 py-6 transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-500"
            >
              <div className="flex items-baseline justify-between gap-6">
                <h3 className="font-display text-2xl font-bold tracking-[-0.015em] text-ink transition-colors group-hover:text-gold-500 sm:text-3xl">
                  {p.label}
                </h3>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-2xl text-ink-dim transition-all group-hover:translate-x-1 group-hover:text-gold-500"
                >
                  →
                </span>
              </div>
              <p className="mt-2.5 text-[15px] leading-relaxed text-ink-dim">
                {p.capabilities.map((c) => c.name).join("   ·   ")}
              </p>
            </Link>
          ))}
        </div>

        <Link
          href="/product"
          className="group mt-10 inline-flex items-center gap-2 text-base font-semibold text-gold-500 transition-colors hover:text-gold-400 focus-visible:outline-none focus-visible:underline"
        >
          See the whole platform
          <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
        </Link>
      </div>
    </section>
  );
}
