import { describe, it, expect } from "vitest";
import {
  SIGNAL_KINDS,
  SIGNAL_KIND_LABEL,
  SIGNAL_KIND_DESCRIPTION,
  labelled,
} from "@/lib/intelligence/provenance";

describe("the kind ladder", () => {
  it("has exactly three kinds — and none of them is generative", () => {
    expect([...SIGNAL_KINDS]).toEqual(["fact", "derived", "heuristic"]);
    // The ratchet: 'prediction' / 'model' / 'ai' labels arrive with a bound
    // model, never before. If this fails, read provenance.ts's header first.
    for (const kind of SIGNAL_KINDS) {
      expect(kind).not.toMatch(/predict|model|ai/i);
    }
  });

  it("every kind has a badge word and a description", () => {
    for (const kind of SIGNAL_KINDS) {
      expect(SIGNAL_KIND_LABEL[kind].length).toBeGreaterThan(0);
      expect(SIGNAL_KIND_DESCRIPTION[kind].length).toBeGreaterThan(0);
    }
  });
});

describe("labelled()", () => {
  const good = {
    kind: "derived" as const,
    basis: "Exact arithmetic over the rota.",
    computedFrom: [{ label: "Rota", href: "/staff/rota" }],
  };

  it("wraps a value with its provenance", () => {
    const m = labelled(42, good);
    expect(m.value).toBe(42);
    expect(m.provenance.kind).toBe("derived");
  });

  it("refuses a metric with no basis", () => {
    expect(() => labelled(1, { ...good, basis: "" })).toThrow(/basis/);
    expect(() => labelled(1, { ...good, basis: "   " })).toThrow(/basis/);
  });

  it("refuses a metric with no evidence links", () => {
    expect(() => labelled(1, { ...good, computedFrom: [] })).toThrow(/computed from/);
  });
});
