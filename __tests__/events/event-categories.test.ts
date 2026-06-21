import { describe, it, expect } from "vitest";
import { VERBS, verbNamespace } from "@/lib/events/registry";
import {
  CATEGORIES,
  CATEGORY_NAMESPACES,
  MAPPED_NAMESPACES,
  ALL_CATEGORIES,
  DEFAULT_CATEGORIES,
  categoryForNamespace,
  categoryForVerb,
  namespacesForCategories,
  type Category,
} from "@/lib/events/categories";

/**
 * Drift guard for the Pulse filter-chip taxonomy (Module 1, PR5 / CEO Directive
 * #005). categories.ts is the ONE place that maps the projection's mechanical
 * `namespace` (the verb prefix) to the human chips the CEO specified. The
 * load-bearing invariant: EVERY registered verb's namespace is explicitly mapped,
 * so a brand-new producer can never silently fall through the "system" fallback
 * and orphan its events off every chip. If you add a verb in a new namespace and
 * this suite goes red, map that namespace in CATEGORY_NAMESPACES — no migration
 * needed (the namespace→category meaning lives in TS, by design).
 */

describe("event categories — no registered verb drifts off the chips", () => {
  it("every verb's namespace is EXPLICITLY mapped to a category", () => {
    for (const verb of VERBS) {
      const ns = verbNamespace(verb);
      expect(MAPPED_NAMESPACES.has(ns), `verb "${verb}" → namespace "${ns}" is unmapped`).toBe(true);
    }
  });

  it("a representative verb in each live namespace resolves to the right chip", () => {
    expect(categoryForVerb("quote.sent")).toBe("sales");
    expect(categoryForVerb("customer.created")).toBe("customers");
    expect(categoryForVerb("job.completed")).toBe("projects");
    expect(categoryForVerb("invoice.paid")).toBe("finance");
    expect(categoryForVerb("ai.run_completed")).toBe("ai");
    expect(categoryForVerb("support.ticket_opened")).toBe("communication");
    expect(categoryForVerb("permission.role_granted")).toBe("staff");
    expect(categoryForVerb("system.cron_ran")).toBe("system");
  });

  it("an UNMAPPED namespace falls back to system (so nothing is ever orphaned)", () => {
    expect(categoryForNamespace("totally_new_namespace")).toBe("system");
  });
});

describe("event categories — the map is internally consistent", () => {
  it("no namespace is claimed by two categories (the reverse index is unambiguous)", () => {
    const all = Object.values(CATEGORY_NAMESPACES).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("MAPPED_NAMESPACES is exactly the union of every category's namespaces", () => {
    const union = new Set(Object.values(CATEGORY_NAMESPACES).flat());
    expect([...MAPPED_NAMESPACES].sort()).toEqual([...union].sort());
  });

  it("every category chip has at least one namespace", () => {
    for (const { id } of CATEGORIES) {
      expect(CATEGORY_NAMESPACES[id].length, `category "${id}" maps to no namespace`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("event categories — selection helpers", () => {
  it("namespacesForCategories flattens + dedupes; empty selection → []", () => {
    expect(namespacesForCategories(["ai"])).toEqual(["ai", "approval", "memory"]);
    expect(namespacesForCategories([])).toEqual([]);
    // Overlapping/duplicated categories never duplicate a namespace.
    const dup = namespacesForCategories(["sales", "sales"]);
    expect(new Set(dup).size).toBe(dup.length);
  });

  it("ALL_CATEGORIES preserves the CEO's chip order", () => {
    expect(ALL_CATEGORIES).toEqual(CATEGORIES.map((c) => c.id));
  });

  it("DEFAULT_CATEGORIES is everything EXCEPT System (hidden by default, one click away)", () => {
    expect(DEFAULT_CATEGORIES).toEqual(ALL_CATEGORIES.filter((c) => c !== "system"));
    expect(DEFAULT_CATEGORIES).not.toContain<Category>("system");
    expect(ALL_CATEGORIES).toContain<Category>("system");
  });
});
