"use client";

import { useMemo, useState } from "react";
import {
  diffQuoteVersions,
  isEmptyDiff,
  type QuoteVersionSnapshot,
} from "@/lib/quotes/version-diff";

/**
 * Version history + diff panel for a quote.
 *
 * Renders the append-only `quote_versions` chain and a deterministic diff
 * between any two snapshots (each captured version, plus the current live
 * quote). The diff maths lives in lib/quotes/version-diff.ts — this component
 * only picks the two endpoints and paints the result. No AI, no server call:
 * every snapshot is already loaded by the page.
 */

type Option = { id: string; label: string; snapshot: QuoteVersionSnapshot };

function money(currency: string, n: number): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function signed(currency: string, delta: number): string {
  if (delta === 0) return "—";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${money(currency, Math.abs(delta))}`;
}

const REASON_STYLE: Record<string, string> = {
  sent: "bg-blue-100 text-blue-700",
  approved: "bg-emerald-100 text-emerald-800",
  "re-approved": "bg-amber-100 text-amber-800",
};

const KIND_STYLE: Record<string, string> = {
  added: "bg-emerald-50 text-emerald-800 border-emerald-200",
  removed: "bg-red-50 text-red-800 border-red-200",
  changed: "bg-amber-50 text-amber-900 border-amber-200",
  unchanged: "bg-white text-slate-600 border-slate-100",
};

const FIELD_LABEL: Record<string, string> = {
  qty: "Qty",
  unit: "Unit",
  unit_price: "Unit price",
  vat_rate: "VAT %",
  line_total: "Line total",
};

export function VersionHistoryPanel({
  versions,
  current,
}: {
  /** Captured versions, newest first. */
  versions: QuoteVersionSnapshot[];
  /** The current live quote as a snapshot (version_number null). */
  current: QuoteVersionSnapshot;
}) {
  // Options: current (live) first, then captured versions newest → oldest.
  const options: Option[] = useMemo(() => {
    const opts: Option[] = [
      { id: "current", label: current.label, snapshot: current },
    ];
    for (const v of versions) {
      opts.push({ id: `v${v.version_number}`, label: v.label, snapshot: v });
    }
    return opts;
  }, [versions, current]);

  // Default: compare the most recent captured version (from) to current (to),
  // i.e. "what has changed since the last milestone". With no captured versions
  // the panel shows the empty state below and these are never read.
  const latestVersion = versions[0];
  const defaultFrom = latestVersion ? `v${latestVersion.version_number}` : "current";
  const [fromId, setFromId] = useState(defaultFrom);
  const [toId, setToId] = useState("current");

  const currentOption: Option = { id: "current", label: current.label, snapshot: current };
  const resolve = (optionId: string): Option =>
    options.find((o) => o.id === optionId) ?? options[0] ?? currentOption;
  const fromOpt = resolve(fromId);
  const toOpt = resolve(toId);

  const diff = useMemo(
    () => diffQuoteVersions(fromOpt.snapshot, toOpt.snapshot),
    [fromOpt, toOpt],
  );

  const currency = toOpt.snapshot.currency || fromOpt.snapshot.currency || "GBP";

  if (versions.length === 0) {
    return (
      <section
        aria-labelledby="version-history-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 id="version-history-heading" className="text-sm font-semibold text-slate-900">
          Version history
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          No versions captured yet. A snapshot is recorded automatically each time
          this quote is sent or (re-)approved, so you can see exactly what the
          customer was quoted at every milestone.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="version-history-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="version-history-heading" className="text-sm font-semibold text-slate-900">
          Version history ({versions.length})
        </h2>
      </div>

      {/* The chain, newest first. */}
      <ol className="mt-3 space-y-1.5">
        {versions.map((v) => (
          <li
            key={v.version_number}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2">
              <span className="font-medium text-slate-900">v{v.version_number}</span>
              {v.captured_reason ? (
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    REASON_STYLE[v.captured_reason] ?? "bg-slate-100 text-slate-700"
                  }`}
                >
                  {v.captured_reason}
                </span>
              ) : null}
              <span className="text-xs text-slate-500">
                {v.captured_at ? v.captured_at.slice(0, 16).replace("T", " ") + " UTC" : ""}
              </span>
            </span>
            <span className="font-medium text-slate-700">
              {money(v.currency, v.total)}
            </span>
          </li>
        ))}
      </ol>

      {/* Diff controls. */}
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
        <div>
          <label htmlFor="diff-from" className="block text-xs font-medium text-slate-600">
            Compare from
          </label>
          <select
            id="diff-from"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            className="mt-1 block rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <span aria-hidden className="pb-2 text-slate-400">→</span>
        <div>
          <label htmlFor="diff-to" className="block text-xs font-medium text-slate-600">
            to
          </label>
          <select
            id="diff-to"
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            className="mt-1 block rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {fromOpt.id === toOpt.id ? (
        <p className="mt-3 text-xs text-slate-500">
          Pick two different versions to see what changed.
        </p>
      ) : isEmptyDiff(diff) ? (
        <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          No changes between <strong>{fromOpt.label}</strong> and{" "}
          <strong>{toOpt.label}</strong>.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {/* Totals delta. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 pr-3 font-medium">Totals</th>
                  <th className="py-1 pr-3 font-medium">{fromOpt.label}</th>
                  <th className="py-1 pr-3 font-medium">{toOpt.label}</th>
                  <th className="py-1 font-medium">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(
                  [
                    ["Subtotal", diff.totals.subtotal],
                    ["VAT", diff.totals.vat_total],
                    ["Total", diff.totals.total],
                  ] as const
                ).map(([label, d]) => (
                  <tr key={label}>
                    <td className="py-1 pr-3 text-slate-700">{label}</td>
                    <td className="py-1 pr-3 text-slate-600">
                      {money(diff.totals.currencyFrom, d.from)}
                    </td>
                    <td className="py-1 pr-3 text-slate-900">
                      {money(diff.totals.currencyTo, d.to)}
                    </td>
                    <td
                      className={`py-1 font-medium ${
                        d.delta > 0
                          ? "text-emerald-700"
                          : d.delta < 0
                            ? "text-red-700"
                            : "text-slate-500"
                      }`}
                    >
                      {signed(currency, d.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {diff.totals.currencyChanged ? (
              <p className="mt-1 text-xs text-amber-700">
                Currency changed: {diff.totals.currencyFrom} → {diff.totals.currencyTo}
              </p>
            ) : null}
          </div>

          {/* Line-item diff. */}
          <div>
            <p className="mb-1.5 text-xs text-slate-500">
              Line items — {diff.summary.added} added · {diff.summary.removed} removed ·{" "}
              {diff.summary.changed} changed
            </p>
            <ul className="space-y-1.5">
              {diff.lines
                .filter((l) => l.kind !== "unchanged")
                .map((l, i) => (
                  <li
                    key={`${l.description}-${i}`}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      KIND_STYLE[l.kind] ?? "border-slate-100 bg-white text-slate-600"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{l.description || "(no description)"}</span>
                      <span className="text-xs uppercase tracking-wide">{l.kind}</span>
                    </div>
                    {l.kind === "changed" ? (
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {l.fieldChanges.map((fc) => (
                          <li key={fc.field}>
                            {FIELD_LABEL[fc.field] ?? fc.field}:{" "}
                            <span className="line-through opacity-70">{String(fc.from)}</span>{" "}
                            → <span className="font-medium">{String(fc.to)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {l.kind === "added" && l.target ? (
                      <p className="mt-1 text-xs">
                        {l.target.qty} × {money(currency, l.target.unit_price)} ={" "}
                        {money(currency, l.target.line_total)}
                      </p>
                    ) : null}
                    {l.kind === "removed" && l.base ? (
                      <p className="mt-1 text-xs">
                        was {l.base.qty} × {money(currency, l.base.unit_price)} ={" "}
                        {money(currency, l.base.line_total)}
                      </p>
                    ) : null}
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
