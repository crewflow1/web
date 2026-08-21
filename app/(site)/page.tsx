import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { buildMetadata } from "@/lib/seo/metadata";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { JobJourney } from "@/components/marketing/home/job-journey";
import { Differentiation } from "@/components/marketing/home/differentiation";
import { SwitchTrust } from "@/components/marketing/home/switch-trust";
import { PricingBlock } from "@/components/marketing/home/pricing-block";
import { Faq } from "@/components/marketing/home/faq";
import { PillarsIndex } from "@/components/marketing/home/pillars-index";

export const metadata: Metadata = buildMetadata({
  title: "CrewFlow — the operating system for UK construction companies",
  titleAbsolute: true,
  description:
    "Run the whole job, from the first call to the last payment. Leads, quotes, site paperwork, CIS and VAT — one system built for how UK construction actually gets paid.",
  path: "/",
  ogTitle: "Run the whole job. From the first call to the last payment.",
  ogEyebrow: "The operating system for UK construction",
  keywords: [
    "construction software UK",
    "construction management software",
    "construction ERP UK",
    "job management software",
  ],
});

export default function HomePage() {
  return (
    <>
      {/* Hero — one idea, stated with confidence. Headline, a line of copy,
          one clear action, then the product itself. No decoration. */}
      <section className="mx-auto max-w-cf px-5 pt-20 sm:px-7 sm:pt-28">
        <h1 className="max-w-[16ch] font-display text-[clamp(2.7rem,7vw,5.5rem)] font-bold leading-[0.95] tracking-[-0.015em] text-ink">
          Run the whole job. From the first call to{" "}
          <span className="text-gold-500">the last payment.</span>
        </h1>
        <p className="mt-8 max-w-xl text-xl leading-relaxed text-ink-mut">
          Leads, quotes, site paperwork, CIS and VAT — one system built for how
          UK construction actually gets paid.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4">
          <BookDemoButton className="inline-flex h-12 items-center rounded-xl bg-gold-500 px-7 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
            Book a demo
          </BookDemoButton>
          <Link
            href="/product"
            className="group inline-flex items-center gap-2 text-base font-medium text-ink transition-colors hover:text-gold-500 focus-visible:outline-none focus-visible:underline"
          >
            Explore the platform
            <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
          </Link>
        </div>
        <p className="mt-9 text-sm text-ink-dim">
          Built in the UK · set up in days · no card fees, no lock-in
        </p>
      </section>

      {/* The product, full-width and large — the first real proof. */}
      <section className="mx-auto max-w-cf px-5 pb-6 pt-16 sm:px-7 sm:pt-24">
        <div className="overflow-hidden rounded-2xl bg-[#F7F9FC] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.7)] ring-1 ring-white/10">
          <Image
            src="/product-shots/dashboard.png"
            alt="The CrewFlow dashboard for Brightwork Construction: a morning brief flagging 3 active jobs without a current RAMS, £11,520 overdue across one invoice, and £55,440 due from customers this week."
            width={1440}
            height={620}
            priority
            sizes="(max-width: 1400px) 100vw, 1360px"
            className="h-auto w-full"
          />
        </div>
        <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-ink-dim">
          One screen for what&apos;s on, what&apos;s late and what needs a look —
          the whole company, first thing in the morning.
        </p>
      </section>

      {/* One job, end to end — the signature product story. */}
      <JobJourney />

      {/* Six parts of the business. */}
      <PillarsIndex />

      {/* What makes it different. */}
      <Differentiation />

      {/* Switching is easier than staying. */}
      <SwitchTrust />

      {/* Pricing. */}
      <PricingBlock />

      {/* Close. */}
      <section className=" bg-navy-950">
        <div className="mx-auto max-w-cf px-5 py-28 sm:px-7 sm:py-36">
          <h2 className="max-w-[18ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
            Run your whole construction company from one place.
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-mut">
            A 30-minute demo, walked through with your own jobs and figures. No
            slides. Your data stays yours — full export any time, no lock-in.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
            <BookDemoButton className="inline-flex h-12 items-center rounded-xl bg-gold-500 px-7 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
            <Link
              href="/product"
              className="group inline-flex items-center gap-2 text-base font-medium text-ink transition-colors hover:text-gold-500 focus-visible:outline-none focus-visible:underline"
            >
              Explore the platform
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
            </Link>
          </div>
        </div>
      </section>

      <Faq />
    </>
  );
}
