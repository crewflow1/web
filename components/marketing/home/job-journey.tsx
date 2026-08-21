import Image from "next/image";

/**
 * "Watch it run a real job." — a few large, deliberately distinct product
 * moments instead of a six-step thumbnail ladder. The end-to-end arc is
 * compressed into one dense step ribbon; then three genuinely different screens
 * (pipeline, safety matrix, money) carry the weight at full size. The interface
 * is the visual — no decoration, no fake chrome, no zig-zag.
 */

const ARC = ["Lead", "Quote", "Job", "RAMS", "Invoice", "Paid"];

type Moment = {
  label: string;
  note: string;
  src: string;
  alt: string;
};

const MOMENTS: Moment[] = [
  {
    label: "Every enquiry in one pipeline.",
    note: "Calls, forms and referrals land in one place, scored hot to cold — so you chase the work worth winning first.",
    src: "/product-shots/journey/leads.png",
    alt: "CrewFlow leads pipeline — enquiries on a board with source, service, estimated value and a hot / warm / cold priority score.",
  },
  {
    label: "Prove it's safe before a tool is lifted.",
    note: "Issue the RAMS with every hazard scored on a 5×5 matrix, signed off, and frozen as the record for the site.",
    src: "/product-shots/journey/rams.png",
    alt: "CrewFlow health & safety register — issued RAMS with hazard counts, risk ratings, and an alert for active jobs with no current risk assessment.",
  },
  {
    label: "Invoices that chase themselves.",
    note: "Applications for payment as the job runs, then reminders on day 3, 7, 14 and 21 until the money actually lands.",
    src: "/product-shots/journey/invoices.png",
    alt: "CrewFlow invoices list — invoices with status, due date and a full net / VAT / total breakdown, plus CSV, Xero and Sage export.",
  },
];

export function JobJourney() {
  return (
    <section className="border-t border-white/5 bg-navy-950">
      <div className="mx-auto max-w-cf px-5 pt-28 sm:px-7 sm:pt-40">
        <h2 className="max-w-[15ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
          Watch it run a real job
        </h2>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-mut">
          You enter a job once. Winning it, keeping it safe and getting paid all
          happen in the same place, with nothing re-keyed in between.
        </p>
        {/* The whole arc, compressed to one dense line. */}
        <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-medium text-ink-dim">
          {ARC.map((step, i) => (
            <span key={step} className="inline-flex items-center gap-3">
              <span className={i === ARC.length - 1 ? "text-gold-500" : ""}>{step}</span>
              {i < ARC.length - 1 && <span aria-hidden="true" className="text-ink-dim/40">→</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="mx-auto mt-16 max-w-cf space-y-20 px-5 sm:mt-24 sm:space-y-28 sm:px-7">
        {MOMENTS.map((m) => (
          <figure key={m.src}>
            <figcaption className="mb-7 max-w-2xl">
              <h3 className="font-display text-[clamp(1.6rem,3vw,2.4rem)] font-bold leading-tight tracking-[-0.015em] text-ink">
                {m.label}
              </h3>
              <p className="mt-3 max-w-lg text-lg leading-relaxed text-ink-mut">{m.note}</p>
            </figcaption>
            <div className="overflow-hidden rounded-2xl bg-[#F7F9FC] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.7)] ring-1 ring-white/10">
              <Image
                src={m.src}
                alt={m.alt}
                width={1440}
                height={600}
                priority={false}
                sizes="(max-width: 1400px) 100vw, 1360px"
                className="h-auto w-full"
              />
            </div>
          </figure>
        ))}
      </div>
    </section>
  );
}
