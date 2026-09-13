import { describe, it, expect } from "vitest";
import {
  detectOptOutSignal,
  normaliseForKeywordMatch,
  normaliseWaId,
  OPT_IN_KEYWORDS,
  OPT_OUT_KEYWORDS,
} from "@/lib/receptionist/optout";

/**
 * STOP / opt-out keyword detection (activation-hardening P2-7) — pure unit.
 *
 * The contract under test: WHOLE-MESSAGE match only (after case-fold,
 * punctuation strip, whitespace collapse); explicit START/UNSTOP is the ONLY
 * re-subscribe; a customer sentence that merely CONTAINS a keyword is never an
 * opt-out. Deterministic — the same message always classifies the same way.
 */

describe("detectOptOutSignal — whole-message opt-out keywords", () => {
  it("detects the three opt-out keywords, case-insensitively", () => {
    expect(OPT_OUT_KEYWORDS).toEqual(["stop", "unsubscribe", "opt out"]);
    expect(detectOptOutSignal("STOP")).toBe("opt_out");
    expect(detectOptOutSignal("stop")).toBe("opt_out");
    expect(detectOptOutSignal("Stop")).toBe("opt_out");
    expect(detectOptOutSignal("UNSUBSCRIBE")).toBe("opt_out");
    expect(detectOptOutSignal("Opt Out")).toBe("opt_out");
    expect(detectOptOutSignal("opt   out")).toBe("opt_out");
  });

  it("tolerates surrounding whitespace and punctuation — 'STOP!!' is still an opt-out", () => {
    expect(detectOptOutSignal("  STOP  ")).toBe("opt_out");
    expect(detectOptOutSignal("STOP!!")).toBe("opt_out");
    expect(detectOptOutSignal("stop.")).toBe("opt_out");
    expect(detectOptOutSignal('"unsubscribe"')).toBe("opt_out");
    expect(detectOptOutSignal("opt out, please")).toBeNull(); // extra words ⇒ a sentence
  });

  it("NEVER trips on a sentence that merely contains a keyword", () => {
    expect(detectOptOutSignal("please don't stop the job")).toBeNull();
    expect(detectOptOutSignal("can you stop by tomorrow?")).toBeNull();
    expect(detectOptOutSignal("we should stop")).toBeNull();
    expect(detectOptOutSignal("start the work monday")).toBeNull();
    expect(detectOptOutSignal("the bus stop")).toBeNull();
  });

  it("explicit START / UNSTOP is the only re-subscribe", () => {
    expect(OPT_IN_KEYWORDS).toEqual(["start", "unstop"]);
    expect(detectOptOutSignal("START")).toBe("opt_in");
    expect(detectOptOutSignal("unstop")).toBe("opt_in");
    // An ordinary follow-up classifies as NEITHER — it must not silently
    // re-subscribe an opted-out sender (the conservative product decision).
    expect(detectOptOutSignal("hello, are you there?")).toBeNull();
    expect(detectOptOutSignal("ok thanks")).toBeNull();
  });

  it("empty / null / whitespace-only input is no signal", () => {
    expect(detectOptOutSignal(null)).toBeNull();
    expect(detectOptOutSignal(undefined)).toBeNull();
    expect(detectOptOutSignal("")).toBeNull();
    expect(detectOptOutSignal("   ")).toBeNull();
    expect(detectOptOutSignal("!!!")).toBeNull();
  });
});

describe("normaliseForKeywordMatch", () => {
  it("case-folds, strips punctuation, collapses whitespace, trims", () => {
    expect(normaliseForKeywordMatch("STOP!!")).toBe("stop");
    expect(normaliseForKeywordMatch(" Opt   out. ")).toBe("opt out");
    expect(normaliseForKeywordMatch("Un-subscribe")).toBe("unsubscribe");
  });
});

describe("normaliseWaId — one identity for wa_id and E.164", () => {
  it("digits-only: a Meta wa_id and its E.164 form resolve to the SAME key", () => {
    expect(normaliseWaId("447700900123")).toBe("447700900123");
    expect(normaliseWaId("+44 7700 900123")).toBe("447700900123");
    expect(normaliseWaId("+447700900123")).toBe("447700900123");
  });

  it("no digits ⇒ null (no identity, no match)", () => {
    expect(normaliseWaId(null)).toBeNull();
    expect(normaliseWaId("")).toBeNull();
    expect(normaliseWaId("anonymous")).toBeNull();
  });
});
