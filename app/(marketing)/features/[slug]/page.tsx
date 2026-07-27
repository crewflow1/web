import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  FEATURES,
  getFeature,
  getFeatureLinks,
  getIndustryLinks,
  paths,
} from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import {
  PageHero,
  Section,
  ContentSections,
  OutcomeCards,
  FaqSection,
  RelatedLinks,
  CtaSection,
} from "@/components/marketing/sections";

export const dynamicParams = false;

export function generateStaticParams() {
  return FEATURES.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const f = getFeature(slug);
  if (!f) return {};
  return buildMetadata({
    title: f.title,
    description: f.metaDescription,
    path: paths.feature(f.slug),
    keywords: [f.keyword, ...(f.secondaryKeywords ?? [])],
    ogTitle: f.h1,
    ogEyebrow: "Feature",
  });
}

export default async function FeaturePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const f = getFeature(slug);
  if (!f) notFound();

  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Features", path: paths.features() },
    { name: f.name, path: paths.feature(f.slug) },
  ];

  return (
    <>
      <JsonLd
        data={[
          webPageSchema({ name: f.title, description: f.metaDescription, path: paths.feature(f.slug) }),
          breadcrumbSchema(crumbs),
        ]}
      />

      <PageHero
        eyebrow={f.eyebrow}
        h1={f.h1}
        intro={f.intro}
        bullets={f.heroBullets}
        breadcrumbs={crumbs}
        secondaryCta={{ label: "All features", href: paths.features() }}
      />

      <Section bg="muted">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {f.problem.heading}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">{f.problem.body}</p>
        </div>
      </Section>

      <ContentSections sections={f.sections} />

      <OutcomeCards items={f.outcomes} />

      <FaqSection items={f.faqs} />

      <RelatedLinks
        groups={[
          { title: "Related features", links: getFeatureLinks(f.related) },
          { title: "Built for your trade", links: getIndustryLinks(f.industries) },
        ]}
      />

      <CtaSection />
    </>
  );
}
