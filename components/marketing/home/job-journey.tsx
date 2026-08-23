"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Reveal } from "@/components/marketing/reveal";

/**
 * "Watch it run a real job" — the signature connected-job scroll story.
 *
 * One real job travels through CrewFlow in six stages, and the product is the
 * moving object: on desktop (with motion allowed) a sticky product frame
 * crossfades and settles through the six real screenshots as you scroll, and
 * the flow ribbon tracks the active stage, so the connection between stages is
 * the thing you feel.
 *
 * Robust by construction:
 *  - SSR / no-JS / reduced-motion / mobile render a plain STACKED filmstrip,
 *    every stage fully visible, nothing hidden, no sticky, no scroll-hijack.
 *  - The sticky story is a progressive enhancement switched on only when the
 *    viewport is desktop AND the user hasn't asked to reduce motion.
 *  - Motion is IntersectionObserver + opacity/transform transitions (defined in
 *    globals.css). No scroll listeners, no animation library.
 */

type Stage = {
  n: string;
  key: string;
  label: string;
  note: string;
  src: string;
  alt: string;
};

const STAGES: Stage[] = [
  {
    n: "01",
    key: "Lead",
    label: "Catch the enquiry",
    note: "Every call, form and referral lands in one pipeline, scored hot to cold so you chase the work worth winning first.",
    src: "/product-shots/journey/leads.png",
    alt: "CrewFlow leads pipeline, enquiries on a board with source, service, estimated value and a hot / warm / cold priority score.",
  },
  {
    n: "02",
    key: "Quote",
    label: "Price it",
    note: "A line-item quote with full VAT, out the door in minutes, not a night at the kitchen table.",
    src: "/product-shots/journey/quotes.png",
    alt: "CrewFlow quotes list, line-item quotes with customer, status, valid-until date and VAT-inclusive totals.",
  },
  {
    n: "03",
    key: "Job",
    label: "Win it, and it becomes a job",
    note: "The customer signs the quote by name and it becomes a live job, with costs, schedule and site details already attached.",
    src: "/product-shots/journey/jobs.png",
    alt: "CrewFlow jobs list, live jobs with status, customer, site address and scheduled dates.",
  },
  {
    n: "04",
    key: "RAMS",
    label: "Prove it's safe",
    note: "Issue the RAMS before a tool is lifted. Every hazard scored on a 5×5 matrix, signed off, and frozen as the record for the site.",
    src: "/product-shots/journey/rams.png",
    alt: "CrewFlow health & safety register, issued RAMS with hazard counts, risk ratings, and an alert for active jobs with no current risk assessment.",
  },
  {
    n: "05",
    key: "Invoice",
    label: "Bill the work",
    note: "Applications for payment as the job runs, then invoices that chase themselves on day 3, 7, 14 and 21, until the money lands.",
    src: "/product-shots/journey/invoices.png",
    alt: "CrewFlow invoices list, invoices with status, due date and a full net / VAT / total breakdown, plus CSV, Xero and Sage export.",
  },
  {
    n: "06",
    key: "Paid",
    label: "See the whole company",
    note: "Every job feeds one screen: what's late, what's owed, what's making money. The morning brief that used to take an afternoon.",
    src: "/product-shots/journey/dashboard.png",
    alt: "CrewFlow dashboard, a morning brief flagging an active job without a current RAMS, an overdue invoice and money due from customers this week.",
  },
];

function Intro() {
  return (
    <div className="mx-auto max-w-cf px-5 pt-28 sm:px-7 sm:pt-40">
      <h2 className="max-w-[15ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
        Watch it run a real job
      </h2>
      <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-mut">
        You enter a job once. Winning it, keeping it safe and getting paid all
        happen in the same place, with nothing re-keyed in between.
      </p>
    </div>
  );
}

function Frame({ src, alt, sizes }: { src: string; alt: string; sizes: string }) {
  return <Image src={src} alt={alt} fill sizes={sizes} className="object-cover object-top" />;
}

