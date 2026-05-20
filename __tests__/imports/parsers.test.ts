import { describe, it, expect } from "vitest";
import {
  parseCsvFile,
  totalRowCount,
  rowToRecord,
} from "@/lib/imports/parsers";

describe("parseCsvFile", () => {
  it("parses a simple header + rows file", () => {
    const csv = `Name,Email,Phone
Acme Builders,info@acme.test,07700900111
Smith & Sons,smith@example.test,07700900222`;
    const sheet = parseCsvFile(csv);
    expect(sheet.header).toEqual(["Name", "Email", "Phone"]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toEqual(["Acme Builders", "info@acme.test", "07700900111"]);
    expect(sheet.rows[1]![1]).toBe("smith@example.test");
  });

  it("respects RFC4180-ish quoting (commas inside quoted cells)", () => {
    const csv = `Name,Address
"Smith, John","12 High Street, London"`;
    const sheet = parseCsvFile(csv);
    expect(sheet.rows[0]).toEqual(["Smith, John", "12 High Street, London"]);
  });

  it("handles \\r\\n line endings (Windows exports)", () => {
    const csv = "A,B\r\n1,2\r\n3,4\r\n";
    const sheet = parseCsvFile(csv);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toEqual(["1", "2"]);
  });

  it("skips entirely empty rows", () => {
    const csv = `A,B
1,2

3,4`;
    const sheet = parseCsvFile(csv);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows.map((r) => r[0])).toEqual(["1", "3"]);
  });

  it("returns null cells for empty strings", () => {
    const csv = `A,B,C
1,,3`;
    const sheet = parseCsvFile(csv);
    expect(sheet.rows[0]).toEqual(["1", null, "3"]);
  });

  it("normalises row width to header length (pads missing trailing cells)", () => {
    const csv = `A,B,C
just-one,two`;
    const sheet = parseCsvFile(csv);
    expect(sheet.rows[0]).toEqual(["just-one", "two", null]);
  });

  it("totalRowCount sums rows across sheets", () => {
    const a = parseCsvFile("A\n1\n2");
    const b = parseCsvFile("X\nfoo\nbar\nbaz");
    expect(totalRowCount([a, b])).toBe(5);
  });

  it("rowToRecord maps cells to header-keyed object", () => {
    const sheet = parseCsvFile("name,email\nJane,j@x.test");
    const rec = rowToRecord(sheet, sheet.rows[0]!);
    expect(rec).toEqual({ name: "Jane", email: "j@x.test" });
  });

  it("returns empty header + rows for empty input", () => {
    const sheet = parseCsvFile("");
    expect(sheet.header).toEqual([]);
    expect(sheet.rows).toEqual([]);
  });
});
