import { describe, it, expect } from "vitest";
import {
  createBlueprintSchema, addRevisionSchema, validateBlueprintFile, sniffBlueprintType,
  blueprintStorageKey, isCurrentVersion, isAllowedBlueprintMime, MAX_BLUEPRINT_BYTES,
} from "@/lib/blueprints/schema";

describe("createBlueprintSchema", () => {
  it("requires drawing number, title, revision", () => {
    expect(createBlueprintSchema.safeParse({ drawing_number: "A-201", title: "GA Plan", revision: "Rev A" }).success).toBe(true);
    expect(createBlueprintSchema.safeParse({ drawing_number: "", title: "x", revision: "A" }).success).toBe(false);
    expect(createBlueprintSchema.safeParse({ drawing_number: "A-1", title: "x", revision: "" }).success).toBe(false);
  });
  it("validates optional revision_date format", () => {
    expect(createBlueprintSchema.safeParse({ drawing_number: "A", title: "t", revision: "A", revision_date: "2026-07-01" }).success).toBe(true);
    expect(createBlueprintSchema.safeParse({ drawing_number: "A", title: "t", revision: "A", revision_date: "nope" }).success).toBe(false);
  });
});

describe("addRevisionSchema", () => {
  it("requires a revision label", () => {
    expect(addRevisionSchema.safeParse({ revision: "Rev B" }).success).toBe(true);
    expect(addRevisionSchema.safeParse({ revision: "" }).success).toBe(false);
  });
});

describe("validateBlueprintFile", () => {
  it("accepts a valid PDF within size", () => {
    expect(validateBlueprintFile({ mime: "application/pdf", size: 1000 })).toEqual({ ok: true });
  });
  it("rejects wrong mime, empty, and oversize", () => {
    expect(validateBlueprintFile({ mime: "text/csv", size: 10 }).ok).toBe(false);
    expect(validateBlueprintFile({ mime: "application/pdf", size: 0 }).ok).toBe(false);
    expect(validateBlueprintFile({ mime: "application/pdf", size: MAX_BLUEPRINT_BYTES + 1 }).ok).toBe(false);
  });
  it("rejects HEIC (not natively renderable)", () => {
    expect(isAllowedBlueprintMime("image/heic")).toBe(false);
  });
});

describe("sniffBlueprintType (magic bytes — declared MIME is untrusted)", () => {
  it("detects real file signatures", () => {
    expect(sniffBlueprintType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("application/pdf");
    expect(sniffBlueprintType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffBlueprintType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffBlueprintType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
  });
  it("returns null for a spoofed file (e.g. an exe renamed to .pdf)", () => {
    expect(sniffBlueprintType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // MZ (PE exe)
    expect(sniffBlueprintType(new Uint8Array([]))).toBeNull();
  });
});

describe("blueprintStorageKey", () => {
  it("puts org_id first (path RLS depends on it) and uses no user input", () => {
    const key = blueprintStorageKey("org-1", "job-2", "bp-3", "file-4", "PDF");
    expect(key).toBe("org-1/job-2/bp-3/file-4.pdf");
    expect(key.startsWith("org-1/")).toBe(true);
  });
  it("sanitises the extension", () => {
    expect(blueprintStorageKey("o", "j", "b", "f", "../evil")).toBe("o/j/b/f.evil");
  });
});

describe("isCurrentVersion", () => {
  it("matches only the live revision", () => {
    expect(isCurrentVersion(3, 3)).toBe(true);
    expect(isCurrentVersion(3, 2)).toBe(false);
    expect(isCurrentVersion(null, 1)).toBe(false);
  });
});
