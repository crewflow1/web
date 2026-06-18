import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { TrendBadge, type Trend } from "./badge";
import { accent, type Accent } from "./tokens";

/**
 * StatTile — a single KPI: label, big accent value, optional sub-line, trend
 * and icon. `value` is a ReactNode so an <AnimatedNumber> can be dropped in to
 * count up on mount. This is the Command Centre metric card, generalised.
 */
export function StatTile({
  label,
  value,
  sub,
  accent: tone = "slate",
  trend,
  icon,
  glow = true,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: Accent;
  trend?: Trend;
  icon?: ReactNode;
  glow?: boolean;
  className?: string;
}) {
  const a = accent(tone);
  return (
    <Card accent={tone} glow={glow} className={className}>
      <div className="relative flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </p>
        {trend ? (
          <TrendBadge trend={trend} />
        ) : icon ? (
          <span className={a.text} aria-hidden>
            {icon}
          </span>
        ) : null}
      </div>
      <p className={cn("relative mt-2 text-2xl font-bold tabular-nums", a.text)}>
        {value}
      </p>
      {sub ? (
        <p className="relative mt-1 truncate text-[11px] text-slate-500">{sub}</p>
      ) : null}
    </Card>
  );
}

/**
 * Fact — a key/value definition row that hides itself when the value is
 * unknown, so a profile never shows an empty or invented field.
 */
export function Fact({
  label,
  value,
}: {
  label: string;
  value: ReactNode | null;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-800/70 py-2 last:border-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-200">{value}</dd>
    </div>
  );
}
