/**
 * Weather intelligence — the Open-Meteo provider adapter. TRANSPORT.
 *
 * THE ONE PLACE IN lib/weather WHERE NETWORK EGRESS EXISTS IN SOURCE. The
 * security suite (__tests__/security/weather-intelligence.test.ts) carries an
 * explicit transport allowlist naming exactly this file — the analogue of the
 * AI ratchet's TRANSPORT set in ai-governance-closure.test.ts — and bans the
 * same egress primitives everywhere else in the feature. Adding a sibling
 * adapter means adding it to that roster, visibly.
 *
 * TRANSPORT, NOT POLICY. This file does not decide WHETHER to call a vendor:
 * it is constructed by the factory in ../index, which has already checked that
 * `WEATHER_PROVIDER` selects this vendor AND `OPEN_METEO_API_KEY` is present
 * AND district→coordinate resolution is available. Mirroring
 * lib/ai/text/anthropic.ts exactly: the key arrives as a constructor argument,
 * and this file reads NO environment variable — a credential that bypassed the
 * factory would be a credential that bypassed the readiness surface, which is
 * the drift `strandedCredentialRisk` exists to report.
 *
 * Equally deliberately, NO RETRY AND NO SLEEP LIVE HERE. A failure is
 * classified (retryable or not — see WeatherProviderError in ../types) and
 * thrown ONCE. Backoff, jitter and the consecutive-failure breaker belong to
 * the fetch service (server/services/weather-fetch.ts), where one policy
 * governs every vendor, rather than each adapter serialising its own hidden
 * sleeps into a cron's wall-clock budget.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VENDOR CONTRACT (documented July 2026; fixtures in
 * __tests__/weather/fixtures are HAND-DERIVED from these documented shapes)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   FORECAST     GET https://customer-api.open-meteo.com/v1/forecast
 *   OBSERVATION  GET https://customer-archive-api.open-meteo.com/v1/archive
 *
 * Both take `latitude`/`longitude` (WGS84 decimal degrees), `start_date`/
 * `end_date` (UTC calendar dates), an `hourly` variable list, and return
 * parallel arrays under `hourly` keyed by ISO-8601 timestamps. We request
 * `wind_speed_unit=ms` (the API's default is km/h — silently accepting the
 * default would put every lifting threshold off by a factor of 3.6),
 * `timezone=UTC` and `timeformat=iso8601`. Failures return HTTP 4xx with a
 * JSON body of `{ "error": true, "reason": "..." }`.
 *
 * THE `customer-` HOSTS ARE LOAD-BEARING, NOT COSMETIC. Open-Meteo's keyless
 * open-access endpoints (api.open-meteo.com) are licensed for NON-COMMERCIAL
 * use only — the licence trap docs/weather/provider-options.md flags as its
 * single most important line. CrewFlow is commercial, so this adapter speaks
 * ONLY to the commercial (`customer-`) endpoints, which REQUIRE the `apikey`
 * query parameter (that is the vendor's documented auth mechanism for these
 * hosts). The free host does not appear in this file, and the security suite
 * pins that: there is no code path that could quietly run on the wrong
 * licence. Attribution is CC-BY 4.0 and travels on `info.attribution`.
 *
 * COST / RATE-LIMIT SEMANTICS. Open-Meteo commercial plans sell a MONTHLY CALL
 * BUDGET (Standard ≈ 1M calls/month, ~€29/mo as of July 2026 — verify before
 * committing), not per-request billing. Exceeding the budget FAILS CLOSED:
 * requests are refused (429), no overage bill accrues. One `fetchWindow` call
 * is exactly one vendor API call (one district, one kind, one window). A 429
 * is classified retryable — the fetch service's backoff-and-breaker decides
 * whether asking again this run is worth it. The call-volume arithmetic lives
 * in docs/weather/provider-options.md; at 4 refreshes/day, even national
 * coverage sits comfortably inside one Standard plan.
 *
 * ARCHIVE LAG, DOCUMENTED HONESTLY. The archive (ERA5-family reanalysis) runs
 * roughly five days behind real time. A window that reaches into that lag
 * returns rows whose measurements are all null; those carry no information and
 * are dropped, which can legitimately produce an EMPTY result for a recent
 * window. Empty ≠ failed — the seam's contract — so the caller sees "no
 * observations yet", never a fabricated reading. If antecedent-rainfall needs
 * fresher observations than the archive can give, the documented follow-up is
 * sourcing recent hours from the forecast endpoint's `past_days` parameter —
 * an activation-time product decision, not smuggled in here.
 */

import type {
  DistrictCoordinates,
  WeatherProvider,
  WeatherReading,
  WeatherReadingKind,
  PostcodeDistrict,
} from "../types";
import { WeatherProviderError } from "../types";
import { boundedMetric } from "../reading-bounds";

const PROVIDER_ID = "open-meteo";

/**
 * CC-BY 4.0 — required on every surface that displays this vendor's data.
 *
 * Exported as the SINGLE SOURCE of the Open-Meteo licence string: the seam's
 * provider→attribution map (../index) resolves it by id so a persisted reading
 * (whose `provider` column names this adapter) is attributable everywhere the
 * data renders, WITHOUT any surface re-typing the string and risking drift.
 */
