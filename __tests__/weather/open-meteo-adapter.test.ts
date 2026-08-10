import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenMeteoProvider } from "@/lib/weather/providers/open-meteo";
import { WeatherProviderError } from "@/lib/weather/types";
import type { DistrictCoordinates, PostcodeDistrict } from "@/lib/weather/types";

/**
 * Open-Meteo adapter — CONTRACT TESTS, zero network.
 *
 * Every response below is CHECKED-IN FIXTURE JSON, hand-derived from the
 * vendor's documented response shape (see the __fixture_note inside each
 * file). The transport is injected, so these tests prove:
 *
 *   1. the REQUEST contract — commercial (`customer-`) hosts only, SI units
 *      demanded explicitly (wind_speed_unit=ms), UTC, the apikey attached,
 *      per-kind hourly variable lists;
 *   2. the MAPPING — vendor arrays → WeatherReading, half-open window
 *      filtering, null passthrough, the all-null-hour drop;
 *   3. the FAILURE classification — retryable (429/5xx/network) vs
 *      deterministic (4xx/malformed/vendor-error), each a THROW, because
 *      empty and failed mean opposite things to a work-viability verdict.
 *
 * No retry logic is tested here because none exists here: backoff and the
 * breaker are the fetch service's policy (weather-fetch-service.test.ts).
 */

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, "fixtures", name), "utf8");

const LS1 = "LS1" as PostcodeDistrict;
const COORDS: DistrictCoordinates = {
  lat: 53.79654,
  lon: -1.55432,
  source: "ons_onspd",
  quality: "centroid",
};

const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

type FetchImpl = typeof fetch;

function provider(fetchImpl: FetchImpl, apiKey = "test-commercial-key") {
  return createOpenMeteoProvider({ apiKey, fetchImpl });
}

const FORECAST_WINDOW = {
  fromInclusive: new Date("2026-11-12T06:00:00Z"),
  toExclusive: new Date("2026-11-12T12:00:00Z"),
};
const ARCHIVE_WINDOW = {
  fromInclusive: new Date("2026-11-09T00:00:00Z"),
  toExclusive: new Date("2026-11-09T06:00:00Z"),
};

describe("identity and construction", () => {
  it("declares its id and the CC-BY attribution the licence requires", () => {
    const p = provider(vi.fn() as unknown as FetchImpl);
    expect(p.info.provider).toBe("open-meteo");
    expect(p.info.attribution).toMatch(/Open-Meteo/);
    expect(p.info.attribution).toMatch(/CC BY 4\.0/);
  });

  it("refuses to construct without a key — the commercial licence gate has no bypass", () => {
    expect(() => createOpenMeteoProvider({ apiKey: "   ", fetchImpl: vi.fn() as never })).toThrow(
      WeatherProviderError,
    );
  });
});

