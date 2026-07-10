import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { csvEscape } from "@/lib/csv";

/**
 * The ONE authoritative CSV field escaper (`lib/csv.ts`).
 *
 * Before this seam existed, `csvEscape` was copy-pasted byte-for-byte into
 * three export surfaces (invoices export, finances export, HQ analytics).
 * This suite pins BOTH halves of the consolidation:
 *
 *   • BEHAVIOUR — the RFC 4180-style quoting contract the exports depend on:
 *     null/undefined serialise to an empty field, plain values pass through,
 *     and a field is quoted (with any embedded quote doubled) exactly when
 *     it contains a comma, a newline, or a double quote.
 *   • ONE OWNER — the three former duplicators now import the shared helper
 *     and no longer carry their own copy, so there is a single place to
 *     reason about CSV quoting.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("csvEscape — the CSV quoting contract", () => {
  it("serialises null and undefined to an empty field", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("passes plain values through unquoted", () => {
    expect(csvEscape("hello")).toBe("hello");
    expect(csvEscape("")).toBe("");
    expect(csvEscape("2026-07-10")).toBe("2026-07-10");
    expect(csvEscape("a b c")).toBe("a b c");
  });

  it("stringifies non-string primitives via String()", () => {
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(0)).toBe("0");
    expect(csvEscape(12.5)).toBe("12.5");
    expect(csvEscape(true)).toBe("true");
    expect(csvEscape(false)).toBe("false");
  });

  it("quotes a field containing a comma", () => {
    expect(csvEscape("Smith, John")).toBe('"Smith, John"');
  });

  it("quotes a field containing a newline", () => {
    expect(csvEscape("line one\nline two")).toBe('"line one\nline two"');
  });

  it("quotes a field containing a double quote and doubles the quote", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("handles the combined case — comma AND embedded quotes", () => {
    expect(csvEscape('a,"b"')).toBe('"a,""b"""');
  });

  it("does not quote values with only benign punctuation", () => {
    expect(csvEscape("a;b|c.d")).toBe("a;b|c.d");
  });
});

describe("csv consolidation — one authoritative owner (source-pinned)", () => {
  it("lib/csv.ts is the sole definition and exports csvEscape", () => {
    const code = read("lib/csv.ts");
    expect(code).toMatch(/export function csvEscape/);
  });

  for (const file of [
    "app/api/invoices/export/route.ts",
    "app/api/finances/export/route.ts",
    "lib/hq/analytics.ts",
  ]) {
    it(`${file} imports the shared escaper and defines no local copy`, () => {
      const code = read(file);
      expect(code).toMatch(/import \{ csvEscape \} from "@\/lib\/csv"/);
      expect(code).not.toMatch(/function csvEscape/);
    });
  }
});
