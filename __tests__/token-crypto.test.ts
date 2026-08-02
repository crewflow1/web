import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

import {
  encryptToken,
  decryptToken,
  isTokenEncryptionConfigured,
  hasEncryptionKey,
} from "@/lib/integrations/token-crypto";

/**
 * Unit proofs for the integration token-encryption envelope (AES-256-GCM).
 *
 * Round-trip; the self-describing `v1:iv:tag:ct` format; authenticated decrypt
 * (tamper throws); and the non-throwing configured predicate across present /
 * absent / malformed keys. A valid test key is injected via env.
 */

const ENV_KEY = "INTEGRATION_TOKEN_ENCRYPTION_KEY";
const VALID_KEY = randomBytes(32).toString("base64");

describe("token-crypto", () => {
  const original = process.env[ENV_KEY];
  beforeEach(() => {
    process.env[ENV_KEY] = VALID_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("round-trips encrypt → decrypt", () => {
    const plaintext = "ya29.a0AfB_byC-super-secret-access-token";
    const ct = encryptToken(plaintext);
    expect(decryptToken(ct)).toBe(plaintext);
  });

  it("round-trips an empty string and unicode", () => {
    for (const p of ["", "🔐 tökén with spaces", "a".repeat(4096)]) {
      expect(decryptToken(encryptToken(p))).toBe(p);
    }
  });

  it("produces the self-describing v1:<iv>:<tag>:<ct> format", () => {
    const ct = encryptToken("hello");
    const parts = ct.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    // iv, tag, ct are all non-empty base64.
    for (const p of parts.slice(1)) expect(p.length).toBeGreaterThan(0);
  });

  it("uses a fresh random IV per call (same plaintext → different ciphertext)", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same");
    expect(decryptToken(b)).toBe("same");
  });

  it("rejects an unrecognised format (missing v1 prefix)", () => {
    expect(() => decryptToken("not-a-valid-envelope")).toThrow();
    expect(() => decryptToken("v2:aaa:bbb:ccc")).toThrow(/format/i);
  });

  it("throws on a tampered ciphertext (GCM auth failure)", () => {
    const ct = encryptToken("tamper-me");
    const [ver, iv, tag, ctB64] = ct.split(":") as [string, string, string, string];
    // Flip a byte in the ciphertext segment.
    const body = Buffer.from(ctB64, "base64");
    body[0] = (body[0] ?? 0) ^ 0xff;
    const tampered = [ver, iv, tag, body.toString("base64")].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws on a tampered auth tag", () => {
    const ct = encryptToken("tamper-tag");
    const [ver, iv, tagB64, ctB64] = ct.split(":") as [string, string, string, string];
    const tag = Buffer.from(tagB64, "base64");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    const tampered = [ver, iv, tag.toString("base64"), ctB64].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("cannot be decrypted with a different key", () => {
    const ct = encryptToken("wrong-key-test");
    process.env[ENV_KEY] = randomBytes(32).toString("base64");
    expect(() => decryptToken(ct)).toThrow();
  });

  it("isTokenEncryptionConfigured / hasEncryptionKey are true with a valid key", () => {
    expect(isTokenEncryptionConfigured()).toBe(true);
    expect(hasEncryptionKey()).toBe(true);
  });

  it("is NOT configured (no throw) when the key is absent", () => {
    delete process.env[ENV_KEY];
    expect(isTokenEncryptionConfigured()).toBe(false);
    expect(hasEncryptionKey()).toBe(false);
    expect(() => encryptToken("x")).toThrow(/missing or malformed/i);
    expect(() => decryptToken("v1:a:b:c")).toThrow(/missing or malformed/i);
  });

  it("is NOT configured (no throw) when the key is the wrong length", () => {
    process.env[ENV_KEY] = randomBytes(16).toString("base64"); // 128-bit, too short
    expect(isTokenEncryptionConfigured()).toBe(false);
    expect(() => encryptToken("x")).toThrow(/missing or malformed/i);
  });

  it("is NOT configured when the key is blank", () => {
    process.env[ENV_KEY] = "   ";
    expect(isTokenEncryptionConfigured()).toBe(false);
  });
});
