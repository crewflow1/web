import { describe, expect, it } from "vitest";
import {
  isOpenSnag,
  snagPriorityLabel,
  snagStatusLabel,
  summariseJobDiary,
  summariseJobSnags,
  type JobDiaryRow,
  type JobSnagRow,
} from "@/lib/site-ops/job-panels";

/**
 * Unit proofs for the job-page panel roll-ups. Pure: rows in, summary out.
 */

const TODAY = "2026-07-20";

function snag(over: Partial<JobSnagRow> & { id: string }): JobSnagRow {
  return {
    title: `Snag ${over.id}`,
    status: "open",
    priority: "medium",
    location: null,
    due_date: null,
    created_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function entry(over: Partial<JobDiaryRow> & { id: string }): JobDiaryRow {
  return {
    entry_date: "2026-07-18",
    weather: null,
    labour_count: null,
    work_summary: null,
    delays: null,
    created_at: "2026-07-18T17:00:00.000Z",
    ...over,
  };
}

describe("isOpenSnag", () => {
  it("treats only the terminal statuses as closed", () => {
    expect(isOpenSnag("open")).toBe(true);
    expect(isOpenSnag("in_progress")).toBe(true);
    expect(isOpenSnag("fixed")).toBe(true);
    expect(isOpenSnag("verified")).toBe(false);
    expect(isOpenSnag("wont_fix")).toBe(false);
  });
});

describe("snag labels", () => {
  it("uses the snag vocabulary and falls back to the raw value", () => {
    expect(snagStatusLabel("in_progress")).toBe("In progress");
    expect(snagPriorityLabel("high")).toBe("High");
    expect(snagStatusLabel("something_new")).toBe("something_new");
  });
});

describe("summariseJobSnags", () => {
  it("summarises an empty job", () => {
    const s = summariseJobSnags([], TODAY);
    expect(s.total).toBe(0);
    expect(s.open).toBe(0);
    expect(s.overdue).toBe(0);
    expect(s.openSnags).toEqual([]);
    expect(s.byPriority.map((p) => p.count)).toEqual([0, 0, 0]);
  });

  it("counts open vs total and rolls up open snags by priority", () => {
    const s = summariseJobSnags(
      [
        snag({ id: "a", priority: "high" }),
        snag({ id: "b", priority: "low", status: "fixed" }),
        snag({ id: "c", priority: "high", status: "verified" }),
        snag({ id: "d", priority: "medium", status: "wont_fix" }),
      ],
      TODAY,
    );
    expect(s.total).toBe(4);
    expect(s.open).toBe(2);
    expect(s.byPriority).toEqual([
      { priority: "high", label: "High", count: 1 },
      { priority: "medium", label: "Medium", count: 0 },
      { priority: "low", label: "Low", count: 1 },
    ]);
  });

  it("counts only OPEN snags past their due date as overdue", () => {
    const s = summariseJobSnags(
      [
        snag({ id: "a", due_date: "2026-07-19" }),
        snag({ id: "b", due_date: "2026-07-20" }),
        snag({ id: "c", due_date: "2026-07-21" }),
        snag({ id: "d", due_date: "2026-06-01", status: "verified" }),
        snag({ id: "e", due_date: null }),
      ],
      TODAY,
    );
    expect(s.overdue).toBe(1);
  });

  it("orders open snags by priority, then oldest first, then id", () => {
    const s = summariseJobSnags(
      [
        snag({ id: "z", priority: "low", created_at: "2026-07-01T00:00:00.000Z" }),
        snag({ id: "b", priority: "high", created_at: "2026-07-05T00:00:00.000Z" }),
        snag({ id: "a", priority: "high", created_at: "2026-07-05T00:00:00.000Z" }),
        snag({ id: "c", priority: "high", created_at: "2026-07-02T00:00:00.000Z" }),
        snag({ id: "m", priority: "medium", created_at: "2026-07-09T00:00:00.000Z" }),
      ],
      TODAY,
    );
    expect(s.openSnags.map((x) => x.id)).toEqual(["c", "a", "b", "m", "z"]);
  });

  it("is independent of input order", () => {
    const rows = [
      snag({ id: "a", priority: "high" }),
      snag({ id: "b", priority: "low" }),
      snag({ id: "c", priority: "medium" }),
    ];
    const forward = summariseJobSnags(rows, TODAY).openSnags.map((x) => x.id);
    const reversed = summariseJobSnags([...rows].reverse(), TODAY).openSnags.map((x) => x.id);
    expect(reversed).toEqual(forward);
  });

  it("treats an unrecognised priority as medium rather than dropping the snag", () => {
    const s = summariseJobSnags([snag({ id: "a", priority: "urgent" })], TODAY);
    expect(s.open).toBe(1);
    expect(s.byPriority.find((p) => p.priority === "medium")?.count).toBe(1);
  });

  it("does not mutate the caller's array", () => {
    const rows = [snag({ id: "b", priority: "low" }), snag({ id: "a", priority: "high" })];
    summariseJobSnags(rows, TODAY);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("summariseJobDiary", () => {
  it("summarises an empty job", () => {
    expect(summariseJobDiary([], 4)).toEqual({
      total: 0,
      recent: [],
      lastEntryDate: null,
      withDelays: 0,
    });
  });

  it("orders newest first by entry date, then write order, then id", () => {
    const s = summariseJobDiary(
      [
        entry({ id: "a", entry_date: "2026-07-17" }),
        entry({ id: "c", entry_date: "2026-07-19", created_at: "2026-07-19T08:00:00.000Z" }),
        entry({ id: "b", entry_date: "2026-07-19", created_at: "2026-07-19T18:00:00.000Z" }),
        entry({ id: "d", entry_date: "2026-07-18" }),
      ],
      10,
    );
    expect(s.recent.map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
    expect(s.lastEntryDate).toBe("2026-07-19");
    expect(s.total).toBe(4);
  });

  it("breaks a fully tied pair by id so the panel never reshuffles", () => {
    const tied = [
      entry({ id: "z", entry_date: "2026-07-19", created_at: "2026-07-19T08:00:00.000Z" }),
      entry({ id: "a", entry_date: "2026-07-19", created_at: "2026-07-19T08:00:00.000Z" }),
    ];
    expect(summariseJobDiary(tied, 10).recent.map((r) => r.id)).toEqual(["a", "z"]);
    expect(summariseJobDiary([...tied].reverse(), 10).recent.map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("applies the limit to the head while reporting the full total", () => {
    const rows = ["a", "b", "c", "d", "e"].map((id, i) =>
      entry({ id, entry_date: `2026-07-1${i}` }),
    );
    const s = summariseJobDiary(rows, 2);
    expect(s.recent).toHaveLength(2);
    expect(s.total).toBe(5);
  });

  it("counts entries recording a delay, ignoring whitespace-only text", () => {
    const s = summariseJobDiary(
      [
        entry({ id: "a", delays: "Concrete late" }),
        entry({ id: "b", delays: "   " }),
        entry({ id: "c", delays: null }),
      ],
      10,
    );
    expect(s.withDelays).toBe(1);
  });

  it("does not mutate the caller's array", () => {
    const rows = [entry({ id: "a", entry_date: "2026-07-17" }), entry({ id: "b", entry_date: "2026-07-19" })];
    summariseJobDiary(rows, 10);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
