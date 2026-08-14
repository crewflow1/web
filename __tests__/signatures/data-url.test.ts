import { describe, it, expect } from "vitest";
import {
  parseSignatureDataUrl,
  looksLikeSignatureDataUrl,
  signatureStorageKey,
  MAX_SIGNATURE_BYTES,
  SIGNATURE_BUCKET,
} from "@/lib/signatures/data-url";

/**
 * Pure trust-boundary rules for the drawn e-signature pipeline. These lock what
 * counts as a valid signature image (a real PNG, size-capped) and how the
 * storage key is shaped (org-first, no user input) — the two facts the DB
 * CHECK + storage RLS also enforce, verified here in isolation.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngDataUrl(extra = Buffer.from("crewflow-sig")): string {
  const bytes = Buffer.concat([PNG_MAGIC, extra]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

describe("parseSignatureDataUrl — accepts a genuine PNG", () => {
  it("decodes a valid PNG data URL to bytes", () => {
    const res = parseSignatureDataUrl(pngDataUrl());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.byteLength).toBeGreaterThan(8);
      expect(Array.from(res.bytes.slice(0, 8))).toEqual(Array.from(PNG_MAGIC));
    }
  });
});

describe("parseSignatureDataUrl — rejects everything that isn't a real PNG", () => {
  it("rejects a non-string / empty input", () => {
    expect(parseSignatureDataUrl(undefined).ok).toBe(false);
    expect(parseSignatureDataUrl("").ok).toBe(false);
    expect(parseSignatureDataUrl(123 as unknown).ok).toBe(false);
  });
  it("rejects a non-PNG MIME (e.g. jpeg/svg/gif)", () => {
    expect(parseSignatureDataUrl("data:image/jpeg;base64,/9j/4AAQ").ok).toBe(false);
    expect(parseSignatureDataUrl("data:image/svg+xml;base64,PHN2Zz4=").ok).toBe(false);
    expect(parseSignatureDataUrl("data:text/html;base64,PGgxPg==").ok).toBe(false);
  });
  it("rejects a data URL whose base64 payload is malformed", () => {
    expect(parseSignatureDataUrl("data:image/png;base64,not valid base64!!!").ok).toBe(false);
  });
  it("rejects PNG-declared bytes that lack the PNG magic number", () => {
    const notPng = `data:image/png;base64,${Buffer.from("this is not a png at all").toString("base64")}`;
    const res = parseSignatureDataUrl(notPng);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a valid PNG/i);
  });
  it("rejects an oversized payload (over the byte cap)", () => {
    const huge = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_SIGNATURE_BYTES + 1024, 1)]);
    const res = parseSignatureDataUrl(`data:image/png;base64,${huge.toString("base64")}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too large/i);
  });
});

describe("looksLikeSignatureDataUrl — optionality gate", () => {
  it("is true only for a PNG data URL", () => {
    expect(looksLikeSignatureDataUrl(pngDataUrl())).toBe(true);
    expect(looksLikeSignatureDataUrl("")).toBe(false);
    expect(looksLikeSignatureDataUrl("data:image/jpeg;base64,xxx")).toBe(false);
    expect(looksLikeSignatureDataUrl(undefined)).toBe(false);
  });
});

describe("signatureStorageKey — org-first, deterministic, no user input", () => {
  const orgA = "11111111-1111-1111-1111-111111111111";
  const orgB = "22222222-2222-2222-2222-222222222222";
  const subject = "33333333-3333-3333-3333-333333333333";
  const sig = "44444444-4444-4444-4444-444444444444";

  it("puts the org_id as the first path segment", () => {
    const key = signatureStorageKey(orgA, "quotes", subject, sig);
    expect(key.split("/")[0]).toBe(orgA);
    expect(key).toBe(`${orgA}/quotes/${subject}/${sig}.png`);
  });
  it("scopes distinct orgs into distinct prefixes (tenant isolation of the key)", () => {
    const a = signatureStorageKey(orgA, "safety_acknowledgements", subject, sig);
    const b = signatureStorageKey(orgB, "safety_acknowledgements", subject, sig);
    expect(a.split("/")[0]).not.toBe(b.split("/")[0]);
  });
  it("targets the private signatures bucket", () => {
    expect(SIGNATURE_BUCKET).toBe("signatures");
  });
});
