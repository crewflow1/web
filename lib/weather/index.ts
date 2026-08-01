import "server-only";

/**
 * Weather intelligence — the provider factory (the plug-in seam).
 *
 * This is the ONE place that knows which weather vendor is active, and today the
 * answer is "none". `getWeatherProvider()` returns `null` on every path, in every
 * environment — prod, CI and dev — and that null is the whole graceful-
 * degradation contract, identical to the email / SMS / WhatsApp seams in
 * lib/comms/index.ts:
 *
 *   provider present → the service fetches, caches, and the decision layer runs
 *                      against real readings.
 *   provider null    → the service fetches NOTHING, writes NOTHING, and reports
 *                      "not configured". The decision layer still runs, over an
 *                      empty window, and returns `unknown` — never `viable`.
 *                      THIS IS THE ONLY PATH THIS BUILD HAS, and therefore the
 *                      only path CI exercises.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ADAPTER EXISTS (open-meteo) — AND THE BUILD IS STILL DARK, deliberately
 * ═══════════════════════════════════════════════════════════════════════════
 * Train 7 added ./providers/open-meteo.ts, a real WeatherProvider for both
 * kinds. That changes what this factory COULD return; it changes nothing about
 * what it DOES return in any environment that exists today, because the
 * open-meteo arm is gated on `OPEN_METEO_API_KEY` — and no such credential is
 * set anywhere (prod, CI, dev). Binding the vendor remains a commercial
 * decision with a licence and a bill attached (docs/weather/provider-options.md);
 * what an engineer could ship in advance of that decision — the adapter, the
 * fetch pipeline, the cron seam — is now shipped, dark.
 *
 *   THE KILL SWITCH is the selection itself: `WEATHER_PROVIDER` unset, "none",
 *   "off" or "disabled" ⇒ null, regardless of any key. No new flag system —
 *   turning weather off is clearing one variable, and turning it on is the
 *   deliberate pair (selection + credential). Removing the credential alone
 *   also kills it: every gate is conjunctive.
 *
 * The metoffice arm still returns null unconditionally: NO Met Office adapter
 * exists in this build. Adding one is a sibling file in ./providers plus this
 * factory's arm plus flipping `PROVIDER_IMPLEMENTED` (./readiness) plus the
 * security suite's transport roster — four visible diffs, never a quiet
 * configuration change.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NETWORK EGRESS EXISTS IN EXACTLY ONE FILE — AND CI STILL PROVES ZERO EGRESS
 * ═══════════════════════════════════════════════════════════════════════════
 * ./providers/open-meteo.ts is the single file in the feature allowed to
 * contain a transport primitive, named on an explicit allowlist in
 * __tests__/security/weather-intelligence.test.ts (the analogue of the AI
 * ratchet's TRANSPORT set). Every other file — this one, the read service, the
 * fetch service, the cron route, the page — is still swept for `fetch(`, http
 * imports and vendor hosts. Construction here is cheap, synchronous and
 * network-free: the seam hands back an object, it does not connect, and with
 * no credential in any environment the adapter is never constructed at all —
 * so CI exercises the null path and the fixture-fed adapter tests, and puts
 * nothing on any wire.
 */

import { env } from "@/lib/env";
import type { WeatherProvider } from "./types";
import { getWeatherReadiness } from "./readiness";
import { createOpenMeteoProvider } from "./providers/open-meteo";

export { WeatherProviderError } from "./types";

export type {
  WeatherProvider,
  WeatherProviderInfo,
  WeatherReading,
  WeatherReadingKind,
  WeatherWindow,
  PostcodeDistrict,
  DistrictCoordinates,
} from "./types";
export { WEATHER_READING_KINDS } from "./types";

export {
  resolveDistrictCoordinates,
  datasetInfo,
  DISTRICT_CENTROID_COUNT,
  DISTRICT_CENTROID_SOURCE,
  DISTRICT_CENTROID_VERSION,
  DISTRICT_CENTROID_ATTRIBUTION,
} from "./geo";
export type { DistrictDatasetInfo, DistrictCentroidRow } from "./geo";

export {
  toPostcodeDistrict,
  isPostcodeDistrict,
  districtForAddress,
  distinctDistricts,
} from "./postcode";

