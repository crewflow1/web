/**
 * Migration OS — file parsers.
 *
 * Pure-ish: parseCsv is fully pure; parseXlsx wraps `xlsx` (SheetJS) which
 * is a dependency we accept for v1 Excel support. Both return the same
 * `ParsedSheet[]` shape: header row + an array of cell-value rows.
 *
 * The detect/duplicate/commit stages all operate on `ParsedSheet`, so
 * adding new source formats (PDF, photos in v2) only requires producing
 * the same shape.
 */

import * as XLSX from "xlsx";

export type Cell = string | number | boolean | null;

export type ParsedSheet = {
  name: string; // sheet name (CSV → "Sheet1")
  header: string[]; // column headers, trimmed + lowercased? no — kept verbatim.
  rows: Cell[][]; // rows[i].length === header.length
};

export function parseCsvFile(text: string, sheetName = "Sheet1"): ParsedSheet {
  // Split on either \r\n, \n, or \r; ignore trailing empty lines.
  const lines = text.split(/\r\n|\n|\r/).filter((l, i, arr) =>
    !(l.trim() === "" && i === arr.length - 1),
  );
  if (lines.length === 0) {
    return { name: sheetName, header: [], rows: [] };
  }
  const allRows: Cell[][] = lines.map(parseCsvLine);
  // Promote the first non-empty row to the header.
  let headerIdx = 0;
  while (headerIdx < allRows.length && allRows[headerIdx]!.every((c) => c === "" || c === null)) {
    headerIdx++;
  }
  const headerRow = allRows[headerIdx] ?? [];
  const header = headerRow.map((c) => String(c ?? "").trim());
  const rows = allRows
    .slice(headerIdx + 1)
    .filter((r) => r.some((c) => c !== "" && c !== null));
  // Normalise widths so each row matches header length.
  const normalised = rows.map((r) => {
    const out: Cell[] = [];
    for (let i = 0; i < header.length; i++) {
      out.push(coerceCell(r[i]));
    }
    return out;
  });
  return { name: sheetName, header, rows: normalised };
}

function parseCsvLine(line: string): Cell[] {
  const out: Cell[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function coerceCell(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    return trimmed;
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

/**
 * Excel parser via SheetJS. Multi-sheet workbooks return one ParsedSheet
 * per sheet; the caller chooses to import all or pick one.
 */
export function parseXlsxBuffer(buffer: ArrayBuffer | Uint8Array | Buffer): ParsedSheet[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const out: ParsedSheet[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    // header:1 → returns rows as arrays-of-cells (raw, no objectification).
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: null,
    }) as unknown[][];
    if (aoa.length === 0) {
      out.push({ name: sheetName, header: [], rows: [] });
      continue;
    }
    // First non-empty row = header.
    let headerIdx = 0;
    while (headerIdx < aoa.length && (aoa[headerIdx] ?? []).every((c) => c === null || c === "")) {
      headerIdx++;
    }
    const headerRow = aoa[headerIdx] ?? [];
    const header = headerRow.map((c) => String(c ?? "").trim());
    const rows = aoa
      .slice(headerIdx + 1)
      .filter((r) => r.some((c) => c !== null && c !== ""))
      .map((r) => {
        const cells: Cell[] = [];
        for (let i = 0; i < header.length; i++) {
          cells.push(coerceCell(r[i]));
        }
        return cells;
      });
    out.push({ name: sheetName, header, rows });
  }
  return out;
}

/** Number of populated rows across all sheets. */
export function totalRowCount(sheets: ParsedSheet[]): number {
  return sheets.reduce((s, sh) => s + sh.rows.length, 0);
}

/**
 * Convert a parsed sheet row into a `Record<header, Cell>` so it can be
 * stored as the `raw` jsonb in import_rows.
 */
export function rowToRecord(sheet: ParsedSheet, row: Cell[]): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (let i = 0; i < sheet.header.length; i++) {
    out[sheet.header[i]!] = row[i] ?? null;
  }
  return out;
}
