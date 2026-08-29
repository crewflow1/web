"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  UNSORTED,
  cycleSort,
  filterRows,
  sortRows,
  groupRows,
  toggleSelected,
  toggleAllSelected,
  allSelected,
  toCsv,
  type DataTableSortType,
  type SortState,
} from "./data-table-core";

/**
 * DataTable — the canonical ADVANCED table (roadmap G3).
 *
 * components/ui/table.tsx is the deliberate SERVER table chrome: zero client
 * JS, adopted by surfaces that only display. This is its capability-driven
 * CLIENT sibling for list pages that need interaction. Every capability is
 * prop-driven and optional; a DataTable with none enabled renders the exact
 * same visual recipe as table.tsx (the thead/td class strings below are
 * copied verbatim from it — the measured dominant idiom, not a new design).
 *
 * CAPABILITIES: sticky header · client-side sorting (asc → desc → natural,
 * aria-sort) · client-side filtering of the LOADED page (server pagination
 * stays authoritative and the count line says so) · pointer-drag column
 * resizing (touch-safe, min-widths) · bulk selection with a non-destructive
 * actions slot · roving keyboard row navigation (↑/↓/Home/End, Enter opens
 * the row's href) · groupBy header rows · loading skeleton · empty slot.
 *
 * RSC BOUNDARY — THE CENTRAL DESIGN CONSTRAINT. The adopting list pages are
 * async SERVER components, and a function cannot cross a server→client props
 * boundary. So nothing here requires a function from the page: cells, mobile
 * cards and the empty state arrive PRE-RENDERED as ReactNodes; sort keys,
 * filter text, CSV values and group labels arrive as plain values on each row
 * (`sortValues`, `filterText`, `csv`, `group`). The one function prop,
 * `bulkActions`, exists for CLIENT parents only — server pages use the
 * serialisable `csvExport` built-in instead.
 *
 * INLINE EDITING IS DELIBERATELY OMITTED (roadmap says "where appropriate";
 * here it is not). Every mutation in this product goes through an explicit
 * PRG server-action form with validation, error surfaces and revalidation. A
 * save-on-blur cell is a write with no confirm step and no failure UI — the
 * destructive-safety posture bans it. Pages link to their detail forms.
 *
 * BULK SAFETY: there are no built-in destructive bulk actions and no default
 * action of any kind. The only built-in is a client-side CSV export of the
 * selected LOADED rows, escaped by lib/csv (the one authoritative escaper).
 *
 * NO cn()/tailwind-merge: this is a client module, and tailwind-merge costs
 * ~8 kB of first-load JS in a client bundle (measured on modal.tsx — see
 * design-system-adoption.test.ts). Nothing here has conflicting classes to
 * merge, so classes are joined with the dumb local `cx` below.
 *
 * STICKY MECHANICS: `position: sticky` cannot escape the horizontal scroll
 * wrapper every table needs for 320/375px safety (the wrapper becomes the
 * sticky containing scrollport). So `stickyHeader` gives the wrapper a
 * viewport-bounded max-height and lets the TABLE scroll under its own header
 * — the header genuinely sticks, and the page never scrolls sideways.
 *
 * LIGHT ONLY, SLATE ONLY — same rules as table.tsx: no `dark:` classes, no
 * tone colours (a cell that carries status renders a page-supplied badge).
 * No animations except the loading skeleton's pulse, which is suppressed
 * under prefers-reduced-motion.
 */

/** Dumb class joiner — NOT cn(): nothing to merge, nothing to ship. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Literal strings so Tailwind's scanner sees them — same rule as table.tsx. */
const HIDE_BELOW = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

/** Card/table split per page: whole literal strings, per the scanner rule. */
const CARDS_ONLY = { sm: "space-y-2 sm:hidden", md: "space-y-2 md:hidden" } as const;
const TABLE_ONLY = { sm: "hidden sm:block", md: "hidden md:block" } as const;

export type DataTableColumn = {
  /** Matches the keys of each row's `cells` / `sortValues`. */
  key: string;
  header: ReactNode;
  /** Declaring a type is what makes the column sortable. */
  sortable?: DataTableSortType;
  /** Right-align with tabular-nums — figures. */
  numeric?: boolean;
  /** Hide the whole column (th + every td, always in sync) below a breakpoint. */
  hideBelow?: keyof typeof HIDE_BELOW;
  /** Resize floor in px (default 64). */
  minWidth?: number;
  /** Extra classes for this column's `<td>`s (e.g. text colour/weight). */
  cellClassName?: string;
};

