import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

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
    default: "CrewFlow — Never miss another construction lead",
    template: "%s · CrewFlow",
  },
  description:
    "AI receptionist + quotes for construction companies. Pick up every call, send quotes from a voice note, get paid faster. Built in Belfast.",
  applicationName: "CrewFlow",
  authors: [{ name: "CrewFlow", url: "https://crewflow.uk" }],
  keywords: [
    "construction software",
    "AI receptionist",
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
    title: "CrewFlow — Never miss another construction lead",
    description:
      "AI receptionist + quotes for UK construction companies. Built in Belfast.",
  },
  twitter: {
    card: "summary_large_image",
    title: "CrewFlow — Never miss another construction lead",
    description:
      "AI receptionist + quotes for UK construction companies. Built in Belfast.",
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
      </body>
    </html>
  );
}
