"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { CoordTag } from "@/components/marketing/setting-out";

/**
 * Signature moment — "One job, end to end."
 *
 * One real job travels the CrewFlow spine. On desktop it's scrollytelling: the
 * product frame is sticky and cross-fades to the active stage's REAL UI crop as
 * the narrative scrolls, while the structural setting-out line fills gold to the
 * active station. On mobile it's a bespoke vertical sequence (not the desktop
 * layout shrunk). Every crop is genuine product UI on illustrative demo data.
 *
 * Robustness by construction:
 *  - No JS / IntersectionObserver-unsupported → the first frame shows and the
 *    narrative text (which carries the whole story) is fully readable; nothing
 *    is stuck hidden. Every stage's alt text is in the DOM for screen readers.
 *  - prefers-reduced-motion → stage swaps are instant (no cross-fade); the
 *    scroll sync still works but never animates (see globals.css .jj-frame).
 *  - The only per-frame compositor work is opacity.
 */

type Stage = {
  n: string;
  tag: string;
  label: string;
  note: string;
  src: string;
  alt: string;
  screen: string;
  url: string;
};

// All crops are a uniform 1440×600 (see scripts/capture-shots.mjs JOURNEY set)
// so they stack and cross-fade without reflow.
const STAGES: Stage[] = [
  {
    n: "01",
    tag: "REV A",
    label: "Price it",
    note: "A line-item quote with full VAT, out the door in minutes — not a night at the kitchen table.",
    src: "/product-shots/journey/quotes.png",
    alt: "CrewFlow quotes list — line-item quotes for construction jobs with customer, status, valid-until date and VAT-inclusive totals.",
    screen: "Quotes",
    url: "app.crewflow.uk/quotes",
  },
  {
    n: "02",
    tag: "REV B",
    label: "Win it",
    note: "The customer signs the quote by name and it becomes a live job — costs, schedule and site details already attached. Nothing re-keyed.",
    src: "/product-shots/journey/jobs.png",
    alt: "CrewFlow jobs list — live jobs with status (new, in-progress, blocked, completed), customer, site address and scheduled dates.",
    screen: "Jobs",
    url: "app.crewflow.uk/jobs",
  },
  {
    n: "03",
    tag: "REV C",
    label: "Prove it's safe",
    note: "Issue the RAMS before anyone lifts a tool — every hazard scored on a 5×5 matrix, signed off, and frozen as the record for the site.",
    src: "/product-shots/journey/rams.png",
    alt: "CrewFlow health & safety register — issued RAMS with hazard counts, risk ratings, and an alert for active jobs with no current risk assessment.",
    screen: "Health & safety",
    url: "app.crewflow.uk/health-safety",
  },
  {
    n: "04",
    tag: "REV D",
    label: "Bill the work",
    note: "Stage valuations and applications for payment as the job runs, then invoices that chase themselves — day 3, 7, 14, 21 — until the money lands.",
    src: "/product-shots/journey/invoices.png",
    alt: "CrewFlow invoices list — invoices with status, due date and a full net / VAT / total breakdown, plus CSV, Xero and Sage export.",
    screen: "Invoices",
    url: "app.crewflow.uk/invoices",
  },
  {
    n: "05",
    tag: "REV E",
    label: "See the whole company",
    note: "Every job feeds one screen — what's late, what's owed, what's making money. The morning brief that used to take an afternoon.",
    src: "/product-shots/journey/dashboard.png",
    alt: "CrewFlow dashboard — a morning brief flagging an active job without a current RAMS, an overdue invoice and money due from customers this week.",
    screen: "Operations dashboard",
    url: "app.crewflow.uk/dashboard",
  },
];

function Chrome({ url }: { url: string }) {
  return (
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
  );
}

