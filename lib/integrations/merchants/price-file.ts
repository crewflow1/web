/**
 * Merchant PRICE-FILE parser — the pure, provider-agnostic normaliser.
 *
 * A builders' merchant distributes trade prices as a PRICE FILE: rows of
 * (stock code, description, price, …). There is no single proprietary API for
 * this — but the CSV price file IS a genuinely knowable, ubiquitous format, so
 * THIS is the real, testable half of the catalogue-import flow (the adapter's
 * job is only to FETCH the bytes; shaping them lives here, once, unit-tested —
 * exactly as `normalizeTrueLayerTransactions` shapes bank rows).
 *
 * Pure by design: no `server-only`, no network, no env. It takes raw CSV text
 * and returns {@link CatalogueItem}[]. It is column-order tolerant (it reads a
 * header row and maps common column aliases) and money-safe (prices parse to
 * integer pence, never a float).
 *
 * ── WHY A HEADER-DRIVEN MAP (not fixed columns) ─────────────────────────────
 * Merchants ship price files with different column orders and header spellings
 * ("Stock Code" vs "SKU" vs "Product Code"; "Price" vs "Unit Price" vs "Nett").
 * Binding to a header map means a new merchant's file needs no code change as
 * long as it carries recognisable headers — and a file WITHOUT a usable header is
 * rejected loudly rather than silently mis-parsed into wrong prices.
 */

import type { CatalogueItem } from "./types";

/** Header aliases → canonical field. Lower-cased, punctuation-insensitive match. */
const HEADER_ALIASES: Record<keyof CatalogueItem | "ignore", string[]> = {
  sku: ["sku", "stockcode", "productcode", "code", "itemcode", "partno", "partnumber"],
  description: ["description", "desc", "productname", "name", "details"],
  unit: ["unit", "uom", "unitofmeasure", "sellunit"],
  packSize: ["packsize", "pack", "packqty", "ordermultiple", "multiple"],
  unitPricePence: ["price", "unitprice", "nett", "nettprice", "netprice", "tradeprice", "listprice"],
  currency: ["currency", "ccy"],
  vatCode: ["vat", "vatcode", "vatrate", "taxcode"],
  effectiveDate: ["effectivedate", "effective", "pricedate", "validfrom", "date"],
  ignore: [],
};

/** Normalise a header cell for matching: lower-case, strip all non-alphanumerics. */
function canonicalHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Parse ONE CSV line into cells, honouring double-quoted fields (which may
 * contain commas and escaped `""` quotes). A small, dependency-free RFC-4180-ish
 * splitter — enough for merchant price files, which are plain comma CSV.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * Parse a decimal price string into INTEGER PENCE. Accepts "12.34", "12", "£12.34",
 * "1,234.50" (thousands separators). Returns null when the cell is not a number,
 * so the row can be skipped rather than importing a 0/NaN price.
 *
 * Rounds half-up on the pence to avoid a float artefact (e.g. 0.1+0.2). The
 * arithmetic is done on a cleaned string → Number → Math.round(x*100).
 */
export function parsePricePence(raw: string): number | null {
  const cleaned = raw.replace(/[£$,\s]/g, "");
  if (cleaned.length === 0) return null;
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export type PriceFileParseResult = {
  items: CatalogueItem[];
  /** Rows dropped because they had no SKU or no parseable price. */
  skipped: number;
};

/**
 * Parse a merchant CSV price file into canonical {@link CatalogueItem}s.
 *
 * Throws when the file has no recognisable header (SKU + price columns are the
 * minimum) — a loud failure, so a malformed file never silently imports zero
 * rows and looks like an "empty catalogue".
 */
export function parsePriceFileCsv(csv: string): PriceFileParseResult {
  const lines = csv
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("price file is empty");
  }

  const header = splitCsvLine(lines[0]!).map(canonicalHeader);

  // Build column index → canonical field.
  const colField: (keyof CatalogueItem | null)[] = header.map((h) => {
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (field === "ignore") continue;
      if (aliases.includes(h)) return field as keyof CatalogueItem;
    }
    return null;
  });

  const hasSku = colField.includes("sku");
  const hasPrice = colField.includes("unitPricePence");
  if (!hasSku || !hasPrice) {
    throw new Error(
      "price file header not recognised: a SKU/stock-code column and a price column are required",
    );
  }

  const items: CatalogueItem[] = [];
  let skipped = 0;

  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]!);
    const get = (field: keyof CatalogueItem): string | null => {
      const idx = colField.indexOf(field);
      if (idx === -1) return null;
      const v = cells[idx];
      return v !== undefined && v.length > 0 ? v : null;
    };

    const sku = get("sku");
    const priceRaw = get("unitPricePence");
    const unitPricePence = priceRaw !== null ? parsePricePence(priceRaw) : null;

    // A row without a SKU or without a parseable price is not importable.
    if (sku === null || unitPricePence === null) {
      skipped++;
      continue;
    }

    items.push({
      sku,
      description: get("description") ?? "",
      unit: get("unit"),
      packSize: get("packSize"),
      unitPricePence,
      currency: (get("currency") ?? "GBP").toUpperCase(),
      vatCode: get("vatCode"),
      effectiveDate: get("effectiveDate"),
    });
  }

  return { items, skipped };
}
