/**
 * Deterministic quote-version diffing.
 *
 * Pure, dependency-free logic shared by the "Version history" panel on
 * app/(app)/quotes/[id]. Given two snapshots (a captured `quote_versions` row,
 * or the current live quote), it produces a totals delta and a line-item diff.
 * No AI, no randomness, no I/O — the same inputs always yield the same output,
 * which is what the unit tests pin.
 */

export interface QuoteVersionLine {
  description: string;
  qty: number;
  unit: string;
  unit_price: number;
  vat_rate: number;
  line_total: number;
  sort_order: number;
}

export interface QuoteVersionSnapshot {
  /** Captured version number, or null for the current live quote. */
  version_number: number | null;
  /** 'sent' | 'approved' | 're-approved', or null for the live quote. */
  captured_reason: string | null;
  status: string;
  currency: string;
  subtotal: number;
  vat_total: number;
  total: number;
  line_items: QuoteVersionLine[];
  captured_at: string | null;
  /** Human label, e.g. "v2 · re-approved" or "Current (live)". */
  label: string;
}

export type LineChangeKind = "added" | "removed" | "changed" | "unchanged";

/** The per-line fields a diff compares (description is the identity, not a field). */
export const COMPARED_LINE_FIELDS = [
  "qty",
  "unit",
  "unit_price",
  "vat_rate",
  "line_total",
] as const;

export type ComparedLineField = (typeof COMPARED_LINE_FIELDS)[number];

export interface LineFieldChange {
  field: ComparedLineField;
  from: string | number;
  to: string | number;
}

export interface LineDiffEntry {
  kind: LineChangeKind;
  description: string;
  /** The line in the base snapshot — absent when the line was added. */
  base: QuoteVersionLine | null;
  /** The line in the target snapshot — absent when the line was removed. */
  target: QuoteVersionLine | null;
  /** Field-level changes, only populated when kind === "changed". */
  fieldChanges: LineFieldChange[];
}

export interface TotalDelta {
  from: number;
  to: number;
  delta: number;
}

export interface TotalsDelta {
  subtotal: TotalDelta;
  vat_total: TotalDelta;
  total: TotalDelta;
  currencyFrom: string;
  currencyTo: string;
  currencyChanged: boolean;
}

export interface QuoteVersionDiff {
  totals: TotalsDelta;
  lines: LineDiffEntry[];
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
}

/** Coerce anything PostgREST/jsonb may hand back (numeric-as-string) to a number. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to pennies so float noise never shows as a spurious change. */
function money(n: number): number {
  const r = Math.round(n * 100) / 100;
  // Normalise -0 to 0 so a zero delta compares equal and never renders "−£0.00".
  return r === 0 ? 0 : r;
}

/**
 * Normalise a raw snapshot line (jsonb element or live line) into a typed line.
 * Tolerates missing/loose fields so a legacy or hand-built snapshot never throws.
 */
export function normalizeSnapshotLine(raw: unknown): QuoteVersionLine {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    description: typeof r.description === "string" ? r.description : "",
    qty: num(r.qty),
    unit: typeof r.unit === "string" ? r.unit : "",
    unit_price: num(r.unit_price),
    vat_rate: num(r.vat_rate),
    line_total: num(r.line_total),
    sort_order: num(r.sort_order),
  };
}

export function normalizeSnapshotLines(raw: unknown): QuoteVersionLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeSnapshotLine);
}

