/** Switching & trust — honest, product-truth-safe reassurance. No cards. */
const POINTS = [
  { t: "Runs alongside Xero", d: "Clean CSV export to Xero & Sage. No live sync to set up or break." },
  { t: "No card fees", d: "Bank transfer only. You keep 100% of every invoice." },
  { t: "No lock-in", d: "Full CSV export any time. No early-termination fees." },
  { t: "Built in the UK", d: "Daily backups, point-in-time recovery, UK GDPR." },
];

export function SwitchTrust() {
  return (
    <section className="border-t border-white/5 bg-navy-950">
      <div className="mx-auto max-w-cf px-5 py-28 sm:px-7 sm:py-36">
        <h2 className="max-w-[20ch] font-display text-[clamp(2.1rem,4.6vw,3.75rem)] font-bold leading-[1.0] tracking-[-0.02em] text-ink">
          Moving across is the easy part
        </h2>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-mut">
          Keep your accountant. Keep Xero. We move you across by hand — customers,
          jobs and finances brought over, checked, and shown to you in a preview
          before anything goes live.
        </p>
        <div className="mt-16 grid gap-x-10 gap-y-10 border-t border-white/10 pt-14 sm:grid-cols-2 lg:grid-cols-4">
          {POINTS.map((x) => (
            <div key={x.t}>
              <h3 className="text-lg font-semibold text-ink">{x.t}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-mut">{x.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