export function JobJourney() {
  const [active, setActive] = useState(0);
  const stepsRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const root = stepsRef.current;
    if (!root) return;
    const steps = Array.from(root.querySelectorAll<HTMLElement>("[data-step]"));
    if (!steps.length) return;
    let raf = 0;
    // The active stage is simply the one whose vertical centre is nearest the
    // viewport middle. Deterministic (no IO band edge cases with tall steps),
    // rAF-throttled, passive — cheap and predictable.
    const update = () => {
      raf = 0;
      const mid = window.innerHeight / 2;
      let best = 0;
      let bestDist = Infinity;
      steps.forEach((s, i) => {
        const r = s.getBoundingClientRect();
        const dist = Math.abs(r.top + r.height / 2 - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      setActive(best);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="relative border-t border-white/5 bg-navy-950">
      <div className="mx-auto max-w-cf px-5 pt-20 sm:px-7 sm:pt-28">
        <CoordTag>Example job · Kitchen extension, Belfast</CoordTag>
        <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
          One job, end to end.
        </h2>
        <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-mut">
          You enter it once. Watch a single job move through CrewFlow — from the
          first price to the last payment, with the site and commercial work that
          wins bigger jobs built into the middle.
        </p>
      </div>

      {/* Desktop: sticky scrollytelling */}
      <div className="mx-auto hidden max-w-cf px-5 sm:px-7 lg:block">
        <div className="grid grid-cols-[minmax(0,0.82fr)_minmax(0,1.28fr)] gap-16">
          {/* Narrative (scrolls) */}
          <ol ref={stepsRef} className="relative py-[10vh]">
            <span
              aria-hidden="true"
              className="absolute bottom-0 left-[7px] top-0 w-px bg-white/10"
            />
            <span
              aria-hidden="true"
              className="jj-fill absolute left-[7px] top-0 w-px bg-gradient-to-b from-blueprint to-gold-500"
              style={{ height: `${((active + 1) / STAGES.length) * 100}%` }}
            />
            {STAGES.map((s, i) => {
              const on = i <= active;
              return (
                <li
                  key={s.n}
                  data-step={i}
                  className="relative flex min-h-[72vh] flex-col justify-center pl-10"
                >
                  <span
                    aria-hidden="true"
                    className={`absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 transition-colors duration-500 ${
                      i === active
                        ? "border-gold-500 bg-gold-500"
                        : on
                          ? "border-gold-500 bg-navy-950"
                          : "border-blueprint bg-navy-950"
                    }`}
                  />
                  <span className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-dim">
                    <span className={i === active ? "text-gold-500" : ""}>{s.n}</span>
                    <span className="text-ink-dim/50">·</span>
                    <span>{s.tag}</span>
                  </span>
                  <h3
                    className={`mt-3 font-display text-2xl font-bold tracking-[-0.02em] transition-colors duration-500 ${
                      i === active ? "text-ink" : "text-ink-dim"
                    }`}
                  >
                    {s.label}
                  </h3>
                  <p
                    className={`mt-3 max-w-md text-[15px] leading-relaxed transition-colors duration-500 ${
                      i === active ? "text-ink-mut" : "text-ink-dim"
                    }`}
                  >
                    {s.note}
                  </p>
                </li>
              );
            })}
          </ol>

          {/* Sticky product frame */}
          <div className="relative">
            <div className="sticky top-[16vh] flex h-[68vh] items-center">
              <figure className="relative w-full overflow-hidden rounded-cf border border-white/10 bg-navy-850 shadow-cf ring-1 ring-inset ring-white/[0.04]">
                <Chrome url={STAGES[active]?.url ?? ""} />
                <div className="relative aspect-[12/5] bg-[#F7F9FC]">
                  {STAGES.map((s, i) => (
                    <Image
                      key={s.n}
                      src={s.src}
                      alt={s.alt}
                      fill
                      sizes="(max-width: 1279px) 0px, 760px"
                      priority={i === 0}
                      className={`jj-frame object-cover object-top ${i === active ? "jj-on" : "jj-off"}`}
                    />
                  ))}
                </div>
                <figcaption className="sr-only">
                  CrewFlow {STAGES[active]?.screen} — {STAGES[active]?.label}.
                </figcaption>
              </figure>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: bespoke vertical sequence */}
      <ol className="mx-auto mt-12 max-w-cf px-5 sm:px-7 lg:hidden">
        <div className="relative">
          <span
            aria-hidden="true"
            className="absolute bottom-6 left-[7px] top-2 w-px bg-gradient-to-b from-blueprint via-blueprint to-gold-500"
          />
          {STAGES.map((s, i) => (
            <li key={s.n} className="relative pb-10 pl-10 last:pb-0">
              <span
                aria-hidden="true"
                className={`absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 ${
                  i === STAGES.length - 1
                    ? "border-gold-500 bg-gold-500"
                    : "border-blueprint bg-navy-950"
                }`}
              />
              <span className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-dim">
                <span className="text-gold-500">{s.n}</span>
                <span className="text-ink-dim/50">·</span>
                <span>{s.tag}</span>
              </span>
              <h3 className="mt-2 font-display text-xl font-bold text-ink">{s.label}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-mut">{s.note}</p>
              <figure className="mt-4 overflow-hidden rounded-cf border border-white/10 bg-navy-850 shadow-cf">
                <Chrome url={s.url} />
                <div className="bg-[#F7F9FC]">
                  <Image
                    src={s.src}
                    alt={s.alt}
                    width={1440}
                    height={600}
                    sizes="(min-width: 1024px) 0px, 100vw"
                    className="h-auto w-full"
                  />
                </div>
              </figure>
            </li>
          ))}
        </div>
      </ol>

      <div className="h-20 sm:h-28" />
    </section>
  );
}
