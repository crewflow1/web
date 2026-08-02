/**
 * H2-CIS M5 — the CIS300 / deduction-statement EXPORT FILE builders, as pure
 * computation.
 *
 * PURE. No Supabase, no server-only, no I/O — imported by the download routes,
 * the emailing service and tests alike, exactly like lib/cis/statements.ts and
 * lib/integrations/accounting/csv.ts. Deterministic: identical rows in ⇒
 * byte-identical string out.
 *
 * ── NOTHING HERE FILES ANYTHING WITH HMRC ───────────────────────────────────
 * This module turns figures CrewFlow already FROZE into a spreadsheet a human
 * downloads and files themselves through HMRC's own service or their filing
 * software. There is no HMRC endpoint, no Government Gateway credential and no
 * transmission anywhere behind it. Producing this file is exactly what the
 * `cis_monthly_returns.status = 'exported'` state records — "the operator took
 * the figures out of CrewFlow" — and asserts NOTHING about a filing having
 * happened. See CIS_NO_FILING_NOTICE in lib/cis/statements.ts.
 *
 * ── MASKED UTR ONLY ─────────────────────────────────────────────────────────
 * The subcontractor's FULL UTR has exactly one unmasked home (the admin-only
 * `cis_subcontractors` row) and is rendered live, one at a time, only on the
 * admin-gated per-statement PDF (app/api/cis/statements/[id]/pdf). This bulk CSV
 * deliberately emits the MASKED UTR that was frozen onto the return line /
 * statement, so it never becomes a second, bulk, unmasked home for the most
 * sensitive field in the domain. The CSV is a reconciliation/working dataset;
 * the authoritative per-subcontractor document with the full UTR is the PDF.
 *
 * ── NO SECOND ARITHMETIC ────────────────────────────────────────────────────
 * Every money figure here is a FROZEN value formatted to 2dp. This module sums
 * nothing and computes no deduction — the frozen return and its lines already
 * reconcile (enforced at COMMIT by the DB). It only serialises.
 *
 * QUOTING follows RFC 4180, delegated to the ONE authoritative escaper
 * (lib/csv.ts `csvEscape`); records are separated by CRLF so the bytes are
 * stable across platforms — the same convention as the accounting export.
 */

import { csvEscape } from "@/lib/csv";
import { round2, toPounds } from "@/lib/money";

/** RFC-4180 record separator, matching lib/integrations/accounting/csv.ts. */
const CRLF = "\r\n";

/**
 * Row cap for a single export. Realistically a month's return has a handful of
 * subcontractors, but a cap that is NEVER SILENT is the discipline the
 * accounting export established (server/services/accounting-export.ts): a
 * builder that hits the cap sets `truncated`, and the caller MUST surface it
 * rather than shipping a partial file that looks complete.
 */
export const CIS_EXPORT_MAX_ROWS = 10_000;

/** Cap a row list and report whether it was truncated at the cap. Pure. */
export function capCisRows<T>(
  rows: readonly T[],
  cap = CIS_EXPORT_MAX_ROWS,
): { rows: T[]; truncated: boolean } {
  const truncated = rows.length > cap;
  return { rows: truncated ? rows.slice(0, cap) : rows.slice(), truncated };
}

/** Frozen money → a stable "1234.50" cell. Never re-derives the figure. */
function money(v: number | string | null | undefined): string {
  return round2(toPounds(v)).toFixed(2);
}

/**
 * The rate cell, stated HONESTLY. A subcontractor re-verified mid-month can span
 * two rates in one line, and HMRC does not require the rate on the return at
 * all — so we print the rate when it is unambiguous and the word "varied" when
 * it is not, never a picked or averaged number. Mirrors the page/PDF wording.
 */
function rateCell(rateIsUniform: boolean, rate: number | string | null | undefined): string {
  return rateIsUniform ? money(rate) : "varied";
}

// ---------------------------------------------------------------------------
// The CIS300-shape monthly return CSV
// ---------------------------------------------------------------------------

/** One frozen `cis_monthly_return_lines` row, as the export reads it. */
export type CisReturnLineForCsv = {
  subcontractor_name: string;
  subcontractor_utr_masked: string | null;
  verification_number: string | null;
  verification_number_required: boolean;
  rate_is_uniform: boolean;
  deduction_rate: number | string | null;
  cis_status: string | null;
  gross_amount: number | string;
  materials_amount: number | string;
  deduction_amount: number | string;
  payment_count: number;
};

