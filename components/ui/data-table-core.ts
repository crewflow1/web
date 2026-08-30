/**
 * DataTable core — the PURE half of components/ui/data-table.tsx.
 *
 * Everything a DataTable *decides* (sort order, which loaded rows a filter
 * keeps, what a select-all toggle does, how a CSV serialises, how rows bucket
 * into groups) lives here as plain functions over plain values: no React, no
 * DOM, no state. That split exists for two reasons:
 *
 *   1. TESTABILITY — __tests__/ui/data-table.test.ts exercises these in the
 *      fast node unit tier without mounting anything.
 *   2. BUNDLE HYGIENE — data-table.tsx is a client module; keeping the logic
 *      in a dependency-free sibling keeps the client file thin and keeps this
 *      logic importable from server code if a page ever needs to pre-sort.
 *
 * CSV escaping is NOT re-implemented: `csvEscape` is imported from the ONE
 * authoritative owner (lib/csv.ts — RFC 4180 quoting + OWASP formula-injection
 * neutralisation). lib/csv is pure by design ("no SDK, no server-only, no Node
 * builtins"), so a client component may import it.
 */
import { csvEscape } from "@/lib/csv";

/** How a sortable column's values compare. Declared per column, never guessed. */
export type DataTableSortType = "text" | "number" | "date";

export type SortDir = "asc" | "desc";

/** `key === null` means "natural order" — the server's order, untouched. */
export type SortState = { key: string | null; dir: SortDir | null };

export const UNSORTED: SortState = { key: null, dir: null };

/**
 * Clicking a sortable header cycles asc → desc → none (back to the server's
 * natural order). Clicking a DIFFERENT header always starts at asc.
 */
export function cycleSort(prev: SortState, key: string): SortState {
  if (prev.key !== key) return { key, dir: "asc" };
  if (prev.dir === "asc") return { key, dir: "desc" };
  return UNSORTED;
}

/**
 * Coerce a raw sort value for comparison. `null`/`undefined`/`""` and values
 * that fail to parse under the declared type all become `null`, and `null`
 * sorts LAST in BOTH directions — a missing due date should never float to the
 * top just because the user flipped the sort.
 */
export function normaliseSortValue(
  value: unknown,
  type: DataTableSortType,
): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "date") {
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? t : null;
  }
  return String(value).toLocaleLowerCase();
}

/**
 * Sort a loaded page of rows by one column. EXPLICITLY stable (original index
 * is the tiebreaker) so equal values keep the server's order, and null values
 * are pinned to the end regardless of direction.
 */
export function sortRows<T>(
  rows: readonly T[],
  getValue: (row: T) => unknown,
  dir: SortDir,
  type: DataTableSortType,
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: normaliseSortValue(getValue(row), type) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c =
        typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v));
      return c === 0 ? a.i - b.i : c * sign;
    })
    .map((e) => e.row);
}

/**
 * Filter the LOADED rows by a free-text query. Case-insensitive; every
 * whitespace-separated term must match somewhere in the row's text. An empty
 * query keeps everything. This is deliberately page-local — server pagination
 * stays authoritative, and the component says so next to the box.
 */
export function filterRows<T>(
  rows: readonly T[],
  getText: (row: T) => string,
  query: string,
): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...rows];
  const terms = q.split(/\s+/);
  return rows.filter((row) => {
    const text = getText(row).toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Toggle one row id in/out of the selection. Pure — returns a new array. */
export function toggleSelected(
  selected: readonly string[],
  id: string,
): string[] {
  return selected.includes(id)
    ? selected.filter((s) => s !== id)
    : [...selected, id];
}

/** True when every currently-visible row is selected (and there is at least one). */
export function allSelected(
  selected: readonly string[],
  visibleIds: readonly string[],
): boolean {
  if (visibleIds.length === 0) return false;
  const set = new Set(selected);
  return visibleIds.every((id) => set.has(id));
}

/**
 * Header select-all semantics: if every visible row is already selected,
 * deselect the visible rows (selections outside the visible set — e.g. rows a
 * filter is currently hiding — are preserved); otherwise select all visible.
 */
export function toggleAllSelected(
  selected: readonly string[],
  visibleIds: readonly string[],
): string[] {
  if (allSelected(selected, visibleIds)) {
    const visible = new Set(visibleIds);
    return selected.filter((id) => !visible.has(id));
  }
  const merged = new Set(selected);
  for (const id of visibleIds) merged.add(id);
  return [...merged];
}

/**
 * Bucket rows by a label, preserving first-appearance order of the labels and
 * the given order of rows inside each bucket. Used for the `groupBy` prop's
 * group header rows.
 */
export function groupRows<T>(
  rows: readonly T[],
  labelOf: (row: T) => string,
): Array<{ label: string; rows: T[] }> {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const label = labelOf(row);
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = [];
      buckets.set(label, bucket);
      order.push(label);
    }
    bucket.push(row);
  }
  return order.map((label) => ({ label, rows: buckets.get(label)! }));
}

/**
 * Serialise header + rows to CSV text via the shared authoritative escaper
 * (quoting + formula-injection neutralisation live in lib/csv, not here).
 * CRLF line endings per RFC 4180.
 */
export function toCsv(
  header: readonly (string | number | null)[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  return [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
}
