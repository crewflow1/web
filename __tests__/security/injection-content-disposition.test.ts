import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { asciiFilename, contentDisposition } from "@/lib/http/content-disposition";

/**
 * INJ-06 — response-header injection via a data-derived download filename.
 *
 * `filename="${invoice.number}.pdf"` put DATA (an imported invoice number, a
 * staff member's name, a document reference) straight into a header value. The
 * runtime refuses CR/LF (so no header splitting) but it ALSO refuses any code
 * point above U+00FF — so the payslip for "Łukasz" or the PDF of an invoice
 * numbered "INV–001" (en dash) was a hard 500. And a `"` let the data close the
 * quoted parameter and append its own.
 *
 * These pin the builder's contract and that no route interpolates data into a
 * Content-Disposition by hand again.
 */

const HOSTILE = [
  "Łukasz Kowalski",
  "INV–001", // en dash
  "请款单-2026",
  "José García",
  'A"; filename="x.exe',
  "INV-1\r\nX-Injected: 1",
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "a\u0000b",
  "",
  "   ",
  "💷 invoice",
];

describe("contentDisposition", () => {
  it("always yields a value the runtime's Headers accepts (never a 500)", () => {
    for (const name of HOSTILE) {
      const value = contentDisposition("inline", `${name}.pdf`, "invoice");
      expect(() => new Response("x", { headers: { "Content-Disposition": value } }), name).not.toThrow();
      // Pure printable ASCII — no control chars, nothing above 0x7E.
      expect(/^[\x20-\x7E]+$/.test(value), value).toBe(true);
    }
  });

  it("the quoted fallback can never be terminated or split by the data", () => {
    for (const name of HOSTILE) {
      const value = contentDisposition("attachment", `${name}.pdf`, "invoice");
      const m = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([^;"\s]+)$/.exec(value);
      expect(m, value).not.toBeNull();
      expect(m![1]).toMatch(/^[A-Za-z0-9._-]+\.pdf$/);
      // exactly one filename= and one filename*= parameter
      expect(value.match(/filename="/g)?.length).toBe(1);
      expect(value.match(/filename\*=/g)?.length).toBe(1);
      expect(m![1]).not.toContain("..");
    }
  });

  it("folds accents rather than dropping the name, and keeps the real name in filename*", () => {
    expect(asciiFilename("José García.pdf")).toBe("Jose_Garcia.pdf");
    const v = contentDisposition("inline", "payslip-Łukasz_Kowalski-2026-11-01.pdf", "payslip");
    // Ł has no NFKD decomposition, so the ASCII fallback substitutes it; the
    // exact name still travels in filename* for every modern browser.
    expect(v).toContain(`filename="payslip-_ukasz_Kowalski-2026-11-01.pdf"`);
    expect(decodeURIComponent(v.split("filename*=UTF-8''")[1]!)).toBe("payslip-Łukasz_Kowalski-2026-11-01.pdf");
  });

  it("leaves an ordinary document number untouched", () => {
    expect(contentDisposition("inline", "INV-2026-0042.pdf")).toBe(
      `inline; filename="INV-2026-0042.pdf"; filename*=UTF-8''INV-2026-0042.pdf`,
    );
  });

  it("falls back to a stem when nothing printable remains", () => {
    expect(contentDisposition("inline", "请款单.pdf", "invoice")).toMatch(/^inline; filename="invoice\.pdf"; /);
    expect(contentDisposition("inline", "", "invoice")).toMatch(/^inline; filename="invoice"; /);
  });
});

describe("no route hand-interpolates DATA into Content-Disposition", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/route\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(join(ROOT, "app"));

  // A hand-built value is acceptable ONLY when every interpolation is a value
  // the server computed from a closed vocabulary (date stamps, enum-validated
  // format/cycle keys) or already passed through a filename sanitiser.
  const SAFE_INTERPOLATION =
    /^\$\{(stamp|stem|month|qStart|format|run\.cycle|run\.period_start|ret\.tax_month_end|bulkZipFilename\(\)|safeReportFilename\([^}]*\)|safeLabelFilename\([^}]*\)|musterFilename\([^}]*\))\}$/;

  it("scans every route handler", () => {
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n")) {
        if (!/content-disposition/i.test(line) || !line.includes("${")) continue;
        if (line.includes("contentDisposition(")) continue;
        const interpolations = line.match(/\$\{[^}]*\}/g) ?? [];
        if (!interpolations.every((i) => SAFE_INTERPOLATION.test(i))) {
          offenders.push(`${f.replace(ROOT + "/", "")}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