describe("the forecast request contract", () => {
  it("speaks to the commercial forecast host with SI units, UTC, and the injected key", async () => {
    const spy = vi.fn(async (_input: string | URL | Request) => json(fixture("open-meteo-forecast.json")));
    await provider(spy as unknown as FetchImpl).fetchWindow({
      district: LS1,
      coordinates: COORDS,
      kind: "forecast",
      ...FORECAST_WINDOW,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.host).toBe("customer-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("53.79654");
    expect(url.searchParams.get("longitude")).toBe("-1.55432");
    // SI or every lifting threshold is 3.6× wrong: the API default is km/h.
    expect(url.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(url.searchParams.get("timezone")).toBe("UTC");
    expect(url.searchParams.get("timeformat")).toBe("iso8601");
    expect(url.searchParams.get("apikey")).toBe("test-commercial-key");
    expect(url.searchParams.get("start_date")).toBe("2026-11-12");
    expect(url.searchParams.get("end_date")).toBe("2026-11-12");
    const hourly = (url.searchParams.get("hourly") ?? "").split(",");
    for (const v of [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "precipitation_probability",
      "wind_speed_10m",
      "wind_gusts_10m",
      "visibility",
    ]) {
      expect(hourly).toContain(v);
    }
  });

  it("maps the documented arrays onto WeatherReading, filtering to the half-open window", async () => {
    const spy = vi.fn(async (_input: string | URL | Request) => json(fixture("open-meteo-forecast.json")));
    const readings = await provider(spy as unknown as FetchImpl).fetchWindow({
      district: LS1,
      coordinates: COORDS,
      kind: "forecast",
      ...FORECAST_WINDOW,
    });

    // Fixture carries 05:00–12:00; the window is [06:00, 12:00) ⇒ six hours.
    expect(readings).toHaveLength(6);
    expect(readings[0]!.validAt.toISOString()).toBe("2026-11-12T06:00:00.000Z");
    expect(readings[5]!.validAt.toISOString()).toBe("2026-11-12T11:00:00.000Z");

    const six = readings[0]!;
    expect(six.district).toBe(LS1);
    expect(six.kind).toBe("forecast");
    expect(six.airTempC).toBe(3.8);
    expect(six.windSpeedMs).toBe(5.8);
    expect(six.windGustMs).toBe(11.2);
    expect(six.humidityPct).toBe(92);
    expect(six.precipProbPct).toBe(35);
    expect(six.visibilityM).toBe(18000);
    // 1 h resolution: the interval total IS the mm/h average.
    expect(six.precipTotalMm).toBe(0.2);
    expect(six.precipRateMmH).toBe(0.2);
  });

  it("passes a vendor null through as null — never as zero, never invented", async () => {
    const spy = vi.fn(async (_input: string | URL | Request) => json(fixture("open-meteo-forecast.json")));
    const readings = await provider(spy as unknown as FetchImpl).fetchWindow({
      district: LS1,
      coordinates: COORDS,
      kind: "forecast",
      ...FORECAST_WINDOW,
    });
    // 08:00 has temperature_2m: null in the fixture; the rest of that hour is real.
    const eight = readings.find((r) => r.validAt.toISOString() === "2026-11-12T08:00:00.000Z")!;
    expect(eight.airTempC).toBeNull();
    expect(eight.windGustMs).toBe(14.6);
  });
});

describe("the observation (archive) request contract", () => {
  it("speaks to the commercial archive host and omits the variables the archive does not publish", async () => {
    const spy = vi.fn(async (_input: string | URL | Request) => json(fixture("open-meteo-archive.json")));
    await provider(spy as unknown as FetchImpl).fetchWindow({
      district: LS1,
      coordinates: COORDS,
      kind: "observation",
      ...ARCHIVE_WINDOW,
    });

    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.host).toBe("customer-archive-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/archive");
    expect(url.searchParams.get("apikey")).toBe("test-commercial-key");
    const hourly = (url.searchParams.get("hourly") ?? "").split(",");
    expect(hourly).toContain("precipitation");
    // The past has no probability, and the archive has no visibility.
    expect(hourly).not.toContain("precipitation_probability");
    expect(hourly).not.toContain("visibility");
  });

  it("drops all-null hours (the publication lag) — a row of nothing is not an observation", async () => {
    const spy = vi.fn(async (_input: string | URL | Request) => json(fixture("open-meteo-archive.json")));
    const readings = await provider(spy as unknown as FetchImpl).fetchWindow({
      district: LS1,
      coordinates: COORDS,
      kind: "observation",
      ...ARCHIVE_WINDOW,
    });
    // Six fixture hours, the last two entirely null ⇒ four readings.
    expect(readings).toHaveLength(4);
    expect(readings.every((r) => r.kind === "observation")).toBe(true);
    expect(readings[1]!.precipTotalMm).toBe(2.4);
    // Archive readings carry null for the unpublished variables, not zero.
    expect(readings[0]!.precipProbPct).toBeNull();
    expect(readings[0]!.visibilityM).toBeNull();
  });
});

describe("failure classification — every failure THROWS; empty is not a failure", () => {
  const attempt = (impl: FetchImpl, kind: "forecast" | "observation" = "forecast") =>
    provider(impl).fetchWindow({
      district: LS1,
      coordinates: COORDS,
      kind,
      ...(kind === "forecast" ? FORECAST_WINDOW : ARCHIVE_WINDOW),
    });

  const thrownBy = async (impl: FetchImpl): Promise<WeatherProviderError> => {
    try {
      await attempt(impl);
    } catch (e) {
      expect(e).toBeInstanceOf(WeatherProviderError);
      return e as WeatherProviderError;
    }
    throw new Error("expected fetchWindow to throw");
  };

  it("an empty hourly series resolves to an EMPTY array — the seam's empty ≠ failed contract", async () => {
    const empty = JSON.stringify({
      latitude: 53.8,
      longitude: -1.5625,
      hourly: { time: [] },
    });
    const readings = await attempt(vi.fn(async () => json(empty)) as unknown as FetchImpl);
    expect(readings).toEqual([]);
  });

  it("429 (call budget exhausted — the capped plan fails CLOSED) is retryable", async () => {
    const e = await thrownBy(vi.fn(async () => json("{}", 429)) as unknown as FetchImpl);
    expect(e.retryable).toBe(true);
    expect(e.status).toBe(429);
  });

  it("5xx is retryable", async () => {
    const e = await thrownBy(vi.fn(async () => json("{}", 503)) as unknown as FetchImpl);
    expect(e.retryable).toBe(true);
  });

  it("a 400 with the vendor's error body is DETERMINISTIC — never retried, reason surfaced", async () => {
    const body = JSON.stringify({ error: true, reason: "Latitude must be in range of -90 to 90°." });
    const e = await thrownBy(vi.fn(async () => json(body, 400)) as unknown as FetchImpl);
    expect(e.retryable).toBe(false);
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/Latitude must be in range/);
  });

  it("a network-level failure (the vendor never answered) is retryable", async () => {
    const e = await thrownBy(
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as FetchImpl,
    );
    expect(e.retryable).toBe(true);
    expect(e.status).toBeNull();
  });

  it("a non-JSON 200 is a deterministic malformed-response failure", async () => {
    const e = await thrownBy(
      vi.fn(async () => new Response("<html>proxy error</html>", { status: 200 })) as unknown as FetchImpl,
    );
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/not JSON/);
  });

  it("the vendor's error shape under HTTP 200 (a proxy artefact) still throws", async () => {
    const body = JSON.stringify({ error: true, reason: "API key limit exceeded" });
    const e = await thrownBy(vi.fn(async () => json(body, 200)) as unknown as FetchImpl);
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/API key limit exceeded/);
  });

  it("a 200 with no hourly block is malformed, not empty — silence must not read as fair weather", async () => {
    const e = await thrownBy(
      vi.fn(async () => json(JSON.stringify({ latitude: 53.8 }))) as unknown as FetchImpl,
    );
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/missing hourly/);
  });
});

