import type { Metadata } from "next";
import Link from "next/link";
import { PILLARS } from "@/lib/marketing/pillars";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { buildMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = buildMetadata({
  title: "The CrewFlow platform, one system for UK construction",
  titleAbsolute: true,
  description:
    "The whole construction business in one connected system: win work, run jobs, prove the site is safe, control the money, manage people and plant, and automate the chasing. Six pillars, forty-odd capabilities, one place.",
  path: "/product",
  ogTitle: "One connected system. Six parts of the business.",
  ogEyebrow: "The platform",
});

// The lifecycle a single job travels — the spine of the "it all connects" story.
const FLOW = [
  "Lead",
  "Quote",
  "Job",
  "Site & safety",
  "People & materials",
  "Money",
  "Reporting",
];

export default function ProductOverview() {
  return (
    <>
      {/* Hero */}
      <section>
        <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
          <h1 className="max-w-[18ch] font-display text-[clamp(2.6rem,6vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.015em] text-ink">
            The commercial, site and financial sides of your business, in one
            place.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-mut">
            CrewFlow connects the whole job, from the first enquiry to the last
            retention payment, so nothing lives in a spreadsheet, a WhatsApp
            thread, or your head.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
            <BookDemoButton className="inline-flex h-12 items-center rounded-xl bg-gold-500 px-7 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
            <a
              href="#pillars"
              className="group inline-flex items-center gap-2 text-base font-medium text-ink transition-colors hover:text-gold-500"
            >
              See the whole platform
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
            </a>
          </div>
        </div>
      </section>

      {/* The connected story — this is the point, not the feature count. */}
      <section className="bg-navy-900">
        <div className="mx-auto max-w-cf px-5 py-24 sm:px-7 sm:py-32">
          <h2 className="max-w-[20ch] font-display text-[clamp(2rem,4.4vw,3.4rem)] font-bold leading-[1.02] tracking-[-0.02em] text-ink">
            One connected system, not five tools that don&apos;t talk.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-mut">
            Enter a job once and it carries itself. A lead becomes a quote; the
            quote becomes a job with its costs, schedule and crew already
            attached; the site paperwork, materials and variations hang off that
            same job; and the work turns into valuations, invoices, payments and
            the tax figures your accountant files. You see the whole lifecycle,
            not six apps that each know a fraction of it.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-3 text-sm font-medium text-ink-dim">
            {FLOW.map((step, i) => (
              <span key={step} className="inline-flex items-center gap-3">
                <span className={i === FLOW.length - 1 ? "text-gold-500" : "text-ink-mut"}>{step}</span>
                {i < FLOW.length - 1 && <span aria-hidden="true" className="text-ink-dim/40">→</span>}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* The complete capability map — every pillar, every live capability. */}
      <div id="pillars">
        {PILLARS.map((p, i) => (
          <section key={p.slug} className={i % 2 === 0 ? "bg-navy-950" : "bg-navy-900"}>
            <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
              <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
                <div>
                  <div className="font-display text-2xl font-bold tabular-nums text-gold-500">
                    {p.n}
                  </div>
                  <h2 className="mt-4 font-display text-[clamp(1.9rem,3.4vw,2.8rem)] font-bold leading-[1.02] tracking-[-0.02em] text-ink">
                    {p.label}
                  </h2>
                  <p className="mt-4 max-w-md text-lg leading-relaxed text-ink-mut">
                    {p.summary}
                  </p>
                  <Link
                    href={`/product/${p.slug}`}
                    className="group mt-7 inline-flex items-center gap-2 text-base font-medium text-ink transition-colors hover:text-gold-500 focus-visible:outline-none focus-visible:underline"
                  >
                    Explore {p.label.toLowerCase()}
                    <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
                  </Link>
                </div>
                <ul className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
                  {p.capabilities.map((c) => (
                    <li key={c.name}>
                      <div className="font-display text-lg font-bold text-ink">{c.name}</div>
                      <div className="mt-1.5 text-[15px] leading-relaxed text-ink-mut">{c.note}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        ))}
      </div>

      {/* CTA */}
      <section className="bg-navy-950">
        <div className="mx-auto max-w-cf px-5 py-24 text-center sm:px-7 sm:py-32">
          <h2 className="mx-auto max-w-2xl font-display text-[clamp(2rem,4.4vw,3.4rem)] font-bold leading-[1.02] tracking-[-0.02em] text-ink">
            See the whole thing on your own numbers.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-ink-mut">
            A 30-minute demo, walked through with your real jobs and figures. No
            slides.
          </p>
          <div className="mt-9 flex justify-center">
            <BookDemoButton className="inline-flex h-12 items-center rounded-xl bg-gold-500 px-7 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
          </div>
        </div>
      </section>
    </>
  );
}
