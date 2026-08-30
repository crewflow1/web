import type { Tone } from "../tokens";
import { SERIES } from "./series";

/**
 * ChartLegend — visible series key. The coloured swatch is aria-hidden
 * decoration; the series NAME is the signal (colour never carries meaning
 * alone, per the tokens.ts doctrine).
 */
export function ChartLegend({
  items,
  className = "",
}: {
  items: Array<{ name: string; tone: Tone }>;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 ${className}`}>
      {items.map((item) => (
        <li key={item.name} className="flex items-center gap-1">
          <span
            aria-hidden
            className={`inline-block h-2 w-2.5 rounded-sm ${SERIES[item.tone].swatch}`}
          />
          {item.name}
        </li>
      ))}
    </ul>
  );
}
