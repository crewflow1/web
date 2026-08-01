import { describe, expect, it } from "vitest";
import {
  assembleEotPack,
  type DelayEventRow,
  type DiaryEvidenceRow,
  type EotPackInput,
  type VariationEvidenceRow,
} from "@/lib/eot/pack";
import type { ProgressSummary } from "@/lib/job-progress/series";

/**
 * Pack assembly (pure). Fixtures cover: recorded-only filtering, category
 * grouping in canonical order, human-claimed totals, evidence resolution,
 * variation deltas, EVERY gap kind, and permutation-independence.
 */

const JOB = "00000000-0000-0000-0000-00000000job1";
const GENERATED = "2026-08-01T09:00:00.000Z";

let seq = 0;
function event(overrides: Partial<DelayEventRow> = {}): DelayEventRow {
  seq += 1;
  return {
    id: `ev-${String(seq).padStart(3, "0")}`,
    job_id: JOB,
    category: "weather",
    status: "recorded",
    started_on: "2026-07-01",
    ended_on: "2026-07-03",
    working_days_lost: 2,
    description: "Storm stopped roofing",
    diary_entry_id: null,
    variation_quote_id: null,
    weather_district: null,
    recorded_at: "2026-07-03T18:00:00.000Z",
    recorded_by: "user-1",
    withdrawn_at: null,
    created_at: "2026-07-01T08:00:00.000Z",
    ...overrides,
  };
}

const DIARY: DiaryEvidenceRow = {
  id: "diary-1",
  entry_date: "2026-07-01",
  weather: "Heavy rain, 40mph gusts",
  labour_count: 4,
  work_summary: "Stood down at 10am",
  delays: "Full stop from 10:00",
};

const VARIATION_EOT: VariationEvidenceRow = {
  id: "var-1",
  variation_number: 3,
  title: "Storm damage remedials",
  status: "sent",
  accepted_at: null,
  eot_requested_completion_date: "2026-09-01",
  eot_agreed_completion_date: "2026-09-08",
  eot_agreed_at: "2026-07-20T10:00:00.000Z",
};

const VARIATION_PLAIN: VariationEvidenceRow = {
  id: "var-0",
  variation_number: 1,
  title: "Extra socket",
  status: "accepted",
  accepted_at: "2026-06-01T10:00:00.000Z",
  eot_requested_completion_date: null,
  eot_agreed_completion_date: null,
  eot_agreed_at: null,
};

const PROGRESS: ProgressSummary = {
  points: [
    {
      day: "2026-06-30",
      percent: 40,
      source: "observation",
      sourceId: "obs-1",
      note: null,
      authorId: null,
      reference: null,
    },
  ],
  latest: null,
  previous: null,
  percent: 40,
  delta: null,
  trend: "first",
  daysSinceUpdate: 1,
  stale: false,
  spanDays: 0,
};

function input(overrides: Partial<EotPackInput> = {}): EotPackInput {
  return {
    jobId: JOB,
    events: [],
    diaryEntries: [],
    variations: [],
    progress: PROGRESS,
    weatherEvidenceAvailable: false,
    generatedAt: GENERATED,
    ...overrides,
  };
}

describe("eot pack · recorded-only filtering", () => {
  it("itemises RECORDED events only; drafts and withdrawn are counted, never itemised", () => {
    const pack = assembleEotPack(
      input({
        events: [
          event({ id: "ev-a", status: "recorded" }),
          event({ id: "ev-b", status: "draft" }),
          event({ id: "ev-c", status: "withdrawn", withdrawn_at: "2026-07-10T00:00:00Z" }),
        ],
      }),
    );
    expect(pack.recordedEventCount).toBe(1);
    expect(pack.draftEventCount).toBe(1);
    expect(pack.withdrawnEventCount).toBe(1);
    const ids = pack.categories.flatMap((c) => c.events.map((e) => e.id));
    expect(ids).toEqual(["ev-a"]);
  });

  it("a withdrawn event's claimed days do NOT enter any total", () => {
    const pack = assembleEotPack(
      input({
        events: [
          event({ working_days_lost: 3 }),
          event({ status: "withdrawn", working_days_lost: 99, withdrawn_at: "2026-07-10T00:00:00Z" }),
        ],
      }),
    );
    expect(pack.totalClaimedWorkingDaysLost).toBe(3);
  });
});

