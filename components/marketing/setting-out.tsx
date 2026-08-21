import type { ReactNode } from "react";

/**
 * A single, quiet section label.
 *
 * The old "Setting-Out System" (datum grids, margin coordinates, datum-tick
 * rules, load-path lines) has been removed: the construction identity now lives
 * in the gold accent and the typography, not in decorative drawing furniture.
 * Only this small-caps kicker remains, used sparingly for context, never as a
 * technical mark. The `CoordTag` name is kept for call-site stability.
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
