import Link from "next/link";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { JsonLd } from "@/components/seo/json-ld";
import { faqSchema } from "@/lib/seo/schema";
import type { Faq } from "@/lib/seo/content";

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

const BG: Record<string, string> = {
  white: "bg-white",
  muted: "bg-slate-50/60",
  dark: "bg-slate-900 text-white",
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
    <section id={id} className={`border-b border-slate-200 ${BG[bg]}`}>
      <div className={`container py-16 sm:py-20 ${className}`}>{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
      {children}
    </p>
  );
}

/** Renders a multi-paragraph string (split on blank lines). */
export function Prose({ text, className = "" }: { text: string; className?: string }) {
  return (
    <>
      {text.split("\n\n").map((p, i) => (
        <p key={i} className={`text-lg leading-relaxed text-slate-600 ${i > 0 ? "mt-4" : ""} ${className}`}>
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
    <ul className={`space-y-3 text-sm text-slate-700 ${className}`}>
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700"
          >
            ✓
          </span>
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
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
        {items.map((c, i) => (
          <li key={c.path} className="flex items-center gap-1.5">
            {i < items.length - 1 ? (
              <>
                <Link href={c.path} className="hover:text-slate-800">
                  {c.name}
                </Link>
                <span aria-hidden className="text-slate-300">
                  /
                </span>
              </>
            ) : (
              <span className="font-medium text-slate-700" aria-current="page">
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
    <section className="relative overflow-hidden border-b border-slate-200 bg-white">
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(251,191,36,0.08),transparent_55%)]"
      />
      <div className="container relative py-14 sm:py-20">
        {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
        <div className="grid gap-10 lg:grid-cols-12">
          <div className={bullets ? "lg:col-span-7" : "lg:col-span-9"}>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h1 className="mt-4 text-3xl font-bold leading-[1.1] tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">
              {h1}
            </h1>
            <div className="mt-5 max-w-2xl">
              <Prose text={intro} />
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <BookDemoButton size="lg">Book demo</BookDemoButton>
              {secondaryCta ? (
                <Link
                  href={secondaryCta.href}
                  className="rounded-md border border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                >
                  {secondaryCta.label}
                </Link>
              ) : null}
            </div>
          </div>
          {bullets ? (
            <div className="lg:col-span-5">
              <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-6 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  What you get
                </p>
                <CheckList items={bullets} className="mt-4" />
              </div>
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
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              {s.h2}
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-slate-600">{s.body}</p>
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
      <div className="grid gap-4 md:grid-cols-3">
        {items.map((o, i) => (
          <div
            key={i}
            className="rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm"
          >
            {o.stat ? (
              <div className="text-4xl font-bold tracking-tight text-slate-900">{o.stat}</div>
            ) : null}
            <div className={`text-sm font-semibold text-slate-900 ${o.stat ? "mt-2" : ""}`}>
              {o.label}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{o.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* FAQ — renders the accordion AND injects FAQPage JSON-LD                     */
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
        <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          {title}
        </h2>
        <div className="mt-10 space-y-3">
          {items.map((q) => (
            <details
              key={q.q}
              className="group rounded-xl border border-slate-200 bg-slate-50/40 px-5 py-4 open:bg-white open:shadow-sm"
            >
              <summary className="flex cursor-pointer items-center justify-between text-base font-semibold text-slate-900 marker:hidden [&::-webkit-details-marker]:hidden">
                {q.q}
                <span aria-hidden className="ml-4 text-slate-500 transition group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{q.a}</p>
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
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {g.title}
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="font-medium text-slate-700 hover:text-amber-700">
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
      <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-900 text-white">
              <th className="px-4 py-4 text-left font-semibold">Feature</th>
              <th className="px-4 py-4 text-left font-semibold">
                <span className="text-amber-400">CrewFlow</span>
              </th>
              <th className="px-4 py-4 text-left font-semibold">{competitorName}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.feature} className={i % 2 === 0 ? "bg-white" : "bg-slate-50/60"}>
                <td className="px-4 py-4 font-medium text-slate-900">{r.feature}</td>
                <td className="px-4 py-4 text-slate-700">{r.crewflow}</td>
                <td className="px-4 py-4 text-slate-500">{r.competitor}</td>
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
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-7">
          <h3 className="text-lg font-semibold text-emerald-900">Where CrewFlow is the better fit</h3>
          <CheckList items={crewflowWins} className="mt-5" />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-7">
          <h3 className="text-lg font-semibold text-slate-900">
            Where {competitorName} is the better fit
          </h3>
          <ul className="mt-5 space-y-3 text-sm text-slate-700">
            {competitorWins.map((it, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600"
                >
                  →
                </span>
                <span>{it}</span>
              </li>
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
    <section className="bg-white">
      <div className="container py-16 sm:py-20">
        <div className="relative overflow-hidden rounded-3xl bg-slate-900 px-8 py-16 text-center shadow-2xl sm:px-16">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(251,191,36,0.18),transparent_60%)]"
          />
          <div className="relative">
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{title}</h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-slate-300">{body}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <BookDemoButton size="lg">Book demo</BookDemoButton>
            </div>
          </div>
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
            className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-amber-300 hover:shadow-md"
          >
            {c.tag ? (
              <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                {c.tag}
              </span>
            ) : null}
            <h3 className="mt-1 text-lg font-semibold text-slate-900 group-hover:text-amber-800">
              {c.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.body}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-amber-700">
              Learn more →
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
    <section className="border-b border-slate-200 bg-white">
      <div className="container py-14 sm:py-20">
        {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-4 max-w-3xl text-3xl font-bold leading-[1.1] tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">
          {h1}
        </h1>
        <div className="mt-5 max-w-2xl">
          <Prose text={intro} />
        </div>
      </div>
    </section>
  );
}
