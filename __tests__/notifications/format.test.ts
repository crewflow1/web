import { describe, it, expect } from "vitest";
import { relativeTime, unreadCount, badgeText } from "@/lib/notifications/format";

describe("relativeTime", () => {
  const now = new Date("2026-05-20T12:00:00Z");

  it("returns Xs ago for seconds", () => {
    expect(relativeTime("2026-05-20T11:59:30Z", now)).toBe("30s ago");
  });
  it("returns Xm ago for minutes", () => {
    expect(relativeTime("2026-05-20T11:30:00Z", now)).toBe("30m ago");
  });
  it("returns Xh ago for hours", () => {
    expect(relativeTime("2026-05-20T08:00:00Z", now)).toBe("4h ago");
  });
  it("returns Xd ago for days", () => {
    expect(relativeTime("2026-05-15T12:00:00Z", now)).toBe("5d ago");
  });
  it("returns Xmo ago for months", () => {
    expect(relativeTime("2026-02-20T12:00:00Z", now)).toBe("2mo ago");
  });
  it("returns Xy ago for years", () => {
    expect(relativeTime("2024-05-20T12:00:00Z", now)).toBe("2y ago");
  });
  it("handles future timestamps gracefully", () => {
    expect(relativeTime("2027-01-01T00:00:00Z", now)).toBe("just now");
  });
  it("returns — for invalid dates", () => {
    expect(relativeTime("not-a-date", now)).toBe("—");
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
