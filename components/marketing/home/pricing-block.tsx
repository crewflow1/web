import Link from "next/link";
import { CoordTag } from "@/components/marketing/setting-out";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";

/** Beat 7 — Pricing / value. One transparent price; value anchored above it. */
const INCLUDED = [
  "Every feature — no tiers or add-ons",
  "Full migration from Sage, Xero, spreadsheets or CSV",
  "Unlimited jobs, quotes, invoices & customers",
  "Mobile for every field-staff member",
  "UK-based onboarding & support",
];

export function PricingBlock() {
  return (
    <section className="border-t border-white/5 bg-navy-900">
      <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <CoordTag>One price. Everything in.</CoordTag>
            <h2 className="mt-5 font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
              Simple, transparent pricing.
            </h2>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-ink-mut">
              No per-seat fees, no per-feature upsells, no card-processing skim.
              One setup, one monthly fee, the whole operating system.
            </p>
            <ul className="mt-7 space-y-3 text-[15px] text-ink-mut">
              {INCLUDED.map((x) => (
                <li key={x} className="flex gap-3">
                  <Check /> {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-cf border border-cfborder bg-navy-800 p-8 shadow-cf">
            <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
              CrewFlow — all-in
            </p>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="font-display text-5xl font-bold tabular-nums text-ink">£500</span>
              <span className="text-ink-dim">/ month</span>
            </div>
            <p className="mt-2 text-sm text-ink-dim">
              + £1,000 one-time setup &amp; migration
            </p>
            <div className="mt-8 flex flex-col gap-3">
              <BookDemoButton className="inline-flex h-12 items-center justify-center rounded-lg bg-gold-500 px-6 text-base font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
                Book a demo
              </BookDemoButton>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center justify-center rounded-lg border border-white/12 px-6 text-base font-medium text-ink transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
              >
                See what&apos;s included
              </Link>
            </div>
            <p className="mt-4 text-center text-xs text-ink-dim">
              We&apos;ll show you the system on your own numbers first.
            </p>
          </div>
        </div>
      </div>
    </section>
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
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
