import { describe, expect, it } from "vitest";
import { summariseSignoff } from "@/lib/health-safety/acknowledgements";

/**
 * Required-operative sign-off status (H&S M6b). The "required" set is the crew
 * rota'd to the document's job; the status is deterministic and never invents a
 * requirement (no job crew ⇒ "not_tracked", not "0 of 0").
 */
describe("summariseSignoff", () => {
  it("is not_tracked when no operatives are required (no job crew)", () => {
    const s = summariseSignoff([], ["u1", "u2"]);
    expect(s.state).toBe("not_tracked");
    expect(s.required).toBe(0);
    expect(s.outstanding).toEqual([]);
    expect(s.extraSigned).toBe(2); // signatures still counted, just no denominator
  });

  it("is fully_signed when every required operative has signed", () => {
    const s = summariseSignoff(["a", "b"], ["a", "b"]);
    expect(s.state).toBe("fully_signed");
    expect(s.signedRequired).toBe(2);
    expect(s.required).toBe(2);
    expect(s.outstanding).toEqual([]);
  });

  it("is partially_signed when some but not all required have signed", () => {
    const s = summariseSignoff(["a", "b", "c"], ["a"]);
    expect(s.state).toBe("partially_signed");
    expect(s.signedRequired).toBe(1);
    expect(s.outstanding).toEqual(["b", "c"]);
  });

  it("is unsigned when required operatives exist but none have signed", () => {
    const s = summariseSignoff(["a", "b"], []);
    expect(s.state).toBe("unsigned");
    expect(s.signedRequired).toBe(0);
    expect(s.outstanding).toEqual(["a", "b"]);
  });

  it("counts extra signers (not in the required set) without inflating progress", () => {
    const s = summariseSignoff(["a"], ["a", "x", "y"]);
    expect(s.state).toBe("fully_signed");
    expect(s.required).toBe(1);
    expect(s.signedRequired).toBe(1);
    expect(s.extraSigned).toBe(2);
  });

  it("deduplicates the required set", () => {
    const s = summariseSignoff(["a", "a", "b"], ["a"]);
    expect(s.required).toBe(2);
    expect(s.outstanding).toEqual(["b"]);
  });
});
