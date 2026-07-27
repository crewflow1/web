import { describe, it, expect } from "vitest";
import { drainEvidenceInto, type TaskResult } from "@/server/sdk/output";

/**
 * Unit proof for the standard output envelope's evidence-drain (server/sdk/output.ts)
 * (CEO Directive #014 / D-04, Phase A; ADR 0008; Bible Volume XIII §10).
 *
 * The drain is the one piece of LOGIC the envelope adds: at completion the runner folds
 * the memory facet's recalled ids into the result's `evidence[]` so an employee gets a
 * provenance trail for free. These pin the contract: a no-op when there is nothing to
 * drain, a non-mutating shallow merge that de-duplicates, and a synthesised envelope when
 * a memory-reading handler returns void.
 */

describe("drainEvidenceInto — folds recalled evidence into the result envelope", () => {
  it("returns the result UNCHANGED (same reference) when there is no recalled evidence", () => {
    const result = { verdict: "done" };
    expect(drainEvidenceInto(result, [])).toBe(result);
  });

  it("returns undefined when a void handler recalled nothing", () => {
    expect(drainEvidenceInto(undefined, [])).toBeUndefined();
  });

  it("synthesises a minimal envelope when a void handler DID recall memory", () => {
    expect(drainEvidenceInto(undefined, ["m1", "m2"])).toEqual({ evidence: ["m1", "m2"] });
  });

  it("adds evidence to a result object WITHOUT mutating the original (shallow copy)", () => {
    const result = { verdict: "qualified", score: 8 };
    const out = drainEvidenceInto(result, ["m1", "m2"]) as Record<string, unknown>;
    expect(out).toEqual({ verdict: "qualified", score: 8, evidence: ["m1", "m2"] });
    expect(result).toEqual({ verdict: "qualified", score: 8 }); // original untouched
    expect(out).not.toBe(result);
  });

  it("UNIONS handler-supplied evidence with recalled ids, de-duplicating in first-seen order", () => {
    const result = { evidence: ["a", "b"] };
    const out = drainEvidenceInto(result, ["b", "c", "a", "d"]) as Record<string, unknown>;
    expect(out.evidence).toEqual(["a", "b", "c", "d"]);
  });

  it("de-duplicates the recalled ids alone", () => {
    const out = drainEvidenceInto({}, ["m1", "m1", "m2"]) as Record<string, unknown>;
    expect(out.evidence).toEqual(["m1", "m2"]);
  });

  it("replaces a non-array handler `evidence` with the drained ids (never crashes on misuse)", () => {
    const out = drainEvidenceInto({ evidence: "oops" } as TaskResult, ["m1"]) as Record<
      string,
      unknown
    >;
    expect(out.evidence).toEqual(["m1"]);
  });

  it("preserves a full AiOutput envelope's other fields", () => {
    const result = {
      summary: "Lead qualified",
      reasoning: "Strong fit",
      confidence: 0.9,
      approvalRequired: false,
    };
    const out = drainEvidenceInto(result, ["m1"]) as Record<string, unknown>;
    expect(out).toMatchObject({
      summary: "Lead qualified",
      reasoning: "Strong fit",
      confidence: 0.9,
      approvalRequired: false,
      evidence: ["m1"],
    });
  });
});
