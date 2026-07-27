import { describe, it, expect } from "vitest";
import {
  detectBookingIntent,
  composeBookingConfirmation,
  composeBookingSummary,
  BOOKING_KINDS,
  MAX_BOOKING_WINDOW,
  MAX_BOOKING_SUMMARY,
  type BookingIntent,
} from "@/lib/receptionist/intent";
import { evaluateReply } from "@/lib/receptionist/policy";

/**
 * Voice Receptionist AI — booking-intent detection, the pure layer, unit tier
 * (the AI Receptionist Programme, R2 — the harvest).
 *
 * Ported unchanged (behaviour-preserving) from the harvested comms-platform
 * booking suite. Two properties matter here and are proven without a database:
 *   1. `detectBookingIntent` recognises a real booking / callback request (and
 *      its requested-time PHRASE) and stays silent on ordinary enquiries.
 *   2. THE KEYSTONE: `composeBookingConfirmation` is a customer commitment BY
 *      CONSTRUCTION, so the guardrail (`evaluateReply`) returns `review` (category
 *      `booking`) over it — never `allow`. A booking is never auto-sendable.
 */

// =====================================================================
// 1. Detection — callbacks, appointments, windows, and silence.
// =====================================================================

describe("detectBookingIntent — recognises a callback request", () => {
  it("catches an explicit 'call me back'", () => {
    const intent = detectBookingIntent("Please can you call me back this afternoon?");
    expect(intent?.kind).toBe("callback");
    expect(intent?.window).toBe("this afternoon");
  });

  it("catches 'give me a ring' / 'callback' variants", () => {
    expect(detectBookingIntent("give me a ring when you can")?.kind).toBe("callback");
    expect(detectBookingIntent("I'd like a callback tomorrow morning")?.kind).toBe("callback");
    expect(detectBookingIntent("can you ring me back")?.kind).toBe("callback");
  });
});

describe("detectBookingIntent — recognises an appointment request", () => {
  it("catches 'book' / 'appointment' / 'schedule'", () => {
    expect(detectBookingIntent("I'd like to book an appointment")?.kind).toBe("appointment");
    expect(detectBookingIntent("can we schedule a visit")?.kind).toBe("appointment");
    expect(detectBookingIntent("do you have a slot free")?.kind).toBe("appointment");
  });

  it("catches 'come round / out' and 'are you free / available'", () => {
    expect(detectBookingIntent("can someone come round to look at it")?.kind).toBe("appointment");
    expect(detectBookingIntent("are you free next week?")?.kind).toBe("appointment");
    expect(detectBookingIntent("when can you come out?")?.kind).toBe("appointment");
  });

  it("treats a bare 'come …' as an appointment ONLY with a time window", () => {
    // "come" alone (no preposition, no time) is not enough.
    expect(detectBookingIntent("this has come loose")).toBeNull();
    // "come" + a time phrase is a booking.
    const intent = detectBookingIntent("could you come Tuesday at 2pm");
    expect(intent?.kind).toBe("appointment");
    expect(intent?.window).toBe("Tuesday at 2pm");
  });

  it("extracts the requested-time window from a day + time", () => {
    const intent = detectBookingIntent("Can someone come round on Tuesday at 2pm to fix the boiler?");
    expect(intent?.kind).toBe("appointment");
    expect(intent?.window).toBe("Tuesday at 2pm"); // leading "on " dropped
  });

  it("captures a daypart window ('Monday morning')", () => {
    const intent = detectBookingIntent("please book me in for Monday morning");
    expect(intent?.window).toBe("Monday morning");
  });
});

describe("detectBookingIntent — stays silent on ordinary enquiries", () => {
  // Ordinary enquiries — none of this must trip a capture.
  const quiet = [
    "My tap is leaking badly.",
    "Also the boiler is making noise.",
    "My boiler is leaking.",
    "My boiler has stopped working.",
    "Any update?",
    "Do you repair leaking taps in Leeds?",
    "I've had a problem since Monday.", // a bare day, no booking cue → silent
  ];
  for (const text of quiet) {
    it(`returns null for: ${text}`, () => {
      expect(detectBookingIntent(text)).toBeNull();
    });
  }

  it("returns null for empty / whitespace", () => {
    expect(detectBookingIntent("")).toBeNull();
    expect(detectBookingIntent("   ")).toBeNull();
    expect(detectBookingIntent(null)).toBeNull();
    expect(detectBookingIntent(undefined)).toBeNull();
  });
});

describe("detectBookingIntent — bounds the window phrase", () => {
  it(`never returns a window longer than MAX_BOOKING_WINDOW`, () => {
    const long = "book me in for " + "2pm ".repeat(200);
    const intent = detectBookingIntent(long);
    expect(intent?.kind).toBe("appointment");
    expect((intent?.window ?? "").length).toBeLessThanOrEqual(MAX_BOOKING_WINDOW);
  });

  it("reports the cues that fired (deterministic signals)", () => {
    const intent = detectBookingIntent("please book me an appointment");
    expect(Array.isArray(intent?.signals)).toBe(true);
    expect((intent?.signals ?? []).length).toBeGreaterThan(0);
  });
});

// =====================================================================
// 2. THE KEYSTONE — the proposed confirmation is a commitment, so the
//    guardrail holds it. A booking is NEVER auto-sendable.
// =====================================================================

describe("composeBookingConfirmation — is a guardrail `review`, never `allow`", () => {
  const intents: BookingIntent[] = [
    { kind: "appointment", window: "Tuesday at 2pm", signals: ["book"] },
    { kind: "appointment", window: null, signals: ["book"] },
    { kind: "callback", window: "this afternoon", signals: ["call_me_back"] },
    { kind: "callback", window: null, signals: ["call_me_back"] },
  ];

  for (const intent of intents) {
    it(`holds the ${intent.kind} confirmation (window: ${intent.window ?? "none"})`, () => {
      const confirmation = composeBookingConfirmation(intent);
      const verdict = evaluateReply(confirmation);
      expect(verdict.verdict).toBe("review");
      expect(verdict.categories).toContain("booking");
      // The load-bearing negative: a booking must NEVER clear as auto-sendable.
      expect(verdict.verdict).not.toBe("allow");
    });
  }

  it("never asserts a prohibited (safety / discrimination) claim → not `block`", () => {
    for (const intent of intents) {
      expect(evaluateReply(composeBookingConfirmation(intent)).verdict).not.toBe("block");
    }
  });
});

describe("composeBookingSummary — the operator label", () => {
  it("labels an appointment / callback with its window", () => {
    expect(
      composeBookingSummary({ kind: "appointment", window: "Tuesday at 2pm", signals: [] }),
    ).toBe("Appointment requested for Tuesday at 2pm");
    expect(composeBookingSummary({ kind: "callback", window: null, signals: [] })).toBe(
      "Callback requested",
    );
  });

  it("is bounded", () => {
    const label = composeBookingSummary({
      kind: "appointment",
      window: "x".repeat(500),
      signals: [],
    });
    expect(label.length).toBeLessThanOrEqual(MAX_BOOKING_SUMMARY);
  });
});

describe("the booking kinds are the bounded set", () => {
  it("is exactly appointment + callback", () => {
    expect([...BOOKING_KINDS]).toEqual(["appointment", "callback"]);
  });
});
