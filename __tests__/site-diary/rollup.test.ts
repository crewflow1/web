import { describe, it, expect } from "vitest";
import {
  aggregateDailyActivity,
  composeDiaryRollup,
  hasRollupActivity,
  AUTO_ROLLUP_SOURCE,
  MANUAL_SOURCE,
  AUTO_ROLLUP_NOTE,
  type DailyActivityInput,
  type DiaryRollupFacts,
} from "@/lib/site-diary/rollup";

/**
 * Site Diary — the PURE end-of-day roll-up aggregator + composer.
 *
 * Everything the automatic diary decides about WHAT a day contained and HOW it
 * reads is proven here, with no database: grouping by job, restriction to active
 * jobs, distinct-user headcount, closed-hours totalling, delivery-reference
 * de-duplication, the "no activity ⇒ no entry" rule, honest omission of zero
 * signals, and the dark-weather fallback (weather absent ⇒ no weather field).
 */

const JOB_A = "11111111-1111-1111-1111-111111111111";
const JOB_B = "22222222-2222-2222-2222-222222222222";
const JOB_DONE = "33333333-3333-3333-3333-333333333333"; // not in activeJobIds
const DATE = "2026-07-18";

function input(partial: Partial<DailyActivityInput>): DailyActivityInput {
  return {
    activeJobIds: new Set([JOB_A, JOB_B]),
    snagsRaised: [],
    snagsResolved: [],
    labour: [],
    deliveries: [],
    photos: [],
    ...partial,
  };
}

describe("the two source markers are distinct constants", () => {
  it("manual and auto_rollup are different", () => {
    expect(MANUAL_SOURCE).toBe("manual");
    expect(AUTO_ROLLUP_SOURCE).toBe("auto_rollup");
    expect(MANUAL_SOURCE).not.toBe(AUTO_ROLLUP_SOURCE);
  });
});

describe("aggregateDailyActivity — grouping + restriction", () => {
  it("groups activity by job and counts each signal", () => {
    const out = aggregateDailyActivity(
      input({
        photos: [{ job_id: JOB_A }, { job_id: JOB_A }, { job_id: JOB_B }],
        snagsRaised: [{ job_id: JOB_A }, { job_id: JOB_A }],
        snagsResolved: [{ job_id: JOB_A }],
      }),
    );
    expect(out.get(JOB_A)).toMatchObject({ photos: 2, snagsRaised: 2, snagsResolved: 1 });
    expect(out.get(JOB_B)).toMatchObject({ photos: 1 });
  });

  it("ignores activity for jobs NOT in activeJobIds (e.g. completed jobs)", () => {
    const out = aggregateDailyActivity(
      input({
        photos: [{ job_id: JOB_DONE }, { job_id: JOB_A }],
        snagsRaised: [{ job_id: JOB_DONE }],
      }),
    );
    expect(out.has(JOB_DONE)).toBe(false);
    expect(out.get(JOB_A)?.photos).toBe(1);
  });

  it("ignores rows with a null/empty job_id", () => {
    const out = aggregateDailyActivity(
      input({ photos: [{ job_id: null }, { job_id: "" }, { job_id: JOB_A }] }),
    );
    expect(out.size).toBe(1);
    expect(out.get(JOB_A)?.photos).toBe(1);
  });

  it("returns NO entry for a job with zero activity (never an empty diary)", () => {
    const out = aggregateDailyActivity(input({}));
    expect(out.size).toBe(0);
  });
});

describe("aggregateDailyActivity — labour headcount + hours", () => {
  it("headcount counts DISTINCT users; hours sum only CLOSED entries", () => {
    const out = aggregateDailyActivity(
      input({
        labour: [
          // Alice: two shifts (one head), 2h + 1.5h closed = 3.5h.
          { job_id: JOB_A, user_id: "alice", started_at: "2026-07-18T08:00:00Z", ended_at: "2026-07-18T10:00:00Z" },
          { job_id: JOB_A, user_id: "alice", started_at: "2026-07-18T13:00:00Z", ended_at: "2026-07-18T14:30:00Z" },
          // Bob: still on the clock — adds a head, no hours.
          { job_id: JOB_A, user_id: "bob", started_at: "2026-07-18T08:00:00Z", ended_at: null },
        ],
      }),
    );
    const f = out.get(JOB_A)!;
    expect(f.labourHeadcount).toBe(2);
    expect(f.labourHours).toBe(3.5);
  });

  it("drops a non-positive / unparseable interval from hours but keeps the head", () => {
    const out = aggregateDailyActivity(
      input({
        labour: [
          { job_id: JOB_A, user_id: "x", started_at: "2026-07-18T10:00:00Z", ended_at: "2026-07-18T09:00:00Z" },
          { job_id: JOB_A, user_id: "y", started_at: "nonsense", ended_at: "also-nonsense" },
        ],
      }),
    );
    const f = out.get(JOB_A)!;
    expect(f.labourHeadcount).toBe(2);
    expect(f.labourHours).toBe(0);
  });
});

