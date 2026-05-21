import { describe, it, expect } from "vitest";
import { canonicaliseNiNumber, maskNiNumber } from "@/lib/staff/secrets";

describe("canonicaliseNiNumber", () => {
  it("accepts a valid UK NI number", () => {
    expect(canonicaliseNiNumber("AB123456C")).toBe("AB123456C");
  });

  it("strips internal whitespace + uppercases", () => {
    expect(canonicaliseNiNumber("ab 12 34 56 c")).toBe("AB123456C");
  });

  it("rejects invalid prefix letters (D, F, I, Q, U, V are reserved)", () => {
    expect(canonicaliseNiNumber("DA123456C")).toBeNull();
    expect(canonicaliseNiNumber("FA123456C")).toBeNull();
    expect(canonicaliseNiNumber("IA123456C")).toBeNull();
    expect(canonicaliseNiNumber("QA123456C")).toBeNull();
  });

  it("rejects bad suffix letters (only A-D legal)", () => {
    expect(canonicaliseNiNumber("AB123456E")).toBeNull();
    expect(canonicaliseNiNumber("AB123456Z")).toBeNull();
  });

  it("rejects wrong digit count", () => {
    expect(canonicaliseNiNumber("AB12345C")).toBeNull();
    expect(canonicaliseNiNumber("AB1234567C")).toBeNull();
  });

  it("rejects empty / null input", () => {
    expect(canonicaliseNiNumber(null)).toBeNull();
    expect(canonicaliseNiNumber(undefined)).toBeNull();
    expect(canonicaliseNiNumber("")).toBeNull();
  });

  it("returns null for completely non-NI strings", () => {
    expect(canonicaliseNiNumber("not a number")).toBeNull();
    expect(canonicaliseNiNumber("12345678")).toBeNull();
  });
});

describe("maskNiNumber", () => {
  it("masks the middle digits, keeping prefix + last 3", () => {
    expect(maskNiNumber("AB123456C")).toBe("AB****56C");
  });

  it("returns em-dash placeholder for missing numbers", () => {
    expect(maskNiNumber(null)).toBe("—");
    expect(maskNiNumber(undefined)).toBe("—");
    expect(maskNiNumber("")).toBe("—");
  });

  it("returns *** when the input is suspiciously short", () => {
    expect(maskNiNumber("ABC")).toBe("***");
    expect(maskNiNumber("AB123")).toBe("***");
  });
});
