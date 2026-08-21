import Link from "next/link";
import { type ReactNode } from "react";
import { clashDisplay, satoshi } from "@/app/_marketing/fonts";

/**
 * Shared shell for /privacy and /terms — dark "Setting-Out" system so the legal
 * pages stay visually coherent with the marketing footer that links to them.
 * Keeps its own minimal chrome (the site nav/modal aren't needed on a legal
 * page) but the same tokens, fonts and gold accent as the rest of the site.
 */
export function LegalShell({
  title,
  intro,
  lastUpdated,
  children,
}: {
  title: string;
  intro?: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div
      data-marketing="true"
      className={`${clashDisplay.variable} ${satoshi.variable} min-h-screen bg-navy-950 font-body text-ink`}
    >
      <header className="border-b border-white/10 bg-navy-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 text-sm">
          <Link
            href="/"
            className="font-display font-semibold text-ink transition-colors hover:text-gold-500"
          >
            ← CrewFlow
          </Link>
          <div className="flex items-center gap-4 text-xs text-ink-dim">
            <Link href="/privacy" className="transition-colors hover:text-ink">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-ink">
              Terms
            </Link>
            <a
              href="mailto:hello@crewflow.uk"
              className="transition-colors hover:text-ink"
            >
              hello@crewflow.uk
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-14">
        <header className="border-b border-white/10 pb-6">
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {title}
          </h1>
          {intro ? <p className="mt-3 text-[15px] leading-relaxed text-ink-mut">{intro}</p> : null}
          <p className="mt-3 font-mono text-xs uppercase tracking-wider text-ink-dim">
            Last updated: {lastUpdated}
          </p>
        </header>

        <article className="legal-prose mt-8 text-[15px] leading-7 text-ink-mut">
          {children}
        </article>

        <footer className="mt-14 border-t border-white/10 pt-6 text-xs text-ink-dim">
          Questions about this page? Email{" "}
          <a
            className="font-medium text-gold-500 transition-colors hover:text-gold-400"
            href="mailto:hello@crewflow.uk"
          >
            hello@crewflow.uk
          </a>{" "}
          and we&apos;ll get back to you.
        </footer>
      </main>
    </div>
  );
}