export type DataTableRow = {
  id: string;
  /** Primary destination — Enter on a focused row navigates here. */
  href?: string;
  /** Pre-rendered cell content, keyed by column key. */
  cells: Record<string, ReactNode>;
  /** Plain values sorting compares — NEVER derived from the ReactNode cells. */
  sortValues?: Record<string, string | number | null>;
  /** Haystack for the client-side filter (falls back to joined sortValues). */
  filterText?: string;
  /** One CSV cell per `csvExport.header` entry, for the built-in export. */
  csv?: readonly (string | number | null)[];
  /** Group label fallback when `groupBy` has no sortValue to read. */
  group?: string;
  /** Accessible name for this row's selection checkbox. */
  selectLabel?: string;
  /** Pre-rendered card for below the `cardsBelow` breakpoint. */
  mobileCard?: ReactNode;
};

export function DataTable({
  columns,
  rows,
  label,
  stickyHeader = false,
  filterable = false,
  resizable = false,
  selectable = false,
  bulkActions,
  csvExport,
  groupBy,
  loading = false,
  loadingRows = 8,
  empty,
  cardsBelow = "md",
  className,
}: {
  columns: readonly DataTableColumn[];
  rows: readonly DataTableRow[];
  /** Accessible name for the table. */
  label: string;
  /** Header sticks while the table scrolls (see STICKY MECHANICS above). */
  stickyHeader?: boolean;
  /** Compact text box filtering the LOADED rows; says so via a count line. */
  filterable?: boolean;
  /** Pointer-drag resize handles on column edges. */
  resizable?: boolean;
  /** Checkbox column + header select-all. Selection alone is inert. */
  selectable?: boolean;
  /**
   * Actions slot for the selection — CLIENT parents only (functions cannot
   * cross the RSC boundary; server pages use `csvExport`). Rendered only when
   * provided; there are no default actions, destructive or otherwise.
   */
  bulkActions?: (selectedIds: string[]) => ReactNode;
  /** Serialisable built-in bulk action: CSV of the selected loaded rows. */
  csvExport?: { filename: string; header: readonly string[] };
  /** Column key whose sortValue labels group header rows. */
  groupBy?: string;
  loading?: boolean;
  loadingRows?: number;
  /** Rendered instead of the table when there are no rows at all. */
  empty?: ReactNode;
  /** Breakpoint below which rows render their `mobileCard` instead. */
  cardsBelow?: "sm" | "md";
  /** Card chrome for the table section — a page decision, as in table.tsx. */
  className?: string;
}) {
  const [sort, setSort] = useState<SortState>(UNSORTED);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [widths, setWidths] = useState<Record<string, number> | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  const descId = useId();
  const filterId = useId();
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const thRefs = useRef<Record<string, HTMLTableCellElement | null>>({});
  const dragRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);

  const sortColumn = columns.find((c) => c.key === sort.key && c.sortable);

  const visible = useMemo(() => {
    const filtered = filterable
      ? filterRows(
          rows,
          (r) =>
            r.filterText ??
            Object.values(r.sortValues ?? {})
              .filter((v) => v !== null && v !== undefined)
              .join(" "),
          filter,
        )
      : [...rows];
    if (!sortColumn || !sort.dir) return filtered;
    return sortRows(
      filtered,
      (r) => r.sortValues?.[sortColumn.key] ?? null,
      sort.dir,
      sortColumn.sortable!,
    );
  }, [rows, filterable, filter, sortColumn, sort.dir]);

  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible]);
  const everySelected = allSelected(selected, visibleIds);
  const selectedVisible = useMemo(
    () => visible.filter((r) => selected.includes(r.id)),
    [visible, selected],
  );

  // The header checkbox's mixed state is a DOM property, not an attribute.
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate =
        selectedVisible.length > 0 && !everySelected;
    }
  }, [selectedVisible.length, everySelected]);

  const hasCards = visible.some((r) => r.mobileCard !== undefined) ||
    rows.some((r) => r.mobileCard !== undefined);
  const keyboard = rows.some((r) => r.href);
  const colCount = columns.length + (selectable ? 1 : 0);

  /** Sorted+filtered rows, interleaved with group header markers. */
  const renderList = useMemo(() => {
    type Entry =
      | { kind: "group"; label: string }
      | { kind: "row"; row: DataTableRow; idx: number };
    const out: Entry[] = [];
    let idx = 0;
    if (groupBy) {
      for (const g of groupRows(
        visible,
        (r) => String(r.sortValues?.[groupBy] ?? r.group ?? "—"),
      )) {
        out.push({ kind: "group", label: g.label });
        for (const row of g.rows) out.push({ kind: "row", row, idx: idx++ });
      }
    } else {
      for (const row of visible) out.push({ kind: "row", row, idx: idx++ });
    }
    return out;
  }, [visible, groupBy]);

  function focusRow(next: number) {
    const clamped = Math.max(0, Math.min(next, visible.length - 1));
    setFocusIdx(clamped);
    rowRefs.current[clamped]?.focus();
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, idx: number, row: DataTableRow) {
    // Only steer when the ROW itself is focused — a checkbox or link inside
    // the row keeps its native keyboard behaviour untouched. (The bubble-up
    // from an inner control reaches this handler too, so the guard must be
    // enforced, not just documented.)
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(visible.length - 1);
    } else if (e.key === "Enter" && row.href && e.target === e.currentTarget) {
      // House navigation pattern: an explicit full navigation, never a
      // router.push that the deep-swap commit race can drop.
      window.location.assign(row.href);
    }
  }

  function onResizeStart(e: ReactPointerEvent<HTMLSpanElement>, key: string) {
    const th = thRefs.current[key];
    if (!th) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // First drag: freeze EVERY resizable column at its measured width so the
    // untouched columns don't reflow under table-fixed.
    if (!widths) {
      const measured: Record<string, number> = {};
      for (const c of columns) {
        const el = thRefs.current[c.key];
        if (el) measured[c.key] = el.offsetWidth;
      }
      setWidths(measured);
      dragRef.current = { key, startX: e.clientX, startWidth: th.offsetWidth };
      return;
    }
    dragRef.current = { key, startX: e.clientX, startWidth: widths[key] ?? th.offsetWidth };
  }

  function onResizeMove(e: ReactPointerEvent<HTMLSpanElement>, min: number) {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.max(min, Math.round(drag.startWidth + (e.clientX - drag.startX)));
    setWidths((prev) => ({ ...(prev ?? {}), [drag.key]: next }));
  }

  function onResizeEnd() {
    dragRef.current = null;
  }

  /** Keyboard resize (WCAG 2.1.1): arrows nudge the column ±16px. */
  function onResizeKeyDown(
    e: KeyboardEvent<HTMLSpanElement>,
    key: string,
    min: number,
  ) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const th = thRefs.current[key];
    if (!th) return;
    setWidths((prev) => {
      const base = prev ?? (() => {
        const measured: Record<string, number> = {};
        for (const c of columns) {
          const el = thRefs.current[c.key];
          if (el) measured[c.key] = el.offsetWidth;
        }
        return measured;
      })();
      const current = base[key] ?? th.offsetWidth;
      const next = Math.max(min, current + (e.key === "ArrowRight" ? 16 : -16));
      return { ...base, [key]: next };
    });
  }

  function exportSelectedCsv() {
    if (!csvExport) return;
    // ALL selected rows, not the filter-visible intersection: the bulk bar
    // says "{selected.length} selected" and selection was an explicit act —
    // a filter typed AFTER selecting is a view, and silently dropping the
    // now-hidden selected rows from the file would contradict the count the
    // user just read.
    const body = rows
      .filter((r) => selected.includes(r.id))
      .filter((r) => r.csv !== undefined)
      .map((r) => [...r.csv!]);
    const csv = toCsv([...csvExport.header], body);
    // BOM so Excel opens the file as UTF-8 rather than guessing a legacy codepage.
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvExport.filename;
    a.rel = "noopener";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── States ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={className} aria-busy="true" aria-label={label}>
        <ul className="divide-y divide-slate-100">
          {Array.from({ length: loadingRows }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3">
              {columns.map((c) => (
                <div
                  key={c.key}
                  aria-hidden
                  className={cx(
                    "h-4 animate-pulse rounded bg-slate-200 motion-reduce:animate-none",
                    c.numeric ? "ml-auto w-16" : "w-32",
                    c.hideBelow && (c.hideBelow === "sm"
                      ? "hidden sm:block"
                      : c.hideBelow === "md"
                        ? "hidden md:block"
                        : "hidden lg:block"),
                  )}
                />
              ))}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (rows.length === 0) {
    return <>{empty ?? null}</>;
  }

  const focus = Math.min(focusIdx, Math.max(visible.length - 1, 0));

  // ── Table section (≥ cardsBelow when cards exist; everywhere otherwise) ──

  const tableSection = (
    <div className={cx(hasCards && TABLE_ONLY[cardsBelow], className)}>
      {filterable ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-2">
          <label htmlFor={filterId} className="sr-only">
            Filter loaded rows
          </label>
          <input
            id={filterId}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter loaded rows…"
            className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          {filter.trim() ? (
            <p className="text-xs text-slate-500" role="status">
              Filtering {visible.length} of {rows.length} loaded rows — pages
              beyond this one are not searched.
            </p>
          ) : null}
        </div>
      ) : null}

      {selectable && selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
          <span className="font-medium text-slate-700">
            {selected.length} selected
          </span>
          <button
            type="button"
            onClick={() => setSelected([])}
            className="text-slate-600 underline hover:text-slate-900"
          >
            Clear
          </button>
          {csvExport ? (
            <button
              type="button"
              onClick={exportSelectedCsv}
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Export selected as CSV
            </button>
          ) : null}
          {bulkActions ? bulkActions([...selected]) : null}
        </div>
      ) : null}

      {keyboard ? (
        <p id={descId} className="sr-only">
          Use the Up and Down arrow keys to move between rows, Home or End to
          jump to the first or last row, and Enter to open the focused row.
        </p>
      ) : null}

      <div
        className={cx(
          "overflow-x-auto",
          stickyHeader && "max-h-[70vh] overflow-y-auto",
        )}
      >
        <table
          aria-label={label}
          aria-describedby={keyboard ? descId : undefined}
          className={cx(
            "min-w-full divide-y divide-slate-200 text-sm",
            widths !== null && "table-fixed",
          )}
        >
          <thead
            className={cx(
              "bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500",
              stickyHeader && "sticky top-0 z-10",
            )}
          >
            <tr>
              {selectable ? (
                <th scope="col" className="w-10 px-4 py-3">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={everySelected}
                    onChange={() =>
                      setSelected((prev) => toggleAllSelected(prev, visibleIds))
                    }
                    className="h-4 w-4 rounded border-slate-300"
                  />
                </th>
              ) : null}
              {columns.map((col) => {
                const active = sortColumn?.key === col.key && sort.dir;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    ref={(el) => {
                      thRefs.current[col.key] = el;
                    }}
                    aria-sort={
                      active
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : col.sortable
                          ? "none"
                          : undefined
                    }
                    style={
                      widths && widths[col.key] !== undefined
                        ? { width: widths[col.key] }
                        : undefined
                    }
                    className={cx(
                      "px-4 py-3",
                      col.numeric && "text-right",
                      col.hideBelow && HIDE_BELOW[col.hideBelow],
                      resizable && "relative",
                    )}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => setSort((prev) => cycleSort(prev, col.key))}
                        className="inline-flex items-center gap-1 uppercase hover:text-slate-700"
                      >
                        {col.header}
                        <span aria-hidden className="text-slate-400">
                          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                    {resizable ? (
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${typeof col.header === "string" && col.header ? col.header : col.key} column`}
                        tabIndex={0}
                        onPointerDown={(e) => onResizeStart(e, col.key)}
                        onPointerMove={(e) => onResizeMove(e, col.minWidth ?? 64)}
                        onPointerUp={onResizeEnd}
                        onPointerCancel={onResizeEnd}
                        onKeyDown={(e) => onResizeKeyDown(e, col.key, col.minWidth ?? 64)}
                        className="absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none select-none focus:outline-none focus-visible:bg-slate-400/60 focus-visible:ring-2 focus-visible:ring-slate-500"
                      />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={colCount}
                  className="px-4 py-6 text-center text-sm text-slate-500"
                >
                  No loaded rows match the filter.
                </td>
              </tr>
            ) : (
              renderList.map((entry) =>
                entry.kind === "group" ? (
                  <tr key={`group:${entry.label}`}>
                    <th
                      colSpan={colCount}
                      scope="colgroup"
                      className="bg-slate-50 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      {entry.label}
                    </th>
                  </tr>
                ) : (
                  <tr
                    key={entry.row.id}
                    ref={(el) => {
                      rowRefs.current[entry.idx] = el;
                    }}
                    tabIndex={keyboard ? (entry.idx === focus ? 0 : -1) : undefined}
                    onKeyDown={
                      keyboard
                        ? (e) => onRowKeyDown(e, entry.idx, entry.row)
                        : undefined
                    }
                    onFocus={
                      keyboard
                        ? (e) => {
                            if (e.target === e.currentTarget) setFocusIdx(entry.idx);
                          }
                        : undefined
                    }
                    className="hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                  >
                    {selectable ? (
                      <td className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={entry.row.selectLabel ?? `Select row ${entry.row.id}`}
                          checked={selected.includes(entry.row.id)}
                          onChange={() =>
                            setSelected((prev) => toggleSelected(prev, entry.row.id))
                          }
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                    ) : null}
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cx(
                          "px-4 py-3",
                          col.numeric && "text-right tabular-nums",
                          col.hideBelow && HIDE_BELOW[col.hideBelow],
                          col.cellClassName,
                        )}
                      >
                        {entry.row.cells[col.key] ?? null}
                      </td>
                    ))}
                  </tr>
                ),
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  // ── Mobile card list (< cardsBelow) — page-supplied markup, 44px+ targets ─

  if (!hasCards) return tableSection;

  return (
    <>
      {tableSection}
      <ul className={CARDS_ONLY[cardsBelow]}>
        {visible.map((row) => (
          <li key={row.id} className="min-h-[44px]">
            {row.mobileCard}
          </li>
        ))}
      </ul>
    </>
  );
}
