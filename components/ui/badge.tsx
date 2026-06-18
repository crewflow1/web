import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { accent, type Accent } from "./tokens";

/**
 * Pills, chips and status dots — the small, high-frequency UI atoms.
 *
 * All pure server components. The accent colours come from ./tokens so a badge,
 * a chip list and a card glow can never drift apart.
 */

/** An accent pill — status, category or count. `soft` uses the lighter fill. */
export function Badge({
  accent: tone = "slate",
  soft = false,
  className,
  children,
}: {
  accent?: Accent;
  soft?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const a = accent(tone);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        soft ? a.soft : a.chip,
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface Trend {
  direction: "up" | "down" | "flat";
  pct: number;
}

/** A period-over-period trend badge — green up, rose down, hidden when flat. */
export function TrendBadge({ trend }: { trend: Trend }) {
  if (trend.direction === "flat") return null;
  const up = trend.direction === "up";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
        up
          ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30"
          : "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-400/30",
      )}
    >
      <span aria-hidden>{up ? "▲" : "▼"}</span>
      {Math.abs(trend.pct)}%
    </span>
  );
}

/** A soft, single chip — used inside `ChipList` but also standalone. */
export function Chip({
  accent: tone = "slate",
  className,
  children,
}: {
  accent?: Accent;
  className?: string;
  children: ReactNode;
}) {
  const a = accent(tone);
  return (
    <span className={cn("rounded-full px-2.5 py-1 text-xs", a.soft, className)}>
      {children}
    </span>
  );
}

/** A wrapped list of chips — services, signals, tags. Honest empty state. */
export function ChipList({
  items,
  accent: tone = "slate",
  empty = "—",
  className,
}: {
  items: string[];
  accent?: Accent;
  empty?: ReactNode;
  className?: string;
}) {
  if (!items.length) {
    return <p className="text-xs text-slate-500">{empty}</p>;
  }
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)}>
      {items.map((item, i) => (
        <li key={`${item}-${i}`}>
          <Chip accent={tone}>{item}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** A small status dot; set `pulse` for the live "breathing" ping. */
export function Dot({
  accent: tone = "emerald",
  pulse = false,
  className,
}: {
  accent?: Accent;
  pulse?: boolean;
  className?: string;
}) {
  const a = accent(tone);
  if (!pulse) {
    return (
      <span
        className={cn("inline-block h-2 w-2 rounded-full", a.dot, className)}
        aria-hidden
      />
    );
  }
  return (
    <span className={cn("relative flex h-2 w-2", className)} aria-hidden>
      <span
        className={cn(
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
          a.dot,
        )}
      />
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", a.dot)} />
    </span>
  );
}

/** The pulsing "live" dot used in headers. */
export function LiveDot() {
  return <Dot accent="emerald" pulse />;
}
