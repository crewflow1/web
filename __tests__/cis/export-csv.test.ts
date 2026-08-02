import { describe, expect, it } from "vitest";

import {
  buildCisReturnCsv,
  buildCisStatementsCsv,
  capCisRows,
  CIS_EXPORT_MAX_ROWS,
  CIS_RETURN_CSV_COLUMNS,
  CIS_STATEMENT_CSV_COLUMNS,
  type CisReturnForCsv,
  type CisReturnLineForCsv,
  type CisStatementForCsv,
} from "@/lib/cis/export-csv";

/**
 * H2-CIS M5 — the CIS300 / deduction-statement CSV export builders.
 *
 * These are the properties that make the file trustworthy to file from: it is
 * deterministic, it reports the FROZEN figures without re-deriving them, it
 * excludes anything not current (superseded / withdrawn statements), it never
 * truncates silently, and it never emits a full UTR.
 */

function retLine(over: Partial<CisReturnLineForCsv> = {}): CisReturnLineForCsv {
  return {
    subcontractor_name: "Groundworks Ltd",
    subcontractor_utr_masked: "••••••7890",
    verification_number: null,
    verification_number_required: false,
    rate_is_uniform: true,
    deduction_rate: 20,
    cis_status: "standard_20",
    gross_amount: 1000,
    materials_amount: 200,
    deduction_amount: 160,
    payment_count: 1,
    ...over,
  };
}

function ret(over: Partial<CisReturnForCsv> = {}): CisReturnForCsv {
  return {
    tax_month_start: "2026-07-06",
    tax_month_end: "2026-08-05",
    return_due_on: "2026-08-19",
    contractor_name: "D J Smith Ltd",
    contractor_paye_reference: "123/AB45678",
    accounts_office_reference: "123PX00123456",
    is_nil: false,
    subcontractor_count: 1,
    payment_count: 1,
    total_gross: 1000,
    total_materials: 200,
    total_deduction: 160,
    status: "prepared",
    ...over,
  };
}

function stmt(over: Partial<CisStatementForCsv> = {}): CisStatementForCsv {
  return {
    statement_number: "CIS-2026-0001",
    status: "issued",
    tax_month_start: "2026-07-06",
    tax_month_end: "2026-08-05",
    statement_due_on: "2026-08-19",
    contractor_name: "D J Smith Ltd",
    contractor_paye_reference: "123/AB45678",
    subcontractor_name: "Groundworks Ltd",
    subcontractor_utr_masked: "••••••7890",
    verification_number: null,
    verification_number_required: false,
    rate_is_uniform: true,
    deduction_rate: 20,
    gross_amount: 1000,
    materials_amount: 200,
    deduction_amount: 160,
    payment_count: 1,
    is_statutory: true,
    issued_on: "2026-08-07",
    ...over,
  };
}

const rows = (csv: string) => csv.split("\r\n");

// ---------------------------------------------------------------------------
// The CIS300 monthly return CSV
// ---------------------------------------------------------------------------

