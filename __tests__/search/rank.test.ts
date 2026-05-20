import { describe, it, expect } from "vitest";
import {
  matchesQuery,
  matchScore,
  sortHitsByMatch,
  normaliseQuery,
  type SearchHit,
} from "@/lib/search/rank";

describe("normaliseQuery", () => {
  it("lowercases + trims", () => {
    expect(normaliseQuery("  Acme  ")).toBe("acme");
  });
});

describe("matchesQuery", () => {
  it("case-insensitive substring match", () => {
    expect(matchesQuery("Acme Builders Ltd", "BUILDERS")).toBe(true);
    expect(matchesQuery("Acme Builders", "smith")).toBe(false);
  });
  it("returns false for null haystack", () => {
    expect(matchesQuery(null, "x")).toBe(false);
  });
  it("returns false for empty query", () => {
    expect(matchesQuery("anything", "")).toBe(false);
  });
});

describe("matchScore", () => {
  it("0 for exact match", () => {
    expect(matchScore("Acme", "ACME")).toBe(0);
  });
  it("1 for prefix match", () => {
    expect(matchScore("Acme Builders", "acme")).toBe(1);
  });
  it("2 for substring match", () => {
    expect(matchScore("North Acme Builders", "acme")).toBe(2);
  });
  it("3 for no match", () => {
    expect(matchScore("Other", "acme")).toBe(3);
  });
});

describe("sortHitsByMatch", () => {
  const hits: SearchHit[] = [
    { type: "lead", id: "1", title: "Other lead", subtitle: null, href: "/leads/1" },
    { type: "customer", id: "2", title: "Acme Builders", subtitle: null, href: "/customers/2" },
    { type: "invoice", id: "3", title: "INV-Acme-001", subtitle: null, href: "/invoices/3" },
    { type: "customer", id: "4", title: "Acme", subtitle: null, href: "/customers/4" },
  ];

  it("sorts exact match first, then prefix, then substring", () => {
    const sorted = sortHitsByMatch(hits, "Acme");
    expect(sorted[0]!.title).toBe("Acme"); // exact
    expect(sorted[1]!.title).toBe("Acme Builders"); // prefix
    // INV-Acme-001 is substring → comes after Acme Builders
    expect(sorted[2]!.title).toBe("INV-Acme-001");
    expect(sorted[3]!.title).toBe("Other lead");
  });

  it("breaks ties using type priority (customer before invoice)", () => {
    const both: SearchHit[] = [
      { type: "invoice", id: "i1", title: "Acme", subtitle: null, href: "/invoices/i1" },
      { type: "customer", id: "c1", title: "Acme", subtitle: null, href: "/customers/c1" },
    ];
    const sorted = sortHitsByMatch(both, "acme");
    expect(sorted[0]!.type).toBe("customer");
    expect(sorted[1]!.type).toBe("invoice");
  });
});