describe("eot pack · grouping, totals and ordering", () => {
  it("groups by category in CANONICAL order regardless of input order", () => {
    const events = [
      event({ id: "ev-o", category: "other", started_on: "2026-07-01" }),
      event({ id: "ev-w", category: "weather", started_on: "2026-07-05" }),
      event({ id: "ev-c", category: "client_instruction", started_on: "2026-07-03" }),
    ];
    const pack = assembleEotPack(input({ events }));
    expect(pack.categories.map((c) => c.category)).toEqual([
      "weather",
      "client_instruction",
      "other",
    ]);
  });

  it("sorts events within a block by (started_on, id) and totals HUMAN claims only", () => {
    const events = [
      event({ id: "ev-z", started_on: "2026-07-09", working_days_lost: 1 }),
      event({ id: "ev-a", started_on: "2026-07-02", working_days_lost: null }),
      event({ id: "ev-b", started_on: "2026-07-02", working_days_lost: 4 }),
    ];
    const pack = assembleEotPack(input({ events }));
    const block = pack.categories[0]!;
    expect(block.events.map((e) => e.id)).toEqual(["ev-a", "ev-b", "ev-z"]);
    // 4 + 1; the null is NOT defaulted to a computed span — it stays unclaimed.
    expect(block.claimedWorkingDaysLost).toBe(5);
    expect(block.unquantifiedEvents).toBe(1);
    expect(pack.claimedByCategory.weather).toBe(5);
    expect(pack.claimedByCategory.design_change).toBe(0);
  });

  it("calendarDaysSpanned is inclusive calendar time, null while ongoing — and NEVER the claim", () => {
    const pack = assembleEotPack(
      input({
        events: [
          event({ id: "ev-1", started_on: "2026-07-01", ended_on: "2026-07-03", working_days_lost: 1 }),
          event({ id: "ev-2", started_on: "2026-07-05", ended_on: null, working_days_lost: null }),
        ],
      }),
    );
    const [e1, e2] = pack.categories[0]!.events;
    expect(e1!.calendarDaysSpanned).toBe(3); // 1st..3rd inclusive
    expect(e1!.workingDaysLost).toBe(1); // the human said 1; the span says 3; both stand
    expect(e2!.calendarDaysSpanned).toBeNull();
    expect(pack.totalClaimedWorkingDaysLost).toBe(1);
  });

  it("is permutation-independent (same pack from reversed inputs)", () => {
    const events = [
      event({ id: "ev-1", category: "design_change" }),
      event({ id: "ev-2", category: "weather", diary_entry_id: "diary-1" }),
      event({ id: "ev-3", category: "weather", started_on: "2026-06-01", ended_on: "2026-06-02" }),
    ];
    const a = assembleEotPack(
      input({ events, diaryEntries: [DIARY], variations: [VARIATION_EOT, VARIATION_PLAIN] }),
    );
    const b = assembleEotPack(
      input({
        events: [...events].reverse(),
        diaryEntries: [DIARY],
        variations: [VARIATION_PLAIN, VARIATION_EOT],
      }),
    );
    expect(b).toEqual(a);
  });
});

describe("eot pack · evidence resolution", () => {
  it("resolves the linked diary entry and variation onto the event", () => {
    const pack = assembleEotPack(
      input({
        events: [event({ diary_entry_id: "diary-1", variation_quote_id: "var-1" })],
        diaryEntries: [DIARY],
        variations: [VARIATION_EOT],
      }),
    );
    const e = pack.categories[0]!.events[0]!;
    expect(e.diaryEntry).toEqual(DIARY);
    expect(e.variation?.variationNumber).toBe(3);
    expect(e.variation?.carriesEot).toBe(true);
  });

  it("computes agreed-vs-requested delta in calendar days, null unless both dates exist", () => {
    const pack = assembleEotPack(input({ variations: [VARIATION_EOT, VARIATION_PLAIN] }));
    const eot = pack.variations.find((v) => v.id === "var-1")!;
    expect(eot.agreedVsRequestedDays).toBe(7); // 01 Sep → 08 Sep
    const requestedOnly = assembleEotPack(
      input({ variations: [{ ...VARIATION_EOT, eot_agreed_completion_date: null }] }),
    ).variations[0]!;
    expect(requestedOnly.agreedVsRequestedDays).toBeNull();
  });

  it("orders variations EoT-carrying first, and eotVariations is exactly that subset", () => {
    const pack = assembleEotPack(input({ variations: [VARIATION_PLAIN, VARIATION_EOT] }));
    expect(pack.variations.map((v) => v.id)).toEqual(["var-1", "var-0"]);
    expect(pack.eotVariations.map((v) => v.id)).toEqual(["var-1"]);
  });
});

