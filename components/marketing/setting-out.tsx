import type { ReactNode } from "react";

/**
 * The Setting-Out System — construction-drawing motif primitives.
 *
 * Borrowed from setting-out / GA drawings, not dashboards: a datum grid with
 * margin grid-references, dimension lines, coordinate/revision title-block tags,
 * and a structural "load-path" line. Cheap CSS/SVG, decorative (aria-hidden),
 * and the thing that makes CrewFlow's dark environment feel *engineered*.
 */

/**
 * ① Datum grid — a whisper-faint blueprint texture, no margin coordinates.
 * Deliberately restrained: a single subtle atmosphere, never a "technical
 * drawing" laid over the whole page. The `refs` prop is retained (ignored) so
 * older callers don't break; margin coordinate letters were removed.
 */
export function DatumGrid({
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
            "linear-gradient(rgb(var(--cf-blueprint) / 0.05) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--cf-blueprint) / 0.05) 1px, transparent 1px)",
          backgroundSize: "104px 104px",
          maskImage:
            "radial-gradient(120% 80% at 50% 0%, black 12%, transparent 68%)",
          WebkitMaskImage:
            "radial-gradient(120% 80% at 50% 0%, black 12%, transparent 68%)",
        }}
      />
    </div>
  );
}

/**
 * ④ Section label — a quiet, refined eyebrow. Body face (not monospace), no
 * bracket mark: a small-caps kicker used sparingly for context, not a
 * decorative "coordinate tag". Kept the CoordTag name for call-site stability.
 */
export function CoordTag({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-block text-[13px] font-semibold uppercase tracking-[0.14em] text-gold-500 ${className}`}
    >
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
