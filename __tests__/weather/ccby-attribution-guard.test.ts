import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  weatherAttributionFor,
  assessAll,
  WORK_TYPES,
  type WeatherReading,
  type WeatherWindow,
  type PostcodeDistrict,
} from "@/lib/weather";
import {
  createOpenMeteoProvider,
  OPEN_METEO_ATTRIBUTION,
} from "@/lib/weather/providers/open-meteo";
import type { WeatherSnapshot } from "@/server/services/weather";
import {
  assessScheduleWeather,
  unavailableWeatherSignal,
} from "@/lib/schedule/weather-risk";
import { composeWeatherSection } from "@/lib/briefing/compose";
import { weatherAttributionLine } from "@/lib/pdf/eot-pack-pdf";
import { assembleEotPack, type DelayEventRow, type EotWeatherEvidence } from "@/lib/eot/pack";

/**
 * CC-BY 4.0 ATTRIBUTION GUARD (Open-Meteo licence compliance).
 *
 * Open-Meteo's data is CC-BY 4.0: docs/weather/provider-options.md — "CC-BY
 * attribution must appear on every surface that renders the data". The
 * attribution string is defined on the provider (info.attribution) as part of
 * the activation contract; this guard exists so a surface can NEVER render a
 * weather reading / metric without threading that attribution through.
 *
 * TWO PROOFS:
 *   1. BEHAVIOURAL — the licence string resolves from the SINGLE provider
 *      source (never a hand-typed duplicate that could drift), and every
 *      data-bearing surface OUTPUT carries it when the data is present and
 *      drops it when dark (so "no data" and "unattributed data" both fail loud).
 *   2. STATIC — each render-path source file still references the attribution
 *      mechanism. If a surface stops wiring attribution, its pin fails; this is
 *      the enumeration that flags a surface rendering metrics without the licence.
 */

const ROOT = resolve(__dirname, "..", "..");
/** Comments stripped, so prose that mentions "attribution" can't satisfy a pin. */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const LS1 = "LS1" as PostcodeDistrict;

