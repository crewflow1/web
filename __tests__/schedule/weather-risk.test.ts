import { describe, expect, it } from "vitest";
import {
  assessScheduleWeather,
  unavailableWeatherSignal,
  type ScheduledJobWeatherInput,
} from "@/lib/schedule/weather-risk";
import { assessAll, WORK_TYPES } from "@/lib/weather";
import type { WeatherReading, WeatherWindow, PostcodeDistrict } from "@/lib/weather";
import type { WeatherSnapshot } from "@/server/services/weather";

/**
 * Schedule weather risk (pure). The one rule under test: a job is flagged ONLY
 * from real readings; a day with no reading is INSUFFICIENT (never cleared), and
 * a dark build produces the honest unavailable signal, never a false all-clear.
 */

const LS1 = "LS1" as PostcodeDistrict;
const READY = { available: true, statusLine: "active" };

function snapshot(readings: WeatherReading[]): WeatherSnapshot {
  const window: WeatherWindow = { district: LS1, readings };
  return {
    readiness: {} as WeatherSnapshot["readiness"],
    statusLine: "active",
    district: LS1,
    window,
    assessments: assessAll(window, [...WORK_TYPES]),
    shortCircuited: false,
  };
}

const STORM: WeatherReading = {
  district: LS1,
  kind: "forecast",
  validAt: new Date("2026-07-10T12:00:00Z"),
  airTempC: 8,
  windSpeedMs: 18,
  windGustMs: 30, // storm-force gust — a blocking breach for at-height / lifting
  precipRateMmH: 5,
  precipTotalMm: 20,
  precipProbPct: 90,
  humidityPct: 85,
  visibilityM: 4000,
};

const MILD: WeatherReading = {
  district: LS1,
  kind: "forecast",
  validAt: new Date("2026-07-11T12:00:00Z"),
  airTempC: 16,
  windSpeedMs: 3,
  windGustMs: 5,
  precipRateMmH: 0,
  precipTotalMm: 0,
  precipProbPct: 10,
  humidityPct: 55,
  visibilityM: 20000,
};

function job(overrides: Partial<ScheduledJobWeatherInput>): ScheduledJobWeatherInput {
  return {
    jobId: "job-1",
    label: "Acme Ltd",
    day: "2026-07-10",
    district: LS1,
    snapshot: null,
    ...overrides,
  };
}

describe("assessScheduleWeather", () => {
  it("DARK: readiness unavailable ⇒ honest unavailable signal, no risks, no false clear", () => {
    const signal = assessScheduleWeather(
      [job({ snapshot: snapshot([STORM]) })], // even with a storm in hand
      { available: false, statusLine: "not connected" },
    );
    expect(signal).toEqual(unavailableWeatherSignal("not connected"));
    expect(signal.available).toBe(false);
    expect(signal.risks).toEqual([]);
    expect(signal.assessedJobs).toBe(0);
  });

  it("READINGS PRESENT with a blocking breach ⇒ a not_viable risk is surfaced", () => {
    const signal = assessScheduleWeather([job({ snapshot: snapshot([STORM]) })], READY);
    expect(signal.available).toBe(true);
    expect(signal.assessedJobs).toBe(1);
    expect(signal.risks).toHaveLength(1);
    expect(signal.risks[0]!.verdict).toBe("not_viable");
    expect(signal.risks[0]!.conditions.length).toBeGreaterThan(0);
    // conditions are deduped — one gust breach, not one per trade
    expect(new Set(signal.risks[0]!.conditions).size).toBe(signal.risks[0]!.conditions.length);
  });

  it("READINGS PRESENT with no breach ⇒ assessed and clear (a legitimate all-clear)", () => {
    const signal = assessScheduleWeather([job({ snapshot: snapshot([MILD]) })], READY);
    expect(signal.assessedJobs).toBe(1);
    expect(signal.insufficientJobs).toBe(0);
    expect(signal.risks).toEqual([]);
  });

  it("EMPTY readings for a known district ⇒ INSUFFICIENT, never a risk and never cleared", () => {
    const signal = assessScheduleWeather([job({ snapshot: snapshot([]) })], READY);
    expect(signal.insufficientJobs).toBe(1);
    expect(signal.assessedJobs).toBe(0);
    expect(signal.risks).toEqual([]);
  });

  it("no derivable district ⇒ counted as unlocated, never guessed", () => {
    const signal = assessScheduleWeather(
      [job({ district: null, snapshot: null })],
      READY,
    );
    expect(signal.unlocatedJobs).toBe(1);
    expect(signal.assessedJobs).toBe(0);
  });

  it("is deterministic — risks sort by (day, jobId) regardless of input order", () => {
    const a = job({ jobId: "b", day: "2026-07-11", snapshot: snapshot([STORM]) });
    const b = job({ jobId: "a", day: "2026-07-10", snapshot: snapshot([STORM]) });
    const c = job({ jobId: "a", day: "2026-07-11", snapshot: snapshot([STORM]) });
    const signal = assessScheduleWeather([a, b, c], READY);
    expect(signal.risks.map((r) => `${r.day}/${r.jobId}`)).toEqual([
      "2026-07-10/a",
      "2026-07-11/a",
      "2026-07-11/b",
    ]);
  });
});
