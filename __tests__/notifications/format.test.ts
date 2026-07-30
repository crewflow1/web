import { describe, it, expect } from "vitest";
import { unreadCount, badgeText } from "@/lib/notifications/format";
import { RELATIVE_TIME_PRESETS, relativeTime } from "@/lib/time/relative";

/**
 * `relativeTime` moved to lib/time/relative.ts (one implementation, seven
 * former copies). The ladder this module documented is preserved verbatim as
 * `RELATIVE_TIME_PRESETS.notification`, so the original assertions are kept
 * here — retargeted at the preset — as the contract they always were.
 */
describe("relativeTime — notification preset", () => {
  const now = new Date("2026-05-20T12:00:00Z");
  const rel = (iso: string) =>
    relativeTime(iso, { ...RELATIVE_TIME_PRESETS.notification, now });

  it("returns Xs ago for seconds", () => {
    expect(rel("2026-05-20T11:59:30Z")).toBe("30s ago");
  });
  it("returns Xm ago for minutes", () => {
    expect(rel("2026-05-20T11:30:00Z")).toBe("30m ago");
  });
  it("returns Xh ago for hours", () => {
    expect(rel("2026-05-20T08:00:00Z")).toBe("4h ago");
  });
  it("returns Xd ago for days", () => {
    expect(rel("2026-05-15T12:00:00Z")).toBe("5d ago");
  });
  it("returns Xmo ago for months", () => {
    expect(rel("2026-02-20T12:00:00Z")).toBe("2mo ago");
  });
  it("returns Xy ago for years", () => {
    expect(rel("2024-05-20T12:00:00Z")).toBe("2y ago");
  });
  it("handles future timestamps gracefully", () => {
    expect(rel("2027-01-01T00:00:00Z")).toBe("just now");
  });
  it("returns — for invalid dates", () => {
    expect(rel("not-a-date")).toBe("—");
  });
});

describe("unreadCount", () => {
  it("counts only entries where read_at is null", () => {
    expect(
      unreadCount([
        { id: "a", read_at: null },
        { id: "b", read_at: "2026-05-19T00:00:00Z" },
        { id: "c", read_at: null },
      ]),
    ).toBe(2);
  });
  it("returns 0 for empty list", () => {
    expect(unreadCount([])).toBe(0);
  });
});

describe("badgeText", () => {
  it("returns empty string for 0", () => {
    expect(badgeText(0)).toBe("");
  });
  it("returns the number as string", () => {
    expect(badgeText(3)).toBe("3");
  });
  it("returns 9+ for values over 9", () => {
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(99)).toBe("9+");
  });
});
