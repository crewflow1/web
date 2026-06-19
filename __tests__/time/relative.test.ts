import { describe, it, expect } from "vitest";
import { relativeTime, relativeTimeVerbose } from "@/lib/time/relative";

/**
 * The single source of truth for relative-time formatting (Directive 007.5).
 * Five copy-pasted implementations now delegate here; these lock the core
 * contract that every surface depends on. The per-surface contracts
 * (notifications "Xs ago", ai-employees "—"/ISO) are pinned by their own
 * suites — this proves the options that reproduce them.
 */

describe("relativeTime — compact", () => {
  const now = new Date("2026-05-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("returns the placeholder for null / undefined / unparseable input", () => {
    expect(relativeTime(null, { now })).toBe("—");
    expect(relativeTime(undefined, { now })).toBe("—");
    expect(relativeTime("not-a-date", { now })).toBe("—");
  });

  it("floors sub-minute to 'just now' at the default minute precision", () => {
    expect(relativeTime(ago(30_000), { now })).toBe("just now");
  });

  it("resolves seconds when precision is 'second'", () => {
    expect(relativeTime(ago(30_000), { now, precision: "second" })).toBe(
      "30s ago",
    );
  });

  it("counts minutes, hours and days", () => {
    expect(relativeTime(ago(5 * 60_000), { now })).toBe("5m ago");
    expect(relativeTime(ago(3 * 3_600_000), { now })).toBe("3h ago");
    expect(relativeTime(ago(5 * 86_400_000), { now })).toBe("5d ago");
  });

  it("defaults to ISO-date overflow past 30 days", () => {
    expect(relativeTime("2020-01-15T10:00:00.000Z", { now })).toBe(
      "2020-01-15",
    );
  });

  it("'extend' overflow keeps counting in months and years", () => {
    expect(relativeTime(ago(60 * 86_400_000), { now, overflow: "extend" })).toBe(
      "2mo ago",
    );
    expect(
      relativeTime(ago(400 * 86_400_000), { now, overflow: "extend" }),
    ).toBe("1y ago");
  });

  it("honours a custom invalid placeholder", () => {
    expect(relativeTime("", { now, invalid: "" })).toBe("");
  });

  it("treats the future as 'just now' unless overflow surfaces the date", () => {
    const future = new Date(now.getTime() + 86_400_000).toISOString();
    expect(relativeTime(future, { now, overflow: "extend" })).toBe("just now");
    expect(relativeTime(future, { now })).toBe(future.slice(0, 10));
  });
});

describe("relativeTimeVerbose", () => {
  const now = new Date("2026-05-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("renders the Intl long form", () => {
    expect(relativeTimeVerbose(ago(30_000), now)).toBe("30 seconds ago");
    expect(relativeTimeVerbose(ago(5 * 60_000), now)).toBe("5 minutes ago");
    expect(relativeTimeVerbose(ago(3 * 3_600_000), now)).toBe("3 hours ago");
  });

  it("returns the raw input when it can't be parsed", () => {
    expect(relativeTimeVerbose("nope", now)).toBe("nope");
  });
});
