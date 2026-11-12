import { describe, it, expect } from "vitest";
import {
  decideAnswering,
  isWithinBusinessHours,
  localParts,
  defaultAnsweringConfig,
  type AnsweringConfig,
} from "@/lib/telephony/answering-policy";

const base = (over: Partial<AnsweringConfig> = {}): AnsweringConfig => ({
  ...defaultAnsweringConfig(),
  enabled: true,
  hasStaffNumbers: true,
  ...over,
});

describe("localParts — timezone correctness (pure, Intl-based)", () => {
  it("maps a winter (GMT) instant to London local parts", () => {
    // 2026-01-05 is a Monday. 10:00Z = 10:00 London (GMT).
    const p = localParts(new Date("2026-01-05T10:00:00Z"), "Europe/London");
    expect(p.weekday).toBe("mon");
    expect(p.minutes).toBe(10 * 60);
    expect(p.date).toBe("2026-01-05");
  });
  it("applies BST (+1) for a summer instant", () => {
    // 2026-07-06 Monday. 08:00Z = 09:00 London (BST).
    const p = localParts(new Date("2026-07-06T08:00:00Z"), "Europe/London");
    expect(p.weekday).toBe("mon");
    expect(p.minutes).toBe(9 * 60);
  });
});

describe("isWithinBusinessHours", () => {
  const cfg = base(); // Mon–Fri 09:00–17:00 Europe/London, Sat/Sun closed
  it("open mid-morning on a weekday", () => {
    expect(isWithinBusinessHours(cfg, new Date("2026-01-05T10:00:00Z"))).toBe(true);
  });
  it("closed before opening (08:59 BST)", () => {
    expect(isWithinBusinessHours(cfg, new Date("2026-07-06T07:58:00Z"))).toBe(false); // 08:58 BST
  });
  it("closed at/after closing (17:00 is exclusive)", () => {
    expect(isWithinBusinessHours(cfg, new Date("2026-01-05T17:00:00Z"))).toBe(false);
    expect(isWithinBusinessHours(cfg, new Date("2026-01-05T16:59:00Z"))).toBe(true);
  });
  it("closed on a weekend", () => {
    expect(isWithinBusinessHours(cfg, new Date("2026-01-04T12:00:00Z"))).toBe(false); // Sunday
  });
  it("closed on a bank-holiday / exceptional closure date", () => {
    const c = base({ closures: ["2026-01-05"] });
    expect(isWithinBusinessHours(c, new Date("2026-01-05T10:00:00Z"))).toBe(false);
  });
  it("malformed hours fail safe to closed", () => {
    const c = base({ weekly: { mon: { open: "nope", close: "17:00" } } });
    expect(isWithinBusinessHours(c, new Date("2026-01-05T10:00:00Z"))).toBe(false);
  });
});

describe("decideAnswering — master switch", () => {
  it("disabled → no AI, no routing", () => {
    expect(decideAnswering(base({ enabled: false }), new Date("2026-01-05T10:00:00Z")).action).toBe("disabled");
  });
  it("staff already answered → human_handled", () => {
    expect(decideAnswering(base(), new Date("2026-01-05T10:00:00Z"), "answered").action).toBe("human_handled");
  });
});

describe("decideAnswering — mode: both (default)", () => {
  const cfg = base({ mode: "both" });
  it("within hours, first leg → ring staff with configured timeout", () => {
    const d = decideAnswering(cfg, new Date("2026-01-05T10:00:00Z"), "no_attempt_yet");
    expect(d.action).toBe("ring_staff");
    if (d.action === "ring_staff") expect(d.ringSeconds).toBe(20);
  });
  it("within hours, staff missed → AI answers", () => {
    expect(decideAnswering(cfg, new Date("2026-01-05T10:00:00Z"), "no_answer").action).toBe("ai_answer");
  });
  it("outside hours → AI answers directly (no point ringing a closed office)", () => {
    expect(decideAnswering(cfg, new Date("2026-01-05T20:00:00Z"), "no_attempt_yet").action).toBe("ai_answer");
  });
});

describe("decideAnswering — mode: missed_only", () => {
  const cfg = base({ mode: "missed_only" });
  it("always rings staff first (even out of hours)", () => {
    expect(decideAnswering(cfg, new Date("2026-01-05T20:00:00Z"), "no_attempt_yet").action).toBe("ring_staff");
  });
  it("staff busy → AI answers", () => {
    expect(decideAnswering(cfg, new Date("2026-01-05T10:00:00Z"), "busy").action).toBe("ai_answer");
  });
});

describe("decideAnswering — mode: out_of_hours", () => {
  const cfg = base({ mode: "out_of_hours" });
  it("within hours, first leg → rings staff (the open office gets the call)", () => {
    expect(decideAnswering(cfg, new Date("2026-01-05T10:00:00Z"), "no_attempt_yet").action).toBe("ring_staff");
  });
  it("within hours, staff missed → take a message (AI stays out, not dropped)", () => {
    expect(decideAnswering(cfg, new Date("2026-01-05T10:00:00Z"), "no_answer").action).toBe("take_message");
    expect(decideAnswering(cfg, new Date("2026-01-05T10:00:00Z"), "busy").action).toBe("take_message");
  });
  it("within hours, no staff numbers → take a message (AI stays out)", () => {
    const noStaff = base({ mode: "out_of_hours", hasStaffNumbers: false });
    expect(decideAnswering(noStaff, new Date("2026-01-05T10:00:00Z"), "no_attempt_yet").action).toBe("take_message");
  });
  it("outside hours → AI answers directly", () => {
    expect(decideAnswering(cfg, new Date("2026-01-05T20:00:00Z"), "no_attempt_yet").action).toBe("ai_answer");
  });
});

describe("decideAnswering — no staff numbers configured", () => {
  it("both mode within hours but no staff numbers → AI answers (nobody to ring)", () => {
    const cfg = base({ mode: "both", hasStaffNumbers: false });
    expect(decideAnswering(cfg, new Date("2026-01-05T10:00:00Z"), "no_attempt_yet").action).toBe("ai_answer");
  });
});
