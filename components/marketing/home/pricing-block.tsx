import Link from "next/link";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";

/** Pricing / value. One transparent price; the price card is the one place a
 *  container genuinely earns its keep. No eyebrow, no monospace. */
const INCLUDED = [
  "Every feature, no tiers or add-ons",
  "Full migration from Sage, Xero, spreadsheets or CSV",
  "Unlimited jobs, quotes, invoices & customers",
  "Mobile for every field-staff member",
  "UK-based onboarding & support",
];

export function PricingBlock() {
  return (
    <section className=" bg-navy-900">
      <div className="mx-auto max-w-cf px-5 py-28 sm:px-7 sm:py-36">
        <div className="grid items-center gap-14 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <h2 className="max-w-[15ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
              Everything, for one monthly price
            </h2>
            <p className="mt-6 max-w-md text-lg leading-relaxed text-ink-mut">
              No per-seat fees, no per-feature upsells, no card-processing skim.
              One setup, one monthly fee, the whole operating system.
            </p>
            <ul className="mt-8 space-y-4 text-[17px] text-ink">
              {INCLUDED.map((x) => (
                <li key={x} className="flex gap-3">
                  <Check /> {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-white/10 bg-navy-950 p-8 sm:p-10">
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-gold-500">
              CrewFlow, all in
            </p>
            <div className="mt-4 flex items-baseline gap-3">
              <span className="font-display text-[clamp(4rem,9vw,6.5rem)] font-bold leading-none tabular-nums tracking-[-0.02em] text-ink">
                £500
              </span>
              <span className="text-lg text-ink-mut">/ month</span>
            </div>
            <p className="mt-3 text-sm text-ink-dim">
              + £1,000 one-time setup &amp; migration
            </p>
            <div className="mt-8 flex flex-col gap-3">
              <BookDemoButton className="inline-flex h-12 items-center justify-center rounded-xl bg-gold-500 px-6 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
                Book a demo
              </BookDemoButton>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-white/12 px-6 text-base font-medium text-ink transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
              >
                See what&apos;s included
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Check() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="mt-1 shrink-0 text-gold-500"
    >
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
