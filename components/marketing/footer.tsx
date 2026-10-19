import Link from "next/link";
import { PILLARS } from "@/lib/marketing/pillars";
import { WordmarkDark } from "@/components/marketing/logo";

const COLS = [
  {
    title: "Solutions",
    links: [
      { label: "Features A to Z", href: "/features" },
      { label: "Compare CrewFlow", href: "/compare" },
      { label: "By trade", href: "/industries" },
      { label: "By location", href: "/construction-software" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Guides", href: "/blog" },
      { label: "Free tools", href: "/tools" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Pricing", href: "/pricing" },
      { label: "Sign in", href: "/login" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

export function SiteFooterDark({
  showDevelopers = false,
}: {
  /**
   * Render the "API & developer docs" link (→ /developers). The layouts pass
   * isPublicApiJobsEnabled() so the link exists exactly when the page does —
   * /developers 404s while FEATURE_PUBLIC_API_JOBS is off, and a footer link
   * to a 404 would out a dark surface. Pinned by reachability.test.ts.
   */
  showDevelopers?: boolean;
}) {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-white/10 bg-navy-950">
      <div className="mx-auto max-w-cf px-5 py-14 sm:px-7">
        <div className="grid gap-10 md:grid-cols-[1.5fr_repeat(4,1fr)]">
          <div>
            <WordmarkDark />
            <p className="mt-4 max-w-xs text-sm text-ink-dim">
              The operating system for UK construction companies. Built and
              supported in the UK.
            </p>
          </div>
          <FooterCol
            title="Product"
            links={PILLARS.map((p) => ({ label: p.label, href: `/product/${p.slug}` }))}
          />
          {COLS.map((c) => (
            <FooterCol
              key={c.title}
              title={c.title}
              links={
                c.title === "Resources" && showDevelopers
                  ? [...c.links, { label: "API & developer docs", href: "/developers" }]
                  : c.links
              }
            />
          ))}
        </div>
        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-ink-dim sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} CrewFlow. All rights reserved.</p>
          <a href="mailto:hello@crewflow.uk" className="transition-colors hover:text-ink">
            hello@crewflow.uk
          </a>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">
        {title}
      </p>
      <ul className="mt-3 space-y-2.5">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="text-sm text-ink-mut transition-colors hover:text-ink"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