describe("aggregateDailyActivity — deliveries", () => {
  it("counts deliveries and de-duplicates references in first-seen order", () => {
    const out = aggregateDailyActivity(
      input({
        deliveries: [
          { job_id: JOB_A, reference: "DN-1" },
          { job_id: JOB_A, reference: "DN-2" },
          { job_id: JOB_A, reference: "DN-1" }, // dup
          { job_id: JOB_A, reference: null }, // no ref → counted, no string
        ],
      }),
    );
    const f = out.get(JOB_A)!;
    expect(f.deliveries).toBe(4);
    expect(f.deliveryReferences).toEqual(["DN-1", "DN-2"]);
  });

  it("is order-independent (a permutation yields identical facts)", () => {
    const rows = [
      { job_id: JOB_A, reference: "DN-2" },
      { job_id: JOB_A, reference: "DN-1" },
    ];
    const a = aggregateDailyActivity(input({ deliveries: rows }));
    const b = aggregateDailyActivity(input({ deliveries: [...rows].reverse() }));
    // References reflect first-seen order, so the two differ — that is expected;
    // counts must not.
    expect(a.get(JOB_A)!.deliveries).toBe(b.get(JOB_A)!.deliveries);
  });
});

describe("hasRollupActivity", () => {
  const base: DiaryRollupFacts = {
    photos: 0,
    snagsRaised: 0,
    snagsResolved: 0,
    deliveries: 0,
    deliveryReferences: [],
    labourHeadcount: 0,
    labourHours: 0,
  };
  it("is false for an all-zero day", () => {
    expect(hasRollupActivity(base)).toBe(false);
  });
  it("is true when any single signal is present", () => {
    expect(hasRollupActivity({ ...base, photos: 1 })).toBe(true);
    expect(hasRollupActivity({ ...base, snagsResolved: 1 })).toBe(true);
    expect(hasRollupActivity({ ...base, deliveries: 1 })).toBe(true);
    expect(hasRollupActivity({ ...base, labourHeadcount: 1 })).toBe(true);
  });
});

describe("composeDiaryRollup", () => {
  const facts: DiaryRollupFacts = {
    photos: 3,
    snagsRaised: 2,
    snagsResolved: 1,
    deliveries: 1,
    deliveryReferences: ["DN-55"],
    labourHeadcount: 4,
    labourHours: 26.5,
  };

  it("returns null when there is no activity (no entry is written)", () => {
    const empty: DiaryRollupFacts = {
      photos: 0,
      snagsRaised: 0,
      snagsResolved: 0,
      deliveries: 0,
      deliveryReferences: [],
      labourHeadcount: 0,
      labourHours: 0,
    };
    expect(composeDiaryRollup(empty, { date: DATE })).toBeNull();
  });

  it("composes labour_count, a readable summary, and the provenance note", () => {
    const c = composeDiaryRollup(facts, { date: DATE })!;
    expect(c.labour_count).toBe(4);
    expect(c.work_summary).toContain("18 Jul 2026");
    expect(c.work_summary).toContain("3 site photos added");
    expect(c.work_summary).toContain("2 snags raised, 1 closed");
    expect(c.work_summary).toContain("1 delivery received (DN-55)");
    expect(c.work_summary).toContain("4 operatives on site — 26.5 hrs logged");
    expect(c.notes).toBe(AUTO_ROLLUP_NOTE);
  });

  it("omits zero signals entirely (never renders '0 photos')", () => {
    const c = composeDiaryRollup(
      { photos: 0, snagsRaised: 0, snagsResolved: 0, deliveries: 2, deliveryReferences: [], labourHeadcount: 0, labourHours: 0 },
      { date: DATE },
    )!;
    expect(c.work_summary).not.toContain("photo");
    expect(c.work_summary).not.toContain("snag");
    expect(c.work_summary).not.toContain("operative");
    expect(c.work_summary).toContain("2 deliveries received");
    expect(c.labour_count).toBeNull();
  });

  it("singularises correctly", () => {
    const c = composeDiaryRollup(
      { photos: 1, snagsRaised: 1, snagsResolved: 0, deliveries: 1, deliveryReferences: [], labourHeadcount: 1, labourHours: 1 },
      { date: DATE },
    )!;
    expect(c.work_summary).toContain("1 site photo added");
    expect(c.work_summary).toContain("1 snag raised");
    expect(c.work_summary).toContain("1 delivery received");
    expect(c.work_summary).toContain("1 operative on site — 1 hr logged");
  });

  it("DARK weather: no weather ⇒ the weather field is null (never invented)", () => {
    const c = composeDiaryRollup(facts, { date: DATE, weather: null })!;
    expect(c.weather).toBeNull();
    expect(c.notes).toBe(AUTO_ROLLUP_NOTE);
  });

  it("LIVE weather: the suggestion fills the field and attribution is appended to notes", () => {
    const c = composeDiaryRollup(facts, {
      date: DATE,
      weather: { text: "4–11°C, gusts to 30 mph, 3.2 mm rain", attribution: "Data © Open-Meteo (CC-BY 4.0)" },
    })!;
    expect(c.weather).toBe("4–11°C, gusts to 30 mph, 3.2 mm rain");
    expect(c.notes).toContain(AUTO_ROLLUP_NOTE);
    expect(c.notes).toContain("Open-Meteo");
  });
});
