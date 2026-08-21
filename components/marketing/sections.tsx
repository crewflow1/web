import Link from "next/link";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { JsonLd } from "@/components/seo/json-ld";
import { faqSchema } from "@/lib/seo/schema";
import type { Faq } from "@/lib/seo/content";
import { CoordTag } from "@/components/marketing/setting-out";

/*
 * Shared marketing section primitives, unified dark "Setting-Out" system.
 * Every legacy page (compare / industries / features / locations / blog /
 * tools) renders through these, so restyling here re-themes the whole surface.
 * Tokens only (navy / ink / gold / blueprint / cfborder); no ad-hoc hexes,
 * no glow. Headings use the display face (Clash) applied by the group layout.
 */

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

const BG: Record<string, string> = {
  white: "bg-navy-950",
  muted: "bg-navy-900",
  dark: "bg-navy-850",
};

export function Section({
  children,
  bg = "white",
  className = "",
  id,
}: {
  children: React.ReactNode;
  bg?: "white" | "muted" | "dark";
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={BG[bg]}>
      <div className={`mx-auto max-w-cf px-5 sm:px-7 py-20 sm:py-28 ${className}`}>{children}</div>
    </section>
  );
}

/** Legacy alias, the marketing eyebrow IS the CoordTag (consolidated). */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <CoordTag>{children}</CoordTag>;
}

/** Renders a multi-paragraph string (split on blank lines). */
export function Prose({ text, className = "" }: { text: string; className?: string }) {
  return (
    <>
      {text.split("\n\n").map((p, i) => (
        <p
          key={i}
          className={`text-lg leading-relaxed text-ink-mut ${i > 0 ? "mt-4" : ""} ${className}`}
        >
          {p}
        </p>
      ))}
    </>
  );
}

