import { describe, it, expect } from "vitest";
import {
  entryHours,
  totalBreakMs,
  isOpen,
  isOnBreak,
  overlapMs,
  hoursInWindow,
  hoursByUser,
  hoursByJob,
  startOfWeekIso,
  startOfMonthIso,
  addDaysIso,
  isWithinLeave,
  type TimeEntry,
} from "@/lib/time/compute";

const baseEntry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: "e1",
  user_id: "u1",
  job_id: null,
  started_at: "2026-05-19T08:00:00Z",
  ended_at: "2026-05-19T16:00:00Z",
  breaks: [],
  ...over,
});

describe("entryHours", () => {
  it("returns 8h for a clean 08:00–16:00 entry with no breaks", () => {
    expect(entryHours(baseEntry())).toBe(8);
  });

  it("deducts break time", () => {
    const e = baseEntry({
      breaks: [
        { started_at: "2026-05-19T12:00:00Z", ended_at: "2026-05-19T12:30:00Z" },
      ],
    });
    expect(entryHours(e)).toBe(7.5);
  });

  it("ignores zero-length or inverted breaks", () => {
    const e = baseEntry({
      breaks: [
        { started_at: "2026-05-19T12:00:00Z", ended_at: "2026-05-19T12:00:00Z" },
        { started_at: "2026-05-19T13:00:00Z", ended_at: "2026-05-19T12:00:00Z" },
      ],
    });
    expect(entryHours(e)).toBe(8);
  });

  it("counts an open entry up to `now`", () => {
    const e = baseEntry({
      started_at: "2026-05-19T08:00:00Z",
      ended_at: null,
    });
    const now = new Date("2026-05-19T11:30:00Z");
    expect(entryHours(e, now)).toBe(3.5);
  });

  it("returns 0 for a future-starting entry", () => {
    const e = baseEntry({
      started_at: "2026-06-01T08:00:00Z",
      ended_at: null,
    });
    expect(entryHours(e, new Date("2026-05-19T08:00:00Z"))).toBe(0);
  });

  it("never returns negative hours (oversized break)", () => {
    const e = baseEntry({
      breaks: [
        { started_at: "2026-05-19T08:00:00Z", ended_at: "2026-05-19T20:00:00Z" },
      ],
    });
    expect(entryHours(e)).toBe(0);
  });
});

describe("totalBreakMs + isOnBreak", () => {
  it("sums multiple closed breaks", () => {
    const e = baseEntry({
      breaks: [
        { started_at: "2026-05-19T10:00:00Z", ended_at: "2026-05-19T10:15:00Z" },
        { started_at: "2026-05-19T12:00:00Z", ended_at: "2026-05-19T12:30:00Z" },
      ],
    });
    expect(totalBreakMs(e.breaks!)).toBe(45 * 60 * 1000);
  });

  it("an open break (ended_at null) counts to `now`", () => {
    const e = baseEntry({
      ended_at: null,
      breaks: [{ started_at: "2026-05-19T12:00:00Z", ended_at: null }],
    });
    const now = new Date("2026-05-19T12:10:00Z");
    expect(totalBreakMs(e.breaks!, now)).toBe(10 * 60 * 1000);
    expect(isOpen(e)).toBe(true);
    expect(isOnBreak(e)).toBe(true);
  });
});

