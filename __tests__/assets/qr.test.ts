import { describe, expect, it } from "vitest";
import {
  generateOpaqueToken,
  isResolvable,
  isValidTokenFormat,
  safeLabelFilename,
  scanPath,
} from "@/lib/assets/qr";

describe("generateOpaqueToken", () => {
  it("produces a valid, URL-safe, unique token each call", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(isValidTokenFormat(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url — safe in a URL
    expect(a.length).toBeGreaterThanOrEqual(24);
    // High entropy: 100 tokens, no collisions.
    const set = new Set(Array.from({ length: 100 }, () => generateOpaqueToken()));
    expect(set.size).toBe(100);
  });
});

describe("isValidTokenFormat", () => {
  it("accepts well-formed tokens and rejects junk (edge rejection before DB)", () => {
    expect(isValidTokenFormat(generateOpaqueToken())).toBe(true);
    expect(isValidTokenFormat("")).toBe(false);
    expect(isValidTokenFormat("short")).toBe(false);
    expect(isValidTokenFormat("has spaces and stuff")).toBe(false);
    expect(isValidTokenFormat("../../etc/passwd")).toBe(false);
    expect(isValidTokenFormat("a".repeat(200))).toBe(false);
    expect(isValidTokenFormat(null)).toBe(false);
    expect(isValidTokenFormat(12345)).toBe(false);
  });
});

describe("isResolvable", () => {
  it("resolves only an active identity", () => {
    expect(isResolvable({ active: true })).toBe(true);
    expect(isResolvable({ active: false })).toBe(false);
    expect(isResolvable(null)).toBe(false);
    expect(isResolvable(undefined)).toBe(false);
  });
});

describe("scanPath", () => {
  it("encodes only the opaque token", () => {
    expect(scanPath("abc123_-")).toBe("/a/abc123_-");
  });
});

describe("safeLabelFilename", () => {
  it("uses the reference, ends in -qr.pdf, and strips unsafe chars", () => {
    expect(safeLabelFilename("Kubota digger", "FLEET-14")).toBe("FLEET-14-qr.pdf");
    expect(safeLabelFilename('a"b\nc', null)).toBe("a-b-c-qr.pdf");
    expect(safeLabelFilename(null, null)).toBe("asset-label-qr.pdf");
    expect(safeLabelFilename("../../etc/passwd")).not.toContain("/");
  });
});