export {
  assessWorkability,
  assessAll,
  summariseWindow,
  dewPointC,
  msToMph,
  sourcedThresholdRatio,
  WORKABILITY_VERDICTS,
} from "./decision";
export type {
  WorkabilityAssessment,
  WorkabilityVerdict,
  WorkabilityReason,
  WeatherSummary,
} from "./decision";

export {
  WORK_TYPES,
  WORK_TYPE_LABELS,
  WORK_TYPE_THRESHOLDS,
  ALL_THRESHOLDS,
  UNSOURCED_THRESHOLD_COUNT,
  FULLY_UNSOURCED_WORK_TYPES,
  isSourced,
} from "./thresholds";
export type { WorkType, Threshold, WeatherMetric, ThresholdSourceKind } from "./thresholds";

export {
  getWeatherReadiness,
  isWeatherAvailable,
  weatherStatusLine,
  KNOWN_WEATHER_PROVIDERS,
  KNOWN_WEATHER_CREDENTIALS,
} from "./readiness";
export type { WeatherReadiness, KnownWeatherProvider } from "./readiness";

/**
 * Resolve the configured weather provider, or `null` when none is usable.
 *
 * NEVER THROWS: an unknown provider name or a missing key degrades to `null`
 * (weather off) rather than crashing the caller. Selecting a provider is
 * CONFIGURATION — `WEATHER_PROVIDER` names the vendor — and the vendor's own
 * credential gates construction, so BOTH must be present before anything is
 * handed back. Every arm resolves to null in every environment that exists
 * today, because no weather credential is set anywhere.
 */
export function getWeatherProvider(): WeatherProvider | null {
  const name = (env.WEATHER_PROVIDER ?? "").trim().toLowerCase();

  switch (name) {
    case "metoffice": {
      // Met Office Weather DataHub, Site Specific (Global Spot).
      // NO ADAPTER IN THIS BUILD. Activation needs, in order:
      //   1. a DataHub subscription and MET_OFFICE_API_KEY;
      //   2. ./providers/met-office.ts implementing WeatherProvider;
      //   3. `metoffice: true` in PROVIDER_IMPLEMENTED (./readiness);
      //   4. the file added to the security suite's transport roster.
      // (The district → coordinate prerequisite is CLOSED: ./geo resolves the
      // lat/lon the API takes, from the checked-in ONSPD centroid dataset.)
      return null;
    }

    case "open-meteo": {
      // Open-Meteo — ADAPTER BUILT (Train 7), STRUCTURALLY DARK until the
      // commercial decision is taken. THE LICENCE TRAP is the reason the key
      // gate below must never be relaxed: the vendor's keyless open-access
      // tier is licensed for NON-COMMERCIAL use only, so "no key" must read
      // as "not activated", never as "fall back to the free endpoints" (the
      // adapter speaks only to the commercial customer- hosts). Activation =
      // a paid subscription, OPEN_METEO_API_KEY set, and the CC-BY 4.0
      // attribution (info.attribution) rendered wherever the data shows.
      const key = (env.OPEN_METEO_API_KEY ?? "").trim();
      if (key.length === 0) {
        // The commercial licence gate. Dark in every environment today.
        return null;
      }
      if (!getWeatherReadiness().districtResolutionAvailable) {
        // No coordinates ⇒ nothing this provider could be asked. Only
        // reachable if the checked-in ONSPD dataset regresses.
        return null;
      }
      return createOpenMeteoProvider({ apiKey: key });
    }

    // Future providers slot in here — configuration only:
    //   case "visualcrossing": ...
    //   case "openweather":    ...

    case "":
    case "none":
    case "off":
    case "disabled":
      // The default posture everywhere. Nothing is set, so this is the arm taken.
      return null;

    default:
      // Unknown name → degrade, don't crash. Weather stays off until the
      // configuration is corrected. Deliberately quiet: this is the DEFAULT
      // state of every environment, and warning on it would train operators to
      // ignore the log.
      return null;
  }
}

/** Cheap presence check, mirroring `isEmailConfigured()`. False in every environment today. */
export function isWeatherProviderConfigured(): boolean {
  return getWeatherProvider() !== null;
}