describe("eot pack · gap surfacing", () => {
  it("no_diary_link: every recorded event without a resolvable diary entry", () => {
    const pack = assembleEotPack(
      input({
        events: [
          event({ id: "ev-1", diary_entry_id: null }),
          // Linked but not fetched (e.g. deleted since) — still a gap.
          event({ id: "ev-2", diary_entry_id: "diary-missing" }),
          event({ id: "ev-3", diary_entry_id: "diary-1" }),
        ],
        diaryEntries: [DIARY],
      }),
    );
    const gapIds = pack.gaps.filter((g) => g.kind === "no_diary_link").map((g) => g.eventId);
    expect(gapIds).toEqual(["ev-1", "ev-2"]);
  });

  it("weather_evidence_dark: every WEATHER event while no provider is bound", () => {
    const pack = assembleEotPack(
      input({
        events: [
          event({ id: "ev-w", category: "weather", weather_district: "LS1" }),
          event({ id: "ev-c", category: "client_instruction" }),
        ],
      }),
    );
    const dark = pack.gaps.filter((g) => g.kind === "weather_evidence_dark");
    expect(dark.map((g) => g.eventId)).toEqual(["ev-w"]);
    expect(dark[0]!.message).toMatch(/no weather provider is connected/i);
  });

  it("weather gap disappears only when the caller declares evidence available", () => {
    const pack = assembleEotPack(
      input({
        events: [event({ category: "weather" })],
        weatherEvidenceAvailable: true,
      }),
    );
    expect(pack.gaps.some((g) => g.kind === "weather_evidence_dark")).toBe(false);
  });

  it("ongoing + days_unquantified per event; no_eot_variation + no_progress_series per job", () => {
    const pack = assembleEotPack(
      input({
        events: [event({ id: "ev-1", ended_on: null, working_days_lost: null, category: "other" })],
        variations: [VARIATION_PLAIN], // a variation exists but carries no EoT
        progress: { ...PROGRESS, points: [], percent: null },
      }),
    );
    const kinds = pack.gaps.map((g) => g.kind);
    expect(kinds).toContain("ongoing");
    expect(kinds).toContain("days_unquantified");
    expect(kinds).toContain("no_eot_variation");
    expect(kinds).toContain("no_progress_series");
    // Job-level gaps carry no eventId.
    expect(pack.gaps.find((g) => g.kind === "no_eot_variation")!.eventId).toBeNull();
  });

  it("no_eot_variation is NOT raised when nothing is recorded (no claim is brewing)", () => {
    const pack = assembleEotPack(input({ events: [event({ status: "draft" })] }));
    expect(pack.gaps.some((g) => g.kind === "no_eot_variation")).toBe(false);
  });

  it("a FAILED progress read (progress null) raises no progress gap — absence of data is not evidence of absence", () => {
    const pack = assembleEotPack(input({ events: [event({})], progress: null }));
    expect(pack.progress).toBeNull();
    expect(pack.gaps.some((g) => g.kind === "no_progress_series")).toBe(false);
  });
});

describe("eot pack · shape", () => {
  it("stamps the injected generatedAt and jobId; empty input yields an empty, gap-free pack", () => {
    const pack = assembleEotPack(input({}));
    expect(pack.jobId).toBe(JOB);
    expect(pack.generatedAt).toBe(GENERATED);
    expect(pack.categories).toEqual([]);
    expect(pack.totalClaimedWorkingDaysLost).toBe(0);
    expect(pack.gaps.filter((g) => g.eventId !== null)).toEqual([]);
  });
});
