import { describe, it, expect } from "vitest";
import {
  RELATIVE_TIME_PRESETS,
  relativeTime,
  relativeTimeVerbose,
} from "@/lib/time/relative";

/**
 * Spec for the consolidated relative-time formatter.
 *
 * Every case pins a FIXED `now` — never the real clock — so a boundary
 * assertion means the same thing at 23:59 as at noon, and in any CI timezone.
 * Date-bearing outputs are Europe/London-pinned by construction, so they are
 * stable regardless of the runner's TZ.
 */

const NOW = new Date("2026-05-20T12:00:00.000Z");
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

/** An ISO string exactly `ms` before the fixed `now`. Negative = future. */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("relativeTime — defaults (minute precision, ISO-date overflow)", () => {
  const at = (ms: number) => relativeTime(ago(ms), { now: NOW });

  it("floors sub-minute to 'just now'", () => {
    expect(at(0)).toBe("just now");
    expect(at(1 * S)).toBe("just now");
  });

  it("holds 'just now' at the 59s/60s boundary", () => {
    expect(at(59 * S)).toBe("just now");
    expect(at(60 * S)).toBe("1m ago");
  });

  it("switches minutes to hours at the 59m/60m boundary", () => {
    expect(at(59 * M)).toBe("59m ago");
    expect(at(60 * M)).toBe("1h ago");
  });

  it("floors rather than rounds within a unit", () => {
    expect(at(90 * S)).toBe("1m ago");
    expect(at(90 * M)).toBe("1h ago");
    expect(at(23.5 * H)).toBe("23h ago");
  });

  it("switches hours to days at the 23h/24h boundary", () => {
    expect(at(23 * H)).toBe("23h ago");
    expect(at(24 * H)).toBe("1d ago");
  });

  it("overflows at the 29d/30d boundary", () => {
    expect(at(29 * D)).toBe("29d ago");
    expect(at(30 * D)).toBe("2026-04-20");
  });

  it("echoes the stored ISO date once overflowed", () => {
    expect(at(730 * D)).toBe("2024-05-20");
    expect(relativeTime("2020-01-15T10:00:00.000Z", { now: NOW })).toBe(
      "2020-01-15",
    );
  });

  it("surfaces the date for a future timestamp rather than a negative count", () => {
    expect(at(-1 * H)).toBe("2026-05-20");
    expect(at(-8 * D)).toBe("2026-05-28");
  });

  it("returns the invalid fallback for absent input", () => {
    expect(relativeTime(null, { now: NOW })).toBe("—");
    expect(relativeTime(undefined, { now: NOW })).toBe("—");
    expect(relativeTime("", { now: NOW })).toBe("—");
  });

  it("returns the invalid fallback for unparseable input", () => {
    expect(relativeTime("not-a-date", { now: NOW })).toBe("—");
    expect(relativeTime("2026-13-45", { now: NOW })).toBe("—");
  });

  it("defaults `now` to the real clock when not injected", () => {
    // Only assertion safe against a live clock: a just-created timestamp is
    // sub-minute. Everything else in this file pins `now`.
    expect(relativeTime(new Date().toISOString())).toBe("just now");
  });
});

describe("relativeTime — second precision", () => {
  const at = (ms: number) =>
    relativeTime(ago(ms), { now: NOW, precision: "second" });

  it("resolves seconds instead of collapsing to 'just now'", () => {
    expect(at(0)).toBe("0s ago");
    expect(at(1 * S)).toBe("1s ago");
    expect(at(30 * S)).toBe("30s ago");
  });

  it("hands over to minutes at the 59s/60s boundary", () => {
    expect(at(59 * S)).toBe("59s ago");
    expect(at(60 * S)).toBe("1m ago");
  });

  it("shares the minute-and-up ladder with minute precision", () => {
    expect(at(59 * M)).toBe("59m ago");
    expect(at(60 * M)).toBe("1h ago");
    expect(at(23 * H)).toBe("23h ago");
    expect(at(24 * H)).toBe("1d ago");
  });
});

describe("relativeTime — overflow: extend", () => {
  const at = (ms: number) =>
    relativeTime(ago(ms), { now: NOW, overflow: "extend" });

  it("keeps counting in months past 30 days", () => {
    expect(at(29 * D)).toBe("29d ago");
    expect(at(30 * D)).toBe("1mo ago");
    expect(at(60 * D)).toBe("2mo ago");
  });

  it("switches months to years at the 11mo/12mo boundary", () => {
    expect(at(359 * D)).toBe("11mo ago");
    expect(at(360 * D)).toBe("1y ago");
  });

  it("never emits a bare day count for an ancient timestamp", () => {
    expect(at(730 * D)).toBe("2y ago");
    expect(at(3650 * D)).toBe("10y ago");
  });

  it("collapses a future timestamp to 'just now'", () => {
    expect(at(-1 * H)).toBe("just now");
    expect(at(-8 * D)).toBe("just now");
  });
});

describe("relativeTime — overflow: dayMonth", () => {
  const at = (ms: number) =>
    relativeTime(ago(ms), { now: NOW, overflow: "dayMonth" });

  it("renders day + month with no year past 30 days", () => {
    expect(at(29 * D)).toBe("29d ago");
    expect(at(30 * D)).toBe("20 Apr");
    expect(at(730 * D)).toBe("20 May");
  });

  it("collapses a future timestamp to 'just now'", () => {
    expect(at(-1 * H)).toBe("just now");
  });

  it("pins the overflow date to Europe/London, not the runtime zone", () => {
    // 23:30 UTC in BST is the NEXT London day. A no-timeZone toLocaleDateString
    // renders the UTC day on a UTC server — the bug lib/time/format.ts warns
    // about, and the reason this branch goes through formatDayMonthUK.
    const iso = "2026-05-20T23:30:00.000Z";
    const later = new Date("2026-07-20T12:00:00.000Z");
    expect(
      new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }),
    ).toBe("20 May");
    expect(relativeTime(iso, { now: later, overflow: "dayMonth" })).toBe(
      "21 May",
    );
  });
});

