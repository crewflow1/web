import Link from "next/link";
import { POSTS, paths } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { itemListSchema, webPageSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { HubHeader, Section, CtaSection } from "@/components/marketing/sections";

const PATH = paths.blog();

export const metadata = buildMetadata({
  title: "The CrewFlow Blog — Guides for UK Construction Businesses",
  description:
    "Practical guides for running a UK construction business: pricing jobs, getting paid faster, choosing software, and staying on top of tax and CIS. From the CrewFlow team.",
  path: PATH,
  keywords: ["construction business advice", "construction software guides", "how to run a construction business UK"],
  ogEyebrow: "Blog",
});

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default function BlogHubPage() {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Blog", path: PATH },
  ];
  const posts = [...POSTS].sort((a, b) => (a.datePublished < b.datePublished ? 1 : -1));

  return (
    <>
      <JsonLd
        data={[
          webPageSchema({
            name: "The CrewFlow blog",
            description: "Practical guides for running a UK construction business.",
            path: PATH,
          }),
          breadcrumbSchema(crumbs),
          itemListSchema(posts.map((p) => ({ name: p.title, path: paths.post(p.slug) }))),
        ]}
      />
      <HubHeader
        eyebrow="Blog"
        h1="Guides for running a UK construction business"
        intro={
          "No fluff, no jargon — practical advice on pricing jobs, getting paid, choosing software and staying on top of tax. Written for owners who'd rather be on site."
        }
        breadcrumbs={crumbs}
      />
      <Section bg="muted">
        <div className="mx-auto max-w-3xl space-y-4">
          {posts.map((p) => (
            <Link
              key={p.slug}
              href={paths.post(p.slug)}
              className="group block rounded-cf border border-cfborder bg-navy-800 p-6 shadow-cf transition-colors hover:border-gold-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
            >
              <div className="flex items-center gap-3 font-mono text-xs font-semibold uppercase tracking-wide text-gold-500">
                <span>{p.category}</span>
                <span className="text-ink-dim/50">·</span>
                <span className="text-ink-dim">{p.readMinutes} min read</span>
              </div>
              <h2 className="mt-2 font-display text-xl font-semibold text-ink">
                {p.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-mut">{p.excerpt}</p>
              <div className="mt-4 text-xs text-ink-dim">{fmtDate(p.datePublished)}</div>
            </Link>
          ))}
        </div>
      </Section>
      <CtaSection />
    </>
  );
}
