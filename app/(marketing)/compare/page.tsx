import { COMPARISONS, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { itemListSchema, webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { HubHeader, CardGrid, CtaSection } from "@/components/marketing/sections";

const PATH = paths.compare();

export const metadata = buildMetadata({
  title: "CrewFlow vs the Alternatives — Honest Comparisons",
  description:
    "Honest comparisons of CrewFlow against Procore, Buildertrend, Jobber, Tradify, Simpro, ServiceM8, Buildxact and Powered Now — including where each is the better fit.",
  path: PATH,
  keywords: ["construction software comparison", "best construction software UK", "construction software alternatives"],
  ogEyebrow: "Compare",
});

export default function CompareHubPage() {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Compare", path: PATH },
  ];
  return (
    <>
      <JsonLd
        data={[
          webPageSchema({
            name: "CrewFlow comparisons",
            description: "Honest comparisons of CrewFlow against the main construction and field-service software.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
          itemListSchema(
            COMPARISONS.map((c) => ({ name: `CrewFlow vs ${c.competitor.name}`, path: paths.comparison(c.slug) })),
          ),
        ]}
      />
      <HubHeader
        eyebrow="Compare"
        h1="CrewFlow vs the alternatives, honestly"
        intro={
          "We'd rather earn your trust than win every row in a table. Each comparison below includes where the other tool is genuinely the better fit — because the right software is the one that fits your business, not ours.\n\nPick a comparison to dig in."
        }
        breadcrumbs={crumbs}
      />
      <CardGrid
        cards={COMPARISONS.map((c) => ({
          tag: "Comparison",
          title: `CrewFlow vs ${c.competitor.name}`,
          body: c.competitor.oneLiner,
          href: paths.comparison(c.slug),
        }))}
      />
      <CtaSection />
    </>
  );
}
