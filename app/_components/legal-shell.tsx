import Link from "next/link";
import { type ReactNode } from "react";

/**
 * Shared shell for /privacy and /terms — keeps both pages visually
 * coherent with the marketing site footer that links to them, and
 * gives a single place to update the "Last updated" treatment.
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
    <div className="min-h-screen bg-white">
      <header className="border-b border-slate-200 bg-slate-50/60">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 text-sm">
          <Link href="/" className="font-semibold text-slate-900 hover:text-slate-700">
            ← CrewFlow
          </Link>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
            <a href="mailto:hello@crewflow.uk" className="hover:text-slate-900">
              hello@crewflow.uk
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12">
        <header className="border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-bold text-slate-900">{title}</h1>
          {intro ? (
            <p className="mt-2 text-sm text-slate-600">{intro}</p>
          ) : null}
          <p className="mt-2 text-xs text-slate-500">Last updated: {lastUpdated}</p>
        </header>

        <article className="legal-prose mt-8 text-sm leading-6 text-slate-700">
          {children}
        </article>

        <footer className="mt-12 border-t border-slate-200 pt-6 text-xs text-slate-500">
          Questions about this page? Email{" "}
          <a className="font-medium text-slate-900 hover:text-slate-700" href="mailto:hello@crewflow.uk">
            hello@crewflow.uk
          </a>{" "}
          and we&apos;ll get back to you.
        </footer>
      </main>
    </div>
  );
}
