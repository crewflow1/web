/**
 * Accounting export — the deterministic CSV serialiser.
 *
 * THE CREDENTIAL-FREE PATH. This is the half of the accounting adapter that
 * works the moment the feature is switched on: no OAuth, no Xero / QuickBooks
 * tenant, no network. A canonical row set (lib/integrations/accounting/
 * canonical.ts) goes in, a spreadsheet an accountant can open goes out. It is
 * the immediate, real value; the provider APIs are a later, credential-gated
 * seam over the SAME canonical rows.
 *
 * QUOTING follows RFC 4180, delegated to the ONE authoritative escaper
 * (lib/csv.ts `csvEscape`): a field is wrapped in double quotes when it holds a
 * comma, a newline or a double quote, and embedded quotes are doubled. Records
 * are separated by CRLF, the RFC-4180 line ending, so the bytes are stable
 * regardless of the platform that generated them.
 *
 * COLUMN ORDER IS FIXED and lives here as the single source of truth. Adding,
 * removing or reordering a column is a conscious edit to `ACCOUNTING_CSV_COLUMNS`
 * — the serialiser derives both the header and every row from it, so they can
 * never drift apart.
 */

import { csvEscape } from "@/lib/csv";
import type { CanonicalAccountingRow } from "./canonical";

/**
 * The fixed CSV column order. Each entry maps a header label to the canonical
 * field it renders. Header and body are BOTH derived from this list, so a
 * column can never appear in one and not the other.
 */
export const ACCOUNTING_CSV_COLUMNS: ReadonlyArray<{
  header: string;
  field: keyof CanonicalAccountingRow;
}> = [
  { header: "date", field: "date" },
  { header: "type", field: "type" },
  { header: "customer", field: "customer" },
  { header: "net", field: "net" },
  { header: "vat", field: "vat" },
  { header: "gross", field: "gross" },
  { header: "invoice_number", field: "invoice_number" },
  { header: "status", field: "status" },
];

/** RFC-4180 record separator. */
const CRLF = "\r\n";

/**
 * Serialise canonical rows to an RFC-4180 CSV string (header + one line per
 * row). Deterministic: identical rows in -> byte-identical string out.
 */
export function toAccountingCsv(
  rows: readonly CanonicalAccountingRow[],
): string {
  const header = ACCOUNTING_CSV_COLUMNS.map((c) => csvEscape(c.header)).join(",");
  const lines = [header];
  for (const row of rows) {
    lines.push(
      ACCOUNTING_CSV_COLUMNS.map((c) => csvEscape(row[c.field])).join(","),
    );
  }
  return lines.join(CRLF);
}
