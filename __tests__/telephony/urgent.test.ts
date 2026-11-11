import { describe, it, expect } from "vitest";
import { isUrgentTranscript } from "@/lib/telephony/urgent";

/**
 * Urgent-call detection (Twilio receptionist PR 6). Conservative by design: real
 * emergencies transfer, routine enquiries do not, and empty input is never urgent.
 */
describe("isUrgentTranscript", () => {
  it("flags genuine emergencies", () => {
    for (const t of [
      "I think there's a gas leak",
      "my kitchen is flooding",
      "burst pipe water everywhere",
      "this is an emergency",
      "I need someone urgently",
      "there's a burning smell and sparking",
      "we have no heating and it's freezing",
      "I need this sorted ASAP",
    ]) {
      expect(isUrgentTranscript(t)).toBe(true);
    }
  });

  it("does NOT flag routine enquiries", () => {
    for (const t of [
      "my boiler needs a service",
      "can I get a quote for a new bathroom",
      "what are your opening hours",
      "I'd like to book someone in next week",
      "the tap drips a little",
      "",
      "hi",
    ]) {
      expect(isUrgentTranscript(t)).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isUrgentTranscript("  GAS   LEAK  ")).toBe(true);
    expect(isUrgentTranscript("EMERGENCY")).toBe(true);
  });
});
