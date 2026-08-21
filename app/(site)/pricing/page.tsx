import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/lib/seo/site";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { DatumGrid } from "@/components/marketing/setting-out";
import { PILLARS } from "@/lib/marketing/pillars";

const PATH = "/pricing";

export const metadata: Metadata = buildMetadata({
  title: "Pricing",
  description:
    "CrewFlow pricing is simple and transparent: £1,000 one-off setup and £500/month, with every feature, full migration and UK support included. Book a demo.",
  path: PATH,
  keywords: [
    "construction software pricing",
    "CrewFlow pricing",
    "construction software cost UK",
  ],
  ogTitle: "One price. The whole operating system.",
  ogEyebrow: "Pricing",
});

const INCLUDED = [
  "Every feature — no tiers, no add-ons",
  "Full migration from Sage, Xero, spreadsheets or CSV",
  "Premium onboarding — live in days, not months",
  "Unlimited jobs, quotes, invoices and customers",
  "Mobile for every field-staff member",
  "UK-based onboarding and support that knows construction",
  "No card-processing fees — keep 100% of every invoice",
  "No lock-in — export your data any time",
];

const FAQS = [
  {
    q: "What does the £1,000 setup cover?",
    a: "Premium onboarding: we migrate your existing customers, invoices and finances, configure CrewFlow around how your firm actually works, and get you live — typically in days. You're not handed a login and left to it.",
  },
  {
    q: "What's included in the £500 a month?",
    a: "Everything. CRM, quoting, jobs, scheduling, timesheets, payroll, invoicing, payment tracking, job costing and tax figures — plus health & safety, CIS and site management, and support. No per-feature upsells.",
  },
  {
    q: "Is it priced per user?",
    a: "No per-seat model that punishes you for adding field staff. One firm, one price. Book a demo and we'll confirm the right fit for your team.",
  },
  {
    q: "Are there card-processing fees?",
    a: "No. CrewFlow tracks bank-transfer payments rather than processing card payments, so there's no processor skim and no per-invoice fee. You keep 100% of every invoice.",
  },
  {
    q: "Can I leave whenever I want?",
    a: "Yes. Full CSV export any time, no lock-in and no early-termination fees. Your data is yours.",
  },
];

export default function PricingPage() {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Pricing", path: PATH },
  ];
  const setup = SITE.pricing.setupGBP.toLocaleString("en-GB");
  const monthly = SITE.pricing.monthlyGBP.toLocaleString("en-GB");

  return (
    <>
      <JsonLd
        data={[
          webPageSchema({
            name: "CrewFlow pricing",
            description:
              "Simple, transparent pricing for UK construction companies — one setup fee, one monthly fee, everything included.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
        ]}
      />

      {/* Hero */}
      <section>
        <div className="mx-auto max-w-cf px-5 pb-10 pt-20 sm:px-7 sm:pt-28">
          <h1 className="max-w-[16ch] font-display text-[clamp(2.6rem,6.5vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.015em] text-ink">
            One price for the whole operating system
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-mut">
            No per-seat fees, no per-feature tiers, no card-processing skim. One
            setup, one monthly fee — everything from winning work to tax-ready
            figures. We set you up properly and stay close.
          </p>
        </div>
      </section>

      {/* Price card + what "everything" means */}
      <section className="relative border-t border-white/5 bg-navy-900">
        <div className="mx-auto max-w-cf px-5 py-16 sm:px-7 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
            {/* The card */}
            <div className="rounded-2xl border border-white/10 bg-navy-800 p-8 lg:sticky lg:top-24">
              <p className="text-sm font-semibold uppercase tracking-[0.12em] text-gold-500">
                CrewFlow, all in
              </p>
              <div className="mt-4 flex items-baseline gap-3">
                <span className="font-display text-[clamp(4rem,9vw,6.5rem)] font-bold leading-none tabular-nums tracking-[-0.02em] text-ink">
                  £{monthly}
                </span>
                <span className="text-lg text-ink-mut">/ month</span>
              </div>
              <p className="mt-3 text-sm text-ink-dim">
                + £{setup} one-time setup &amp; migration
              </p>
              <div className="mt-7">
                <BookDemoButton className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-gold-500 px-6 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
                  Book a demo
                </BookDemoButton>
              </div>
              <p className="mt-3 text-center text-xs text-ink-dim">
                See it on your own numbers before you commit.
              </p>

              <div className="my-7 h-px bg-white/10" />

              <ul className="space-y-3 text-[15px] text-ink-mut">
                {INCLUDED.map((item) => (
                  <li key={item} className="flex gap-3">
                    <Check />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Everything = the six pillars (kept in the dark system) */}
            <div>
              <h2 className="max-w-xl font-display text-[clamp(1.9rem,3.4vw,2.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
                Every part of the business, included
              </h2>
              <p className="mt-4 max-w-lg text-lg leading-relaxed text-ink-mut">
                Every module below is part of CrewFlow — not a premium tier, not
                an add-on. Six parts of the company, in one system.
              </p>

              <ol className="mt-9 border-t border-white/10">
                {PILLARS.map((p) => (
                  <li key={p.slug}>
                    <Link
                      href={`/product/${p.slug}`}
                      className="group grid grid-cols-[2.5rem_1fr] items-baseline gap-x-4 gap-y-2 rounded-lg border-b border-white/10 py-5 transition-colors hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-500"
                    >
                      <span className="text-sm font-semibold tabular-nums text-gold-500">
                        {p.n}
                      </span>
                      <span className="min-w-0">
                        <span className="font-display text-lg font-bold text-ink">
                          {p.label}
                        </span>
                        <span className="mt-1.5 block text-[14px] leading-relaxed text-ink-mut">
                          {p.capabilities.map((c) => c.name).join("  ·  ")}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-white/5">
        <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-24">
          <h2 className="font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
            Cost, answered plainly
          </h2>
          <div className="mt-10 max-w-3xl divide-y divide-white/10 border-y border-white/10">
            {FAQS.map((f) => (
              <details key={f.q} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-lg font-semibold text-ink [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span
                    aria-hidden="true"
                    className="text-2xl font-light text-ink-dim transition-transform duration-200 group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-mut">
                  {f.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t border-white/5">
        <DatumGrid />
        <div className="relative mx-auto max-w-cf px-5 py-24 text-center sm:px-7 sm:py-28">
          <h2 className="mx-auto max-w-2xl font-display text-[clamp(2rem,4vw,3.2rem)] font-bold leading-[1.03] tracking-[-0.025em] text-ink">
            See it on your own numbers.
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-lg text-ink-mut">
            A 30-minute demo, walked through with your own jobs and figures. No
            slides, no obligation.
          </p>
          <div className="mt-9 flex justify-center">
            <BookDemoButton className="inline-flex h-12 items-center rounded-lg bg-gold-500 px-6 text-base font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
          </div>
        </div>
      </section>
    </>
  );
}

function Check() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-gold-500"
    >
      <path
        d="M5 13l4 4L19 7"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
