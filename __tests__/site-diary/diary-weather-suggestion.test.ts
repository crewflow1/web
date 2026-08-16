import { describe, it, expect, vi, beforeEach } from "vitest";
import { suggestWeatherText } from "@/lib/site-diary/weather";
import type { WeatherSummary, WindowCoverage } from "@/lib/weather/decision";
import type { WeatherReading, WeatherWindow } from "@/lib/weather/types";

/**
 * Site Diary — the automatic-weather suggestion.
 *
 * Two layers, both proven here:
 *   A. suggestWeatherText — the PURE formatter. Grounded in observed metrics,
 *      never inventing a number, and returning null when there is nothing honest
 *      to say (no readings, or every metric absent).
 *   B. suggestDiaryWeather — the server composition. The load-bearing claim the
 *      task requires: it FALLS BACK HONESTLY (returns null → the manual field
 *      stays hand-typed) on a dark build, a job with no postcode, and a day the
 *      cache has no reading for; it never fabricates weather; and on a hit it
 *      carries the provider's licence attribution.
 */

// ── A. The pure formatter ────────────────────────────────────────────────────

const EMPTY_SUMMARY: WeatherSummary = {
  minAirTempC: null,
  maxAirTempC: null,
  maxWindSpeedMs: null,
  maxWindGustMs: null,
  maxPrecipRateMmH: null,
  totalPrecipMm: null,
  maxPrecipProbPct: null,
  minVisibilityM: null,
  maxHumidityPct: null,
  minDewPointMarginC: null,
  antecedentPrecipMm: null,
};

const cov = (readingCount: number): WindowCoverage => ({
  readingCount,
  gustReadingCount: readingCount,
  dewPointReadingCount: readingCount,
});

describe("suggestWeatherText (pure formatter)", () => {
  it("returns null when the window contributed no readings — the honest fallback", () => {
    expect(suggestWeatherText(EMPTY_SUMMARY, cov(0))).toBeNull();
  });

  it("returns null when readings exist but every metric is absent (never zero-fills)", () => {
    expect(suggestWeatherText(EMPTY_SUMMARY, cov(6))).toBeNull();
  });

  it("formats a temperature range, gust, and rainfall", () => {
    const s: WeatherSummary = {
      ...EMPTY_SUMMARY,
      minAirTempC: 4.2,
      maxAirTempC: 10.6,
      maxWindGustMs: 13.4, // ~30 mph
      totalPrecipMm: 3.24,
    };
    // 4–11°C, gusts to 30 mph, 3.2 mm rain
    const out = suggestWeatherText(s, cov(8));
    expect(out).toBe("4–11°C, gusts to 30 mph, 3.2 mm rain");
  });

  it("reads an explicit zero total as 'dry' — an observation, not an absence", () => {
    const s: WeatherSummary = { ...EMPTY_SUMMARY, minAirTempC: 8, maxAirTempC: 8, totalPrecipMm: 0 };
    expect(suggestWeatherText(s, cov(4))).toBe("8°C, dry");
  });

  it("falls back to mean wind, labelled distinctly, when no gust figure was reported", () => {
    const s: WeatherSummary = { ...EMPTY_SUMMARY, maxWindSpeedMs: 8.94 }; // ~20 mph
    expect(suggestWeatherText(s, cov(3))).toBe("wind to 20 mph");
  });
});

// ── B. The server composition (suggestDiaryWeather) ──────────────────────────

const isWeatherAvailable = vi.fn(() => false);
const buildWeatherSnapshot = vi.fn();
// Untyped mock: the throwing default lives in beforeEach so mockResolvedValue in
// the live-path tests isn't narrowed to `never` by a throwing initializer.
const createClient = vi.fn();

vi.mock("@/lib/weather/readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/weather/readiness")>();
  return { ...actual, isWeatherAvailable };
});
vi.mock("@/server/services/weather", () => ({ buildWeatherSnapshot }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));

const { suggestDiaryWeather } = await import("@/app/(app)/diary/_data");

/** A minimal jobs.select(...).eq().eq().maybeSingle() chain returning one row. */
function jobClientReturning(row: unknown, error: unknown = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error }),
  };
  return { from: () => chain };
}

function reading(over: Partial<WeatherReading>): WeatherReading {
  return {
    district: "LS1" as WeatherReading["district"],
    kind: "observation",
    validAt: new Date("2026-07-18T09:00:00Z"),
    airTempC: null,
    windSpeedMs: null,
    windGustMs: null,
    precipRateMmH: null,
    precipTotalMm: null,
    precipProbPct: null,
    humidityPct: null,
    visibilityM: null,
    ...over,
  };
}

