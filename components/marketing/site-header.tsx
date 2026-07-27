import Link from "next/link";
import { Logo } from "./logo";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";

const NAV = [
  { label: "Features", href: "/features" },
  { label: "Compare", href: "/compare" },
  { label: "Industries", href: "/industries" },
  { label: "Pricing", href: "/pricing" },
  { label: "Tools", href: "/tools" },
  { label: "Blog", href: "/blog" },
];

/**
 * Shared marketing header. Real route links (not in-page anchors) so every
 * page surfaces the hub pages — the top of the internal-linking structure.
 * Server-rendered and fully crawlable; no JS needed for the nav itself.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/95 backdrop-blur">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2" aria-label="CrewFlow home">
          <Logo />
          <span className="text-base font-semibold tracking-tight text-slate-900">
            CrewFlow
          </span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Primary">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 md:inline-flex"
            >
              {n.label}
            </Link>
          ))}
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Sign in
          </Link>
          <BookDemoButton size="sm">Book demo</BookDemoButton>
        </nav>
      </div>
    </header>
  );
}
