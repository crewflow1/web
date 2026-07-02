import { describe, it, expect } from "vitest";
import { toE164, toInternationalDigits, whatsAppHref } from "@/lib/phone";

describe("toInternationalDigits", () => {
  it("converts a UK national number (07…) to +44 international digits", () => {
    expect(toInternationalDigits("07700 900000")).toBe("447700900000");
    expect(toInternationalDigits("07700900000")).toBe("447700900000");
  });

  it("strips the + from E.164 input", () => {
    expect(toInternationalDigits("+44 7700 900000")).toBe("447700900000");
    expect(toInternationalDigits("+447700900000")).toBe("447700900000");
  });

  it("drops the 00 international access code", () => {
    expect(toInternationalDigits("0044 7700 900000")).toBe("447700900000");
  });

  it("keeps an already-international UK number (44…)", () => {
    expect(toInternationalDigits("447700900000")).toBe("447700900000");
  });

  it("strips spaces, brackets and dashes", () => {
    expect(toInternationalDigits("(07700) 900-000")).toBe("447700900000");
  });

  it("preserves a non-UK international number given with +", () => {
    expect(toInternationalDigits("+1 (415) 555-0123")).toBe("14155550123");
  });

  it("assumes UK for a bare subscriber number missing its leading 0", () => {
    expect(toInternationalDigits("7700900000")).toBe("447700900000");
  });

  it("returns null for empty or junk input", () => {
    expect(toInternationalDigits(null)).toBeNull();
    expect(toInternationalDigits(undefined)).toBeNull();
    expect(toInternationalDigits("")).toBeNull();
    expect(toInternationalDigits("   ")).toBeNull();
    expect(toInternationalDigits("abc")).toBeNull();
    expect(toInternationalDigits("+")).toBeNull();
  });
});

describe("whatsAppHref", () => {
  it("builds a wa.me link in WhatsApp's required international format", () => {
    expect(whatsAppHref("07700 900000")).toBe("https://wa.me/447700900000");
    expect(whatsAppHref("+44 7700 900000")).toBe("https://wa.me/447700900000");
  });

  it("returns null when there is no usable number", () => {
    expect(whatsAppHref(null)).toBeNull();
    expect(whatsAppHref("")).toBeNull();
    expect(whatsAppHref("abc")).toBeNull();
  });
});

describe("toE164", () => {
  it("prefixes a + onto the international digits (the SMS destination shape)", () => {
    expect(toE164("07700 900000")).toBe("+447700900000");
    expect(toE164("07700900000")).toBe("+447700900000");
  });

  it("normalises E.164, 00-access and bare-UK input to a single canonical +form", () => {
    expect(toE164("+44 7700 900000")).toBe("+447700900000");
    expect(toE164("0044 7700 900000")).toBe("+447700900000");
    expect(toE164("447700900000")).toBe("+447700900000");
    expect(toE164("(07700) 900-000")).toBe("+447700900000");
  });

  it("preserves a non-UK international number", () => {
    expect(toE164("+1 (415) 555-0123")).toBe("+14155550123");
  });

  it("returns null for empty or undialable input (the transport records invalid_destination)", () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("   ")).toBeNull();
    expect(toE164("abc")).toBeNull();
    expect(toE164("+")).toBeNull();
  });
});
