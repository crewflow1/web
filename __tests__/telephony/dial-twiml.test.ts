import { describe, it, expect } from "vitest";
import {
  buildDialTwiml,
  TWILIO_VOICE_DIAL_STATUS_ACTION,
} from "@/lib/telephony/providers/twilio";

/**
 * buildDialTwiml (Twilio receptionist PR 2) — the STAFF-FIRST <Dial> builder.
 * Pins: null on no valid number (so the caller falls back to AI, never an empty
 * <Dial>), simultaneous multi-number ring, E.164 filtering, timeout clamping,
 * owned-number callerId, optional greeting + recording, and XML-safety.
 */
describe("buildDialTwiml", () => {
  it("returns null when there is no valid staff number (fall back to AI)", () => {
    expect(buildDialTwiml({ numbers: [], timeoutSeconds: 20 })).toBeNull();
    expect(buildDialTwiml({ numbers: ["not-a-number", "07700900000"], timeoutSeconds: 20 })).toBeNull();
  });

  it("rings multiple staff numbers SIMULTANEOUSLY in one <Dial>", () => {
    const xml = buildDialTwiml({
      numbers: ["+447700900001", "+447700900002"],
      timeoutSeconds: 25,
    });
    expect(xml).toContain("<Number>+447700900001</Number><Number>+447700900002</Number>");
    expect(xml).toContain(`action="${TWILIO_VOICE_DIAL_STATUS_ACTION}"`);
    expect(xml).toContain('timeout="25"');
    expect(xml).toContain('method="POST"');
  });

  it("drops invalid numbers but keeps the valid ones", () => {
    const xml = buildDialTwiml({
      numbers: ["+447700900001", "oops", "07700900002", "+447700900003"],
      timeoutSeconds: 20,
    });
    expect(xml).toContain("<Number>+447700900001</Number>");
    expect(xml).toContain("<Number>+447700900003</Number>");
    expect(xml).not.toContain("oops");
    expect(xml).not.toContain("07700900002");
  });

  it("clamps the ring timeout to [5, 120]", () => {
    expect(buildDialTwiml({ numbers: ["+447700900001"], timeoutSeconds: 1 })).toContain('timeout="5"');
    expect(buildDialTwiml({ numbers: ["+447700900001"], timeoutSeconds: 999 })).toContain('timeout="120"');
    expect(buildDialTwiml({ numbers: ["+447700900001"], timeoutSeconds: 0 })).toContain('timeout="20"');
  });

  it("only sets callerId when it is a valid owned E.164 number", () => {
    expect(
      buildDialTwiml({ numbers: ["+447700900001"], timeoutSeconds: 20, callerId: "+441234567890" }),
    ).toContain('callerId="+441234567890"');
    expect(
      buildDialTwiml({ numbers: ["+447700900001"], timeoutSeconds: 20, callerId: "withheld" }),
    ).not.toContain("callerId=");
  });

  it("prepends a greeting <Say> and adds recording only when asked", () => {
    const xml = buildDialTwiml({
      numbers: ["+447700900001"],
      timeoutSeconds: 20,
      greeting: "Connecting you now",
      record: true,
    });
    expect(xml).toContain("<Say>Connecting you now</Say>");
    expect(xml).toContain('record="record-from-answer-dual"');

    const noRec = buildDialTwiml({ numbers: ["+447700900001"], timeoutSeconds: 20 });
    expect(noRec).not.toContain("record=");
    expect(noRec).not.toContain("<Say>");
  });

  it("is valid XML with a declaration and a single <Response>", () => {
    const xml = buildDialTwiml({ numbers: ["+447700900001"], timeoutSeconds: 20 })!;
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml.endsWith("</Response>")).toBe(true);
  });
});
