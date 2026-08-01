import { describe, it, expect } from "vitest";
import type { TimeEntry } from "@/lib/time/compute";
import { trailingDayWindow } from "@/lib/intelligence/window";
import {
  MIN_RATED_ROSTERED_HOURS,
  computeUtilisation,
  hoursRatio,
  utilisationMetric,
  type UtilisationMember,
  type UtilisationRotaRow,
} from "@/lib/intelligence/utilisation";

/**
 * Utilisation — exact hours from fixtures, the sample floor, the labour-cost
 * refusal, and the BST window edge. Deterministic pinned instants throughout:
 * `now` is 23:30Z on 31 July 2026 — a BST month-end instant where the UTC day
 * and the London day disagree (the repo's freshest incident class).
 */

const NOW = new Date("2026-07-31T23:30:00Z"); // London: 00:30, 1 Aug 2026
const WINDOW = trailingDayWindow(NOW, 30); // 2026-07-03 .. 2026-08-01 London

const members: UtilisationMember[] = [
  { userId: "u-a", name: "Anna", hourlyPay: 20 },
  { userId: "u-b", name: "Bert", hourlyPay: null },
  { userId: "u-c", name: "Cara", hourlyPay: 15 },
];

function entry(over: Partial<TimeEntry> & Pick<TimeEntry, "id" | "user_id" | "started_at">): TimeEntry {
  return { job_id: null, ended_at: null, breaks: [], ...over };
}

describe("computeUtilisation — exact numbers", () => {
  const rota: UtilisationRotaRow[] = [
    // Anna: one full shift, 08:00–16:00Z on 10 July → 8h rostered.
    { user_id: "u-a", job_id: "job-1", starts_at: "2026-07-10T08:00:00Z", ends_at: "2026-07-10T16:00:00Z" },
    // Bert: a 2h shift → below the 8h floor.
    { user_id: "u-b", job_id: null, starts_at: "2026-07-11T08:00:00Z", ends_at: "2026-07-11T10:00:00Z" },
  ];
  const timeEntries: TimeEntry[] = [
    // Anna: 08:00–14:00 with a 30-minute break → 5.5h recorded.
    entry({
      id: "t-1",
      user_id: "u-a",
      job_id: "job-1",
      started_at: "2026-07-10T08:00:00Z",
      ended_at: "2026-07-10T14:00:00Z",
      breaks: [{ started_at: "2026-07-10T12:00:00Z", ended_at: "2026-07-10T12:30:00Z" }],
    }),
    // Bert: 2h, no breaks, no rate on file.
    entry({
      id: "t-2",
      user_id: "u-b",
      started_at: "2026-07-11T08:00:00Z",
      ended_at: "2026-07-11T10:00:00Z",
    }),
  ];

  const result = computeUtilisation({
    members,
    rota,
    timeEntries,
    window: WINDOW,
    nowMs: NOW.getTime(),
  });

  it("computes exact hours per member", () => {
    const anna = result.members.find((m) => m.userId === "u-a")!;
    expect(anna.rosteredHours).toBe(8);
    expect(anna.recordedHours).toBe(5.5);
    expect(anna.coverage.pct).toBe(69); // round(5.5 / 8 × 100)
    expect(anna.coverage.rated).toBe(true);
    expect(anna.jobsRostered).toBe(1);
    expect(anna.jobsWorked).toBe(1);
  });

  it("withholds the coverage rate below the rostered-hours floor", () => {
    const bert = result.members.find((m) => m.userId === "u-b")!;
    expect(bert.rosteredHours).toBe(2);
    expect(bert.recordedHours).toBe(2);
    expect(bert.coverage.pct).toBeNull(); // 2h < 8h floor — no rate earned
    expect(bert.coverage.rated).toBe(false);
  });

  it("prices only members with a rate, and counts the unpriced", () => {
    const anna = result.members.find((m) => m.userId === "u-a")!;
    const bert = result.members.find((m) => m.userId === "u-b")!;
    expect(anna.labourCost).toBe(110); // 5.5h × £20
    expect(bert.labourCost).toBeNull(); // no rate → null, never £0
    expect(result.totals.labourCost).toBe(110);
    expect(result.totals.membersWithoutRate).toBe(1);
  });

  it("org totals are the exact member sums", () => {
    expect(result.totals.rosteredHours).toBe(10);
    expect(result.totals.recordedHours).toBe(7.5);
    expect(result.totals.coverage.pct).toBe(75);
    expect(result.totals.membersWithRoster).toBe(2);
    expect(result.totals.membersWithTime).toBe(2);
  });

  it("a member with nothing in the window contributes zeros, not noise", () => {
    const cara = result.members.find((m) => m.userId === "u-c")!;
    expect(cara.rosteredHours).toBe(0);
    expect(cara.recordedHours).toBe(0);
    expect(cara.coverage.pct).toBeNull();
  });
});

