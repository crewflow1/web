import { describe, it, expect } from "vitest";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@/lib/auth/recovery-codes";

/**
 * MFA recovery-code crypto helper — the one-way scrypt hashing that backs the
 * lost-device escape hatch. Pins: correct round-trip, single-use uniqueness,
 * no-plaintext-storage shape, tamper/typo tolerance, and constant-shape verify.
 */

describe("generateRecoveryCodes", () => {
  it("mints the default batch of display codes + index-aligned hashes", () => {
    const { display, hashes } = generateRecoveryCodes();
    expect(display).toHaveLength(RECOVERY_CODE_COUNT);
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it("produces distinct high-entropy codes (no collisions in a batch)", () => {
    const { display } = generateRecoveryCodes();
    expect(new Set(display).size).toBe(display.length);
  });

  it("formats codes as two dash-separated groups of five from the safe alphabet", () => {
    const { display } = generateRecoveryCodes();
    for (const c of display) {
      expect(c).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
      // no ambiguous glyphs
      expect(c).not.toMatch(/[01OILU]/);
    }
  });

  it("stores only a self-describing scrypt hash — never the plaintext", () => {
    const { display, hashes } = generateRecoveryCodes();
    for (let i = 0; i < hashes.length; i++) {
      expect(hashes[i]!.startsWith("scrypt$")).toBe(true);
      const bare = display[i]!.replace("-", "");
      expect(hashes[i]).not.toContain(display[i]!);
      expect(hashes[i]).not.toContain(bare);
    }
  });

  it("each freshly minted display code verifies against its own hash", () => {
    const { display, hashes } = generateRecoveryCodes();
    for (let i = 0; i < display.length; i++) {
      expect(verifyRecoveryCode(display[i]!, hashes[i]!)).toBe(true);
    }
  });
});

describe("verifyRecoveryCode", () => {
  it("accepts the code with-or-without the dash, in any case, with spaces", () => {
    const h = hashRecoveryCode("ABCDE-FGHJK");
    expect(verifyRecoveryCode("ABCDE-FGHJK", h)).toBe(true);
    expect(verifyRecoveryCode("abcdefghjk", h)).toBe(true);
    expect(verifyRecoveryCode("  abcde fghjk ", h)).toBe(true);
  });

  it("rejects a wrong code", () => {
    const h = hashRecoveryCode("ABCDE-FGHJK");
    expect(verifyRecoveryCode("ZZZZZ-ZZZZZ", h)).toBe(false);
  });

  it("never throws on a malformed stored hash — returns false", () => {
    expect(verifyRecoveryCode("anything", "")).toBe(false);
    expect(verifyRecoveryCode("anything", "not-a-hash")).toBe(false);
    expect(verifyRecoveryCode("anything", "scrypt$16384$8$1$badsalt")).toBe(false);
    expect(verifyRecoveryCode("anything", "bcrypt$x$y")).toBe(false);
  });

  it("hashes the same code differently each time (per-code random salt)", () => {
    const a = hashRecoveryCode("ABCDE-FGHJK");
    const b = hashRecoveryCode("ABCDE-FGHJK");
    expect(a).not.toBe(b);
    // ...yet both verify
    expect(verifyRecoveryCode("ABCDE-FGHJK", a)).toBe(true);
    expect(verifyRecoveryCode("ABCDE-FGHJK", b)).toBe(true);
  });
});

describe("normalizeRecoveryCode", () => {
  it("strips whitespace/dashes and upper-cases", () => {
    expect(normalizeRecoveryCode("  ab-cd ef ")).toBe("ABCDEF");
  });
});
