import { describe, expect, it } from "vitest";
import {
  assembleEotPack,
  type DelayEventRow,
  type EotPackInput,
  type EotWeatherEvidence,
} from "@/lib/eot/pack";

/**
 * EOT pack — the weather-evidence seam (pure).
 *
 * Proves the three behaviours the wiring must guarantee:
 *   (a) real readings present  → the event surfaces them and drops the dark gap;
 *   (b) dark (flag false)      → byte-identical to before: dark gap, no evidence;
 *   (c) weatherEvidenceAvailable is honoured as "readings exist" — evidence is
 *       attached IFF the caller declared it available AND supplied a summary,
 *       and a reading is NEVER fabricated.
 */

const JOB = "00000000-0000-0000-0000-00000000job1";
const GENERATED = "2026-08-01T09:00:00.000Z";

function weatherEvent(overrides: Partial<DelayEventRow> = {}): DelayEventRow {
  return {
    id: "ev-weather",
    job_id: JOB,
    category: "weather",
    status: "recorded",
    started_on: "2026-07-01",
    ended_on: "2026-07-02",
    working_days_lost: 2,
    description: "Storm stopped roofing",
    diary_entry_id: "diary-1", // linked, so the only gap in play is the weather one
    variation_quote_id: null,
    weather_district: "LS1",
    recorded_at: "2026-07-02T18:00:00.000Z",
    recorded_by: "user-1",
    withdrawn_at: null,
    created_at: "2026-07-01T08:00:00.000Z",
    ...overrides,
  };
}

const EVIDENCE: EotWeatherEvidence = {
  district: "LS1",
  readingCount: 12,
  minAirTempC: 4,
  maxWindSpeedMs: 14,
  maxWindGustMs: 22,
  maxPrecipRateMmH: 6,
  totalPrecipMm: 30,
};

function input(overrides: Partial<EotPackInput> = {}): EotPackInput {
  return {
    jobId: JOB,
    events: [weatherEvent()],
    diaryEntries: [
      {
        id: "diary-1",
        entry_date: "2026-07-01",
        weather: "Heavy rain",
        labour_count: 4,
        work_summary: "Stood down",
        delays: "Full stop",
      },
    ],
    variations: [],
    progress: null,
    weatherEvidenceAvailable: false,
    generatedAt: GENERATED,
    ...overrides,
  };
}

describe("eot pack · weather evidence", () => {
  it("(b) DARK: flag false ⇒ dark gap, no evidence — byte-identical to before wiring", () => {
    const pack = assembleEotPack(input({ weatherEvidenceAvailable: false }));
    const ev = pack.categories.flatMap((c) => c.events).find((e) => e.id === "ev-weather")!;
    expect(ev.weatherEvidence).toBeNull();
    const darkGaps = pack.gaps.filter((g) => g.kind === "weather_evidence_dark");
    expect(darkGaps).toHaveLength(1);
    expect(darkGaps[0]!.message).toMatch(/no weather provider is connected/i);
  });

  it("(a) READINGS PRESENT: flag true + summary ⇒ evidence attached, dark gap gone", () => {
    const pack = assembleEotPack(
      input({
        weatherEvidenceAvailable: true,
        weatherEvidenceByEvent: new Map([["ev-weather", EVIDENCE]]),
      }),
    );
    const ev = pack.categories.flatMap((c) => c.events).find((e) => e.id === "ev-weather")!;
    expect(ev.weatherEvidence).toEqual(EVIDENCE);
    expect(pack.gaps.some((g) => g.kind === "weather_evidence_dark")).toBe(false);
  });

  it("(c) never fabricates: flag true but NO summary for the event ⇒ evidence null", () => {
    const pack = assembleEotPack(
      input({ weatherEvidenceAvailable: true, weatherEvidenceByEvent: new Map() }),
    );
    const ev = pack.categories.flatMap((c) => c.events).find((e) => e.id === "ev-weather")!;
    expect(ev.weatherEvidence).toBeNull();
  });

  it("evidence attaches ONLY to weather events — a non-weather event is never given weather", () => {
    const pack = assembleEotPack(
      input({
        events: [weatherEvent({ id: "ev-access", category: "access", weather_district: null })],
        weatherEvidenceAvailable: true,
        // A hostile/confused map keyed on the non-weather id must be ignored.
        weatherEvidenceByEvent: new Map([["ev-access", EVIDENCE]]),
      }),
    );
    const ev = pack.categories.flatMap((c) => c.events).find((e) => e.id === "ev-access")!;
    expect(ev.weatherEvidence).toBeNull();
  });
});
