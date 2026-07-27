"use client";

import { useId } from "react";

/**
 * Shared, styled primitives for the free SEO calculators. Keeps every tool
 * visually consistent and the per-tool components tiny (just state + maths).
 */

export function CalcCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {children}
    </div>
  );
}

export function CalcInputs({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 border-b border-slate-100 p-6 sm:grid-cols-2">{children}</div>;
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
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {label}
      <div className="mt-1 flex items-stretch overflow-hidden rounded-md border border-slate-300 shadow-sm focus-within:border-slate-900 focus-within:ring-2 focus-within:ring-slate-900/10">
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
          className="w-full px-3 py-2 text-sm outline-none"
        />
        {suffix ? (
          <span className="flex items-center bg-slate-50 px-3 text-sm font-medium text-slate-500">
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
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {label}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
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
  return <div className="grid gap-px bg-slate-100 sm:grid-cols-3">{children}</div>;
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
    <div className={`p-6 text-center ${highlight ? "bg-slate-900" : "bg-white"}`}>
      <div className={`text-2xl font-bold tracking-tight ${highlight ? "text-amber-400" : "text-slate-900"}`}>
        {value}
      </div>
      <div className={`mt-1 text-xs font-medium ${highlight ? "text-slate-300" : "text-slate-500"}`}>
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
