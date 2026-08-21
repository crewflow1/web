import { INDUSTRIES, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { itemListSchema, webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { HubHeader, CardGrid, CtaSection } from "@/components/marketing/sections";

const PATH = paths.industries();

export const metadata = buildMetadata({
  title: "Construction Software by Trade",
  description:
    "CrewFlow is built for your trade, software for builders, electricians, plumbers, roofers, joiners, groundworks, plasterers, landscapers, scaffolders and heating engineers.",
  path: PATH,
  keywords: ["software for builders", "software for electricians", "plumbing software", "roofing software", "trade software UK"],
  ogEyebrow: "Industries",
});

function firstSentence(text: string): string {
  const clean = text.replace(/\n\n/g, " ");
  const idx = clean.indexOf(". ");
  return idx === -1 ? clean : clean.slice(0, idx + 1);
}

export default function IndustriesHubPage() {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Industries", path: PATH },
  ];
  return (
    <>
      <JsonLd
        data={[
          webPageSchema({
            name: "Construction software by trade",
            description: "CrewFlow tailored to each construction trade.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
          itemListSchema(INDUSTRIES.map((i) => ({ name: i.trade, path: paths.industry(i.slug) }))),
        ]}
      />
      <HubHeader
        eyebrow="Industries"
        h1="Construction software built for your trade"
        intro={
          "Every trade runs differently, a roofer's day isn't a plasterer's, and a groundworks firm isn't a plumbing one. CrewFlow is one operating system that flexes to how your trade actually works.\n\nFind your trade below."
        }
        breadcrumbs={crumbs}
      />
      <CardGrid
        cards={INDUSTRIES.map((i) => ({
          tag: "Trade",
          title: i.trade,
          body: firstSentence(i.intro),
          href: paths.industry(i.slug),
        }))}
      />
      <CtaSection />
    </>
  );
}
