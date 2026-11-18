import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Inter } from "next/font/google";
import "./globals.css";
import "./_marketing/tokens.css";
import { CookieConsent } from "@/app/_components/cookie-consent";

/**
 * 404 for URLs that match NO route (enabled by `experimental.globalNotFound`
 * in next.config.ts). Same look as app/not-found.tsx, which still serves
 * `notFound()` calls made inside real routes.
 *
 * Rendered PER REQUEST on purpose (`connection()`): middleware gives unknown
 * paths the strict nonce Content-Security-Policy (lib/security/csp.ts), so the
 * 404 HTML must carry that request's nonce or none of its scripts would run.
 * A dynamic API here only affects this one route — unlike in app/not-found.tsx,
 * which is embedded in every page's payload and would de-optimise the static
 * marketing pages.
 */

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Page not found · CrewFlow",
  robots: { index: false, follow: true },
};

export default async function GlobalNotFound() {
  await connection();
  return (
    <html lang="en-GB" className={inter.variable}>
      <body className="min-h-screen bg-white font-sans text-slate-900 antialiased">
        <main className="container flex min-h-screen flex-col items-center justify-center py-16 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-amber-600">404</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">Page not found</h1>
          <p className="mt-3 max-w-md text-slate-600">
            That page doesn&apos;t exist. Head back home and try again.
          </p>
          <Link
            href="/"
            className="mt-6 rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Back to CrewFlow
          </Link>
        </main>
        <CookieConsent />
      </body>
    </html>
  );
}
