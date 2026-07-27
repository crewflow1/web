import { describe, it, expect } from "vitest";
import {
  computeRetentionSchedule,
  addMonths,
  type RetentionSchedule,
} from "@/lib/retentions/schedule";
import type { RetentionPosition } from "@/lib/retentions/compute";

const NOW = new Date("2026-07-22T12:00:00Z");

const round = (n: number) => Math.round(n * 100) / 100;

/** Build a RetentionPosition; held is derived like the real compute. The
 *  schedule only reads accrued/released/held/ratePercent. */
function position(accrued: number, released: number, ratePercent = 5): RetentionPosition {
  return {
    ratePercent,
    invoicedBase: 0,
    accrued: round(accrued),
    released: round(released),
    held: round(Math.max(0, accrued - released)),
  } as unknown as RetentionPosition;
}

function sched(over: {
  accrued: number;
  released: number;
  ratePercent?: number;
  pc?: string | null;
  dlpMonths?: number;
  firstPct?: number;
}): RetentionSchedule {
  return computeRetentionSchedule({
    position: position(over.accrued, over.released, over.ratePercent ?? 5),
    practicalCompletionDate: over.pc ?? null,
    defectsLiabilityMonths: over.dlpMonths ?? 12,
    firstReleasePct: over.firstPct ?? 50,
    now: NOW,
  });
}

describe("addMonths", () => {
  it("adds calendar months", () => {
    expect(addMonths("2026-01-15", 12)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", 6)).toBe("2026-07-15");
  });
  it("clamps to month end (Jan 31 + 1mo → Feb 28)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
  it("months = 0 returns the same date", () => {
    expect(addMonths("2026-05-10", 0)).toBe("2026-05-10");
  });
});

describe("computeRetentionSchedule — the BLOCKER: size off accrued, not live held", () => {
  it("a fully-released first moiety reads 'released', NOT 'still owes held×pct'", () => {
    // accrued 1000, £500 released at PC. held is now 500. Sizing off held would
    // wrongly claim £250 still due at PC; sizing off accrued is correct.
    const s = sched({ accrued: 1000, released: 500, pc: "2026-06-01", firstPct: 50 });
    const first = s.moieties.find((m) => m.key === "first")!;
    expect(first.amount).toBe(500);
    expect(first.remaining).toBe(0);
    expect(first.status).toBe("released");
    const second = s.moieties.find((m) => m.key === "second")!;
    expect(second.amount).toBe(500);
    expect(second.remaining).toBe(500);
  });

  it("FIFO waterfall: a partial release crossing the first-moiety boundary fills first, overflows to second", () => {
    // accrued 1000, £600 released → first (500) fully released, £100 into second.
    const s = sched({ accrued: 1000, released: 600, pc: "2026-06-01", firstPct: 50 });
    const first = s.moieties.find((m) => m.key === "first")!;
    const second = s.moieties.find((m) => m.key === "second")!;
    expect(first.remaining).toBe(0);
    expect(first.status).toBe("released");
    expect(second.remaining).toBe(400); // 500 − 100
  });
});

describe("computeRetentionSchedule — moiety dates + status", () => {
  it("first at PC, second due FROM PC + DLP months", () => {
    const s = sched({ accrued: 1000, released: 0, pc: "2026-06-01", dlpMonths: 12, firstPct: 50 });
    const first = s.moieties.find((m) => m.key === "first")!;
    const second = s.moieties.find((m) => m.key === "second")!;
    expect(first.dueDate).toBe("2026-06-01");
    expect(first.status).toBe("due"); // PC (2026-06-01) ≤ today (2026-07-22)
    expect(first.dueFrom).toBe(false);
    expect(second.dueDate).toBe("2027-06-01");
    expect(second.status).toBe("upcoming"); // future
    expect(second.dueFrom).toBe(true); // "due from", not overdue
    expect(s.dueNow).toBe(500); // only the first moiety is due
  });

  it("a future PC date makes the first moiety 'upcoming'", () => {
    const s = sched({ accrued: 1000, released: 0, pc: "2026-12-01", firstPct: 50 });
    expect(s.moieties.find((m) => m.key === "first")!.status).toBe("upcoming");
    expect(s.dueNow).toBe(0);
  });

  it("DLP = 0 → second moiety due date equals PC date", () => {
    const s = sched({ accrued: 1000, released: 0, pc: "2026-06-01", dlpMonths: 0, firstPct: 50 });
    expect(s.moieties.find((m) => m.key === "second")!.dueDate).toBe("2026-06-01");
  });
});

describe("computeRetentionSchedule — single-release + degradation", () => {
  it("first-release 100% → a single moiety, no second", () => {
    const s = sched({ accrued: 1000, released: 0, pc: "2026-06-01", firstPct: 100 });
    expect(s.moieties).toHaveLength(1);
    expect(s.moieties[0]!.amount).toBe(1000);
  });

  it("first-release 0% → everything at the end of the defects period", () => {
    const s = sched({ accrued: 1000, released: 0, pc: "2026-06-01", firstPct: 0 });
    const second = s.moieties.find((m) => m.key === "second")!;
    expect(second.amount).toBe(1000);
    expect(s.moieties.find((m) => m.key === "first")!.amount).toBe(0);
  });

  it("no retention (rate 0 / accrued 0) → inactive, no schedule", () => {
    const s = sched({ accrued: 0, released: 0, ratePercent: 0 });
    expect(s.active).toBe(false);
    expect(s.moieties).toHaveLength(0);
  });

  it("retention but no PC date → active + awaitingPcDate, no due dates, nothing 'due'", () => {
    const s = sched({ accrued: 1000, released: 0, pc: null });
    expect(s.active).toBe(true);
    expect(s.awaitingPcDate).toBe(true);
    expect(s.dueNow).toBe(0);
    expect(s.moieties.every((m) => m.dueDate === null)).toBe(true);
    expect(s.moieties.every((m) => m.status !== "due")).toBe(true); // never fake-overdue
  });

  it("fully released across both moieties → both 'released', dueNow 0", () => {
    const s = sched({ accrued: 1000, released: 1000, pc: "2026-06-01", firstPct: 50 });
    expect(s.moieties.every((m) => m.status === "released")).toBe(true);
    expect(s.dueNow).toBe(0);
  });
});
