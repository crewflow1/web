import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  UNSORTED,
  cycleSort,
  normaliseSortValue,
  sortRows,
  filterRows,
  toggleSelected,
  toggleAllSelected,
  allSelected,
  groupRows,
  toCsv,
} from "@/components/ui/data-table-core";

/**
 * DataTable (roadmap G3) — two halves:
 *
 *   1. The PURE core (components/ui/data-table-core.ts): sorting, loaded-page
 *      filtering, selection reducers, grouping, CSV serialisation. Exercised
 *      directly — no DOM, fast unit tier.
 *   2. A SOURCE contract: the four canonical list pages actually adopt
 *      DataTable (an advanced table nothing renders is debt, exactly like the
 *      recovered primitives design-system-adoption.test.ts pins), the module
 *      is a client component, and — like Modal — it stays OUT of the server
 *      barrel so it cannot drag a client boundary into every consumer of
 *      "@/components/ui".
 */

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ── Sorting ─────────────────────────────────────────────────────────────────

describe("cycleSort — click cycles asc → desc → natural order", () => {
  it("cycles a single column through the three states", () => {
    const s1 = cycleSort(UNSORTED, "total");
    expect(s1).toEqual({ key: "total", dir: "asc" });
    const s2 = cycleSort(s1, "total");
    expect(s2).toEqual({ key: "total", dir: "desc" });
    const s3 = cycleSort(s2, "total");
    expect(s3).toEqual({ key: null, dir: null });
  });

  it("switching column always restarts at asc, whatever the previous state", () => {
    expect(cycleSort({ key: "total", dir: "desc" }, "due")).toEqual({
      key: "due",
      dir: "asc",
    });
  });
});

describe("normaliseSortValue", () => {
  it("treats null/undefined/empty as missing under every type", () => {
    for (const type of ["text", "number", "date"] as const) {
      expect(normaliseSortValue(null, type)).toBeNull();
      expect(normaliseSortValue(undefined, type)).toBeNull();
      expect(normaliseSortValue("", type)).toBeNull();
    }
  });

  it("parses numbers and rejects the unparseable", () => {
    expect(normaliseSortValue("12.5", "number")).toBe(12.5);
    expect(normaliseSortValue(0, "number")).toBe(0);
    expect(normaliseSortValue("not a number", "number")).toBeNull();
  });

  it("parses ISO dates to a comparable timestamp", () => {
    const a = normaliseSortValue("2026-01-02", "date") as number;
    const b = normaliseSortValue("2026-02-01", "date") as number;
    expect(a).toBeLessThan(b);
    expect(normaliseSortValue("no date", "date")).toBeNull();
  });

  it("lowercases text so sorting is case-insensitive", () => {
    expect(normaliseSortValue("INV-001", "text")).toBe("inv-001");
  });
});