/** Identity key for matching a line across snapshots: normalised description. */
function descKey(description: string): string {
  return description.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Assign each line a stable occurrence key (`desc#0`, `desc#1`, …) so duplicate
 * descriptions pair up deterministically rather than collapsing into one.
 * Lines are keyed in a stable order (sort_order, then description) so the pairing
 * is independent of the array's incoming order.
 */
function keyedLines(
  lines: QuoteVersionLine[],
): Array<{ key: string; line: QuoteVersionLine }> {
  const ordered = [...lines].sort(
    (a, b) =>
      a.sort_order - b.sort_order ||
      descKey(a.description).localeCompare(descKey(b.description)),
  );
  const seen = new Map<string, number>();
  return ordered.map((line) => {
    const base = descKey(line.description);
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    return { key: `${base}#${occ}`, line };
  });
}

function fieldValue(
  line: QuoteVersionLine,
  field: ComparedLineField,
): string | number {
  return line[field];
}

function fieldEquals(
  a: QuoteVersionLine,
  b: QuoteVersionLine,
  field: ComparedLineField,
): boolean {
  const av = a[field];
  const bv = b[field];
  if (typeof av === "number" && typeof bv === "number") {
    return money(av) === money(bv);
  }
  return av === bv;
}

function totalDelta(from: number, to: number): TotalDelta {
  return { from: money(from), to: money(to), delta: money(to - from) };
}

/**
 * Diff two snapshots. `base` is the earlier/"from" version, `target` the
 * later/"to" version (which may be the live quote). Output ordering is
 * deterministic: lines sort by their reference sort_order (target's, else
 * base's), then by description, then by key.
 */
export function diffQuoteVersions(
  base: QuoteVersionSnapshot,
  target: QuoteVersionSnapshot,
): QuoteVersionDiff {
  const baseKeyed = keyedLines(base.line_items);
  const targetKeyed = keyedLines(target.line_items);

  const baseMap = new Map(baseKeyed.map((k) => [k.key, k.line]));
  const targetMap = new Map(targetKeyed.map((k) => [k.key, k.line]));

  const allKeys = new Set<string>([...baseMap.keys(), ...targetMap.keys()]);

  const entries: Array<{ sortRef: number; entry: LineDiffEntry }> = [];

  for (const key of allKeys) {
    const b = baseMap.get(key) ?? null;
    const t = targetMap.get(key) ?? null;

    if (b && !t) {
      entries.push({
        sortRef: b.sort_order,
        entry: {
          kind: "removed",
          description: b.description,
          base: b,
          target: null,
          fieldChanges: [],
        },
      });
      continue;
    }
    if (!b && t) {
      entries.push({
        sortRef: t.sort_order,
        entry: {
          kind: "added",
          description: t.description,
          base: null,
          target: t,
          fieldChanges: [],
        },
      });
      continue;
    }
    // Both present — compare fields.
    if (b && t) {
      const fieldChanges: LineFieldChange[] = [];
      for (const field of COMPARED_LINE_FIELDS) {
        if (!fieldEquals(b, t, field)) {
          fieldChanges.push({
            field,
            from: fieldValue(b, field),
            to: fieldValue(t, field),
          });
        }
      }
      entries.push({
        sortRef: t.sort_order,
        entry: {
          kind: fieldChanges.length > 0 ? "changed" : "unchanged",
          // Prefer the target's description text when it differs only by case/space.
          description: t.description,
          base: b,
          target: t,
          fieldChanges,
        },
      });
    }
  }

  entries.sort(
    (a, b) =>
      a.sortRef - b.sortRef ||
      descKey(a.entry.description).localeCompare(descKey(b.entry.description)),
  );

  const lines = entries.map((e) => e.entry);

  const summary = {
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
    changed: lines.filter((l) => l.kind === "changed").length,
    unchanged: lines.filter((l) => l.kind === "unchanged").length,
  };

  return {
    totals: {
      subtotal: totalDelta(base.subtotal, target.subtotal),
      vat_total: totalDelta(base.vat_total, target.vat_total),
      total: totalDelta(base.total, target.total),
      currencyFrom: base.currency,
      currencyTo: target.currency,
      currencyChanged: base.currency !== target.currency,
    },
    lines,
    summary,
  };
}

/** True when the diff shows no material change (used to render "No changes"). */
export function isEmptyDiff(diff: QuoteVersionDiff): boolean {
  return (
    diff.summary.added === 0 &&
    diff.summary.removed === 0 &&
    diff.summary.changed === 0 &&
    diff.totals.subtotal.delta === 0 &&
    diff.totals.vat_total.delta === 0 &&
    diff.totals.total.delta === 0 &&
    !diff.totals.currencyChanged
  );
}

/** Build the human label for a captured version row. */
export function versionLabel(
  versionNumber: number,
  capturedReason: string | null,
): string {
  return capturedReason
    ? `v${versionNumber} · ${capturedReason}`
    : `v${versionNumber}`;
}
