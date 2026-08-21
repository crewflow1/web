import type { ReactNode } from "react";

/**
 * The Setting-Out System — construction-drawing motif primitives.
 *
 * Borrowed from setting-out / GA drawings, not dashboards: a datum grid with
 * margin grid-references, dimension lines, coordinate/revision title-block tags,
 * and a structural "load-path" line. Cheap CSS/SVG, decorative (aria-hidden),
 * and the thing that makes CrewFlow's dark environment feel *engineered*.
 */

/** ① Datum grid — faint blueprint grid + optional margin grid references. */
export function DatumGrid({
  refs = false,
  className = "",
}: {
  refs?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(46,92,138,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(46,92,138,0.10) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(120% 90% at 50% 0%, black 30%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(120% 90% at 50% 0%, black 30%, transparent 78%)",
        }}
      />
      {refs && (
        <div className="absolute inset-0 mx-auto hidden max-w-cf px-2 font-mono text-[10px] uppercase tracking-widest text-ink-dim/50 lg:block">
          {["A", "B", "C", "D"].map((c, i) => (
            <span
              key={c}
              className="absolute top-2"
              style={{ left: `${12 + i * 25}%` }}
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** ④ Coordinate / revision title-block tag (eyebrows + frame captions). */
export function CoordTag({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-gold-500 ${className}`}
    >
      <span aria-hidden="true" className="inline-block h-2 w-2 border border-gold-500/60" />
      {children}
    </span>
  );
}

/** ⑦ Hairline rule with a single datum tick. Section divider. */
export function DatumRule({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`relative h-px w-full bg-cfborder ${className}`}>
      <span className="absolute left-[12%] top-0 h-2 w-px -translate-y-1/2 bg-blueprint" />
    </div>
  );
}