describe("sortRows", () => {
  type R = { id: string; v: string | number | null };
  const byV = (r: R) => r.v;

  it("sorts numbers asc and desc", () => {
    const rows: R[] = [
      { id: "a", v: 300 },
      { id: "b", v: 100 },
      { id: "c", v: 200 },
    ];
    expect(sortRows(rows, byV, "asc", "number").map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(sortRows(rows, byV, "desc", "number").map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts dates by parsed time, not string luck", () => {
    const rows: R[] = [
      { id: "a", v: "2026-02-01" },
      { id: "b", v: "2025-12-31" },
    ];
    expect(sortRows(rows, byV, "asc", "date").map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("pins missing values LAST in BOTH directions (a missing due date never floats up)", () => {
    const rows: R[] = [
      { id: "none", v: null },
      { id: "late", v: "2026-03-01" },
      { id: "early", v: "2026-01-01" },
    ];
    expect(sortRows(rows, byV, "asc", "date").map((r) => r.id)).toEqual(["early", "late", "none"]);
    expect(sortRows(rows, byV, "desc", "date").map((r) => r.id)).toEqual(["late", "early", "none"]);
  });

  it("is stable: equal values keep the server's order", () => {
    const rows: R[] = [
      { id: "first", v: "paid" },
      { id: "second", v: "paid" },
      { id: "third", v: "draft" },
    ];
    expect(sortRows(rows, byV, "asc", "text").map((r) => r.id)).toEqual([
      "third",
      "first",
      "second",
    ]);
    // …and does not mutate the input.
    expect(rows[0]?.id).toBe("first");
  });
});

// ── Filtering (loaded page only — server pagination stays authoritative) ────

describe("filterRows", () => {
  type R = { id: string; text: string };
  const rows: R[] = [
    { id: "1", text: "INV-001 paid 2026-01-02" },
    { id: "2", text: "INV-002 overdue 2026-02-02" },
    { id: "3", text: "INV-010 draft" },
  ];
  const byText = (r: R) => r.text;

  it("an empty or whitespace query keeps every loaded row", () => {
    expect(filterRows(rows, byText, "")).toHaveLength(3);
    expect(filterRows(rows, byText, "   ")).toHaveLength(3);
  });

  it("matches case-insensitively", () => {
    expect(filterRows(rows, byText, "inv-002").map((r) => r.id)).toEqual(["2"]);
    expect(filterRows(rows, byText, "OVERDUE").map((r) => r.id)).toEqual(["2"]);
  });

  it("requires every whitespace-separated term to match", () => {
    expect(filterRows(rows, byText, "inv paid").map((r) => r.id)).toEqual(["1"]);
    expect(filterRows(rows, byText, "inv nothere")).toHaveLength(0);
  });
});

// ── Selection reducers ──────────────────────────────────────────────────────

describe("selection reducers", () => {
  it("toggleSelected adds then removes, without mutating", () => {
    const s0: string[] = [];
    const s1 = toggleSelected(s0, "a");
    const s2 = toggleSelected(s1, "b");
    const s3 = toggleSelected(s2, "a");
    expect(s1).toEqual(["a"]);
    expect(s2).toEqual(["a", "b"]);
    expect(s3).toEqual(["b"]);
    expect(s0).toEqual([]);
  });

  it("toggleAllSelected selects all visible when any are unselected", () => {
    expect(toggleAllSelected(["a"], ["a", "b", "c"]).sort()).toEqual(["a", "b", "c"]);
  });

  it("toggleAllSelected deselects the visible set when all are selected — but PRESERVES selections a filter is hiding", () => {
    // "hidden" is selected but not currently visible (filtered out): the
    // header checkbox must not silently throw that selection away.
    expect(toggleAllSelected(["a", "b", "hidden"], ["a", "b"])).toEqual(["hidden"]);
  });

  it("allSelected is false for an empty visible set (a header checkbox on no rows is never checked)", () => {
    expect(allSelected(["a"], [])).toBe(false);
    expect(allSelected(["a", "b"], ["a", "b"])).toBe(true);
    expect(allSelected(["a"], ["a", "b"])).toBe(false);
  });
});

// ── Grouping ────────────────────────────────────────────────────────────────

describe("groupRows", () => {
  it("buckets by label in first-appearance order, keeping in-bucket order", () => {
    const rows = [
      { id: "1", g: "paid" },
      { id: "2", g: "draft" },
      { id: "3", g: "paid" },
    ];
    const groups = groupRows(rows, (r) => r.g);
    expect(groups.map((g) => g.label)).toEqual(["paid", "draft"]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["1", "3"]);
    expect(groups[1]?.rows.map((r) => r.id)).toEqual(["2"]);
  });
});

// ── CSV (via the ONE authoritative escaper in lib/csv) ─────────────────────

describe("toCsv — bulk 'Export selected as CSV'", () => {
  it("joins with commas and CRLF, header first", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2");
  });

  it("quotes fields containing commas and doubles embedded quotes (lib/csv rules)", () => {
    expect(toCsv(["name"], [['Bloggs, Joe "JB"']])).toBe('name\r\n"Bloggs, Joe ""JB"""');
  });

  it("neutralises formula injection but keeps negative amounts numeric", () => {
    const out = toCsv(["v"], [["=HYPERLINK(1)"], ["-100.50"]]);
    const lines = out.split("\r\n");
    expect(lines[1]).toBe("'=HYPERLINK(1)");
    // A negative money amount MUST survive as a number, not be apostrophised.
    expect(lines[2]).toBe("-100.50");
  });

  it("serialises null as an empty field", () => {
    expect(toCsv(["a", "b"], [[null, "x"]])).toBe("a,b\r\n,x");
  });
});

// ── Source contract — the four canonical list pages ADOPT DataTable ────────

const ADOPTING_PAGES = [
  "app/(app)/invoices/page.tsx",
  "app/(app)/customers/page.tsx",
  "app/(app)/suppliers/page.tsx",
  "app/(app)/staff/page.tsx",
] as const;

describe("adoption + module contract", () => {
  for (const page of ADOPTING_PAGES) {
    it(`${page} imports DataTable from its own module`, () => {
      expect(read(page)).toMatch(
        /import\s*\{[^}]*\bDataTable\b[^}]*\}\s*from\s*["']@\/components\/ui\/data-table["']/,
      );
    });

    it(`${page} no longer hand-rolls its list table`, () => {
      // Comment lines stripped: prose may legitimately mention the old idiom.
      const code = read(page)
        .split("\n")
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");
      expect(code, `${page} still spells table chrome by hand`).not.toMatch(
        /<(?:table|thead|tbody)\s+className=/,
      );
    });
  }

  it("data-table.tsx is a client component (it owns real interaction state)", () => {
    expect(read("components/ui/data-table.tsx")).toMatch(/^"use client";/);
  });

  it("data-table-core.ts stays PURE — no React, no client boundary, csvEscape from lib/csv", () => {
    const src = read("components/ui/data-table-core.ts");
    expect(src).not.toContain('"use client"');
    expect(src).not.toMatch(/from ["']react["']/);
    expect(src).toMatch(/from "@\/lib\/csv"/);
    // The one authoritative escaper — never a fourth copy of csvEscape.
    expect(src).not.toMatch(/function csvEscape/);
  });

  it("DataTable stays OUT of the server barrel, exactly like Modal", () => {
    // The barrel is imported by server pages; re-exporting a client module
    // from it drags the client boundary into every consumer (measured on
    // Modal — see design-system-adoption.test.ts).
    const barrel = read("components/ui/index.ts")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");
    expect(barrel).not.toMatch(/from\s*["']\.\/data-table["']/);
    expect(barrel).not.toMatch(/\bDataTable\b/);
  });

  it("invoices is the ONLY adopting page with a bulk action, and it is the CSV export (non-destructive)", () => {
    const invoices = read("app/(app)/invoices/page.tsx");
    expect(invoices).toMatch(/csvExport=\{\{/);
    for (const page of ADOPTING_PAGES.filter((p) => !p.includes("invoices"))) {
      expect(read(page), `${page} must not pass a bulk action`).not.toMatch(
        /csvExport=|bulkActions=/,
      );
    }
    // No page passes a function-valued bulkActions slot — these are server
    // components, and a function cannot cross the RSC boundary.
    for (const page of ADOPTING_PAGES) {
      expect(read(page)).not.toMatch(/bulkActions=/);
    }
  });
});
