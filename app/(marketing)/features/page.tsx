import { FEATURES, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { itemListSchema, webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { HubHeader, CardGrid, CtaSection } from "@/components/marketing/sections";

const PATH = paths.features();

export const metadata = buildMetadata({
  title: "Features — One System for the Whole Construction Business",
  description:
    "Every CrewFlow feature in one place: CRM, quoting, job management, scheduling, timesheets, payroll, invoicing, payment tracking, job costing, tax and AI. Book a demo.",
  path: PATH,
  keywords: ["construction software features", "construction management software", "construction operating system"],
  ogEyebrow: "Features",
});

function firstSentence(text: string): string {
  const clean = text.replace(/\n\n/g, " ");
  const idx = clean.indexOf(". ");
  return idx === -1 ? clean : clean.slice(0, idx + 1);
}

export default function FeaturesHubPage() {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Features", path: PATH },
  ];
  return (
    <>
      <JsonLd
        data={[
          webPageSchema({
            name: "CrewFlow features",
            description:
              "Every CrewFlow feature for UK construction companies — from CRM and quoting to payroll, profitability and tax.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
          itemListSchema(FEATURES.map((f) => ({ name: f.name, path: paths.feature(f.slug) }))),
        ]}
      />
      <HubHeader
        eyebrow="Features"
        h1="Every part of your construction business, in one system"
        intro={
          "CrewFlow replaces the five tools that don't talk to each other. From the first enquiry to the Corporation Tax return, every feature connects to the next — so nothing is re-keyed and nothing slips.\n\nExplore each capability below."
        }
        breadcrumbs={crumbs}
      />
      <CardGrid
        cards={FEATURES.map((f) => ({
          tag: f.eyebrow,
          title: f.name,
          body: firstSentence(f.intro),
          href: paths.feature(f.slug),
        }))}
      />
      <CtaSection />
    </>
  );
}
