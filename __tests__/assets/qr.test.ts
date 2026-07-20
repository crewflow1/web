import { describe, expect, it } from "vitest";
import {
  isResolvable,
  isValidTokenFormat,
  safeLabelFilename,
  scanPath,
  tokenFromScan,
} from "@/lib/assets/qr";
import { generateOpaqueToken } from "@/lib/assets/qr-token";

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

describe("tokenFromScan", () => {
  const token = "abc123_-XYZtoken0000"; // 20 chars, valid shape

  it("accepts a full label URL and pulls the token from the /a/<token> path", () => {
    expect(tokenFromScan(`https://crewflow.uk/a/${token}`)).toBe(token);
    expect(tokenFromScan(`https://crewflow.uk/a/${token}?ref=x#y`)).toBe(token);
    expect(tokenFromScan(`https://crewflow.uk/a/${token}/`)).toBe(token);
  });

  it("accepts a bare path and a bare token", () => {
    expect(tokenFromScan(`/a/${token}`)).toBe(token);
    expect(tokenFromScan(token)).toBe(token);
    expect(tokenFromScan(`  ${token}  `)).toBe(token); // trims
  });

  it("IGNORES the scanned host — a spoofed origin can't become an open redirect", () => {
    // The host is discarded; only the token is extracted, to be re-navigated
    // internally via scanPath. So evil.example yields the same token, not a redirect.
    expect(tokenFromScan(`https://evil.example/a/${token}`)).toBe(token);
  });

  it("rejects anything that isn't an /a/<token> path or a well-formed token", () => {
    expect(tokenFromScan("https://crewflow.uk/assets")).toBeNull();
    expect(tokenFromScan("https://crewflow.uk/a/")).toBeNull();
    expect(tokenFromScan("/login?next=/a/x")).toBeNull();
    expect(tokenFromScan("javascript:alert(1)")).toBeNull();
    expect(tokenFromScan("short")).toBeNull(); // below the 16-char floor
    expect(tokenFromScan("has spaces in it here")).toBeNull();
    expect(tokenFromScan("")).toBeNull();
    expect(tokenFromScan(null)).toBeNull();
    expect(tokenFromScan(42)).toBeNull();
  });

  it("round-trips a token that was percent-encoded into the URL path", () => {
    expect(tokenFromScan(`https://crewflow.uk/a/${encodeURIComponent(token)}`)).toBe(token);
  });
});
