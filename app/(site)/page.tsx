import type { Metadata } from "next";
import Link from "next/link";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { DatumGrid, CoordTag } from "@/components/marketing/setting-out";
import { ProductFrame } from "@/components/marketing/product-frame";
import { JobFlow } from "@/components/marketing/home/job-flow";
import { Differentiation } from "@/components/marketing/home/differentiation";
import { SwitchTrust } from "@/components/marketing/home/switch-trust";
import { PricingBlock } from "@/components/marketing/home/pricing-block";
import { Faq } from "@/components/marketing/home/faq";

export const metadata: Metadata = {
  title: "CrewFlow — the operating system for UK construction companies",
  description:
    "Run the whole job, from the first call to the last payment. Leads, quotes, site paperwork, valuations, CIS and VAT — one system built for how UK construction actually gets paid.",
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <>
      {/* Beat 1 — Hero: extreme restraint on the setting-out board */}
      <section className="relative isolate overflow-hidden">
        <DatumGrid refs />
        <div className="relative mx-auto max-w-cf px-5 pb-14 pt-20 sm:px-7 sm:pb-20 sm:pt-28">
          <CoordTag>The operating system for UK construction</CoordTag>
          <h1 className="mt-6 max-w-[15ch] font-display text-[clamp(2.75rem,6.6vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.03em] text-ink">
            Run the whole job. From the first call to{" "}
            <span className="text-gold-500">the last payment.</span>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-mut">
            Leads, quotes, site paperwork, valuations, CIS and VAT — one system
            built for how UK construction actually gets paid.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <BookDemoButton className="inline-flex h-12 items-center rounded-lg bg-gold-500 px-6 text-base font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
            <Link
              href="/product"
              className="inline-flex h-12 items-center gap-1.5 rounded-lg border border-white/12 px-6 text-base font-medium text-ink transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
            >
              Explore the platform <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-dim">
            <span className="inline-flex items-center gap-2">
              <Tick /> Set up in days
            </span>
            <span className="inline-flex items-center gap-2">
              <Tick /> Built in the UK
            </span>
            <span className="inline-flex items-center gap-2">
              <Tick /> No card fees, no lock-in
            </span>
          </div>
        </div>
      </section>

      {/* Beat 2 — Product as hero: the light "built object" set into the board */}
      <section className="relative border-t border-white/5 bg-navy-900">
        <div className="mx-auto max-w-cf px-5 py-16 sm:px-7 sm:py-24">
          <ProductFrame
            screen="Operations dashboard"
            url="app.crewflow.uk/dashboard"
            className="mx-auto max-w-4xl"
          />
          <p className="mx-auto mt-7 max-w-md text-center text-[15px] leading-relaxed text-ink-dim">
            One screen for what&apos;s on, what&apos;s late and what needs a
            look — the whole company at a glance.
          </p>
        </div>
      </section>

      {/* Beat 3 — Signature moment: one job, end to end */}
      <JobFlow />

      {/* Beat 5 — Differentiation (Beat 4 pillars slots in above this) */}
      <Differentiation />

      {/* Beat 6 — Switching & trust */}
      <SwitchTrust />

      {/* Beat 7 — Pricing / value */}
      <PricingBlock />

      {/* Beat 8 — Final CTA */}
      <section className="relative overflow-hidden border-t border-white/5">
        <DatumGrid />
        <div className="relative mx-auto max-w-cf px-5 py-24 text-center sm:px-7 sm:py-32">
          <h2 className="mx-auto max-w-3xl font-display text-[clamp(2rem,4.2vw,3.4rem)] font-bold leading-[1.02] tracking-[-0.025em] text-ink">
            Run your whole construction company from one place.
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-lg text-ink-mut">
            A 30-minute demo, walked through with your own jobs and figures. No
            slides.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <BookDemoButton className="inline-flex h-12 items-center rounded-lg bg-gold-500 px-6 text-base font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
            <Link
              href="/product"
              className="inline-flex h-12 items-center gap-1.5 rounded-lg border border-white/12 px-6 text-base font-medium text-ink transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
            >
              Explore the platform <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* Beat 9 — FAQ */}
      <Faq />
    </>
  );
}

function Tick() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="text-gold-500"
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
