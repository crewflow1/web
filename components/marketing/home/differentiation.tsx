import { CoordTag, DatumRule } from "@/components/marketing/setting-out";

/**
 * Beat 5 — Differentiation. The site / commercial / UK-finance layer that trade
 * apps don't have and that wins bigger work. Every item is LIVE (product-truth).
 */
const COLUMNS = [
  {
    tag: "Site & compliance",
    items: [
      "RAMS, scored on a 5×5 matrix",
      "Permits to work & toolbox talks",
      "Site diaries & client progress reports",
      "Versioned drawings — pins & markup",
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
      "Job costing — real margin, live",
    ],
  },
  {
    tag: "UK finance",
    items: [
      "CIS deductions, statements & verification",
      "VAT & Corporation Tax working papers",
      "PO 3-way matching to bills & GRNs",
      "Invoices that chase themselves",
      "Bank-CSV reconciliation — no card fees",
    ],
  },
];

export function Differentiation() {
  return (
    <section className="relative border-t border-white/5 bg-navy-900">
      <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-28">
        <CoordTag>The layer that wins bigger jobs</CoordTag>
        <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
          Not a job app. A construction ERP.
        </h2>
        <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-mut">
          The site, commercial and UK-finance work most trade apps don&apos;t
          touch — the layer that gets you onto bigger tenders and keeps the
          margin you won.
        </p>
        <div className="mt-14 grid gap-x-10 gap-y-12 md:grid-cols-3">
          {COLUMNS.map((c) => (
            <div key={c.tag}>
              <DatumRule />
              <h3 className="mt-5 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-gold-500">
                {c.tag}
              </h3>
              <ul className="mt-5 space-y-3.5">
                {c.items.map((it) => (
                  <li key={it} className="flex gap-3 text-[15px] leading-snug text-ink-mut">
                    <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-blueprint" />
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
