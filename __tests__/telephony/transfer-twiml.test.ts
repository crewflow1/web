import { describe, it, expect } from "vitest";
import { buildTransferTwiml } from "@/lib/telephony/providers/twilio";

/**
 * buildTransferTwiml (Twilio receptionist PR 6) — the human-escalation handover.
 */
describe("buildTransferTwiml", () => {
  it("says a handover line then dials the single escalation number", () => {
    const xml = buildTransferTwiml({ number: "+447700900999" })!;
    expect(xml).toContain("<Say>");
    expect(xml).toContain("<Dial");
    expect(xml).toContain("<Number>+447700900999</Number>");
  });

  it("uses a custom message + owned callerId + clamped timeout", () => {
    const xml = buildTransferTwiml({
      number: "+447700900999",
      message: "Connecting you to the on-call engineer.",
      callerId: "+441234567890",
      timeoutSeconds: 999,
    })!;
    expect(xml).toContain("<Say>Connecting you to the on-call engineer.</Say>");
    expect(xml).toContain('callerId="+441234567890"');
    expect(xml).toContain('timeout="120"');
  });

  it("returns null for a non-E.164 number (falls back to AI, never empty Dial)", () => {
    expect(buildTransferTwiml({ number: "07700900999" })).toBeNull();
    expect(buildTransferTwiml({ number: "" })).toBeNull();
  });

  it("ignores a non-owned callerId", () => {
    const xml = buildTransferTwiml({ number: "+447700900999", callerId: "withheld" })!;
    expect(xml).not.toContain("callerId=");
  });
});
