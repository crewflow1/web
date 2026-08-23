import { Reveal } from "@/components/marketing/reveal";

/**
 * Differentiation, the site / commercial / UK-finance layer that trade apps
 * don't have and that wins bigger work. Every item is LIVE (product-truth).
 * Presented as three plain columns of real capability, no eyebrow, no
 * decorative rules, no monospace. One subtle reveal here (variation, most
 * sections have no motion at all).
 */
const COLUMNS = [
  {
    tag: "Site & compliance",
    items: [
      "RAMS, scored on a 5×5 matrix",
      "Permits to work & toolbox talks",
      "Site diaries & client progress reports",
      "Versioned drawings, pins & markup",
      "Worker H&S sign-off you can prove",
    ],
  },
  {
    tag: "Commercial",
    items: [
      "Variations captured against the job",
      "Extensions of time",
      "Staged valuations / applications for payment",
      "Retention register & release tracking",
      "Job costing, live per-job margin",
    ],
  },
  {
    tag: "UK finance",
    items: [
      "CIS deductions & statements",
      "VAT & Corporation Tax working papers",
      "PO 3-way matching to bills & GRNs",
      "Invoices that chase themselves",
      "Bank-CSV reconciliation, no card fees",
    ],
  },
];

export function Differentiation() {
  return (
    <section className=" bg-navy-900">
      <div className="mx-auto max-w-cf px-5 py-28 sm:px-7 sm:py-36">
        <h2 className="max-w-[18ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
          Not a job app. The whole construction business.
        </h2>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-mut">
          The site, commercial and UK-finance work most trade apps don&apos;t
          touch, the layer that gets you onto bigger tenders and keeps the
          margin you won.
        </p>
        <Reveal className="mt-16 pt-2">
          <div className="grid gap-x-12 gap-y-14 md:grid-cols-3">
            {COLUMNS.map((c) => (
              <div key={c.tag}>
                <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-gold-500">
                  {c.tag}
                </h3>
                <ul className="mt-6 space-y-4">
                  {c.items.map((it) => (
                    <li key={it} className="text-[17px] leading-snug text-ink">
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
