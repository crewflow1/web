import { FEATURES, paths, type Faq } from "@/lib/seo/content";
import { SITE } from "@/lib/seo/site";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { PageHero, Section, FaqSection, CtaSection } from "@/components/marketing/sections";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import Link from "next/link";

const PATH = paths.pricing();

export const metadata = buildMetadata({
  title: "Pricing",
  description:
    "CrewFlow pricing is simple and transparent: £1,000 one-off setup and £500/month, with every feature, full migration and support included. Book a demo.",
  path: PATH,
  keywords: ["construction software pricing", "CrewFlow pricing", "construction software cost UK"],
  ogEyebrow: "Pricing",
});

const PRICING_FAQS: Faq[] = [
  {
    q: "What does the £1,000 setup cover?",
    a: "Premium onboarding: we migrate your existing customers, invoices and finances, configure CrewFlow around how your firm works, and get you live — typically in days. You're not handed a login and left to it.",
  },
  {
    q: "What's included in the £500/month?",
    a: "Everything. Every feature — CRM, quoting, jobs, scheduling, timesheets, payroll, invoicing, payment tracking, job costing, tax, plus H&S, CIS and site management — plus support. No per-feature upsells.",
  },
  {
    q: "Is it per user?",
    a: "Pricing is built to be simple for a construction SME rather than a per-seat model that punishes you for adding field staff. Book a demo and we'll confirm the right fit for your team size.",
  },
  {
    q: "Are there card processing fees?",
    a: "No. CrewFlow tracks bank-transfer payments rather than processing card payments, so there's no processor skim and no per-invoice fee. You keep 100% of every invoice.",
  },
  {
    q: "Can I leave whenever I want?",
    a: "Yes. Full data export to CSV any time, no lock-in and no early-termination fees. Your data is yours.",
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
            description: "Simple, transparent pricing for UK construction companies.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
        ]}
      />

      <PageHero
        eyebrow="Pricing"
        h1="Simple, transparent pricing. Everything included."
        intro={
          "No per-feature tiers, no surprise upsells, no card-processing fees. One setup fee, one monthly fee, and the whole operating system — from winning work to filing tax.\n\nWe're a premium, high-touch product: we set you up properly and stay close."
        }
        breadcrumbs={crumbs}
      />

      <Section bg="muted">
        <div className="mx-auto max-w-xl">
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 bg-slate-900 px-8 py-8 text-center text-white">
              <div className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                CrewFlow — all-in
              </div>
              <div className="mt-4 flex items-end justify-center gap-1">
                <span className="text-5xl font-bold tracking-tight">£{monthly}</span>
                <span className="mb-1 text-slate-300">/month</span>
              </div>
              <div className="mt-2 text-sm text-slate-300">
                + £{setup} one-off setup &amp; migration
              </div>
            </div>
            <div className="px-8 py-8">
              <ul className="space-y-3 text-sm text-slate-700">
                {[
                  "Every feature — no tiers, no add-ons",
                  "Full migration from Sage, Xero, spreadsheets or CSV",
                  "Premium onboarding, live in days",
                  "Unlimited jobs, quotes, invoices and customers",
                  "Mobile dashboard for every field staff member",
                  "Support from a UK team that knows construction",
                  "No card-processing fees — keep 100% of every invoice",
                  "No lock-in — export your data any time",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700"
                    >
                      ✓
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex justify-center">
                <BookDemoButton size="lg">Book a demo</BookDemoButton>
              </div>
              <p className="mt-3 text-center text-xs text-slate-500">
                See it on your own numbers before you commit.
              </p>
            </div>
          </div>
        </div>
      </Section>

      <Section bg="white">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Everything is included
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">
            One price, the whole operating system. Every module below is part of CrewFlow — not a
            premium tier.
          </p>
        </div>
        <div className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <Link
              key={f.slug}
              href={paths.feature(f.slug)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-amber-300 hover:text-amber-800"
            >
              {f.name}
            </Link>
          ))}
        </div>
      </Section>

      <FaqSection items={PRICING_FAQS} title="Pricing questions" />

      <CtaSection />
    </>
  );
}