describe("the BST window edge (London midnight = 23:00Z)", () => {
  it("clips a shift straddling the London window start, not the UTC one", () => {
    // Window opens at 2026-07-02T23:00:00Z (London midnight, BST). A shift
    // 21:00Z→01:00Z straddles it: only the 2h inside the window count.
    const result = computeUtilisation({
      members: [{ userId: "u-a", name: "Anna", hourlyPay: null }],
      rota: [
        { user_id: "u-a", job_id: null, starts_at: "2026-07-02T21:00:00Z", ends_at: "2026-07-03T01:00:00Z" },
      ],
      timeEntries: [],
      window: WINDOW,
      nowMs: NOW.getTime(),
    });
    expect(result.members[0]!.rosteredHours).toBe(2);
  });

  it("an entry entirely before the London window start counts nothing", () => {
    const result = computeUtilisation({
      members: [{ userId: "u-a", name: "Anna", hourlyPay: null }],
      rota: [
        { user_id: "u-a", job_id: null, starts_at: "2026-07-02T20:00:00Z", ends_at: "2026-07-02T22:30:00Z" },
      ],
      timeEntries: [],
      window: WINDOW,
      nowMs: NOW.getTime(),
    });
    expect(result.members[0]!.rosteredHours).toBe(0);
  });

  it("time clocked at 23:30Z on 31 July (London 1 Aug) is inside the window", () => {
    const result = computeUtilisation({
      members: [{ userId: "u-a", name: "Anna", hourlyPay: null }],
      rota: [],
      timeEntries: [
        entry({
          id: "t-9",
          user_id: "u-a",
          started_at: "2026-07-31T21:00:00Z",
          ended_at: "2026-07-31T23:00:00Z",
        }),
      ],
      window: WINDOW,
      nowMs: NOW.getTime(),
    });
    expect(result.members[0]!.recordedHours).toBe(2);
  });
});

describe("hoursRatio", () => {
  it("floor boundary: rated exactly at the floor", () => {
    expect(hoursRatio(4, MIN_RATED_ROSTERED_HOURS).pct).toBe(50);
    expect(hoursRatio(4, MIN_RATED_ROSTERED_HOURS - 0.5).pct).toBeNull();
  });
});

describe("the labelled metric", () => {
  it("is derived, windowed, and flags the floor when the org rate is withheld", () => {
    const empty = computeUtilisation({
      members,
      rota: [],
      timeEntries: [],
      window: WINDOW,
      nowMs: NOW.getTime(),
    });
    const m = utilisationMetric(empty);
    expect(m.provenance.kind).toBe("derived");
    expect(m.provenance.window).toEqual({ fromDay: "2026-07-03", toDay: "2026-08-01" });
    expect(m.provenance.sampleFloorApplied).toBe(true);
    expect(m.provenance.basis).toContain(`${MIN_RATED_ROSTERED_HOURS} rostered hours`);
  });
});
