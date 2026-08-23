import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  INDUSTRIES,
  getIndustry,
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
  FaqSection,
  RelatedLinks,
  CtaSection,
} from "@/components/marketing/sections";

export const dynamicParams = false;

export function generateStaticParams() {
  return INDUSTRIES.map((i) => ({ slug: i.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const i = getIndustry(slug);
  if (!i) return {};
  return buildMetadata({
    title: i.title,
    description: i.metaDescription,
    path: paths.industry(i.slug),
    keywords: [i.keyword, ...(i.secondaryKeywords ?? [])],
    ogTitle: i.h1,
    ogEyebrow: "For " + i.trade,
  });
}

export default async function IndustryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const i = getIndustry(slug);
  if (!i) notFound();

  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Industries", path: paths.industries() },
    { name: i.trade, path: paths.industry(i.slug) },
  ];

  return (
    <>
      <JsonLd
        data={[
          webPageSchema({ name: i.title, description: i.metaDescription, path: paths.industry(i.slug) }),
          breadcrumbSchema(crumbs),
        ]}
      />

      <PageHero
        eyebrow={i.eyebrow}
        h1={i.h1}
        intro={i.intro}
        breadcrumbs={crumbs}
        secondaryCta={{ label: "All trades", href: paths.industries() }}
      />

      <Section bg="muted">
        <div className="mx-auto max-w-3xl">
          <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink sm:text-3xl">
            The daily grind for {i.trade.toLowerCase()}
          </h2>
          <ul className="mt-6 space-y-3 text-[15px] text-ink-mut">
            {i.painPoints.map((p, idx) => (
              <li key={idx} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger/15 text-[10px] font-bold text-danger"
                >
                  ✕
                </span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <ContentSections sections={i.sections} />

      <FaqSection items={i.faqs} />

      <RelatedLinks
        groups={[
          { title: `Key features for ${i.trade.toLowerCase()}`, links: getFeatureLinks(i.featuredModules) },
          { title: "Related trades", links: getIndustryLinks(i.related) },
        ]}
      />

      <CtaSection title={`See CrewFlow built for ${i.trade.toLowerCase()}.`} />
    </>
  );
}