function snapshot(readings: WeatherReading[], attribution: string | null): WeatherSnapshot {
  const window: WeatherWindow = { district: LS1, readings };
  return {
    readiness: {} as WeatherSnapshot["readiness"],
    statusLine: "active",
    attribution,
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
  windGustMs: 30, // storm-force gust — a blocking breach ⇒ a rendered risk
  precipRateMmH: 5,
  precipTotalMm: 20,
  precipProbPct: 90,
  humidityPct: 85,
  visibilityM: 4000,
};

// =====================================================================
// 1. The licence string resolves from the ONE provider source — no drift.
// =====================================================================

describe("weatherAttributionFor — the single-source resolver", () => {
  it("resolves the CC-BY 4.0 string for open-meteo", () => {
    const a = weatherAttributionFor("open-meteo");
    expect(a).not.toBeNull();
    expect(a).toMatch(/CC BY 4\.0/);
    expect(a).toMatch(/Open-Meteo/i);
  });

  it("is null for a null / unknown / off provider — dark ⇒ nothing to attribute", () => {
    expect(weatherAttributionFor(null)).toBeNull();
    expect(weatherAttributionFor(undefined)).toBeNull();
    expect(weatherAttributionFor("")).toBeNull();
    expect(weatherAttributionFor("metoffice")).toBeNull(); // no adapter, no string
    expect(weatherAttributionFor("nonsense")).toBeNull();
  });

  it("CANNOT DRIFT from the live provider's info.attribution — same source", () => {
    // Both the map and the running adapter read the exported constant, so a
    // change to the licence text updates every render site at once.
    const live = createOpenMeteoProvider({ apiKey: "test-key" }).info.attribution;
    expect(weatherAttributionFor("open-meteo")).toBe(live);
    expect(weatherAttributionFor("open-meteo")).toBe(OPEN_METEO_ATTRIBUTION);
  });
});

// =====================================================================
// 2. Every data-bearing surface OUTPUT carries attribution with the data
//    and drops it when dark. (Calibration: flip the data on and the
//    attribution MUST appear; flip it off and it MUST be null.)
// =====================================================================

describe("schedule weather signal · attribution rides with the rendered risks", () => {
  it("a signal built from REAL readings carries the provider attribution", () => {
    const signal = assessScheduleWeather(
      [{ jobId: "j1", label: "Acme", day: "2026-07-10", district: LS1, snapshot: snapshot([STORM], OPEN_METEO_ATTRIBUTION) }],
      { available: true, statusLine: "active", attribution: OPEN_METEO_ATTRIBUTION },
    );
    expect(signal.assessedJobs).toBe(1);
    expect(signal.risks.length).toBeGreaterThan(0); // weather IS rendered
    expect(signal.attribution, "rendered risks must carry the licence").toBe(OPEN_METEO_ATTRIBUTION);
  });

  it("the dark / unavailable signal attributes nothing", () => {
    expect(unavailableWeatherSignal("not connected").attribution).toBeNull();
    const dark = assessScheduleWeather(
      [{ jobId: "j1", label: "Acme", day: "2026-07-10", district: LS1, snapshot: snapshot([STORM], null) }],
      { available: false, statusLine: "not connected" },
    );
    expect(dark.attribution).toBeNull();
  });
});

describe("briefing weather section · attribution rides with clear/risk output", () => {
  const RISK = {
    label: "Acme",
    day: "2026-07-10",
    district: "LS1",
    verdict: "not_viable" as const,
    conditions: ["Gust exceeds the limit"],
  };

  it("a RISK section (weather-derived conditions rendered) carries attribution", () => {
    const s = composeWeatherSection({
      available: true,
      statusLine: "active",
      assessedJobs: 1,
      insufficientJobs: 0,
      risks: [RISK],
      attribution: OPEN_METEO_ATTRIBUTION,
    });
    expect(s.status).toBe("risk");
    expect(s.attribution).toBe(OPEN_METEO_ATTRIBUTION);
  });

  it("a CLEAR section (assessed against real data) carries attribution", () => {
    const s = composeWeatherSection({
      available: true,
      statusLine: "active",
      assessedJobs: 3,
      insufficientJobs: 0,
      risks: [],
      attribution: OPEN_METEO_ATTRIBUTION,
    });
    expect(s.status).toBe("clear");
    expect(s.attribution).toBe(OPEN_METEO_ATTRIBUTION);
  });

  it("an UNAVAILABLE section renders no weather ⇒ no attribution", () => {
    const s = composeWeatherSection({
      available: false,
      statusLine: "not connected",
      assessedJobs: 0,
      insufficientJobs: 0,
      risks: [],
      attribution: OPEN_METEO_ATTRIBUTION, // even if supplied, nothing is rendered
    });
    expect(s.status).toBe("unavailable");
    expect(s.attribution).toBeNull();
  });
});

describe("EOT pack · attribution binds to the pack exactly when evidence is rendered", () => {
  const JOB = "00000000-0000-0000-0000-00000000job1";
  const weatherEvent: DelayEventRow = {
    id: "ev-weather",
    job_id: JOB,
    category: "weather",
    status: "recorded",
    started_on: "2026-07-01",
    ended_on: "2026-07-02",
    working_days_lost: 2,
    description: "Storm stopped roofing",
    diary_entry_id: null,
    variation_quote_id: null,
    weather_district: "LS1",
    recorded_at: "2026-07-02T18:00:00.000Z",
    recorded_by: "user-1",
    withdrawn_at: null,
    created_at: "2026-07-01T08:00:00.000Z",
  };
  const EVIDENCE: EotWeatherEvidence = {
    district: "LS1",
    readingCount: 12,
    minAirTempC: 4,
    maxWindSpeedMs: 14,
    maxWindGustMs: 22,
    maxPrecipRateMmH: 6,
    totalPrecipMm: 30,
  };
  const base = {
    jobId: JOB,
    events: [weatherEvent],
    diaryEntries: [],
    variations: [],
    progress: null,
    generatedAt: "2026-08-01T09:00:00.000Z",
  };

  it("evidence present ⇒ pack carries the attribution", () => {
    const pack = assembleEotPack({
      ...base,
      weatherEvidenceAvailable: true,
      weatherEvidenceByEvent: new Map([["ev-weather", EVIDENCE]]),
      weatherAttribution: OPEN_METEO_ATTRIBUTION,
    });
    expect(pack.categories.some((c) => c.events.some((e) => e.weatherEvidence))).toBe(true);
    expect(pack.weatherAttribution).toBe(OPEN_METEO_ATTRIBUTION);
  });

  it("no evidence rendered ⇒ pack drops attribution even if one is supplied", () => {
    const pack = assembleEotPack({
      ...base,
      weatherEvidenceAvailable: false,
      weatherAttribution: OPEN_METEO_ATTRIBUTION,
    });
    expect(pack.weatherAttribution).toBeNull();
  });

  it("the PDF licence line carries the vendor string verbatim", () => {
    expect(weatherAttributionLine(OPEN_METEO_ATTRIBUTION)).toContain(OPEN_METEO_ATTRIBUTION);
    expect(weatherAttributionLine(OPEN_METEO_ATTRIBUTION)).toMatch(/CC BY 4\.0/);
  });
});

// =====================================================================
// 3. STATIC ENUMERATION — every weather-render surface still wires
//    attribution. If a surface stops threading it, its pin fails.
// =====================================================================

describe("every weather-render surface wires the attribution through", () => {
  const SURFACES: ReadonlyArray<readonly [string, RegExp, string]> = [
    // The accessor threads the ACTIVE provider's attribution onto the snapshot.
    ["server/services/weather.ts", /weatherAttributionFor\s*\(\s*readiness\.provider\s*\)/, "snapshot threading"],
    // The EOT service captures snapshot.attribution and hands it to the pack…
    ["server/services/eot-pack.ts", /weatherAttribution/, "EOT service threading"],
    // …the pure pack carries it onto the output…
    ["lib/eot/pack.ts", /weatherAttribution/, "EOT pack shape"],
    // …and the client-facing PDF renders it, gated on the field being present.
    ["lib/pdf/eot-pack-pdf.tsx", /pack\.weatherAttribution/, "EOT PDF render"],
    // The schedule signal carries attribution alongside the risk output.
    ["lib/schedule/weather-risk.ts", /attribution/, "schedule signal"],
    ["server/services/schedule-integrity.ts", /weatherAttributionFor\s*\(\s*readiness\.provider\s*\)/, "schedule threading"],
    // The weather page renders the WEATHER-DATA attribution (distinct from geo).
    ["app/(app)/weather/page.tsx", /weatherAttributionFor\s*\(\s*readiness\.provider\s*\)/, "weather page render"],
    // The briefing composer surfaces attribution on its assessed sections.
    ["lib/briefing/compose.ts", /attribution/, "briefing section"],
  ];

  for (const [file, pattern, what] of SURFACES) {
    it(`${file} wires attribution (${what})`, () => {
      expect(code(file), `${file} must wire weather attribution`).toMatch(pattern);
    });
  }

  it("the PDF gates the licence line on the attribution actually being present", () => {
    // Rendered ONLY when pack.weatherAttribution is truthy ⇒ the dark pack
    // prints nothing new, and a populated one prints the licence.
    const pdf = code("lib/pdf/eot-pack-pdf.tsx");
    expect(pdf).toMatch(/pack\.weatherAttribution\s*\?/);
    expect(pdf).toMatch(/weatherAttributionLine\s*\(\s*pack\.weatherAttribution\s*\)/);
  });
});