export const OPEN_METEO_ATTRIBUTION =
  "Weather data by Open-Meteo.com (https://open-meteo.com/), licensed under CC BY 4.0";
const ATTRIBUTION = OPEN_METEO_ATTRIBUTION;

/** Commercial endpoints ONLY — see the licence-trap block in the header. */
const FORECAST_ENDPOINT = "https://customer-api.open-meteo.com/v1/forecast";
const ARCHIVE_ENDPOINT = "https://customer-archive-api.open-meteo.com/v1/archive";

/**
 * The hourly variables requested, per kind — exactly what maps onto
 * `WeatherReading`, nothing speculative (the same discipline as the
 * migration's column list: no UV, no pollen).
 *
 * The archive publishes neither `precipitation_probability` (the past has no
 * probability) nor `visibility`, so the observation list omits them and those
 * fields stay null on observation readings — which the decision layer already
 * treats as "not reported", never as "fine".
 */
const FORECAST_HOURLY = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_gusts_10m",
  "visibility",
] as const;

const ARCHIVE_HOURLY = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation",
  "wind_speed_10m",
  "wind_gusts_10m",
] as const;

/** A hung vendor must not eat a cron's whole wall-clock budget. */
const REQUEST_TIMEOUT_MS = 15_000;

export type OpenMeteoOptions = {
  /**
   * The COMMERCIAL subscription key, injected by the factory in ../index.
   * REQUIRED even though the vendor's open-access tier is keyless: the free
   * tier is non-commercial-only, and this adapter refuses to exist without
   * the commercial credential rather than default onto the wrong licence.
   */
  readonly apiKey: string;
  /**
   * Transport injection for tests: contract tests hand in a stub that serves
   * checked-in fixture JSON, so the suite proves the mapping with ZERO
   * network. Defaults to the platform fetch.
   */
  readonly fetchImpl?: typeof fetch;
};

