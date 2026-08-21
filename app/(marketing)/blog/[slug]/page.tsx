import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { POSTS, getPost, getPostLinks, getFeatureLinks, paths, type BlogBlock } from "@/lib/seo/content";
import { buildMetadata } from "@/lib/seo/metadata";
import { ogImageUrl } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { articleSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { Breadcrumbs, FaqSection, RelatedLinks, CtaSection } from "@/components/marketing/sections";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";

export const dynamicParams = false;

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const p = getPost(slug);
  if (!p) return {};
  return buildMetadata({
    title: p.title,
    titleAbsolute: true,
    description: p.metaDescription,
    path: paths.post(p.slug),
    keywords: [p.keyword],
    type: "article",
    publishedTime: p.datePublished,
    modifiedTime: p.dateModified ?? p.datePublished,
    ogEyebrow: p.category,
    image: ogImageUrl({ title: p.title, eyebrow: p.category }),
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function Block({ block }: { block: BlogBlock }) {
  switch (block.type) {
    case "p":
      return <p className="mt-5 text-lg leading-relaxed text-ink-mut">{block.text}</p>;
    case "h2":
      return <h2 className="mt-12 font-display text-2xl font-bold tracking-[-0.02em] text-ink">{block.text}</h2>;
    case "h3":
      return <h3 className="mt-8 font-display text-xl font-semibold text-ink">{block.text}</h3>;
    case "ul":
      return (
        <ul className="mt-5 list-disc space-y-2 pl-6 text-lg text-ink-mut marker:text-gold-500">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="mt-5 list-decimal space-y-2 pl-6 text-lg text-ink-mut marker:text-ink-dim">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote className="mt-6 rounded-2xl bg-navy-900 px-6 py-5 text-lg italic text-ink-mut">
          {block.text}
          {block.cite ? <cite className="mt-2 block text-sm not-italic text-ink-dim">{block.cite}</cite> : null}
        </blockquote>
      );
    case "cta":
      return (
        <div className="mt-8 rounded-cf border border-cfborder bg-navy-900 p-6 text-center">
          <p className="text-base font-medium text-ink">{block.text}</p>
          <div className="mt-4 flex justify-center">
            <BookDemoButton className="inline-flex h-11 items-center rounded-lg bg-gold-500 px-5 text-sm font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
          </div>
        </div>
      );
  }
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const p = getPost(slug);
  if (!p) notFound();

  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Blog", path: paths.blog() },
    { name: p.title, path: paths.post(p.slug) },
  ];

  return (
    <>
      <JsonLd
        data={[
          articleSchema({
            headline: p.title,
            description: p.metaDescription,
            path: paths.post(p.slug),
            datePublished: p.datePublished,
            dateModified: p.dateModified,
            image: ogImageUrl({ title: p.title, eyebrow: p.category }),
          }),
          breadcrumbSchema(crumbs),
        ]}
      />

      <article>
        <div className="mx-auto max-w-cf px-5 py-16 sm:px-7">
          <div className="mx-auto max-w-3xl">
            <Breadcrumbs items={crumbs} />
            <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.12em] text-gold-500">
              <span>{p.category}</span>
              <span className="text-ink-dim/50">·</span>
              <span className="text-ink-dim">{p.readMinutes} min read</span>
            </div>
            <h1 className="mt-3 font-display text-[clamp(2rem,4.5vw,3.25rem)] font-bold leading-[1.08] tracking-[-0.03em] text-ink">
              {p.h1}
            </h1>
            <div className="mt-4 text-sm text-ink-dim">
              Published {fmtDate(p.datePublished)} · By the CrewFlow team
            </div>

            <div className="mt-8">
              {p.body.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </div>
          </div>
        </div>
      </article>

      {p.faqs?.length ? <FaqSection items={p.faqs} /> : null}

      <RelatedLinks
        groups={[
          { title: "Keep reading", links: getPostLinks(p.related) },
          { title: "Related features", links: getFeatureLinks(p.relatedFeatures ?? []) },
        ]}
      />

      <CtaSection />
    </>
  );
}