describe("buildCisReturnCsv", () => {
  it("emits the header from the column definition, then one row per subcontractor", () => {
    const out = buildCisReturnCsv({
      ret: ret({ subcontractor_count: 2, payment_count: 2, total_gross: 1400, total_materials: 200, total_deduction: 240 }),
      lines: [
        retLine({ subcontractor_name: "Groundworks Ltd" }),
        retLine({ subcontractor_name: "Roofing Ltd", gross_amount: 400, materials_amount: 0, deduction_amount: 80 }),
      ],
    });
    const lines = rows(out.csv);
    expect(lines[0]).toBe(CIS_RETURN_CSV_COLUMNS.map((c) => c.header).join(","));
    expect(lines).toHaveLength(3); // header + 2 subcontractors
    expect(out.rowCount).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("uses CRLF line endings (RFC 4180)", () => {
    const out = buildCisReturnCsv({ ret: ret(), lines: [retLine()] });
    expect(out.csv).toContain("\r\n");
    expect(out.csv.split("\r\n")).toHaveLength(2);
  });

  it("formats frozen money to 2dp without re-deriving it", () => {
    const out = buildCisReturnCsv({
      ret: ret(),
      // Deliberately a string, as PostgREST returns numeric, and awkward pennies.
      lines: [retLine({ gross_amount: "1234.5", materials_amount: "0", deduction_amount: "246.9" })],
    });
    const body = rows(out.csv)[1]!.split(",");
    const grossIdx = CIS_RETURN_CSV_COLUMNS.findIndex((c) => c.header === "gross_ex_vat");
    const dedIdx = CIS_RETURN_CSV_COLUMNS.findIndex((c) => c.header === "deduction");
    expect(body[grossIdx]).toBe("1234.50");
    expect(body[dedIdx]).toBe("246.90");
  });

  it("states a varied rate honestly rather than picking a number", () => {
    const out = buildCisReturnCsv({
      ret: ret(),
      lines: [retLine({ rate_is_uniform: false, deduction_rate: null })],
    });
    const rateIdx = CIS_RETURN_CSV_COLUMNS.findIndex((c) => c.header === "deduction_rate");
    expect(rows(out.csv)[1]!.split(",")[rateIdx]).toBe("varied");
  });

  it("models a NIL return as a header plus one explicit nil row, never an empty file", () => {
    const out = buildCisReturnCsv({
      ret: ret({ is_nil: true, subcontractor_count: 0, payment_count: 0, total_gross: 0, total_materials: 0, total_deduction: 0 }),
      lines: [],
    });
    const lines = rows(out.csv);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/NIL RETURN/);
    expect(out.rowCount).toBe(0);
  });

  it("escapes a comma in a subcontractor name (RFC 4180 quoting)", () => {
    const out = buildCisReturnCsv({
      ret: ret(),
      lines: [retLine({ subcontractor_name: "Smith, Jones & Co" })],
    });
    expect(out.csv).toContain('"Smith, Jones & Co"');
  });

  it("never emits an unmasked UTR — only the masked value it was given", () => {
    const out = buildCisReturnCsv({
      ret: ret(),
      lines: [retLine({ subcontractor_utr_masked: "••••••7890" })],
    });
    // No 10-digit UTR anywhere in the file.
    expect(out.csv).not.toMatch(/\b\d{10}\b/);
    expect(out.csv).toContain("••••••7890");
  });

  it("is deterministic — identical input yields byte-identical output", () => {
    const input = { ret: ret(), lines: [retLine(), retLine({ subcontractor_name: "B" })] };
    expect(buildCisReturnCsv(input).csv).toBe(buildCisReturnCsv(input).csv);
  });

  it("truncates LOUDLY at the cap, never silently", () => {
    const many = Array.from({ length: CIS_EXPORT_MAX_ROWS + 5 }, (_, i) =>
      retLine({ subcontractor_name: `Sub ${i}` }),
    );
    const out = buildCisReturnCsv({ ret: ret({ is_nil: false }), lines: many });
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(CIS_EXPORT_MAX_ROWS);
    expect(rows(out.csv)).toHaveLength(CIS_EXPORT_MAX_ROWS + 1); // + header
  });
});

// ---------------------------------------------------------------------------
// The deduction-statement CSV
// ---------------------------------------------------------------------------

describe("buildCisStatementsCsv", () => {
  it("emits one row per ISSUED statement", () => {
    const out = buildCisStatementsCsv({
      statements: [stmt({ statement_number: "CIS-2026-0001" }), stmt({ statement_number: "CIS-2026-0002" })],
    });
    const lines = rows(out.csv);
    expect(lines[0]).toBe(CIS_STATEMENT_CSV_COLUMNS.map((c) => c.header).join(","));
    expect(out.rowCount).toBe(2);
  });

  it("EXCLUDES superseded and withdrawn statements, and reports how many", () => {
    const out = buildCisStatementsCsv({
      statements: [
        stmt({ statement_number: "CIS-1", status: "issued" }),
        stmt({ statement_number: "CIS-2", status: "superseded" }),
        stmt({ statement_number: "CIS-3", status: "withdrawn" }),
      ],
    });
    expect(out.rowCount).toBe(1);
    expect(out.excludedNonIssued).toBe(2);
    expect(out.csv).toContain("CIS-1");
    expect(out.csv).not.toContain("CIS-2");
    expect(out.csv).not.toContain("CIS-3");
  });

  it("never emits an unmasked UTR", () => {
    const out = buildCisStatementsCsv({ statements: [stmt({ subcontractor_utr_masked: "••••••7890" })] });
    expect(out.csv).not.toMatch(/\b\d{10}\b/);
  });

  it("leaves a required-but-absent verification number blank, never fabricated", () => {
    const out = buildCisStatementsCsv({
      statements: [stmt({ verification_number_required: true, verification_number: null })],
    });
    const verIdx = CIS_STATEMENT_CSV_COLUMNS.findIndex((c) => c.header === "verification_number");
    const reqIdx = CIS_STATEMENT_CSV_COLUMNS.findIndex((c) => c.header === "verification_number_required");
    const body = rows(out.csv)[1]!.split(",");
    expect(body[verIdx]).toBe("");
    expect(body[reqIdx]).toBe("yes");
  });

  it("is deterministic", () => {
    const input = { statements: [stmt(), stmt({ statement_number: "CIS-2026-0002" })] };
    expect(buildCisStatementsCsv(input).csv).toBe(buildCisStatementsCsv(input).csv);
  });
});

describe("capCisRows", () => {
  it("reports truncation only when the cap is exceeded", () => {
    expect(capCisRows([1, 2, 3], 5)).toEqual({ rows: [1, 2, 3], truncated: false });
    expect(capCisRows([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true });
  });
});