// ---------------------------------------------------------------------------
// weather_readings CHECK + precision compliance — the mapper NULLS out-of-range
//
// The mapper used to filter only non-finite/NaN and mirrored NONE of the
// weather_readings CHECKs/precision ceilings (mig 20261074000000): an out-of-range
// value (a glitch negative wind, a >100 % humidity, a precip that overflows
// numeric(5,2)) flowed straight into a row the DB rejects — and ONE such row aborts
// the district's ENTIRE upsert (0 rows → never fresh → re-fetched-and-re-failed
// every tick, denying weather to every org watching the district). Post-fix
// (boundedMetric) the offending metric is nulled at the mapper, so no row can
// violate a CHECK. Pre-fix these are RED (the raw value survives); green after.
// ---------------------------------------------------------------------------

describe("open-meteo mapper — weather_readings CHECK/precision compliance", () => {
  const HOUR = "2026-11-12T06:00"; // inside FORECAST_WINDOW [06:00, 12:00)

  /** A forecast body with all metrics valid; override any to inject an out-of-range value. */
  function forecastBody(over: Partial<Record<string, number | null>> = {}): string {
    const base: Record<string, number | null> = {
      temperature_2m: 4.2,
      relative_humidity_2m: 80,
      precipitation: 0.3,
      precipitation_probability: 40,
      wind_speed_10m: 5,
      wind_gusts_10m: 9,
      visibility: 12000,
      ...over,
    };
    return JSON.stringify({
      hourly: {
        time: [HOUR],
        temperature_2m: [base.temperature_2m],
        relative_humidity_2m: [base.relative_humidity_2m],
        precipitation: [base.precipitation],
        precipitation_probability: [base.precipitation_probability],
        wind_speed_10m: [base.wind_speed_10m],
        wind_gusts_10m: [base.wind_gusts_10m],
        visibility: [base.visibility],
      },
    });
  }

  async function mapForecast(body: string) {
    const spy = vi.fn(async (_i: string | URL | Request) => json(body));
    return provider(spy as unknown as FetchImpl).fetchWindow({
      district: LS1,
      coordinates: COORDS,
      kind: "forecast",
      ...FORECAST_WINDOW,
    });
  }

  // Each entry ties a weather_readings CHECK/precision (20261074000000) to an
  // out-of-range provider value the mapper MUST null. A NEW measurement column /
  // CHECK REQUIRES a new row here AND a matching bound in lib/weather/reading-bounds
  // — a CHECK without a mapper bound is exactly the class this guard catches.
  const WEATHER_CHECKS: ReadonlyArray<{
    check: string;
    over: Partial<Record<string, number | null>>;
    field: keyof Awaited<ReturnType<typeof mapForecast>>[number];
  }> = [
    { check: "wind_speed_ms check (>= 0)", over: { wind_speed_10m: -3 }, field: "windSpeedMs" },
    { check: "wind_gust_ms check (>= 0)", over: { wind_gusts_10m: -1 }, field: "windGustMs" },
    { check: "precip_rate_mm_h check (>= 0)", over: { precipitation: -0.5 }, field: "precipRateMmH" },
    { check: "precip_prob_pct check (between 0 and 100)", over: { precipitation_probability: 250 }, field: "precipProbPct" },
    { check: "humidity_pct check (between 0 and 100)", over: { relative_humidity_2m: 250 }, field: "humidityPct" },
    { check: "visibility_m check (>= 0)", over: { visibility: -100 }, field: "visibilityM" },
    { check: "wind_speed_ms numeric(4,1) precision (overflow)", over: { wind_speed_10m: 1234.5 }, field: "windSpeedMs" },
    { check: "precip_rate_mm_h numeric(5,2) precision (overflow)", over: { precipitation: 100000 }, field: "precipRateMmH" },
  ];

  it.each(WEATHER_CHECKS)(
    "nulls a value outside CHECK: $check (never emits an insertable-violating field)",
    async ({ over, field }) => {
      const readings = await mapForecast(forecastBody(over));
      expect(readings).toHaveLength(1);
      expect(readings[0]![field]).toBeNull();
    },
  );

  it("keeps in-range boundary values (0 wind, 100 % humidity, 0 visibility)", async () => {
    const readings = await mapForecast(
      forecastBody({ wind_speed_10m: 0, relative_humidity_2m: 100, precipitation_probability: 100, visibility: 0 }),
    );
    expect(readings).toHaveLength(1);
    expect(readings[0]!.windSpeedMs).toBe(0);
    expect(readings[0]!.humidityPct).toBe(100);
    expect(readings[0]!.precipProbPct).toBe(100);
    expect(readings[0]!.visibilityM).toBe(0);
  });

  it("a reading whose ONLY signal is out-of-range is DROPPED by the all-null-hour filter", async () => {
    // Every field null except a glitch negative wind → wind nulled → all-null hour →
    // dropped, so a single glitchy sample can never contribute an uninsertable row.
    const readings = await mapForecast(
      forecastBody({
        temperature_2m: null,
        relative_humidity_2m: null,
        precipitation: null,
        precipitation_probability: null,
        wind_speed_10m: -3,
        wind_gusts_10m: null,
        visibility: null,
      }),
    );
    expect(readings).toHaveLength(0);
  });
});
