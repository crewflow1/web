import Image from "next/image";
import { CoordTag } from "@/components/marketing/setting-out";
import { Reveal } from "@/components/marketing/reveal";

/**
 * Signature moment — "One job, end to end."
 *
 * One real job travels the CrewFlow spine across five stages, each a genuine,
 * large product crop set as the "built object" beside its narrative. The
 * setting-out line runs down the left (blueprint → gold), the job progressing
 * as you descend; each stage rises into view once as you reach it.
 *
 * Composed-by-construction: every stage is a complete row (text + frame) so the
 * section always reads, at any scroll position, on any width — no sticky-scroll
 * runway to look empty. Reveal is one-shot + default-visible (no-JS/reduced-
 * motion safe). Desktop = text beside a wide frame; mobile = text above it.
 */

type Stage = {
  n: string;
  tag: string;
  label: string;
  note: string;
  src: string;
  alt: string;
  url: string;
};

const STAGES: Stage[] = [
  {
    n: "01",
    tag: "REV A",
    label: "Price it",
    note: "A line-item quote with full VAT, out the door in minutes — not a night at the kitchen table.",
    src: "/product-shots/journey/quotes.png",
    alt: "CrewFlow quotes list — line-item quotes for construction jobs with customer, status, valid-until date and VAT-inclusive totals.",
    url: "app.crewflow.uk/quotes",
  },
  {
    n: "02",
    tag: "REV B",
    label: "Win it",
    note: "The customer signs the quote by name and it becomes a live job — costs, schedule and site details already attached. Nothing re-keyed.",
    src: "/product-shots/journey/jobs.png",
    alt: "CrewFlow jobs list — live jobs with status (new, in-progress, blocked, completed), customer, site address and scheduled dates.",
    url: "app.crewflow.uk/jobs",
  },
  {
    n: "03",
    tag: "REV C",
    label: "Prove it's safe",
    note: "Issue the RAMS before anyone lifts a tool — every hazard scored on a 5×5 matrix, signed off, and frozen as the record for the site.",
    src: "/product-shots/journey/rams.png",
    alt: "CrewFlow health & safety register — issued RAMS with hazard counts, risk ratings, and an alert for active jobs with no current risk assessment.",
    url: "app.crewflow.uk/health-safety",
  },
  {
    n: "04",
    tag: "REV D",
    label: "Bill the work",
    note: "Stage valuations and applications for payment as the job runs, then invoices that chase themselves — day 3, 7, 14, 21 — until the money lands.",
    src: "/product-shots/journey/invoices.png",
    alt: "CrewFlow invoices list — invoices with status, due date and a full net / VAT / total breakdown, plus CSV, Xero and Sage export.",
    url: "app.crewflow.uk/invoices",
  },
  {
    n: "05",
    tag: "REV E",
    label: "See the whole company",
    note: "Every job feeds one screen — what's late, what's owed, what's making money. The morning brief that used to take an afternoon.",
    src: "/product-shots/journey/dashboard.png",
    alt: "CrewFlow dashboard — a morning brief flagging an active job without a current RAMS, an overdue invoice and money due from customers this week.",
    url: "app.crewflow.uk/dashboard",
  },
];

function Frame({ url, src, alt, priority }: { url: string; src: string; alt: string; priority: boolean }) {
  return (
    <figure className="overflow-hidden rounded-cf border border-white/10 bg-navy-850 shadow-cf ring-1 ring-inset ring-white/[0.04]">
      <div
        aria-hidden="true"
        className="flex items-center gap-2 border-b border-white/10 bg-navy-800 px-3.5 py-2.5"
      >
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        </span>
        <span className="ml-2 truncate rounded-md bg-navy-950/60 px-2.5 py-1 font-mono text-[11px] text-ink-dim">
          {url}
        </span>
      </div>
      <div className="bg-[#F7F9FC]">
        <Image
          src={src}
          alt={alt}
          width={1440}
          height={600}
          priority={priority}
          sizes="(max-width: 1023px) 100vw, 740px"
          className="h-auto w-full"
        />
      </div>
    </figure>
  );
}

export function JobJourney() {
  return (
    <section className="relative border-t border-white/5 bg-navy-950">
      <div className="mx-auto max-w-cf px-5 pt-20 sm:px-7 sm:pt-28">
        <CoordTag>Example job · Kitchen extension, Belfast</CoordTag>
        <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
          One job, end to end.
        </h2>
        <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-mut">
          You enter it once. Follow a single job down through CrewFlow — from the
          first price to the last payment, with the site and commercial work that
          wins bigger jobs built into the middle.
        </p>
      </div>

      <ol className="relative mx-auto mt-14 max-w-cf px-5 sm:mt-16 sm:px-7">
        {/* Structural setting-out line: blueprint at the top, gold by the end. */}
        <span
          aria-hidden="true"
          className="absolute bottom-10 left-[calc(1.25rem+7px)] top-2 w-px bg-gradient-to-b from-blueprint via-blueprint to-gold-500 sm:left-[calc(1.75rem+7px)]"
        />
        {STAGES.map((s, i) => {
          const last = i === STAGES.length - 1;
          return (
            <li key={s.n} className="relative pb-14 pl-10 last:pb-0 sm:pb-16">
              <span
                aria-hidden="true"
                className={`absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 ${
                  last ? "border-gold-500 bg-gold-500" : "border-blueprint bg-navy-950"
                }`}
              />
              <Reveal>
                <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:gap-12">
                  <div>
                    <span className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-dim">
                      <span className="text-gold-500">{s.n}</span>
                      <span className="text-ink-dim/50">·</span>
                      <span>{s.tag}</span>
                    </span>
                    <h3 className="mt-2.5 font-display text-2xl font-bold tracking-[-0.02em] text-ink">
                      {s.label}
                    </h3>
                    <p className="mt-3 max-w-md text-[15px] leading-relaxed text-ink-mut">
                      {s.note}
                    </p>
                  </div>
                  <Frame url={s.url} src={s.src} alt={s.alt} priority={false} />
                </div>
              </Reveal>
            </li>
          );
        })}
      </ol>

      <div className="h-20 sm:h-28" />
    </section>
  );
}
