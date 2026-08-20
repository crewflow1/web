import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "./_marketing/tokens.css";
import { CookieConsent } from "@/app/_components/cookie-consent";

// Boot-time env validation — throws if anything required is missing.
import "@/lib/env";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://crewflow.uk"),
  title: {
    default: "CrewFlow. The operating system for UK construction companies.",
    template: "%s · CrewFlow",
  },
  description:
    "Leads, quotes, jobs, staff, rota, invoices, payments, profitability and tax. Every part of your construction company in one place.",
  applicationName: "CrewFlow",
  authors: [{ name: "CrewFlow", url: "https://crewflow.uk" }],
  keywords: [
    "construction software",
    "construction operating system",
    "construction CRM",
    "UK construction",
    "quotes",
    "invoicing",
    "builders software",
    "Northern Ireland",
  ],
  openGraph: {
    type: "website",
    locale: "en_GB",
    url: "https://crewflow.uk",
    siteName: "CrewFlow",
    title: "CrewFlow. The operating system for UK construction companies.",
    description:
      "Leads, quotes, jobs, staff, rota, invoices, payments, profitability and tax. One system for the whole company.",
  },
  twitter: {
    card: "summary_large_image",
    title: "CrewFlow. The operating system for UK construction companies.",
    description:
      "Leads, quotes, jobs, staff, rota, invoices, payments, profitability and tax. One system for the whole company.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#0F172A",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-GB" className={inter.variable}>
      <body className="min-h-screen bg-white font-sans text-slate-900 antialiased">
        {children}
        <CookieConsent />
      </body>
    </html>
  );
}
