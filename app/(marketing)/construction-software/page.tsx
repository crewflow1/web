import { LOCATIONS, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { itemListSchema, webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { HubHeader, CardGrid, CtaSection } from "@/components/marketing/sections";

const PATH = paths.locations();

export const metadata = buildMetadata({
  title: "Construction Software Across the UK",
  description:
    "CrewFlow is construction software for companies across the UK, built in Belfast, serving builders and trades in London, Manchester, Birmingham, Glasgow, Leeds and beyond.",
  path: PATH,
  keywords: ["construction software UK", "construction software near me", "UK construction software"],
  ogEyebrow: "Locations",
});

export default function LocationsHubPage() {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Construction software UK", path: PATH },
  ];
  return (
    <>
      <JsonLd
        data={[
          webPageSchema({
            name: "Construction software across the UK",
            description: "CrewFlow for UK construction companies, wherever you are.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
          itemListSchema(LOCATIONS.map((l) => ({ name: l.location, path: paths.location(l.slug) }))),
        ]}
      />
      <HubHeader
        eyebrow="Across the UK"
        h1="Construction software for UK companies, wherever you build"
        intro={
          "CrewFlow is built in Belfast and used by construction companies across the United Kingdom. One operating system, leads to tax, made for UK construction and UK tax.\n\nFind your area below."
        }
        breadcrumbs={crumbs}
      />
      <CardGrid
        cards={LOCATIONS.map((l) => ({
          tag: l.region,
          title: l.location,
          body: `Construction software for ${l.location} builders and trades, one system for quotes, jobs, payroll, invoices and tax.`,
          href: paths.location(l.slug),
        }))}
      />
      <CtaSection />
    </>
  );
}
