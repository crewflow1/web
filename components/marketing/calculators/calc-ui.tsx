"use client";

import { useId } from "react";

/**
 * Shared, styled primitives for the free SEO calculators. Keeps every tool
 * visually consistent and the per-tool components tiny (just state + maths).
 */

export function CalcCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl overflow-hidden rounded-cf border border-cfborder bg-navy-800 shadow-cf">
      {children}
    </div>
  );
}

export function CalcInputs({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 border-b border-white/10 p-6 sm:grid-cols-2">{children}</div>;
}

export function NumberField({
  label,
  value,
  onChange,
  suffix,
  min = 0,
  step = "any",
  placeholder,
}: {
  label: string;
  value: number | "";
  onChange: (v: number | "") => void;
  suffix?: string;
  min?: number;
  step?: number | "any";
  placeholder?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block text-sm font-medium text-ink-mut">
      {label}
      <div className="mt-1.5 flex items-stretch overflow-hidden rounded-md border border-cfborder focus-within:border-gold-500 focus-within:ring-2 focus-within:ring-gold-500/20">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "" ? "" : Number(v));
          }}
          className="w-full bg-navy-900 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim"
        />
        {suffix ? (
          <span className="flex items-center bg-navy-850 px-3 text-sm font-medium text-ink-dim">
            {suffix}
          </span>
        ) : null}
      </div>
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block text-sm font-medium text-ink-mut">
      {label}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 block w-full rounded-md border border-cfborder bg-navy-900 px-3 py-2 text-sm text-ink focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/20"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ResultGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-px bg-white/10 sm:grid-cols-3">{children}</div>;
}

export function Result({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`p-6 text-center ${highlight ? "bg-navy-950" : "bg-navy-800"}`}>
      <div
        className={`font-display text-2xl font-bold tabular-nums tracking-tight ${highlight ? "text-gold-500" : "text-ink"}`}
      >
        {value}
      </div>
      <div className={`mt-1 text-xs font-medium ${highlight ? "text-ink-mut" : "text-ink-dim"}`}>
        {label}
      </div>
    </div>
  );
}

/** GBP formatter. */
export const gbp = (n: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 }).format(
    isFinite(n) ? n : 0,
  );

/** Plain number formatter. */
export const num = (n: number, dp = 2) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: dp }).format(isFinite(n) ? n : 0);
