import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCATIONS, getLocation, getLocationLinks, getFeatureLinks, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import {
  PageHero,
  Section,
  CheckList,
  FaqSection,
  RelatedLinks,
  CtaSection,
} from "@/components/marketing/sections";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCATIONS.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const l = getLocation(slug);
  if (!l) return {};
  return buildMetadata({
    title: l.title,
    description: l.metaDescription,
    path: paths.location(l.slug),
    keywords: [l.keyword],
    ogTitle: l.h1,
    ogEyebrow: l.location,
  });
}

const CORE_FEATURES = [
  "construction-crm",
  "quoting-software",
  "job-management-software",
  "invoicing-software",
  "payroll-software",
  "tax-software",
];

export default async function LocationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const l = getLocation(slug);
  if (!l) notFound();

  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Construction software UK", path: paths.locations() },
    { name: l.location, path: paths.location(l.slug) },
  ];

  return (
    <>
      <JsonLd
        data={[
          webPageSchema({ name: l.title, description: l.metaDescription, path: paths.location(l.slug) }),
          breadcrumbSchema(crumbs),
        ]}
      />

      <PageHero
        eyebrow={l.eyebrow}
        h1={l.h1}
        intro={l.intro}
        breadcrumbs={crumbs}
        secondaryCta={{ label: "All locations", href: paths.locations() }}
      />

      <Section bg="muted">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Built for construction in {l.location}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">{l.localContext}</p>
        </div>
      </Section>

      <Section bg="white">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            One system for the whole business
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">
            Whether you&apos;re a sole trader or a growing firm in {l.location}, CrewFlow brings
            every part of the business into one place:
          </p>
          <CheckList
            className="mt-6"
            items={[
              "Capture every enquiry and quote it fast",
              "Manage jobs, crews and schedules from one screen",
              "Invoice straight from the job and chase payment automatically",
              "Run weekly payroll from your crew's real clocked hours",
              "See VAT, PAYE and Corporation Tax all year — no deadline panic",
              "Know the real margin on every job",
            ]}
          />
        </div>
      </Section>

      <FaqSection items={l.faqs} />

      <RelatedLinks
        groups={[
          { title: "Explore features", links: getFeatureLinks(CORE_FEATURES) },
          { title: "Other areas", links: getLocationLinks(l.related) },
        ]}
      />

      <CtaSection title={`See CrewFlow for your ${l.location} firm.`} />
    </>
  );
}
