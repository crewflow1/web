import { describe, it, expect } from "vitest";
import { formatBytes } from "@/lib/format/bytes";

/**
 * Unit tests for the canonical byte-size formatter, consolidated from three
 * copies (documents page, customer-portal document list, job-documents client).
 * The binary-unit boundaries and rounding are pinned exactly to the behaviour
 * every former copy produced.
 */
describe("formatBytes", () => {
  it("returns empty string for null / undefined / non-positive sizes", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-10)).toBe("");
  });

  it("formats bytes below 1 KB verbatim", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats kilobytes with rounding at the 1 KB boundary", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB"); // 1.5 KB rounds to 2
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("formats megabytes with one decimal at the 1 MB boundary", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});
