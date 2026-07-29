import type { Metadata } from "next";
import { getTool, paths, getFeatureLinks, getToolLinks } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { PageHero, Section, FaqSection, RelatedLinks, CtaSection } from "@/components/marketing/sections";

/** Metadata for a tool page — call from the page's `export const metadata`. */
export function toolMetadata(slug: string): Metadata {
  const t = getTool(slug);
  if (!t) return {};
  return buildMetadata({
    title: t.title,
    description: t.metaDescription,
    path: paths.tool(t.slug),
    keywords: [t.keyword, ...(t.secondaryKeywords ?? [])],
    ogTitle: t.h1,
    ogEyebrow: "Free tool",
  });
}

/**
 * Server-rendered SEO shell wrapping the interactive calculator (passed as
 * children). Gives every tool consistent hero, schema, how-it-works, FAQ,
 * internal links and CTA — so the page is fully indexable and the maths is
 * the only per-tool client code.
 */
export function ToolPageShell({
  slug,
  children,
}: {
  slug: string;
  children: React.ReactNode;
}) {
  const t = getTool(slug);
  if (!t) return null;

  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Free tools", path: paths.tools() },
    { name: t.name, path: paths.tool(t.slug) },
  ];

  return (
    <>
      <JsonLd
        data={[
          webPageSchema({ name: t.title, description: t.metaDescription, path: paths.tool(t.slug) }),
          breadcrumbSchema(crumbs),
        ]}
      />

      <PageHero
        eyebrow={t.eyebrow}
        h1={t.h1}
        intro={t.intro}
        breadcrumbs={crumbs}
        secondaryCta={{ label: "All free tools", href: paths.tools() }}
      />

      <Section bg="muted">{children}</Section>

      <Section bg="white">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {t.howItWorks.h2}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">{t.howItWorks.body}</p>
          {t.howItWorks.bullets ? (
            <ul className="mt-6 space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-5 text-sm text-slate-700">
              {t.howItWorks.bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span aria-hidden className="mt-0.5 text-amber-600">
                    ›
                  </span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-6 text-xs text-slate-500">
            Estimates are guidance only — always confirm critical figures against your own
            measurements, supplier quotes and, for tax, your accountant or HMRC.
          </p>
        </div>
      </Section>

      <FaqSection items={t.faqs} />

      <RelatedLinks
        groups={[
          { title: "Related features", links: getFeatureLinks(t.relatedFeatures) },
          { title: "More free tools", links: getToolLinks(t.relatedTools) },
        ]}
      />

      <CtaSection title="Quote, cost and get paid — without the spreadsheet." />
    </>
  );
}
