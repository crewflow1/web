/** FAQ. Native <details>, no-JS-safe. All answers product-truth-safe. */
const FAQS = [
  {
    q: "How long does setup take?",
    a: "Setup usually takes 2 to 3 days. We import your customers, invoices and finances from a CSV or Excel export, show you a preview before we commit, and can roll back in one click.",
  },
  {
    q: "We already use Xero, do we have to ditch it?",
    a: "No. CrewFlow is the operations layer; Xero stays your accountant's tool. Your numbers export cleanly to Xero and Sage when it's time to file.",
  },
  {
    q: "Does CrewFlow take card payments?",
    a: "No. UK construction runs on bank transfer, so CrewFlow tracks payments rather than processing them, no gateway fee, and you keep 100% of every invoice.",
  },
  {
    q: "My lads only have phones on site. Does that work?",
    a: "Yes. The staff view is mobile-first in the browser, clock-in, today's rota and expected take-home. Built for someone standing in a van, not a CFO at a desk.",
  },
  {
    q: "Is my data safe?",
    a: "Daily automated backups with point-in-time recovery and storage redundancy, hosted to UK standards under UK GDPR.",
  },
  {
    q: "What does it cost?",
    a: "£500 a month plus a one-time £1,000 for setup and migration. No per-seat fees. Book a demo and we'll show you the system on your own numbers first.",
  },
  {
    q: "Can I leave whenever I want?",
    a: "Yes. Full CSV export any time, no lock-in and no early-termination fees. Your data is yours.",
  },
];

export function Faq() {
  return (
    <section className="">
      <div className="mx-auto max-w-cf px-5 py-28 sm:px-7 sm:py-36">
        <h2 className="font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
          Questions, answered
        </h2>
        <div className="mt-10 max-w-3xl">
          {FAQS.map((f) => (
            <details key={f.q} className="group -mx-4 rounded-xl px-4 py-4 transition-colors open:bg-white/[0.02]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-lg font-semibold text-ink [&::-webkit-details-marker]:hidden">
                {f.q}
                <span
                  aria-hidden="true"
                  className="text-2xl font-light text-ink-dim transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-mut">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
