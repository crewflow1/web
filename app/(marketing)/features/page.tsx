import Link from "next/link";
import { FEATURES, paths } from "@/lib/seo/content";
import { PILLARS } from "@/lib/marketing/pillars";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { itemListSchema, webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { HubHeader, CtaSection } from "@/components/marketing/sections";

const PATH = paths.features();

export const metadata = buildMetadata({
  title: "Features, everything CrewFlow does for UK construction",
  description:
    "The whole platform, grouped the way the business works: win work, run jobs, prove the site is safe, control the money, manage people and plant, and automate the chasing. In-depth guides to every core capability.",
  path: PATH,
  keywords: ["construction software features", "construction management software", "construction operating system"],
  ogEyebrow: "Features",
});

/**
 * Capability name → in-depth SEO guide slug, for the capabilities that have a
 * dedicated feature page. Everything else is shown as text (real, live, but no
 * separate guide yet), so the page reflects the FULL breadth without inventing
 * pages that don't exist.
 */
const GUIDE: Record<string, string> = {
  "CRM & leads": "construction-crm",
  "Quotes & estimates": "quoting-software",
  "Job management": "job-management-software",
  "Scheduling & calendar": "scheduling-software",
  "Customer portal": "customer-portal",
  "Cash position": "payments-reconciliation",
  Invoicing: "invoicing-software",
  "Job costing": "job-costing-software",
  Expenses: "expense-tracking",
  "CIS & tax figures": "tax-software",
  Workforce: "timesheet-software",
  Payroll: "payroll-software",
};

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
              "Every CrewFlow capability for UK construction companies, grouped by the part of the business it runs.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
          itemListSchema(FEATURES.map((f) => ({ name: f.name, path: paths.feature(f.slug) }))),
        ]}
      />
      <HubHeader
        eyebrow="Features"
        h1="Everything CrewFlow does, grouped the way the business works"
        intro={
          "Far more than a job app. This is the whole platform, six connected parts of the business, so a lead flows all the way through to the tax figures your accountant files.\n\nThe capabilities people search for most have in-depth guides, linked below. Everything listed is live today."
        }
        breadcrumbs={crumbs}
      />

      <section className="bg-navy-900">
        <div className="mx-auto max-w-cf space-y-16 px-5 py-20 sm:space-y-20 sm:px-7 sm:py-28">
          {PILLARS.map((p) => (
            <div key={p.slug}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                <h2 className="font-display text-2xl font-bold tracking-[-0.015em] text-ink sm:text-3xl">
                  {p.label}
                </h2>
                <Link
                  href={`/product/${p.slug}`}
                  className="group inline-flex items-center gap-2 text-sm font-medium text-ink-mut transition-colors hover:text-gold-500 focus-visible:outline-none focus-visible:underline"
                >
                  Explore {p.label.toLowerCase()}
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
                </Link>
              </div>
              <ul className="mt-7 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                {p.capabilities.map((c) => {
                  const slug = GUIDE[c.name];
                  return (
                    <li key={c.name}>
                      {slug ? (
                        <Link
                          href={paths.feature(slug)}
                          className="group font-display text-lg font-bold text-ink transition-colors hover:text-gold-500 focus-visible:outline-none focus-visible:underline"
                        >
                          {c.name}
                          <span aria-hidden="true" className="ml-1 text-gold-500 opacity-0 transition-opacity group-hover:opacity-100">→</span>
                        </Link>
                      ) : (
                        <span className="font-display text-lg font-bold text-ink">{c.name}</span>
                      )}
                      <div className="mt-1.5 text-[15px] leading-relaxed text-ink-mut">{c.note}</div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-navy-950">
        <div className="mx-auto max-w-cf px-5 py-16 text-center sm:px-7">
          <Link
            href="/product"
            className="group inline-flex items-center gap-2 text-base font-semibold text-gold-500 transition-colors hover:text-gold-400 focus-visible:outline-none focus-visible:underline"
          >
            See how it all connects, the whole platform
            <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
          </Link>
        </div>
      </section>

      <CtaSection />
    </>
  );
}
