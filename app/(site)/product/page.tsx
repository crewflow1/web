import type { Metadata } from "next";
import Link from "next/link";
import { PILLARS } from "@/lib/marketing/pillars";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { buildMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = buildMetadata({
  title: "The CrewFlow platform — one system for UK construction",
  titleAbsolute: true,
  description:
    "CRM, jobs, site & safety, money, people & assets and automation — the whole construction business in one system. Six connected pillars, one place.",
  path: "/product",
  ogTitle: "One system. Six parts of the business.",
  ogEyebrow: "The platform",
});

export default function ProductOverview() {
  return (
    <>
      {/* Hero */}
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
          <h1 className="max-w-[18ch] font-display text-[clamp(2.6rem,6vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.015em] text-ink">
            The commercial, site and financial sides of your business, in one
            place.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-mut">
            CrewFlow connects the whole job — from the first enquiry to the last
            retention payment — so nothing lives in a spreadsheet, a WhatsApp
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
              See the six pillars
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
            </a>
          </div>
        </div>
      </section>

      {/* Pillars */}
      <section id="pillars" className="mx-auto max-w-cf px-5 py-20 sm:px-7">
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Six pillars. One connected system.
          </h2>
          <p className="mt-3 text-ink-mut">
            Enter something once and it flows through the rest — a quote becomes
            a job, a job becomes an invoice, and the site paperwork is right
            there when you need to prove it.
          </p>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p) => (
            <Link
              key={p.slug}
              href={`/product/${p.slug}`}
              className="group flex flex-col rounded-cf border border-cfborder bg-navy-800 p-6 shadow-cf transition-colors hover:border-gold-500/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-display text-sm font-semibold text-gold-500">
                  {p.n}
                </span>
                <span
                  aria-hidden="true"
                  className="text-ink-dim transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </div>
              <h3 className="mt-3 font-display text-xl font-bold text-ink">
                {p.label}
              </h3>
              <p className="mt-2 flex-1 text-sm text-ink-mut">{p.summary}</p>
              <p className="mt-4 text-[13px] leading-relaxed text-ink-dim">
                {p.capabilities.slice(0, 4).map((c) => c.name).join("  ·  ")}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-cf px-5 py-16 text-center sm:px-7">
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            See it on your own numbers.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-mut">
            A 30-minute demo, walked through with your real jobs and figures. No
            slides.
          </p>
          <div className="mt-6 flex justify-center">
            <BookDemoButton className="inline-flex h-12 items-center rounded-lg bg-gold-500 px-6 text-base font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600">
              Book a demo
            </BookDemoButton>
          </div>
        </div>
      </section>
    </>
  );
}
