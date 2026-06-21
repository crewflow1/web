import { describe, it, expect } from "vitest";
import {
  ALL_CATEGORIES,
  DEFAULT_CATEGORIES,
  type Category,
} from "@/lib/events/categories";
import {
  encodeCategories,
  decodeCategories,
  categoryConstraint,
  decodeFilters,
  filtersAreDirty,
  DEFAULT_CATEGORY_SET,
} from "@/app/admin/pulse/_url";

/**
 * Unit proof for the Pulse URL ↔ filter-state codec (Module 1, PR5 / CEO
 * Directive #005). ONE codec serves both the server page (SSR initial fetch) and
 * the client feed (replaceState), so a shared `?cat=&sev=&act=&q=` deep link must
 * reconstruct IDENTICALLY on both sides. These tests pin that round-trip and the
 * three category sentinels — default (omit), "all", "none" — plus the
 * constraint the reader actually applies and the "is this view dirty" predicate.
 */

const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();

describe("pulse url — encodeCategories (the param the URL carries)", () => {
  it("omits the param (null) when the selection equals the default view", () => {
    expect(encodeCategories(DEFAULT_CATEGORY_SET)).toBeNull();
    expect(encodeCategories(new Set(DEFAULT_CATEGORIES))).toBeNull();
  });

  it("uses the `none` / `all` sentinels for the empty and full sets", () => {
    expect(encodeCategories(new Set())).toBe("none");
    expect(encodeCategories(new Set(ALL_CATEGORIES))).toBe("all");
  });

  it("emits a csv in canonical chip order for a real subset", () => {
    // Input order is irrelevant — output follows ALL_CATEGORIES (sales before finance).
    expect(encodeCategories(new Set<Category>(["finance", "sales"]))).toBe("sales,finance");
  });
});

describe("pulse url — decodeCategories (the inverse)", () => {
  it("an absent/empty param decodes to the default (everything except System)", () => {
    expect(sorted(decodeCategories(undefined))).toEqual(sorted(new Set(DEFAULT_CATEGORIES)));
    expect(sorted(decodeCategories(""))).toEqual(sorted(new Set(DEFAULT_CATEGORIES)));
  });

  it("honours the `all` / `none` sentinels", () => {
    expect(sorted(decodeCategories("all"))).toEqual(sorted(new Set(ALL_CATEGORIES)));
    expect(decodeCategories("none").size).toBe(0);
  });

  it("parses a csv, dropping unknown ids, and falls back to default if nothing valid remains", () => {
    expect(sorted(decodeCategories("sales,finance"))).toEqual(["finance", "sales"]);
    expect(sorted(decodeCategories("sales,not-a-cat"))).toEqual(["sales"]);
    expect(sorted(decodeCategories("garbage"))).toEqual(sorted(new Set(DEFAULT_CATEGORIES)));
  });
});

describe("pulse url — encode/decode is a faithful round trip", () => {
  const cases: { name: string; set: Set<Category> }[] = [
    { name: "default", set: new Set(DEFAULT_CATEGORIES) },
    { name: "all", set: new Set(ALL_CATEGORIES) },
    { name: "none", set: new Set<Category>() },
    { name: "subset", set: new Set<Category>(["sales", "ai", "system"]) },
  ];
  for (const { name, set } of cases) {
    it(`survives a round trip for the ${name} selection`, () => {
      const encoded = encodeCategories(set); // string | null (null = omitted)
      const decoded = decodeCategories(encoded ?? undefined);
      expect(sorted(decoded)).toEqual(sorted(set));
    });
  }
});

describe("pulse url — categoryConstraint (what the reader applies)", () => {
  it('maps empty → "none" (render an empty state, do not query)', () => {
    expect(categoryConstraint(new Set())).toBe("none");
  });

  it("maps the full set → undefined (NO namespace constraint — unmapped namespaces survive)", () => {
    expect(categoryConstraint(new Set(ALL_CATEGORIES))).toBeUndefined();
  });

  it("maps a subset → the explicit category list, in chip order", () => {
    expect(categoryConstraint(new Set<Category>(["finance", "sales"]))).toEqual(["sales", "finance"]);
  });
});

describe("pulse url — decodeFilters (reads the whole param set)", () => {
  it("defaults cleanly when every param is absent", () => {
    const f = decodeFilters(() => undefined);
    expect(sorted(f.categories)).toEqual(sorted(new Set(DEFAULT_CATEGORIES)));
    expect(f.severities.size).toBe(0);
    expect(f.actors.size).toBe(0);
    expect(f.search).toBe("");
  });

  it("reads cat / sev / act / q together and trims the search", () => {
    const params: Record<string, string> = {
      cat: "sales",
      sev: "critical,warn",
      act: "human",
      q: "  overdue invoice  ",
    };
    const f = decodeFilters((k) => params[k]);
    expect(sorted(f.categories)).toEqual(["sales"]);
    expect(sorted(f.severities)).toEqual(["critical", "warn"]);
    expect(sorted(f.actors)).toEqual(["human"]);
    expect(f.search).toBe("overdue invoice");
  });
});

describe("pulse url — filtersAreDirty (drives the Reset affordance)", () => {
  it("is false for the pristine default view", () => {
    expect(filtersAreDirty(decodeFilters(() => undefined))).toBe(false);
  });

  it("is true once ANY axis diverges from the default", () => {
    expect(filtersAreDirty(decodeFilters((k) => (k === "q" ? "x" : undefined)))).toBe(true);
    expect(filtersAreDirty(decodeFilters((k) => (k === "sev" ? "critical" : undefined)))).toBe(true);
    expect(filtersAreDirty(decodeFilters((k) => (k === "act" ? "ai_employee" : undefined)))).toBe(
      true,
    );
    // Even widening categories to "all" is a divergence from the default.
    expect(filtersAreDirty(decodeFilters((k) => (k === "cat" ? "all" : undefined)))).toBe(true);
  });
});
