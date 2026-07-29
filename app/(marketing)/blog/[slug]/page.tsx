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
      return <p className="mt-5 text-lg leading-relaxed text-slate-700">{block.text}</p>;
    case "h2":
      return <h2 className="mt-12 text-2xl font-bold tracking-tight text-slate-900">{block.text}</h2>;
    case "h3":
      return <h3 className="mt-8 text-xl font-semibold text-slate-900">{block.text}</h3>;
    case "ul":
      return (
        <ul className="mt-5 list-disc space-y-2 pl-6 text-lg text-slate-700">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="mt-5 list-decimal space-y-2 pl-6 text-lg text-slate-700">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote className="mt-6 border-l-4 border-amber-400 bg-slate-50 py-3 pl-5 text-lg italic text-slate-700">
          {block.text}
          {block.cite ? <cite className="mt-2 block text-sm not-italic text-slate-500">— {block.cite}</cite> : null}
        </blockquote>
      );
    case "cta":
      return (
        <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
          <p className="text-base font-medium text-slate-800">{block.text}</p>
          <div className="mt-4 flex justify-center">
            <BookDemoButton size="md">Book a demo</BookDemoButton>
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

      <article className="border-b border-slate-200 bg-white">
        <div className="container py-14 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <Breadcrumbs items={crumbs} />
            <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-amber-700">
              <span>{p.category}</span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500">{p.readMinutes} min read</span>
            </div>
            <h1 className="mt-3 text-3xl font-bold leading-[1.15] tracking-tight text-slate-900 sm:text-4xl">
              {p.h1}
            </h1>
            <div className="mt-4 text-sm text-slate-500">
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
