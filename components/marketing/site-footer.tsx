import Link from "next/link";
import { Logo } from "./logo";
import { SITE } from "@/lib/seo/site";
import {
  FEATURES,
  INDUSTRIES,
  COMPARISONS,
  LOCATIONS,
  POSTS,
  TOOLS,
  paths,
} from "@/lib/seo/content";

/**
 * Comprehensive marketing footer — the internal-linking workhorse.
 *
 * Rendered on every marketing page, it links down into the deep content
 * (features, industries, comparisons, locations, guides), so link equity from
 * the homepage + hubs flows to every leaf page and crawlers always have a
 * path to everything. This is where the "every page strengthens every other
 * page" strategy actually lives in the DOM.
 */

function Col({
  heading,
  headingHref,
  links,
}: {
  heading: string;
  headingHref?: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {headingHref ? (
          <Link href={headingHref} className="hover:text-slate-900">
            {heading}
          </Link>
        ) : (
          heading
        )}
      </h4>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-slate-600 hover:text-slate-900">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SOCIAL_LINKS: { label: string; href: string }[] = [
  { label: "LinkedIn", href: SITE.social.linkedin },
  { label: "X", href: SITE.social.x },
  { label: "Instagram", href: SITE.social.instagram },
  { label: "Facebook", href: SITE.social.facebook },
  { label: "YouTube", href: SITE.social.youtube },
  { label: "TikTok", href: SITE.social.tiktok },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50/60">
      <div className="container grid gap-8 py-14 sm:grid-cols-2 lg:grid-cols-6">
        {/* Brand */}
        <div className="lg:col-span-2">
          <Link href="/" className="flex items-center gap-2" aria-label="CrewFlow home">
            <Logo />
            <span className="text-base font-semibold tracking-tight text-slate-900">
              CrewFlow
            </span>
          </Link>
          <p className="mt-3 max-w-xs text-sm text-slate-600">
            The operating system for UK construction companies. Built in{" "}
            {SITE.location.locality}, {SITE.location.region}.
          </p>
          <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {SOCIAL_LINKS.map((s) => (
              <li key={s.href}>
                <a
                  href={s.href}
                  target="_blank"
                  rel="me noopener noreferrer"
                  className="text-slate-600 hover:text-slate-900"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </div>

        <Col
          heading="Features"
          headingHref={paths.features()}
          links={FEATURES.slice(0, 8).map((f) => ({ label: f.navLabel, href: paths.feature(f.slug) }))}
        />
        <Col
          heading="Industries"
          headingHref={paths.industries()}
          links={INDUSTRIES.slice(0, 8).map((i) => ({ label: i.trade, href: paths.industry(i.slug) }))}
        />
        <Col
          heading="Compare"
          headingHref={paths.compare()}
          links={COMPARISONS.slice(0, 8).map((c) => ({
            label: `vs ${c.competitor.name}`,
            href: paths.comparison(c.slug),
          }))}
        />
        <Col
          heading="Locations"
          headingHref={paths.locations()}
          links={LOCATIONS.slice(0, 8).map((l) => ({ label: l.location, href: paths.location(l.slug) }))}
        />
      </div>

      <div className="border-t border-slate-200">
        <div className="container grid gap-8 py-8 sm:grid-cols-2 lg:grid-cols-6">
          <Col
            heading="Guides"
            headingHref={paths.blog()}
            links={POSTS.map((p) => ({ label: p.title, href: paths.post(p.slug) }))}
          />
          <Col
            heading="Free tools"
            headingHref={paths.tools()}
            links={TOOLS.map((t) => ({ label: t.navLabel, href: paths.tool(t.slug) }))}
          />
          <Col
            heading="Company"
            links={[
              { label: "Pricing", href: paths.pricing() },
              { label: "Book a demo", href: "/#book-demo" },
              { label: "Sign in", href: "/login" },
              { label: "Privacy", href: "/privacy" },
              { label: "Terms", href: "/terms" },
            ]}
          />
        </div>
      </div>

      <div className="border-t border-slate-200">
        <div className="container flex flex-wrap items-center justify-between gap-4 py-6 text-xs text-slate-500">
          <span>© {new Date().getFullYear()} CrewFlow. All rights reserved.</span>
          <a href={`mailto:${SITE.email}`} className="hover:text-slate-700">
            {SITE.email}
          </a>
        </div>
      </div>
    </footer>
  );
}