/** The frozen `cis_monthly_returns` header the export reads. */
export type CisReturnForCsv = {
  tax_month_start: string;
  tax_month_end: string;
  return_due_on: string;
  contractor_name: string;
  contractor_paye_reference: string;
  accounts_office_reference: string | null;
  is_nil: boolean;
  subcontractor_count: number;
  payment_count: number;
  total_gross: number | string;
  total_materials: number | string;
  total_deduction: number | string;
  status: "prepared" | "exported";
};

/**
 * The fixed CIS300 column order — the single source of truth, header and body
 * BOTH derived from it so they can never drift (the accounting-export idiom).
 * Columns follow the CIS300 monthly-return shape: contractor identity repeated
 * per row (so each row is self-describing when the file is split), then the
 * per-subcontractor figures HMRC asks for.
 */
export const CIS_RETURN_CSV_COLUMNS: ReadonlyArray<{
  header: string;
  cell: (line: CisReturnLineForCsv, ret: CisReturnForCsv) => string;
}> = [
  { header: "tax_month_start", cell: (_l, r) => r.tax_month_start },
  { header: "tax_month_end", cell: (_l, r) => r.tax_month_end },
  { header: "return_due_on", cell: (_l, r) => r.return_due_on },
  { header: "contractor_name", cell: (_l, r) => r.contractor_name },
  { header: "contractor_paye_reference", cell: (_l, r) => r.contractor_paye_reference },
  { header: "accounts_office_reference", cell: (_l, r) => r.accounts_office_reference ?? "" },
  { header: "subcontractor_name", cell: (l) => l.subcontractor_name },
  { header: "subcontractor_utr_masked", cell: (l) => l.subcontractor_utr_masked ?? "" },
  {
    header: "verification_number",
    // Never invent one. Present, or blank — the absence is stated in the PDF.
    cell: (l) => l.verification_number ?? "",
  },
  {
    header: "verification_number_required",
    cell: (l) => (l.verification_number_required ? "yes" : "no"),
  },
  { header: "deduction_rate", cell: (l) => rateCell(l.rate_is_uniform, l.deduction_rate) },
  { header: "gross_ex_vat", cell: (l) => money(l.gross_amount) },
  { header: "materials", cell: (l) => money(l.materials_amount) },
  { header: "deduction", cell: (l) => money(l.deduction_amount) },
  { header: "payment_count", cell: (l) => String(l.payment_count) },
];

export type CisReturnCsvResult = { csv: string; rowCount: number; truncated: boolean };

/**
 * Serialise a FROZEN, prepared monthly return and its lines to an RFC-4180 CSV.
 *
 * DRAFT / DIVERGENCE EXCLUSION: this takes the frozen return the operator
 * prepared, never a live recomputation. Exporting the live ledger would let a
 * download silently disagree with the figures the operator reviewed and froze —
 * the same reason the accounting export excludes drafts. A superseded return is
 * refused by the route, not here (this is a pure serialiser).
 *
 * A NIL return is a real, reportable dataset: it emits the header row and a
 * single body row recording zero payments, so a nil return produces a file that
 * plainly says "0", never an empty or absent one.
 */
