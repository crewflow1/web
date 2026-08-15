"use client";

import { useMemo, useState } from "react";
import type { PriceBookPickerItem } from "@/lib/pricing/schema";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

/**
 * Price-book picker for the quote builder.
 *
 * A search box over the org's curated rate library. Typing filters by
 * description / code / category; picking a result populates a NEW quote line
 * (still fully editable). The list is client-side (the items are already loaded
 * on the page) and capped in the UI so a large library stays usable — the box
 * narrows it. Money is displayed in pounds (already converted from stored pence).
 */
export function PriceBookPicker({
  items,
  onPick,
}: {
  items: PriceBookPickerItem[];
  onPick: (item: PriceBookPickerItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? items.filter((it) =>
          [it.description, it.code ?? "", it.category ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : items;
    return base.slice(0, 8);
  }, [items, query]);

  return (
    <div>
      <label
        htmlFor="price-book-search"
        className="block text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        Add from price book
      </label>
      <input
        id="price-book-search"
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search items by name, code or category…"
        className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {open ? (
        <ul className="mt-2 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 bg-white">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-500">No matching items.</li>
          ) : (
            results.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(it);
                    setQuery("");
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">
                      {it.description}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {[it.code, it.category].filter(Boolean).join(" · ") || " "}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-sm font-medium text-slate-700">
                    {GBP.format(it.unit_price)}
                    <span className="text-xs text-slate-400"> / {it.unit}</span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
