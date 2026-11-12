import { describe, it, expect } from "vitest";
import {
  aiReceptionistSetupSchema,
  normaliseE164,
  parseClosureDates,
  parseStaffNumbers,
  parseWeeklyHours,
} from "@/lib/ai-receptionist/schema";

/**
 * Settings-side parsing for the structured answering policy (Twilio receptionist
 * PR 3). The pure helpers + the Zod schema's new fields are validated here so a
 * bad value never reaches the ai_receptionist_setups row.
 */

describe("normaliseE164", () => {
  it("accepts and cleans valid international numbers", () => {
    expect(normaliseE164("+44 7700 900123")).toBe("+447700900123");
    expect(normaliseE164("+1 (415) 555-0100")).toBe("+14155550100");
  });
  it("rejects non-E.164 values", () => {
    expect(normaliseE164("07700900123")).toBeNull(); // no country code
    expect(normaliseE164("hello")).toBeNull();
    expect(normaliseE164("")).toBeNull();
    expect(normaliseE164(null)).toBeNull();
  });
});

describe("parseStaffNumbers", () => {
  it("parses newline/comma lists, dedupes, and flags invalid tokens", () => {
    const r = parseStaffNumbers("+447700900123\n+44 7700 900124, 07700900125\n+447700900123");
    expect(r.numbers).toEqual(["+447700900123", "+447700900124"]);
    expect(r.invalid).toEqual(["07700900125"]);
  });
  it("empty → empty", () => {
    expect(parseStaffNumbers("")).toEqual({ numbers: [], invalid: [] });
    expect(parseStaffNumbers(null)).toEqual({ numbers: [], invalid: [] });
  });
});

describe("parseClosureDates", () => {
  it("keeps valid YYYY-MM-DD, dedupes, flags the rest", () => {
    const r = parseClosureDates("2026-12-25\n2026-12-25, 25/12/2026\n2026-13-40");
    expect(r.dates).toEqual(["2026-12-25"]);
    expect(r.invalid).toEqual(["25/12/2026", "2026-13-40"]);
  });
});

describe("parseWeeklyHours", () => {
  const get = (map: Record<string, string>) => (name: string) => map[name] ?? null;

  it("marks a day closed when the closed box is set", () => {
    const { weekly, errors } = parseWeeklyHours(get({ hours_mon_closed: "on" }));
    expect(weekly.mon).toBeNull();
    expect(errors).toEqual({});
  });
  it("parses a valid open/close window", () => {
    const { weekly, errors } = parseWeeklyHours(
      get({ hours_tue_open: "08:30", hours_tue_close: "17:00" }),
    );
    expect(weekly.tue).toEqual({ open: "08:30", close: "17:00" });
    expect(errors).toEqual({});
  });
  it("errors on malformed times and on close<=open", () => {
    const bad = parseWeeklyHours(get({ hours_wed_open: "9am", hours_wed_close: "17:00" }));
    expect(bad.errors.hours_wed).toMatch(/HH:MM/);
    expect(bad.weekly.wed).toBeNull();

    const inverted = parseWeeklyHours(get({ hours_thu_open: "17:00", hours_thu_close: "09:00" }));
    expect(inverted.errors.hours_thu).toMatch(/after opening/);
  });
  it("neither time nor closed → treated as closed (safe default)", () => {
    const { weekly } = parseWeeklyHours(get({}));
    expect(weekly.fri).toBeNull();
  });
});

describe("aiReceptionistSetupSchema — new scalar fields", () => {
  const base = { enabled: "false" };

  it("defaults answering_mode to both and clamps ring timeout", () => {
    const r = aiReceptionistSetupSchema.safeParse({
      ...base,
      answering_mode: "",
      ring_timeout_seconds: "999",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.answering_mode).toBe("both");
      expect(r.data.ring_timeout_seconds).toBe(120);
      expect(r.data.timezone).toBe("Europe/London");
    }
  });

  it("keeps a valid mode and a valid ring timeout", () => {
    const r = aiReceptionistSetupSchema.safeParse({
      ...base,
      answering_mode: "missed_only",
      ring_timeout_seconds: "30",
    });
    expect(r.success && r.data.answering_mode).toBe("missed_only");
    expect(r.success && r.data.ring_timeout_seconds).toBe(30);
  });

  it("rejects a non-E.164 fallback number", () => {
    const r = aiReceptionistSetupSchema.safeParse({ ...base, fallback_number: "07700900123" });
    expect(r.success).toBe(false);
  });

  it("requires a consent message when recording is enabled", () => {
    const off = aiReceptionistSetupSchema.safeParse({ ...base, recording_enabled: "on" });
    expect(off.success).toBe(false); // consent missing
    const on = aiReceptionistSetupSchema.safeParse({
      ...base,
      recording_enabled: "on",
      recording_consent_message: "This call may be recorded.",
    });
    expect(on.success).toBe(true);
  });

  it("parses checkbox booleans", () => {
    const r = aiReceptionistSetupSchema.safeParse({
      ...base,
      notify_email: "on",
      notify_sms: "",
    });
    expect(r.success && r.data.notify_email).toBe(true);
    expect(r.success && r.data.notify_sms).toBe(false);
  });
});
