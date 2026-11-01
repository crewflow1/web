"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Shared customer typeahead picker — the ONE customer selector used across the
 * sales/project forms (jobs, quotes, leads, reviews, customer-parent).
 *
 * It replaces the all-customers-up-front <select> dropdowns with a server-backed
 * typeahead that queries the shared /api/customers/search endpoint (→ the
 * search_customers RPC), so matching here is byte-identical to the customers
 * list and the Cmd/K palette: multi-token, partial-anywhere, case-insensitive,
 * postcode-normalised and phone-format-tolerant. Results are labelled with the
 * customer NAME and their ONE-LINE ADDRESS, so a tradesperson picks the right
 * "John Smith" by the address.
 *
 * FORM CONTRACT. The component submits exactly the same thing the old <select>
 * did: a single `customer_id` value via a hidden <input name={name}>. Server
 * actions and validation are untouched.
 *
 * PRESERVE-SELECTION. `defaultValue` (+ its label resolved from `initialOptions`
 * or a fallback) seeds the selection and the hidden input KEEPS that id until
 * the user explicitly picks another or clears it — so an untouched edit save
 * round-trips the same id and can never silently null a valid link (the F-1
 * preserve-option guarantee, now enforced by the hidden input rather than a
 * <select> option).
 */

type Hit = {
  id: string;
  name: string;
  address: string;
  customer_type: string | null;
};

export type CustomerComboboxProps = {
  /** Hidden-input name the form reads (e.g. "customer_id", "parent_customer_id"). */
  name: string;
  label: string;
  /** Currently-selected customer id (edit prefill). */
  defaultValue?: string | null;
  /** Server-loaded options used ONLY to resolve the selected label and seed the
   * initial (pre-typing) list; live matching always goes through the server. */
  initialOptions?: { id: string; name: string }[];
  /** Narrow the search to one customer type (the parent-business picker). */
  type?: "individual" | "business";
  /** Drop this id from results (a business can't be its own parent). */
  excludeId?: string;
  required?: boolean;
  error?: string;
  help?: string;
  /** When set, an explicit "clear selection" affordance is offered and the empty
   * value is allowed (optional reference). The string is the cleared-state hint. */
  noneLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Notified on every selection change (id or "" when cleared) — lets a parent
   * form keep dependent state in sync (the quote builder's property/lead pickers). */
  onSelect?: (id: string) => void;
};

const DEBOUNCE_MS = 200;
const MIN_CHARS = 2;

export function CustomerCombobox({
  name,
  label,
  defaultValue,
  initialOptions = [],
  type,
  excludeId,
  required = false,
  error,
  help,
  noneLabel,
  placeholder = "Search name, address, postcode, phone or email",
  autoFocus = false,
  onSelect,
}: CustomerComboboxProps) {
  const fieldId = useId();
  const listId = `${fieldId}-list`;
  const errorId = error ? `${fieldId}-error` : undefined;

  const initialLabel = (() => {
    if (!defaultValue) return "";
    const found = initialOptions.find((o) => o.id === defaultValue);
    return found ? found.name : "Selected customer";
  })();

  const [selectedId, setSelectedId] = useState<string>(defaultValue ?? "");
  // `query` doubles as the input's display value: it holds the selected label
  // when a customer is chosen and the box is idle, or the user's live text.
  const [query, setQuery] = useState<string>(initialLabel);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [dirty, setDirty] = useState(false); // user has typed since last selection

  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const select = useCallback(
    (hit: Pick<Hit, "id" | "name">) => {
      setSelectedId(hit.id);
      setQuery(hit.name);
      setOpen(false);
      setDirty(false);
      setActiveIndex(-1);
      onSelect?.(hit.id);
    },
    [onSelect],
  );

  const clear = useCallback(() => {
    setSelectedId("");
    setQuery("");
    setResults([]);
    setDirty(false);
    setActiveIndex(-1);
    onSelect?.("");
  }, [onSelect]);

  // Fetch matches (debounced). An empty query (with a cleared selection) seeds
  // the dropdown from initialOptions so clicking into the box shows something.
  useEffect(() => {
    if (!open) return;
    const term = dirty ? query.trim() : "";

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (term.length === 0) {
      setResults(
        initialOptions
          .filter((o) => o.id !== excludeId)
          .slice(0, 20)
          .map((o) => ({ id: o.id, name: o.name, address: "", customer_type: null })),
      );
      setLoading(false);
      return;
    }
    if (term.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const params = new URLSearchParams({ q: term });
      if (type) params.set("type", type);
      fetch(`/api/customers/search?${params.toString()}`, { signal: ac.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((body: { hits?: Hit[] }) => {
          const hits = (body.hits ?? []).filter((h) => h.id !== excludeId);
          setResults(hits);
          setActiveIndex(hits.length > 0 ? 0 : -1);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setResults([]);
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, dirty, type, excludeId, initialOptions]);

  // Close when clicking outside.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && activeIndex >= 0 && results[activeIndex]) {
        e.preventDefault();
        select(results[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const noCustomers = initialOptions.length === 0 && !defaultValue;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div ref={rootRef} className="relative">
      <label htmlFor={fieldId} className="block text-sm font-medium text-slate-800">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>

      {/* The id actually submitted. Kept in sync with the selection; preserves a
          valid link on an untouched edit save. */}
      <input type="hidden" name={name} value={selectedId} />

      <div className="relative mt-1.5">
        <input
          id={fieldId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={noCustomers}
          placeholder={noCustomers ? "No customers yet" : placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDirty(true);
            setOpen(true);
            // Typing over a selection detaches it until a new pick/clear, so a
            // half-typed term is never silently submitted as the old id.
            if (selectedId) setSelectedId("");
          }}
          onFocus={(e) => {
            setOpen(true);
            e.currentTarget.select();
          }}
          onKeyDown={onKeyDown}
          className={`block w-full rounded-md border bg-white px-3 py-2.5 pr-9 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-1 ${
            error
              ? "border-red-400 focus:border-red-500 focus:ring-red-500"
              : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
          }`}
        />
        {selectedId || query ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear selected customer"
            className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-700"
          >
            ×
          </button>
        ) : null}

        {open && !noCustomers ? (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
          >
            {noneLabel ? (
              <li
                role="option"
                aria-selected={selectedId === ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  clear();
                  setOpen(false);
                }}
                className="cursor-pointer px-3 py-2 text-slate-500 hover:bg-slate-50"
              >
                {noneLabel}
              </li>
            ) : null}
            {loading ? (
              <li className="px-3 py-2 text-slate-400">Searching…</li>
            ) : results.length === 0 ? (
              <li className="px-3 py-2 text-slate-400">
                {dirty && query.trim().length >= MIN_CHARS
                  ? "No matching customers"
                  : dirty && query.trim().length > 0
                    ? "Keep typing…"
                    : "Type to search customers"}
              </li>
            ) : (
              results.map((h, i) => (
                <li
                  key={h.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(h);
                  }}
                  className={`cursor-pointer px-3 py-2 ${
                    i === activeIndex ? "bg-slate-100" : "hover:bg-slate-50"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-slate-900">{h.name}</span>
                    {h.customer_type === "business" ? (
                      <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800">
                        Business
                      </span>
                    ) : null}
                  </span>
                  {h.address ? (
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {h.address}
                    </span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>

      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : help ? (
        <p className="mt-1 text-xs text-slate-500">{help}</p>
      ) : noCustomers ? (
        <p className="mt-1 text-xs text-slate-500">
          Add a customer first via the Customers tab.
        </p>
      ) : null}
    </div>
  );
}