const JOB_WITH_POSTCODE = {
  id: "job-1",
  site_address_line1: "1 Site Road",
  site_address_line2: null,
  site_city: "Leeds",
  site_county: null,
  site_postcode: "LS1 4AP",
  site_country: null,
  customer: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  isWeatherAvailable.mockReturnValue(false);
  createClient.mockImplementation(() => {
    throw new Error("suggestDiaryWeather read the database on a path that must not");
  });
});

describe("suggestDiaryWeather (server composition)", () => {
  it("returns null when no jobId is supplied — nothing to locate", async () => {
    expect(await suggestDiaryWeather({ orgId: "org-1", jobId: "", date: "2026-07-18" })).toBeNull();
  });

  it("returns null when no date is supplied", async () => {
    expect(await suggestDiaryWeather({ orgId: "org-1", jobId: "job-1", date: "" })).toBeNull();
  });

  it("DARK BUILD: returns null WITHOUT reading a single row or building a snapshot", async () => {
    isWeatherAvailable.mockReturnValue(false);
    const out = await suggestDiaryWeather({ orgId: "org-1", jobId: "job-1", date: "2026-07-18" });
    expect(out).toBeNull();
    expect(createClient).not.toHaveBeenCalled(); // the short-circuit is real
    expect(buildWeatherSnapshot).not.toHaveBeenCalled();
  });

  it("falls back honestly (null) when the cache has NO reading for the day", async () => {
    isWeatherAvailable.mockReturnValue(true);
    createClient.mockResolvedValue(jobClientReturning(JOB_WITH_POSTCODE));
    const window: WeatherWindow = {
      district: "LS1" as WeatherWindow["district"],
      readings: [], // provider live, but no reading cached for this district/day
      antecedentPrecipMm: null,
      antecedentWindowHours: null,
    };
    buildWeatherSnapshot.mockResolvedValue({ window, attribution: "Weather data by X" });
    const out = await suggestDiaryWeather({ orgId: "org-1", jobId: "job-1", date: "2026-07-18" });
    expect(out).toBeNull(); // never a fabricated forecast
  });

  it("falls back honestly (null) when the job has no resolvable postcode", async () => {
    isWeatherAvailable.mockReturnValue(true);
    createClient.mockResolvedValue(
      jobClientReturning({ ...JOB_WITH_POSTCODE, site_postcode: null, customer: null }),
    );
    const out = await suggestDiaryWeather({ orgId: "org-1", jobId: "job-1", date: "2026-07-18" });
    expect(out).toBeNull();
    expect(buildWeatherSnapshot).not.toHaveBeenCalled(); // no location ⇒ no read attempt
  });

  it("returns null (not a throw) when the job read fails — the pre-fill never breaks the page", async () => {
    isWeatherAvailable.mockReturnValue(true);
    createClient.mockResolvedValue(jobClientReturning(null, { message: "boom" }));
    const out = await suggestDiaryWeather({ orgId: "org-1", jobId: "job-1", date: "2026-07-18" });
    expect(out).toBeNull();
  });

  it("on a hit: returns the formatted phrase AND the provider's licence attribution", async () => {
    isWeatherAvailable.mockReturnValue(true);
    createClient.mockResolvedValue(jobClientReturning(JOB_WITH_POSTCODE));
    const window: WeatherWindow = {
      district: "LS1" as WeatherWindow["district"],
      readings: [
        reading({ airTempC: 4.2, windGustMs: 13.4, precipTotalMm: 1.6 }),
        reading({ airTempC: 10.6, windGustMs: 9.0, precipTotalMm: 1.64 }),
      ],
      antecedentPrecipMm: null,
      antecedentWindowHours: null,
    };
    buildWeatherSnapshot.mockResolvedValue({ window, attribution: "Weather data by Open-Meteo (CC-BY 4.0)" });
    const out = await suggestDiaryWeather({ orgId: "org-1", jobId: "job-1", date: "2026-07-18" });
    expect(out).not.toBeNull();
    expect(out?.text).toBe("4–11°C, gusts to 30 mph, 3.2 mm rain");
    expect(out?.attribution).toBe("Weather data by Open-Meteo (CC-BY 4.0)");
  });
});
