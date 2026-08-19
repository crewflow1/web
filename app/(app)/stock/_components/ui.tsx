import Link from "next/link";
import type { ReactNode } from "react";
import { STOCK_LEVEL_CLASS, STOCK_LEVEL_LABELS, type StockLevel } from "@/lib/stock/balance";
import {
  MOVEMENT_TYPE_CLASS,
  formatEffect,
  formatQuantity,
  movementTypeLabel,
} from "@/lib/stock/movements";

/**
 * Shared presentation for the stock surface. Presentation ONLY — every
 * judgement (is this low, which way did it move, what is it called) belongs to
 * the pure modules in lib/stock and is imported, never re-decided here.
 *
 * THE ACCOUNTING BOUNDARY: nothing on this surface renders a price, a cost or a
 * total value, because none exists. Stock is quantities; the money already
 * landed when the supplier's bill was recorded.
 */

/** A headline number. Only ever fed a real count — never a placeholder. */
export function Tile({
  label,
  value,
  hint,
  tone = "plain",
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "plain" | "warn" | "bad" | "good";
  href?: string;
}) {
  const toneClass =
    tone === "bad"
      ? "border-red-200 bg-red-50"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50"
        : tone === "good"
          ? "border-emerald-200 bg-emerald-50"
          : "border-slate-200 bg-white";
  const body = (
    // `min-w-0` so the tile can shrink below its content's min-content width when
    // it is a grid item — a grid track defaults to `min-content`, which would let
    // a comma-grouped GBP figure (`£6,234,567.00`) push the whole grid past a
    // 375px viewport. Paired with `truncate` on the value line, the figure clips
    // instead of scrolling the page. The contract is asserted by
    // __tests__/ui/money-tile-overflow-guard.test.ts (Tile is a money-fed
    // primitive once /stock/valuation passes it `value={formatGbp(…)}`).
    <div className={`min-w-0 rounded-xl border p-4 shadow-sm ${toneClass}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 truncate text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block transition hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}

export function LevelPill({ level }: { level: StockLevel }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STOCK_LEVEL_CLASS[level]}`}
    >
      {STOCK_LEVEL_LABELS[level]}
    </span>
  );
}

export function MovementPill({ type }: { type: string }) {
  const cls =
    (MOVEMENT_TYPE_CLASS as Record<string, string>)[type] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
      {movementTypeLabel(type)}
    </span>
  );
}

/**
 * "40 bags" — a quantity with its unit, trimmed of 2dp noise.
 *
 * The space between number and unit is a REAL space character, not only the
 * `ml-1` margin: a margin is invisible to `textContent`, so "40 bags" would
 * copy, read aloud and match as "40bags".
 */
export function Qty({ value, unit }: { value: number | string | null | undefined; unit?: string }) {
  return (
    <span className="tabular-nums">
      {formatQuantity(value)}
      {unit ? (
        <>
          {" "}
          <span className="text-slate-500">{unit}</span>
        </>
      ) : null}
    </span>
  );
}

/** "+40" / "−12.5", coloured by direction. */
export function Effect({
  row,
  unit,
}: {
  row: { movement_type: string; qty?: number | string | null; effect?: number | string | null };
  unit?: string;
}) {
  const text = formatEffect(row);
  const tone = text.startsWith("+")
    ? "text-emerald-700"
    : text.startsWith("−")
      ? "text-amber-700"
      : "text-slate-700";
  return (
    <span className={`font-semibold tabular-nums ${tone}`}>
      {text}
      {unit ? (
        <>
          {" "}
          <span className="font-normal text-slate-500">{unit}</span>
        </>
      ) : null}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * The banner every stock surface carries. Not decoration: the single most
 * expensive misunderstanding available here is "issuing stock to a job costs
 * the job money", and a builder who believes it will double-count their
 * materials in their head even though the software does not.
 */
export function AccountingNote() {
  return (
    <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      Stock here is <span className="font-medium text-slate-800">quantities, not money</span>.
      Materials are costed once, when you record the supplier&rsquo;s bill — moving them between
      places or issuing them to a job never adds a second cost.
    </p>
  );
}
