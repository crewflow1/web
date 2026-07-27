import { TOOLS, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { itemListSchema, webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { HubHeader, CardGrid, CtaSection } from "@/components/marketing/sections";

const PATH = paths.tools();

export const metadata = buildMetadata({
  title: "Free Construction Calculators & Tools",
  description:
    "Free calculators for construction businesses — markup & margin, UK VAT, concrete and bricks. Quick, accurate, and built by the team behind CrewFlow.",
  path: PATH,
  keywords: ["construction calculator", "free construction tools", "builder calculators uk", "construction markup calculator"],
  ogEyebrow: "Free tools",
});

function teaser(intro: string): string {
  const s = intro.replace(/—/g, "—");
  const i = s.indexOf(". ");
  return i === -1 ? s : s.slice(0, i + 1);
}

export default function ToolsHubPage() {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Free tools", path: PATH },
  ];
  return (
    <>
      <JsonLd
        data={[
          webPageSchema({
            name: "Free construction calculators",
            description: "Free, accurate calculators for UK construction businesses.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
          itemListSchema(TOOLS.map((t) => ({ name: t.name, path: paths.tool(t.slug) }))),
        ]}
      />
      <HubHeader
        eyebrow="Free tools"
        h1="Free calculators for construction businesses"
        intro={
          "Quick, accurate, no sign-up. Price jobs, check VAT and estimate materials in seconds — built by the team behind CrewFlow, the operating system for UK construction companies."
        }
        breadcrumbs={crumbs}
      />
      <CardGrid
        cards={TOOLS.map((t) => ({
          tag: "Calculator",
          title: t.name,
          body: teaser(t.intro),
          href: paths.tool(t.slug),
        }))}
      />
      <CtaSection />
    </>
  );
}
