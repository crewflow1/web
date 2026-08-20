import { CoordTag } from "@/components/marketing/setting-out";

/** Beat 6 — Switching & trust. Honest, product-truth-safe reassurance. */
const POINTS = [
  { t: "Runs alongside Xero", d: "Clean CSV export to Xero & Sage. No live sync to set up or break." },
  { t: "No card fees", d: "Bank transfer only. You keep 100% of every invoice." },
  { t: "No lock-in", d: "Full CSV export any time. No early-termination fees." },
  { t: "Built in the UK", d: "Daily backups, point-in-time recovery, UK GDPR." },
];

export function SwitchTrust() {
  return (
    <section className="border-t border-white/5">
      <div className="mx-auto max-w-cf px-5 py-20 sm:px-7 sm:py-24">
        <CoordTag>Switching & trust</CoordTag>
        <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.9rem,3.4vw,2.9rem)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
          You&apos;re not ripping anything out. You&apos;re getting organised.
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-mut">
          Keep your accountant. Keep Xero. We move you across by hand — customers,
          jobs and finances brought over, checked, and shown to you in a preview
          before anything goes live.
        </p>
        <div className="mt-10 grid gap-px overflow-hidden rounded-cf border border-cfborder bg-cfborder sm:grid-cols-2 lg:grid-cols-4">
          {POINTS.map((x) => (
            <div key={x.t} className="bg-navy-800 p-5">
              <h3 className="font-display text-sm font-bold text-ink">{x.t}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim">{x.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