describe("overlapMs + hoursInWindow", () => {
  it("returns 0 for entries entirely outside the window", () => {
    const e = baseEntry({ started_at: "2026-05-19T08:00:00Z", ended_at: "2026-05-19T09:00:00Z" });
    expect(
      overlapMs(e, new Date("2026-05-20T00:00:00Z"), new Date("2026-05-21T00:00:00Z")),
    ).toBe(0);
  });

  it("clips to the window edges", () => {
    const e = baseEntry({ started_at: "2026-05-19T22:00:00Z", ended_at: "2026-05-20T02:00:00Z" });
    const inside = overlapMs(
      e,
      new Date("2026-05-20T00:00:00Z"),
      new Date("2026-05-21T00:00:00Z"),
    );
    expect(inside).toBe(2 * 3600 * 1000);
  });

  it("hoursInWindow proportionally deducts breaks", () => {
    // 8h day, 1h break. Window covers exactly half. Expect 3.5h net.
    const e = baseEntry({
      started_at: "2026-05-19T08:00:00Z",
      ended_at: "2026-05-19T16:00:00Z",
      breaks: [
        { started_at: "2026-05-19T11:00:00Z", ended_at: "2026-05-19T12:00:00Z" },
      ],
    });
    const half = hoursInWindow(
      [e],
      new Date("2026-05-19T08:00:00Z"),
      new Date("2026-05-19T12:00:00Z"),
    );
    expect(half).toBe(3.5);
  });
});

describe("hoursByUser + hoursByJob", () => {
  it("aggregates per user", () => {
    const entries = [
      baseEntry({ id: "a", user_id: "u1", started_at: "2026-05-19T08:00:00Z", ended_at: "2026-05-19T12:00:00Z" }),
      baseEntry({ id: "b", user_id: "u1", started_at: "2026-05-19T13:00:00Z", ended_at: "2026-05-19T17:00:00Z" }),
      baseEntry({ id: "c", user_id: "u2", started_at: "2026-05-19T09:00:00Z", ended_at: "2026-05-19T13:00:00Z" }),
    ];
    const out = hoursByUser(
      entries,
      new Date("2026-05-19T00:00:00Z"),
      new Date("2026-05-20T00:00:00Z"),
    );
    expect(out.get("u1")).toBe(8);
    expect(out.get("u2")).toBe(4);
  });

  it("hoursByJob ignores entries without a job_id", () => {
    const entries = [
      baseEntry({ job_id: "job-A", started_at: "2026-05-19T08:00:00Z", ended_at: "2026-05-19T12:00:00Z" }),
      baseEntry({ job_id: null, started_at: "2026-05-19T13:00:00Z", ended_at: "2026-05-19T17:00:00Z" }),
    ];
    const out = hoursByJob(
      entries,
      new Date("2026-05-19T00:00:00Z"),
      new Date("2026-05-20T00:00:00Z"),
    );
    expect(out.get("job-A")).toBe(4);
    expect(out.has(null as unknown as string)).toBe(false);
  });
});

describe("week / month boundaries", () => {
  it("startOfWeekIso returns Monday for a Tuesday", () => {
    expect(startOfWeekIso(new Date("2026-05-19T10:00:00Z"))).toBe("2026-05-18");
  });
  it("startOfWeekIso returns Monday-of-prev-week for a Sunday", () => {
    expect(startOfWeekIso(new Date("2026-05-17T10:00:00Z"))).toBe("2026-05-11");
  });
  it("startOfMonthIso returns the 1st of the month", () => {
    expect(startOfMonthIso(new Date("2026-05-19T10:00:00Z"))).toBe("2026-05-01");
  });
  it("addDaysIso walks across month boundaries", () => {
    expect(addDaysIso("2026-05-30", 3)).toBe("2026-06-02");
    expect(addDaysIso("2026-05-01", -1)).toBe("2026-04-30");
  });
});

describe("isWithinLeave", () => {
  const approved = {
    starts_at: "2026-05-19T00:00:00Z",
    ends_at: "2026-05-20T23:59:59Z",
    status: "approved",
  };
  it("true when instant falls inside an approved leave", () => {
    expect(isWithinLeave(new Date("2026-05-19T12:00:00Z"), approved)).toBe(true);
  });
  it("false for an instant outside the window", () => {
    expect(isWithinLeave(new Date("2026-05-21T12:00:00Z"), approved)).toBe(false);
  });
  it("false for a pending leave even if the date matches", () => {
    expect(
      isWithinLeave(new Date("2026-05-19T12:00:00Z"), { ...approved, status: "pending" }),
    ).toBe(false);
  });
});
