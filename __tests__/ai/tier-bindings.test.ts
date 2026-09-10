import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TIER_MODEL } from "@/lib/ai/governor/registry";

/**
 * TIER_MODEL — the CEO-approved 2026-09-10 production bindings, pinned.
 *
 * These are SOURCE-OF-TRUTH pins, not snapshots of convenience: any change to
 * a model id, a price, or a reservation envelope is a product decision that
 * must arrive as a reviewed diff updating this file in the same commit.
 *
 * LIFECYCLE — the standing rule this suite enforces:
 *   Anthropic lists claude-haiku-4-5-20251001 as Active with availability
 *   committed "not sooner than 2026-10-15" — the NEAREST retirement horizon
 *   in the bound lineup (Sonnet 5: not sooner than 2027-06-30; Opus 5:
 *   2027-07-24). Retirement is preceded by ≥60 days' emailed notice and a
 *   named replacement (platform.claude.com/docs/en/about-claude/
 *   model-deprecations). When that notice lands, the replacement is a
 *   REVIEWED REBIND DIFF here — never an automatic switch, never an alias
 *   drift, never a silent fallback. A retired id fails loudly at the
 *   provider (governed, settled as a failure, degradesTo serves) rather
 *   than silently running a different model.
 */

describe("TIER_MODEL — the approved production bindings", () => {
  it("cheap = the PINNED Haiku 4.5 snapshot (never the unversioned alias)", () => {
    expect(TIER_MODEL.cheap).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      usdPerMTokIn: 1,
      usdPerMTokOut: 5,
      reserveInputTokens: 32_000,
      reserveOutputTokens: 2_048,
    });
    // Haiku 4.5 predates the 4.6 generation, so its dateless form is a
    // MOVABLE alias — refused; we pin the dated snapshot. (claude-sonnet-5 /
    // claude-opus-5 are 4.6-generation dateless ids, which Anthropic
    // documents as pinned snapshots in their own right — no date form exists.)
    expect(TIER_MODEL.cheap?.model).not.toBe("claude-haiku-4-5");
  });

  it("mid = claude-sonnet-5 at its verified prices and the quote-writer envelope", () => {
    expect(TIER_MODEL.mid).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      usdPerMTokIn: 2,
      usdPerMTokOut: 10,
      reserveInputTokens: 8_000,
      reserveOutputTokens: 2_000,
    });
  });

  it("high = claude-opus-5 at its verified prices and the research envelope", () => {
    expect(TIER_MODEL.high).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      usdPerMTokIn: 5,
      usdPerMTokOut: 25,
      reserveInputTokens: 24_000,
      reserveOutputTokens: 3_200,
    });
  });

  it("embedding and transcription REMAIN dark — each is its own future reviewed diff", () => {
    expect(TIER_MODEL.embedding).toBeNull();
    expect(TIER_MODEL.transcription).toBeNull();
  });

  it("LIFECYCLE: the registry carries the Haiku 4.5 retirement-handling rule in writing", () => {
    // The rule must live beside the binding it governs, so the eventual
    // rebind diff cannot claim ignorance. Pinned on source.
    const src = readFileSync(
      resolve(__dirname, "../../lib/ai/governor/registry.ts"),
      "utf8",
    );
    expect(src).toMatch(/not sooner than 2026-10-15/);
    expect(src).toMatch(/REVIEWED REBIND DIFF/);
  });

  it("no binding may ever quietly shrink its worst-case envelope below the measured call shapes", () => {
    // OCR whole-PDF (cheap), quote-writer context (mid), research evidence
    // packs (high) — the measured worst cases these envelopes were sized to.
    expect(TIER_MODEL.cheap!.reserveInputTokens).toBeGreaterThanOrEqual(30_000);
    expect(TIER_MODEL.cheap!.reserveOutputTokens).toBeGreaterThanOrEqual(2_048);
    expect(TIER_MODEL.mid!.reserveInputTokens).toBeGreaterThanOrEqual(7_300);
    expect(TIER_MODEL.mid!.reserveOutputTokens).toBeGreaterThanOrEqual(2_000);
    expect(TIER_MODEL.high!.reserveInputTokens).toBeGreaterThanOrEqual(20_000);
    expect(TIER_MODEL.high!.reserveOutputTokens).toBeGreaterThanOrEqual(3_200);
  });
});
