import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toneClass, type Tone } from "./tokens";

/**
 * StatTile — one KPI on a card: label, big value, optional hint, optionally the
 * whole tile is a link to the surface the number came from.
 *
 * There are six independent hand-rolled versions of this tile in the repo
 * (`Stat` in app/(app)/fleet/_components/ui.tsx, `Tile` in stock and in four
 * admin surfaces). This is the generic one. Its geometry is fleet's tile
 * verbatim — `min-w-0 rounded-xl border border-slate-200 bg-white p-4
 * shadow-sm`, `text-xl font-bold tabular-nums sm:text-2xl` — so adopting it is
 * a pixel-for-pixel swap, not a restyle.
 *
 * The one real change is the colour input. Fleet's `Stat` takes a raw Tailwind
 * string (`accent="text-amber-700"`), which is a colour decision re-derived at
 * every call site and invisible to any check. `StatTile` takes a `tone` and
 * resolves it through ./tokens, where the value colour is AA-verified against
 * the white card by __tests__/ui/tokens.test.ts.
 *
 * Server component — no client JS.
 *
 *   <StatTile label="Renewals due" value="4" hint="MOT, tax, insurance"
 *             tone="amber" href="/fleet/compliance" />
 */

const CARD = "min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm";

/** Hover affordance, applied only when the tile is actually a link. */
const CARD_LINK = "block transition hover:border-slate-300 hover:shadow";

export function StatTile({
  label,
  value,
  hint,
  tone: t = "slate",
  href,
  className,
}: {
  label: string;
  /** ReactNode so a formatted figure (money, a count + unit) can be composed. */
  value: ReactNode;
  hint?: ReactNode;
  /** Defaults to the inert neutral, whose value colour is slate-900. */
  tone?: Tone;
  /** When set the whole tile becomes one link — a single, large target. */
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      {/* slate-500 on white is 4.76:1 — AA for normal text. */}
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-xl font-bold tabular-nums sm:text-2xl",
          toneClass(t, "value"),
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cn(CARD, CARD_LINK, className)}>
        {body}
      </Link>
    );
  }
  return <div className={cn(CARD, className)}>{body}</div>;
}