export function CheckList({
  items,
  className = "",
}: {
  items: string[];
  className?: string;
}) {
  return (
    <ul className={`space-y-3.5 text-[15px] text-ink ${className}`}>
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 text-gold-500">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Breadcrumbs (visual; schema is injected by the page)                       */
/* -------------------------------------------------------------------------- */

export function Breadcrumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-ink-dim">
        {items.map((c, i) => (
          <li key={c.path} className="flex items-center gap-1.5">
            {i < items.length - 1 ? (
              <>
                <Link href={c.path} className="transition-colors hover:text-ink">
                  {c.name}
                </Link>
                <span aria-hidden className="text-ink-dim/50">
                  /
                </span>
              </>
            ) : (
              <span className="font-medium text-ink-mut" aria-current="page">
                {c.name}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Page hero (used by every [slug] template)                                  */
/* -------------------------------------------------------------------------- */

export function PageHero({
  eyebrow,
  h1,
  intro,
  bullets,
  breadcrumbs,
  secondaryCta,
}: {
  eyebrow: string;
  h1: string;
  intro: string;
  bullets?: string[];
  breadcrumbs?: { name: string; path: string }[];
  secondaryCta?: { label: string; href: string };
}) {
  return (
    <section>
      <div className="mx-auto max-w-cf px-5 sm:px-7 py-16 sm:py-24">
        {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
        <div className="grid gap-12 lg:grid-cols-12 lg:items-start">
          <div className={bullets ? "lg:col-span-7" : "lg:col-span-9"}>
            <h1 className="max-w-[20ch] font-display text-[clamp(2.4rem,5.5vw,4.25rem)] font-bold leading-[0.99] tracking-[-0.015em] text-ink">
              {h1}
            </h1>
            <div className="mt-6 max-w-2xl">
              <Prose text={intro} />
            </div>
            <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
              <BookDemoButton className="inline-flex h-12 items-center rounded-xl bg-gold-500 px-7 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
                Book a demo
              </BookDemoButton>
              {secondaryCta ? (
                <Link
                  href={secondaryCta.href}
                  className="group inline-flex items-center gap-2 text-base font-medium text-ink transition-colors hover:text-gold-500 focus-visible:outline-none focus-visible:underline"
                >
                  {secondaryCta.label}
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
                </Link>
              ) : null}
            </div>
          </div>
          {bullets ? (
            <div className="lg:col-span-5 lg:pt-2">
              <CheckList items={bullets} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Content sections                                                           */
/* -------------------------------------------------------------------------- */

export function ContentSections({
  sections,
}: {
  sections: { h2: string; body: string; bullets?: string[] }[];
}) {
  return (
    <Section bg="white">
      <div className="mx-auto max-w-3xl space-y-12">
        {sections.map((s, i) => (
          <div key={i}>
            <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink sm:text-3xl">
              {s.h2}
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-mut">{s.body}</p>
            {s.bullets ? <CheckList items={s.bullets} className="mt-6" /> : null}
          </div>
        ))}
      </div>
    </Section>
  );
}

export function OutcomeCards({
  items,
}: {
  items: { stat?: string; label: string; body: string }[];
}) {
  return (
    <Section bg="muted">
      <div className="grid gap-x-10 gap-y-12 sm:grid-cols-3">
        {items.map((o, i) => (
          <div key={i}>
            {o.stat ? (
              <div className="font-display text-[2.8rem] font-bold leading-none tabular-nums tracking-tight text-gold-500">
                {o.stat}
              </div>
            ) : null}
            <div className={`font-display text-lg font-semibold text-ink ${o.stat ? "mt-3" : ""}`}>
              {o.label}
            </div>
            <p className="mt-2.5 text-[15px] leading-relaxed text-ink-mut">{o.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* FAQ, renders the accordion AND injects FAQPage JSON-LD                     */
/* -------------------------------------------------------------------------- */

export function FaqSection({
  items,
  title = "Common questions",
}: {
  items: Faq[];
  title?: string;
}) {
  if (!items?.length) return null;
  return (
    <Section bg="white">
      <JsonLd data={faqSchema(items)} />
      <div className="mx-auto max-w-3xl">
        <h2 className="text-center font-display text-2xl font-bold tracking-[-0.02em] text-ink sm:text-3xl">
          {title}
        </h2>
        <div className="mt-10">
          {items.map((q) => (
            <details key={q.q} className="group -mx-4 rounded-xl px-4 py-4 transition-colors open:bg-white/[0.02]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-lg font-semibold text-ink [&::-webkit-details-marker]:hidden">
                {q.q}
                <span
                  aria-hidden
                  className="text-2xl font-light text-ink-dim transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-mut">{q.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Related internal links                                                     */
/* -------------------------------------------------------------------------- */

export function RelatedLinks({
  groups,
}: {
  groups: { title: string; links: { label: string; href: string }[] }[];
}) {
  const visible = groups.filter((g) => g.links.length > 0);
  if (!visible.length) return null;
  return (
    <Section bg="muted">
      <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((g) => (
          <div key={g.title}>
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-dim">
              {g.title}
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="font-medium text-ink-mut transition-colors hover:text-gold-500"
                  >
                    {l.label} →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Comparison table                                                           */
/* -------------------------------------------------------------------------- */

export function ComparisonTable({
  competitorName,
  rows,
}: {
  competitorName: string;
  rows: { feature: string; crewflow: string; competitor: string }[];
}) {
  return (
    <Section bg="white">
      <div className="mx-auto max-w-4xl overflow-x-auto rounded-cf border border-cfborder shadow-cf">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-navy-800 text-ink">
              <th className="px-4 py-4 text-left font-semibold">Feature</th>
              <th className="px-4 py-4 text-left font-semibold">
                <span className="text-gold-500">CrewFlow</span>
              </th>
              <th className="px-4 py-4 text-left font-semibold">{competitorName}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.feature} className={i % 2 === 0 ? "bg-navy-900" : "bg-navy-850"}>
                <td className="px-4 py-4 font-medium text-ink">{r.feature}</td>
                <td className="px-4 py-4 text-ink-mut">{r.crewflow}</td>
                <td className="px-4 py-4 text-ink-dim">{r.competitor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Two-column honesty section (where each wins)                               */
/* -------------------------------------------------------------------------- */

export function VersusColumns({
  competitorName,
  crewflowWins,
  competitorWins,
}: {
  competitorName: string;
  crewflowWins: string[];
  competitorWins: string[];
}) {
  return (
    <Section bg="muted">
      <div className="grid gap-x-12 gap-y-10 pt-2 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-gold-500">
            Where CrewFlow is the better fit
          </h3>
          <CheckList items={crewflowWins} className="mt-6" />
        </div>
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-ink-dim">
            Where {competitorName} is the better fit
          </h3>
          <ul className="mt-6 space-y-3.5 text-[15px] text-ink-mut">
            {competitorWins.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Final CTA band                                                             */
/* -------------------------------------------------------------------------- */

export function CtaSection({
  title = "See it on your own data.",
  body = "30 minutes. We'll import a sample of your existing setup live on the call so you see exactly what your dashboard would look like tomorrow morning.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <section className="bg-navy-950">
      <div className="mx-auto max-w-cf px-5 py-24 text-center sm:px-7 sm:py-32">
        <h2 className="mx-auto max-w-2xl font-display text-[clamp(2rem,4.4vw,3.4rem)] font-bold leading-[1.02] tracking-[-0.02em] text-ink">
          {title}
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-ink-mut">{body}</p>
        <div className="mt-9 flex justify-center">
          <BookDemoButton className="inline-flex h-12 items-center rounded-xl bg-gold-500 px-7 text-base font-semibold text-navy-950 transition-colors hover:bg-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
            Book a demo
          </BookDemoButton>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Hub card grid                                                              */
/* -------------------------------------------------------------------------- */

export function CardGrid({
  cards,
}: {
  cards: { title: string; body: string; href: string; tag?: string }[];
}) {
  return (
    <Section bg="muted">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-2xl bg-navy-900 p-6 transition-colors hover:bg-navy-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
          >
            {c.tag ? (
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-500">
                {c.tag}
              </span>
            ) : null}
            <h3 className="mt-1 font-display text-lg font-semibold text-ink">
              {c.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-mut">{c.body}</p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-gold-500">
              Learn more{" "}
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </span>
          </Link>
        ))}
      </div>
    </Section>
  );
}

export function HubHeader({
  eyebrow,
  h1,
  intro,
  breadcrumbs,
}: {
  eyebrow: string;
  h1: string;
  intro: string;
  breadcrumbs?: { name: string; path: string }[];
}) {
  return (
    <section>
      <div className="mx-auto max-w-cf px-5 sm:px-7 py-16 sm:py-24">
        {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
        <h1 className="max-w-[20ch] font-display text-[clamp(2.4rem,5.5vw,4.25rem)] font-bold leading-[0.99] tracking-[-0.015em] text-ink">
          {h1}
        </h1>
        <div className="mt-6 max-w-2xl">
          <Prose text={intro} />
        </div>
      </div>
    </section>
  );
}
