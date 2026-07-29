import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { COMPARISONS, getComparison, getComparisonLinks, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import {
  PageHero,
  Section,
  ComparisonTable,
  VersusColumns,
  FaqSection,
  RelatedLinks,
  CtaSection,
} from "@/components/marketing/sections";

export const dynamicParams = false;

export function generateStaticParams() {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const c = getComparison(slug);
  if (!c) return {};
  return buildMetadata({
    title: c.title,
    titleAbsolute: true,
    description: c.metaDescription,
    path: paths.comparison(c.slug),
    keywords: [c.keyword, ...(c.secondaryKeywords ?? [])],
    ogTitle: c.h1,
    ogEyebrow: "Comparison",
  });
}

const REVIEWED_FMT = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "long" });

export default async function ComparisonPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const c = getComparison(slug);
  if (!c) notFound();

  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Compare", path: paths.compare() },
    { name: `vs ${c.competitor.name}`, path: paths.comparison(c.slug) },
  ];

  return (
    <>
      <JsonLd
        data={[
          webPageSchema({ name: c.title, description: c.metaDescription, path: paths.comparison(c.slug) }),
          breadcrumbSchema(crumbs),
        ]}
      />

      <PageHero
        eyebrow={c.eyebrow}
        h1={c.h1}
        intro={c.intro}
        breadcrumbs={crumbs}
        secondaryCta={{ label: "All comparisons", href: paths.compare() }}
      />

      <Section bg="muted">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            The honest framing
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">{c.positioning}</p>
          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
            <span className="font-semibold text-slate-900">{c.competitor.name} in one line:</span>{" "}
            {c.competitor.oneLiner} <span className="text-slate-500">·</span>{" "}
            <span className="font-semibold text-slate-900">Best for:</span> {c.competitor.bestFor}
          </div>
        </div>
      </Section>

      <ComparisonTable competitorName={c.competitor.name} rows={c.rows} />

      <VersusColumns
        competitorName={c.competitor.name}
        crewflowWins={c.whereCrewflowWins}
        competitorWins={c.whereCompetitorWins}
      />

      <Section bg="white">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">The verdict</h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">{c.verdict}</p>
          <p className="mt-6 text-xs text-slate-500">
            {c.competitor.name} details reflect publicly available positioning as of{" "}
            {REVIEWED_FMT(c.lastReviewed)}. Always check {c.competitor.name}&apos;s website for their
            latest features and pricing.
          </p>
        </div>
      </Section>

      <FaqSection items={c.faqs} />

      <RelatedLinks groups={[{ title: "More comparisons", links: getComparisonLinks(c.related) }]} />

      <CtaSection title="See CrewFlow on your own numbers." />
    </>
  );
}