export function JobJourney() {
  const [enhanced, setEnhanced] = useState(false);
  const [active, setActive] = useState(0);
  const stageRefs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)").matches;
    const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (desktop && motionOk && "IntersectionObserver" in window) setEnhanced(true);
  }, []);

  useEffect(() => {
    if (!enhanced) return;
    // A thin band across the middle of the viewport: the stage crossing it is
    // "active". No scroll listener, the observer only fires on threshold cross.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = Number((e.target as HTMLElement).dataset.idx);
            if (!Number.isNaN(idx)) setActive(idx);
          }
        }
      },
      { rootMargin: "-48% 0px -48% 0px", threshold: 0 },
    );
    const els = stageRefs.current.filter(Boolean) as HTMLLIElement[];
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [enhanced]);

  /* ---- Enhancement OFF: plain stacked filmstrip (SSR / mobile / reduced-motion) ---- */
  if (!enhanced) {
    return (
      <section className="bg-navy-950">
        <Intro />
        <div className="mx-auto mt-16 max-w-cf space-y-20 px-5 sm:mt-24 sm:space-y-28 sm:px-7">
          {STAGES.map((s) => (
            <Reveal key={s.src}>
              <figure>
                <figcaption className="mb-7 max-w-2xl">
                  <div className="font-display text-xl font-bold tabular-nums text-gold-500">{s.n}</div>
                  <h3 className="mt-3 font-display text-[clamp(1.5rem,2.6vw,2rem)] font-bold leading-tight tracking-[-0.015em] text-ink">
                    {s.label}
                  </h3>
                  <p className="mt-3 max-w-lg text-lg leading-relaxed text-ink-mut">{s.note}</p>
                </figcaption>
                <div className="relative aspect-[12/5] overflow-hidden rounded-2xl bg-[#F7F9FC] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.7)] ring-1 ring-white/10">
                  <Frame src={s.src} alt={s.alt} sizes="(max-width: 1400px) 100vw, 1360px" />
                </div>
              </figure>
            </Reveal>
          ))}
        </div>
      </section>
    );
  }

  /* ---- Enhancement ON: sticky product frame + scrolling stages (desktop) ---- */
  return (
    <section className="bg-navy-950">
      <Intro />
      <div className="mx-auto mt-8 max-w-cf px-5 sm:px-7">
        <div className="grid lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
          {/* Scrolling stages */}
          <ol>
            {STAGES.map((s, i) => (
              <li
                key={s.src}
                ref={(el) => {
                  stageRefs.current[i] = el;
                }}
                data-idx={i}
                data-cf-stage={active === i ? "active" : ""}
                className="flex min-h-[64vh] items-center"
              >
                <div>
                  <div className="font-display text-xl font-bold tabular-nums text-gold-500">{s.n}</div>
                  <h3 className="mt-3 font-display text-[clamp(1.7rem,2.8vw,2.4rem)] font-bold leading-tight tracking-[-0.015em] text-ink">
                    {s.label}
                  </h3>
                  <p className="mt-4 max-w-md text-lg leading-relaxed text-ink-mut">{s.note}</p>
                </div>
              </li>
            ))}
          </ol>

          {/* Sticky product frame that crossfades through the stages */}
          <div className="relative hidden lg:block">
            <div className="sticky top-24">
              <div className="relative aspect-[12/5] overflow-hidden rounded-2xl bg-[#F7F9FC] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.7)] ring-1 ring-white/10">
                {STAGES.map((s, i) => (
                  <div key={s.src} data-cf-frame={active === i ? "active" : ""} className="absolute inset-0">
                    <Frame src={s.src} alt={s.alt} sizes="720px" />
                  </div>
                ))}
              </div>
              {/* Flow ribbon, the whole lifecycle, active stage lit */}
              <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-medium">
                {STAGES.map((s, i) => (
                  <span key={s.key} className="inline-flex items-center gap-3">
                    <span data-cf-step={active === i ? "active" : ""} className={active === i ? "text-gold-500" : "text-ink-dim"}>
                      {s.key}
                    </span>
                    {i < STAGES.length - 1 && <span aria-hidden="true" className="text-ink-dim/40">→</span>}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="h-16 sm:h-24" />
    </section>
  );
}