describe("relativeTime — rounding: nearest", () => {
  const at = (ms: number) =>
    relativeTime(ago(ms), { now: NOW, rounding: "nearest" });

  it("rounds sub-minute up from the half-minute mark", () => {
    expect(at(29 * S)).toBe("just now");
    expect(at(30 * S)).toBe("1m ago");
    expect(at(45 * S)).toBe("1m ago");
    expect(at(59 * S)).toBe("1m ago");
  });

  it("does not double-round: minutes come off the millisecond diff", () => {
    // round(round(29_500 / 1000) / 60) would be 1 ("1m ago"); the contract is
    // round(29_500 / 60_000) = 0.
    expect(at(29.5 * S)).toBe("just now");
  });

  it("rounds minutes to the nearest hour", () => {
    expect(at(89 * M)).toBe("1h ago");
    expect(at(91 * M)).toBe("2h ago");
  });

  it("cascades: hours round off the already-rounded minutes", () => {
    expect(at(23.5 * H)).toBe("1d ago");
    // 29d12h rounds up to 30 days, so `nearest` overflows a day EARLIER than
    // `floor` does — the clearest consequence of the cascade.
    expect(at(29.5 * D)).toBe("2026-04-21");
    expect(relativeTime(ago(29.5 * D), { now: NOW })).toBe("29d ago");
  });

  it("leaves exact unit boundaries unchanged", () => {
    expect(at(60 * S)).toBe("1m ago");
    expect(at(60 * M)).toBe("1h ago");
    expect(at(24 * H)).toBe("1d ago");
    expect(at(29 * D)).toBe("29d ago");
  });
});

describe("relativeTime — invalid fallback is configurable", () => {
  it("honours an empty-string fallback", () => {
    expect(relativeTime(null, { now: NOW, invalid: "" })).toBe("");
    expect(relativeTime("not-a-date", { now: NOW, invalid: "" })).toBe("");
  });

  it("honours a custom justNowLabel", () => {
    expect(
      relativeTime(ago(10 * S), { now: NOW, justNowLabel: "moments ago" }),
    ).toBe("moments ago");
  });
});

describe("RELATIVE_TIME_PRESETS", () => {
  it("notification: seconds up front, months and years at the tail", () => {
    const p = RELATIVE_TIME_PRESETS.notification;
    expect(relativeTime(ago(30 * S), { ...p, now: NOW })).toBe("30s ago");
    expect(relativeTime(ago(5 * D), { ...p, now: NOW })).toBe("5d ago");
    expect(relativeTime(ago(30 * D), { ...p, now: NOW })).toBe("1mo ago");
    expect(relativeTime(ago(730 * D), { ...p, now: NOW })).toBe("2y ago");
    expect(relativeTime(ago(-1 * H), { ...p, now: NOW })).toBe("just now");
    expect(relativeTime(null, { ...p, now: NOW })).toBe("—");
  });

  it("hqConsole: nearest rounding, day+month tail, blank when absent", () => {
    const p = RELATIVE_TIME_PRESETS.hqConsole;
    expect(relativeTime(ago(45 * S), { ...p, now: NOW })).toBe("1m ago");
    expect(relativeTime(ago(23.5 * H), { ...p, now: NOW })).toBe("1d ago");
    expect(relativeTime(ago(30 * D), { ...p, now: NOW })).toBe("20 Apr");
    expect(relativeTime(ago(-1 * H), { ...p, now: NOW })).toBe("just now");
    expect(relativeTime(null, { ...p, now: NOW })).toBe("");
    expect(relativeTime("not-a-date", { ...p, now: NOW })).toBe("");
  });
});

describe("relativeTimeVerbose", () => {
  const at = (ms: number) => relativeTimeVerbose(ago(ms), NOW);

  it("uses the long Intl form for sub-minute", () => {
    expect(at(0)).toBe("now");
    expect(at(30 * S)).toBe("30 seconds ago");
    expect(at(59 * S)).toBe("59 seconds ago");
  });

  it("crosses to minutes, hours and days", () => {
    expect(at(60 * S)).toBe("1 minute ago");
    expect(at(5 * M)).toBe("5 minutes ago");
    expect(at(60 * M)).toBe("1 hour ago");
    expect(at(3 * H)).toBe("3 hours ago");
  });

  it("uses the natural word for a single day", () => {
    expect(at(24 * H)).toBe("yesterday");
    expect(at(6 * D)).toBe("6 days ago");
  });

  it("falls back to a full London-pinned date past a week", () => {
    expect(at(7 * D)).toBe("13 May 2026");
    expect(at(730 * D)).toBe("20 May 2024");
  });

  it("renders future timestamps forwards", () => {
    expect(at(-1 * H)).toBe("in 1 hour");
    expect(at(-2 * D)).toBe("in 2 days");
    expect(at(-8 * D)).toBe("28 May 2026");
  });

  it("returns the raw input unchanged when unparseable", () => {
    expect(relativeTimeVerbose("not-a-date", NOW)).toBe("not-a-date");
    expect(relativeTimeVerbose("", NOW)).toBe("");
  });

  it("defaults `now` to the real clock when not injected", () => {
    expect(relativeTimeVerbose(new Date().toISOString())).toBe("now");
  });
});
