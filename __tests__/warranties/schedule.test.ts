import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeWarrantyClock,
  daysBetweenIso,
  NO_CERTIFICATE_NOTE,
} from "@/lib/warranties/schedule";

/**
 * Warranty clock — the derived dates, and the honest absence of them.
 *
 * The load-bearing case is the FIRST describe block: with no issued completion
 * certificate there is no start date, and the module must say so rather than
 * fall back to any other date on the job.
 */

describe("no completion certificate → no invented start date", () => {
  const clock = computeWarrantyClock({
    periodMonths: 12,
    serviceIntervalMonths: 12,
    certificateCompletionDate: null,
    today: "2026-07-31",
  });

  it("reports pending_completion, not active and not expired", () => {
    expect(clock.status).toBe("pending_completion");
  });

  it("returns NO start, NO expiry and NO days-remaining", () => {
    expect(clock.start).toBeNull();
    expect(clock.expiry).toBeNull();
    expect(clock.daysRemaining).toBeNull();
  });

  it("derives no servicing schedule from a start date it does not have", () => {
    expect(clock.serviceSchedule).toEqual([]);
    expect(clock.nextService).toBeNull();
  });

  it("has one canonical sentence for the missing date", () => {
    expect(NO_CERTIFICATE_NOTE).toMatch(/completion certificate is issued/i);
  });

  it("the module never reaches for any other completion date", () => {
    // A regression here would mean somebody added a fallback input — most
    // plausibly jobs.practical_completion_date, the editable working field this
    // module exists to refuse. Asserted against the source, comments stripped,
    // so a docblock explaining the rule can't satisfy it.
    const src = readFileSync(
      resolve(__dirname, "..", "..", "lib/warranties/schedule.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("practical_completion");
    expect(src).not.toContain("scheduled_date");
    // Exactly one date input on the public entry point.
    const params = src.slice(src.indexOf("export function computeWarrantyClock"), src.indexOf("): WarrantyClock"));
    expect(params.match(/\w*[Dd]ate\w*(?=[?:])/g)).toEqual(["certificateCompletionDate"]);
  });
});

describe("with an issued certificate the clock is derived from it", () => {
  it("expires period_months after the frozen completion date", () => {
    const clock = computeWarrantyClock({
      periodMonths: 12,
      serviceIntervalMonths: null,
      certificateCompletionDate: "2026-03-15",
      today: "2026-07-31",
    });
    expect(clock.start).toBe("2026-03-15");
    expect(clock.expiry).toBe("2027-03-15");
    expect(clock.status).toBe("active");
    expect(clock.daysRemaining).toBe(daysBetweenIso("2026-07-31", "2027-03-15"));
  });

  it("clamps a month-end start (31 Jan + 1 month = 28 Feb)", () => {
    const clock = computeWarrantyClock({
      periodMonths: 1,
      serviceIntervalMonths: null,
      certificateCompletionDate: "2026-01-31",
      today: "2026-02-01",
    });
    expect(clock.expiry).toBe("2026-02-28");
  });

  it("reads expired once the term has run out", () => {
    const clock = computeWarrantyClock({
      periodMonths: 6,
      serviceIntervalMonths: null,
      certificateCompletionDate: "2025-01-10",
      today: "2026-07-31",
    });
    expect(clock.status).toBe("expired");
    expect(clock.daysRemaining!).toBeLessThan(0);
  });

  it("a voided warranty is void whatever the dates say", () => {
    const clock = computeWarrantyClock({
      periodMonths: 24,
      serviceIntervalMonths: null,
      certificateCompletionDate: "2026-03-15",
      voided: true,
      today: "2026-07-31",
    });
    expect(clock.status).toBe("void");
  });
});

describe("servicing occurrences are derived for display", () => {
  const clock = computeWarrantyClock({
    periodMonths: 36,
    serviceIntervalMonths: 12,
    certificateCompletionDate: "2025-01-10",
    today: "2026-07-31",
  });

  it("places one occurrence per interval inside the term", () => {
    expect(clock.serviceSchedule.map((o) => o.due)).toEqual([
      "2026-01-10",
      "2027-01-10",
      "2028-01-10",
    ]);
  });

  it("never schedules past the expiry — cover ends, so does the obligation", () => {
    for (const o of clock.serviceSchedule) {
      expect(daysBetweenIso(o.due, clock.expiry!)).toBeGreaterThanOrEqual(0);
    }
  });

  it("marks passed occurrences overdue and points nextService at the first future one", () => {
    expect(clock.serviceSchedule[0]!.state).toBe("overdue");
    expect(clock.nextService?.due).toBe("2027-01-10");
  });

  it("produces nothing when there is no servicing interval", () => {
    const none = computeWarrantyClock({
      periodMonths: 36,
      serviceIntervalMonths: null,
      certificateCompletionDate: "2025-01-10",
      today: "2026-07-31",
    });
    expect(none.serviceSchedule).toEqual([]);
  });

  it("caps a pathological interval/term combination", () => {
    const many = computeWarrantyClock({
      periodMonths: 600,
      serviceIntervalMonths: 1,
      certificateCompletionDate: "2000-01-01",
      today: "2026-07-31",
    });
    expect(many.serviceSchedule.length).toBeLessThanOrEqual(60);
  });
});
