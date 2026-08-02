import { describe, it, expect } from "vitest";
import {
  computeNextRun,
  isValidCron,
  parseCron,
  CronParseError,
} from "@/lib/automation/cron";

/**
 * Deterministic cron evaluation (lib/automation/cron.ts).
 *
 * The schedule drain's concurrency safety rests on `computeNextRun` being a PURE
 * function of (expression, from): two drains that observe the same next_run_at
 * must compute the SAME next occurrence, or the optimistic claim would advance to
 * different instants and the idempotency argument would collapse. These tests pin
 * that determinism, the UTC anchoring, and the field grammar.
 */

const at = (iso: string) => new Date(iso);

describe("parseCron — grammar + validation", () => {
  it("accepts the standard 5-field forms", () => {
    for (const e of [
      "* * * * *",
      "0 9 * * 1",
      "*/15 * * * *",
      "0 0 1 * *",
      "0 9-17 * * 1-5",
      "0 9,12,17 * * *",
      "30 6 1,15 */2 *",
    ]) {
      expect(isValidCron(e), e).toBe(true);
    }
  });

  it("rejects malformed expressions", () => {
    for (const e of [
      "",
      "* * * *", //       4 fields
      "* * * * * *", //   6 fields
      "60 * * * *", //    minute out of range
      "* 24 * * *", //    hour out of range
      "* * 0 * *", //     day-of-month below 1
      "* * * 13 *", //    month out of range
      "*/0 * * * *", //   zero step
      "5-1 * * * *", //   inverted range
      "abc * * * *", //   non-numeric
    ]) {
      expect(isValidCron(e), e).toBe(false);
    }
  });

  it("throws CronParseError with a field-specific message", () => {
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
  });

  it("treats day-of-week 7 as Sunday (0)", () => {
    // 0 0 * * 7  == Sunday midnight. 4 Jan 2026 is a Sunday.
    const next = computeNextRun("0 0 * * 7", at("2026-01-01T12:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(next.getUTCDay()).toBe(0);
  });
});

describe("computeNextRun — determinism + correctness (UTC)", () => {
  it("is a pure function: same inputs → same output", () => {
    const from = at("2026-08-02T10:03:11.000Z");
    const a = computeNextRun("0 9 * * 1", from);
    const b = computeNextRun("0 9 * * 1", from);
    expect(a.toISOString()).toBe(b.toISOString());
  });

  it("returns the next whole minute strictly after `from` for '* * * * *'", () => {
    expect(
      computeNextRun("* * * * *", at("2026-08-02T10:03:11.500Z")).toISOString(),
    ).toBe("2026-08-02T10:04:00.000Z");
    // Exactly on a minute boundary still advances (STRICTLY after).
    expect(
      computeNextRun("* * * * *", at("2026-08-02T10:04:00.000Z")).toISOString(),
    ).toBe("2026-08-02T10:05:00.000Z");
  });

  it("*/15 steps to the next quarter hour", () => {
    expect(
      computeNextRun("*/15 * * * *", at("2026-08-02T10:03:00.000Z")).toISOString(),
    ).toBe("2026-08-02T10:15:00.000Z");
    expect(
      computeNextRun("*/15 * * * *", at("2026-08-02T10:59:30.000Z")).toISOString(),
    ).toBe("2026-08-02T11:00:00.000Z");
  });

  it("'0 9 * * 1' finds the next Monday 09:00 UTC", () => {
    // 2 Aug 2026 is a Sunday → next Monday is the 3rd.
    expect(
      computeNextRun("0 9 * * 1", at("2026-08-02T10:00:00.000Z")).toISOString(),
    ).toBe("2026-08-03T09:00:00.000Z");
  });

  it("'0 0 1 * *' rolls into the next month", () => {
    expect(
      computeNextRun("0 0 1 * *", at("2026-08-15T00:00:00.000Z")).toISOString(),
    ).toBe("2026-09-01T00:00:00.000Z");
  });

  it("anchors in UTC, not local time (no BST drift)", () => {
    // 1 Jul 2026 is BST (UTC+1) in London. A UTC-anchored '0 9 * * *' is 09:00Z
    // regardless of the season — the property the drain relies on.
    expect(
      computeNextRun("0 9 * * *", at("2026-07-01T08:30:00.000Z")).toISOString(),
    ).toBe("2026-07-01T09:00:00.000Z");
  });

  it("applies the POSIX dom/dow UNION when both are restricted", () => {
    // '0 0 13 * 5' = midnight on the 13th OR any Friday. From 1 Aug 2026, the
    // first Friday is the 7th — earlier than the 13th, so the union picks it.
    expect(
      computeNextRun("0 0 13 * 5", at("2026-08-01T00:00:00.000Z")).toISOString(),
    ).toBe("2026-08-07T00:00:00.000Z");
  });

  it("resolves a sparse leap-day schedule without spinning", () => {
    // '0 0 29 2 *' — 29 Feb. 2028 is the next leap year.
    expect(
      computeNextRun("0 0 29 2 *", at("2026-03-01T00:00:00.000Z")).toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
  });

  it("treats a stepped day-of-month field as RESTRICTED, not a wildcard", () => {
    // Regression: '*/n' on dom/dow is a restricted field (value subset), so it
    // must fire every nth day — NOT every day. '0 9 */3 * *' from the 1st (a
    // matching day) advances to the 4th, not the 2nd.
    expect(
      computeNextRun("0 9 */3 * *", at("2026-08-01T09:00:00.000Z")).toISOString(),
    ).toBe("2026-08-04T09:00:00.000Z");
  });

  it("treats a stepped day-of-week field as RESTRICTED, not a wildcard", () => {
    // '0 9 * * */2' = every other weekday starting Sunday(0): Sun, Tue, Thu, Sat.
    // From Sun 2 Aug 2026 10:00 the next match is Tue the 4th — NOT Mon the 3rd.
    expect(
      computeNextRun("0 9 * * */2", at("2026-08-02T10:00:00.000Z")).toISOString(),
    ).toBe("2026-08-04T09:00:00.000Z");
  });
});
