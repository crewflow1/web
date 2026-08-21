import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { PILLARS, pillarBySlug } from "@/lib/marketing/pillars";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { ProductFrame } from "@/components/marketing/product-frame";
import { buildMetadata } from "@/lib/seo/metadata";

export const dynamicParams = false;

export function generateStaticParams() {
  return PILLARS.map((p) => ({ pillar: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pillar: string }>;
}): Promise<Metadata> {
  const { pillar } = await params;
  const p = pillarBySlug(pillar);
  if (!p) return {};
  return buildMetadata({
    title: `${p.label} — CrewFlow for UK construction`,
    titleAbsolute: true,
    description: p.summary,
    path: `/product/${p.slug}`,
    ogTitle: p.headline,
    ogEyebrow: p.eyebrow,
  });
}

export default async function PillarPage({
  params,
}: {
  params: Promise<{ pillar: string }>;
}) {
  const { pillar } = await params;
  const p = pillarBySlug(pillar);
  if (!p) notFound();
  const others = PILLARS.filter((x) => x.slug !== p.slug);

  return (
    <>
      {/* Hero */}
      <section>
        <div className="mx-auto max-w-cf px-5 py-16 sm:px-7 sm:py-24">
          <nav aria-label="Breadcrumb" className="text-sm text-ink-dim">
            <Link href="/product" className="hover:text-ink">
              Platform
            </Link>{" "}
            <span aria-hidden="true">/</span>{" "}
            <span className="text-ink-mut">{p.label}</span>
          </nav>
          <h1 className="mt-6 max-w-[20ch] font-display text-[clamp(2.4rem,5.5vw,4.25rem)] font-bold leading-[0.99] tracking-[-0.015em] text-ink">
            {p.headline}
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-mut">{p.summary}</p>
          <div className="mt-8">
            <BookDemoButton className="inline-flex h-12 items-center rounded-lg bg-gold-500 px-6 text-base font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
              Book a demo
            </BookDemoButton>
          </div>
        </div>
      </section>

      {/* Real product screenshot (when available for this pillar) */}
      {p.shot ? (
        <section className="bg-navy-900">
          <div className="mx-auto max-w-cf px-5 py-16 sm:px-7 sm:py-24">
            <ProductFrame
              screen={p.shot.screen}
              url={p.shot.url}
              className="mx-auto max-w-5xl"
            >
              <Image
                src={p.shot.src}
                alt={p.shot.alt}
                width={p.shot.w}
                height={p.shot.h}
                sizes="(max-width: 1024px) 100vw, 1024px"
                className="h-auto w-full"
              />
            </ProductFrame>
          </div>
        </section>
      ) : null}

      {/* Capabilities */}
      <section className="mx-auto max-w-cf px-5 py-16 sm:px-7 sm:py-20">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          What&apos;s inside
        </h2>
        <div className="mt-10 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {p.capabilities.map((c) => (
            <div key={c.name}>
              <h3 className="font-display text-lg font-bold text-ink">
                {c.name}
              </h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-mut">{c.note}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 max-w-2xl text-sm text-ink-dim">
          Everything here is live today — no add-ons, no per-feature upsells,
          nothing you have to wait for.
        </p>
      </section>

      {/* Part of one system */}
      <section className="bg-navy-900">
        <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
          <h2 className="font-display text-2xl font-bold tracking-tight">
            Part of one connected system
          </h2>
          <p className="mt-3 max-w-2xl text-ink-mut">
            {p.label} doesn&apos;t sit on its own — it feeds the rest of CrewFlow,
            so you enter things once and they flow all the way through.
          </p>
          <div className="mt-10 flex flex-wrap gap-x-8 gap-y-4">
            {others.map((o) => (
              <Link
                key={o.slug}
                href={`/product/${o.slug}`}
                className="group inline-flex items-center gap-2 text-lg font-medium text-ink transition-colors hover:text-gold-500 focus-visible:outline-none focus-visible:underline"
              >
                {o.label}
                <span aria-hidden="true" className="text-ink-dim transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section>
        <div className="mx-auto max-w-cf px-5 py-24 text-center sm:px-7 sm:py-32">
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            See {p.label.toLowerCase()} on your own jobs.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-mut">
            A 30-minute demo walked through with your real numbers. No slides.
          </p>
          <div className="mt-6 flex justify-center">
            <BookDemoButton className="inline-flex h-12 items-center rounded-lg bg-gold-500 px-6 text-base font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600">
              Book a demo
            </BookDemoButton>
          </div>
        </div>
      </section>
    </>
  );
}