/** UTC calendar date (YYYY-MM-DD) — the granularity the vendor's window takes. */
function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A finite number or null — the vendor uses JSON null for "not available". */
function metric(series: unknown, index: number): number | null {
  if (!Array.isArray(series)) return null;
  const v: unknown = series[index];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

type HourlyBlock = Readonly<Record<string, unknown>> & { readonly time?: unknown };

/**
 * Build the Open-Meteo provider.
 *
 * A factory function rather than an exported class, so the ONLY way to obtain
 * an instance is through `getWeatherProvider()`'s credential-gated arm (or a
 * test constructing one explicitly with a fixture transport — which is the
 * point of the seam).
 */
export function createOpenMeteoProvider(options: OpenMeteoOptions): WeatherProvider {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    // The factory never calls with an empty key; this guards a direct caller.
    throw new WeatherProviderError({
      provider: PROVIDER_ID,
      message: "cannot construct without the commercial API key (the licence gate)",
      retryable: false,
    });
  }
  const transport = options.fetchImpl ?? globalThis.fetch;

  async function requestHourly(input: {
    readonly kind: WeatherReadingKind;
    readonly coordinates: DistrictCoordinates;
    readonly fromInclusive: Date;
    readonly toExclusive: Date;
  }): Promise<HourlyBlock> {
    const endpoint = input.kind === "forecast" ? FORECAST_ENDPOINT : ARCHIVE_ENDPOINT;
    const hourly = input.kind === "forecast" ? FORECAST_HOURLY : ARCHIVE_HOURLY;

    const url = new URL(endpoint);
    url.searchParams.set("latitude", String(input.coordinates.lat));
    url.searchParams.set("longitude", String(input.coordinates.lon));
    url.searchParams.set("hourly", hourly.join(","));
    url.searchParams.set("start_date", isoDateUTC(input.fromInclusive));
    // `end_date` is inclusive at DATE granularity; the exact half-open instant
    // window is applied by the caller-side filter in fetchWindow below.
    url.searchParams.set("end_date", isoDateUTC(new Date(input.toExclusive.getTime() - 1)));
    url.searchParams.set("wind_speed_unit", "ms"); // SI, or every lifting threshold is 3.6× wrong
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("timeformat", "iso8601");
    url.searchParams.set("apikey", apiKey); // the vendor's documented auth for customer- hosts

    let response: Response;
    try {
      response = await transport(url.toString(), {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // Network-level failure (DNS, TLS, timeout): the vendor never answered.
      throw new WeatherProviderError({
        provider: PROVIDER_ID,
        message: `network failure: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      });
    }

    if (!response.ok) {
      // 429 = call budget exhausted or rate-limited (fails closed, no overage
      // bill); 5xx = vendor-side. Both transient. Any other 4xx is OUR request
      // being wrong — retrying it would spend budget to get the same refusal.
      const retryable = response.status === 429 || response.status >= 500;
      let reason = `HTTP ${response.status}`;
      try {
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "reason" in body &&
          typeof (body as { reason: unknown }).reason === "string"
        ) {
          reason = `HTTP ${response.status}: ${(body as { reason: string }).reason}`;
        }
      } catch {
        // Unparseable error body — the status alone is the answer.
      }
      throw new WeatherProviderError({
        provider: PROVIDER_ID,
        message: reason,
        retryable,
        status: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WeatherProviderError({
        provider: PROVIDER_ID,
        message: "malformed response: body is not JSON",
        retryable: false,
        status: response.status,
      });
    }

    if (typeof payload !== "object" || payload === null) {
      throw new WeatherProviderError({
        provider: PROVIDER_ID,
        message: "malformed response: body is not an object",
        retryable: false,
        status: response.status,
      });
    }

    // The vendor's own error shape can arrive under HTTP 200 behind proxies.
    if ((payload as { error?: unknown }).error === true) {
      const reason = (payload as { reason?: unknown }).reason;
      throw new WeatherProviderError({
        provider: PROVIDER_ID,
        message: `vendor error: ${typeof reason === "string" ? reason : "no reason given"}`,
        retryable: false,
        status: response.status,
      });
    }

    const block = (payload as { hourly?: unknown }).hourly;
    if (typeof block !== "object" || block === null || !Array.isArray((block as HourlyBlock).time)) {
      throw new WeatherProviderError({
        provider: PROVIDER_ID,
        message: "malformed response: missing hourly time series",
        retryable: false,
        status: response.status,
      });
    }
    return block as HourlyBlock;
  }

  function toReadings(input: {
    readonly district: PostcodeDistrict;
    readonly kind: WeatherReadingKind;
    readonly fromInclusive: Date;
    readonly toExclusive: Date;
    readonly hourly: HourlyBlock;
  }): WeatherReading[] {
    const { hourly } = input;
    const times = hourly.time as unknown[];
    const out: WeatherReading[] = [];

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (typeof t !== "string") continue;
      // `timezone=UTC` + iso8601 yields "2026-11-12T06:00" with no zone
      // designator; it IS UTC by request, so say so explicitly.
      const validAt = new Date(t.endsWith("Z") || t.includes("+") ? t : `${t}Z`);
      if (Number.isNaN(validAt.getTime())) continue;
      // The vendor's window is date-granular; the seam's is instant-granular
      // and half-open. Enforce [fromInclusive, toExclusive) here.
      if (validAt < input.fromInclusive || validAt >= input.toExclusive) continue;

      // `precipitation` is the millimetres accumulated over the preceding
      // one-hour step — so it is simultaneously the interval total AND, at 1 h
      // resolution, numerically the mm/h average rate. Both fields are set
      // from it, and that equivalence holds ONLY because the step is one hour.
      const precipMm = metric(hourly["precipitation"], i);

      // Every metric is run through boundedMetric so a value outside the
      // weather_readings CHECK / numeric precision (a glitch negative wind, a
      // >100 % humidity, a precip that overflows numeric(5,2)) is NULLED rather
      // than emitted — one such value would abort the district's whole upsert and
      // strand it re-failing every tick. The precip pair is bounded per FIELD
      // because the rate (numeric(5,2)) and total (numeric(6,2)) ceilings differ.
      const reading: WeatherReading = {
        district: input.district,
        kind: input.kind,
        validAt,
        airTempC: boundedMetric(metric(hourly["temperature_2m"], i), "air_temp_c"),
        windSpeedMs: boundedMetric(metric(hourly["wind_speed_10m"], i), "wind_speed_ms"),
        windGustMs: boundedMetric(metric(hourly["wind_gusts_10m"], i), "wind_gust_ms"),
        precipRateMmH: boundedMetric(precipMm, "precip_rate_mm_h"),
        precipTotalMm: boundedMetric(precipMm, "precip_total_mm"),
        precipProbPct: boundedMetric(metric(hourly["precipitation_probability"], i), "precip_prob_pct"),
        humidityPct: boundedMetric(metric(hourly["relative_humidity_2m"], i), "humidity_pct"),
        visibilityM: boundedMetric(metric(hourly["visibility"], i), "visibility_m"),
      };

      // An hour where EVERY measurement is null (the archive's not-yet-
      // available lag) carries no information: storing it would cache
      // "nothing" under a row that looks like data. Dropped — which is how a
      // recent observation window legitimately comes back empty.
      const hasAny =
        reading.airTempC !== null ||
        reading.windSpeedMs !== null ||
        reading.windGustMs !== null ||
        reading.precipRateMmH !== null ||
        reading.precipTotalMm !== null ||
        reading.precipProbPct !== null ||
        reading.humidityPct !== null ||
        reading.visibilityM !== null;
      if (hasAny) out.push(reading);
    }
    return out;
  }

  return {
    info: { provider: PROVIDER_ID, attribution: ATTRIBUTION },

    async fetchWindow(input) {
      const hourly = await requestHourly({
        kind: input.kind,
        coordinates: input.coordinates,
        fromInclusive: input.fromInclusive,
        toExclusive: input.toExclusive,
      });
      return toReadings({
        district: input.district,
        kind: input.kind,
        fromInclusive: input.fromInclusive,
        toExclusive: input.toExclusive,
        hourly,
      });
    },
  };
}