export function buildCisReturnCsv(input: {
  ret: CisReturnForCsv;
  lines: readonly CisReturnLineForCsv[];
}): CisReturnCsvResult {
  const header = CIS_RETURN_CSV_COLUMNS.map((c) => csvEscape(c.header)).join(",");
  const { rows, truncated } = capCisRows(input.lines);

  const bodyRows: string[] = [];
  if (input.ret.is_nil || rows.length === 0) {
    // A nil month has no subcontractor lines. Emit ONE row that states the nil
    // return explicitly rather than a headerless empty file that reads as "no
    // data" — a nil return is an obligation, not an absence.
    const nilLine: CisReturnLineForCsv = {
      subcontractor_name: "NIL RETURN — no CIS payments in this tax month",
      subcontractor_utr_masked: null,
      verification_number: null,
      verification_number_required: false,
      rate_is_uniform: true,
      deduction_rate: 0,
      cis_status: null,
      gross_amount: 0,
      materials_amount: 0,
      deduction_amount: 0,
      payment_count: 0,
    };
    bodyRows.push(
      CIS_RETURN_CSV_COLUMNS.map((c) => csvEscape(c.cell(nilLine, input.ret))).join(","),
    );
  } else {
    for (const line of rows) {
      bodyRows.push(
        CIS_RETURN_CSV_COLUMNS.map((c) => csvEscape(c.cell(line, input.ret))).join(","),
      );
    }
  }

  return {
    csv: [header, ...bodyRows].join(CRLF),
    rowCount: input.ret.is_nil ? 0 : rows.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// The per-subcontractor deduction-statement CSV
// ---------------------------------------------------------------------------

/**
 * One issued `cis_statements` row, as the statement export reads it. Only the
 * fields a deduction statement carries (CIS340 3.15) plus the status, so the
 * export can drop anything not currently `issued`.
 */
export type CisStatementForCsv = {
  statement_number: string;
  status: "issued" | "superseded" | "withdrawn";
  tax_month_start: string;
  tax_month_end: string;
  statement_due_on: string;
  contractor_name: string;
  contractor_paye_reference: string;
  subcontractor_name: string;
  subcontractor_utr_masked: string | null;
  verification_number: string | null;
  verification_number_required: boolean;
  rate_is_uniform: boolean;
  deduction_rate: number | string | null;
  gross_amount: number | string;
  materials_amount: number | string;
  deduction_amount: number | string;
  payment_count: number;
  is_statutory: boolean;
  issued_on: string;
};

export const CIS_STATEMENT_CSV_COLUMNS: ReadonlyArray<{
  header: string;
  cell: (s: CisStatementForCsv) => string;
}> = [
  { header: "statement_number", cell: (s) => s.statement_number },
  { header: "issued_on", cell: (s) => s.issued_on },
  { header: "tax_month_start", cell: (s) => s.tax_month_start },
  { header: "tax_month_end", cell: (s) => s.tax_month_end },
  { header: "statement_due_on", cell: (s) => s.statement_due_on },
  { header: "contractor_name", cell: (s) => s.contractor_name },
  { header: "contractor_paye_reference", cell: (s) => s.contractor_paye_reference },
  { header: "subcontractor_name", cell: (s) => s.subcontractor_name },
  { header: "subcontractor_utr_masked", cell: (s) => s.subcontractor_utr_masked ?? "" },
  { header: "verification_number", cell: (s) => s.verification_number ?? "" },
  {
    header: "verification_number_required",
    cell: (s) => (s.verification_number_required ? "yes" : "no"),
  },
  { header: "deduction_rate", cell: (s) => rateCell(s.rate_is_uniform, s.deduction_rate) },
  { header: "gross_ex_vat", cell: (s) => money(s.gross_amount) },
  { header: "materials", cell: (s) => money(s.materials_amount) },
  { header: "deduction", cell: (s) => money(s.deduction_amount) },
  { header: "payment_count", cell: (s) => String(s.payment_count) },
  { header: "is_statutory", cell: (s) => (s.is_statutory ? "yes" : "no") },
];

export type CisStatementsCsvResult = { csv: string; rowCount: number; truncated: boolean };

/**
 * Serialise the CURRENT (issued) deduction statements of one tax month to CSV.
 *
 * TERMINAL EXCLUSION: `superseded` and `withdrawn` statements are dropped. Those
 * documents were replaced or retracted; a working spreadsheet of "the statements
 * that stand" must not list them, exactly as the return export takes the frozen
 * prepared figures and not the drafts. The excluded count is returned so the
 * caller can surface it rather than silently omitting rows.
 */
export function buildCisStatementsCsv(input: {
  statements: readonly CisStatementForCsv[];
}): CisStatementsCsvResult & { excludedNonIssued: number } {
  const issued = input.statements.filter((s) => s.status === "issued");
  const excludedNonIssued = input.statements.length - issued.length;

  const header = CIS_STATEMENT_CSV_COLUMNS.map((c) => csvEscape(c.header)).join(",");
  const { rows, truncated } = capCisRows(issued);
  const body = rows.map((s) => CIS_STATEMENT_CSV_COLUMNS.map((c) => csvEscape(c.cell(s))).join(","));

  return {
    csv: [header, ...body].join(CRLF),
    rowCount: rows.length,
    truncated,
    excludedNonIssued,
  };
}
