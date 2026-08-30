import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Drift guard: every hit `type` the backend (app/api/search/route.ts) can emit
 * MUST have an entry in BOTH TYPE_LABELS and TYPE_ICONS in the palette
 * (app/(app)/_components/search-palette.tsx). Without this, a newly-added
 * backend hit type renders a blank icon + blank type label in the Cmd/K palette
 * — exactly the S3 defect this test exists to prevent recurring.
 *
 * Source-text parsing (rather than importing the client component) keeps this
 * decoupled from React/"use client" module resolution and asserts against what
 * actually ships.
 */

const ROOT = resolve(__dirname, "..", "..");
const ROUTE = readFileSync(
  resolve(ROOT, "app/api/search/route.ts"),
  "utf8",
);
const PALETTE = readFileSync(
  resolve(ROOT, "app/(app)/_components/search-palette.tsx"),
  "utf8",
);

/** Every `type: "..."` literal actually pushed onto the hits array in the
 * route — including the two-armed ternary form (`type: cond ? "a" : "b"`,
 * used for the asset/vehicle split). */
function backendEmittedTypes(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\btype:\s*"([a-z_]+)"/g)) {
    out.add(m[1]!);
  }
  for (const m of src.matchAll(
    /\btype:\s*\w+\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/g,
  )) {
    out.add(m[1]!);
    out.add(m[2]!);
  }
  return [...out].sort();
}

/** Keys declared inside a `const NAME: ... = { ... };` object literal. */
function objectKeys(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name}`);
  expect(start, `${name} declaration present`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", start);
  const close = src.indexOf("};", open);
  const body = src.slice(open + 1, close);
  const out = new Set<string>();
  for (const m of body.matchAll(/(\w+):/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

describe("search palette type coverage (drift guard)", () => {
  const emitted = backendEmittedTypes(ROUTE);
  const labels = objectKeys(PALETTE, "TYPE_LABELS");
  const icons = objectKeys(PALETTE, "TYPE_ICONS");

  it("the backend emits the full known set of hit types", () => {
    // Sanity anchor so the parser can't silently match nothing.
    expect(emitted).toEqual(
      [
        "customer",
        "invoice",
        "job",
        "job_document",
        "lead",
        "permit",
        "purchase_order",
        "quote",
        "risk_assessment",
        "site_report",
        "snag",
        "staff",
        // "everything searchable" completion families
        "supplier",
        "finance",
        "blueprint",
        "asset",
        "vehicle",
        "toolbox_talk",
        "diary_entry",
        "support_ticket",
        "staff_qualification",
        "attachment",
      ].sort(),
    );
  });

  it("every backend hit type has a TYPE_LABELS entry", () => {
    const missing = emitted.filter((t) => !labels.includes(t));
    expect(missing, `missing TYPE_LABELS entries: ${missing.join(", ")}`).toEqual([]);
  });

  it("every backend hit type has a TYPE_ICONS entry", () => {
    const missing = emitted.filter((t) => !icons.includes(t));
    expect(missing, `missing TYPE_ICONS entries: ${missing.join(", ")}`).toEqual([]);
  });

  it("TYPE_LABELS and TYPE_ICONS cover exactly the same keys", () => {
    expect(labels).toEqual(icons);
  });
});
