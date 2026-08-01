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
 * WHY THERE IS NO ADAPTER HERE, deliberately
 * ═══════════════════════════════════════════════════════════════════════════
 * Every arm below returns null because NO adapter file exists. That is not an
 * omission, it is the mandate: binding a weather vendor is a commercial decision
 * with a licence and a bill attached, and it is not an engineer's to take. The
 * options, their keys, their licences and their costs are documented in
 * docs/weather/provider-options.md so the decision can be made on evidence.
 *
 * Adding one is a sibling file in ./providers plus a branch here, plus flipping
 * that vendor's entry in `PROVIDER_IMPLEMENTED` (./readiness) — which trips the
 * security suite, so activation can never be a quiet configuration change.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO NETWORK EGRESS IS POSSIBLE FROM THIS BUILD
 * ═══════════════════════════════════════════════════════════════════════════
 * No file under lib/weather/ or server/services/weather.ts contains a `fetch(`,
 * an `http`/`https` import, a vendor SDK import, or a URL to a weather host.
 * `__tests__/security/weather-intelligence.test.ts` proves it by scanning the
 * source of every file in the feature, so the guarantee survives someone adding
 * a file later. Construction here is cheap, synchronous and network-free even
 * once an adapter exists — the seam hands back an object, it does not connect.
 */

import { env } from "@/lib/env";
import type { WeatherProvider } from "./types";

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
 * CONFIGURATION ONLY — `WEATHER_PROVIDER` names the vendor and the vendor's own
 * key gates it — but configuration alone is not sufficient, because there is
 * nothing to construct.
 *
 * Returns `null` unconditionally today. The switch is written out in full anyway,
 * so the diff that activates a vendor is one branch in an obvious place rather
 * than a new control-flow shape invented under time pressure.
 */
export function getWeatherProvider(): WeatherProvider | null {
  const name = (env.WEATHER_PROVIDER ?? "").trim().toLowerCase();

  switch (name) {
    case "metoffice": {
      // Met Office Weather DataHub, Site Specific (Global Spot).
      // NO ADAPTER IN THIS BUILD. Activation needs, in order:
      //   1. a DataHub subscription and MET_OFFICE_API_KEY;
      //   2. ./providers/met-office.ts implementing WeatherProvider;
      //   3. `metoffice: true` in PROVIDER_IMPLEMENTED (./readiness).
      // (The district → coordinate prerequisite is CLOSED: ./geo resolves the
      // lat/lon the API takes, from the checked-in ONSPD centroid dataset.)
      return null;
    }

    case "open-meteo": {
      // Open-Meteo. NO ADAPTER IN THIS BUILD.
      // NOTE THE LICENCE TRAP: the keyless open-access tier is licensed for
      // NON-COMMERCIAL use only. CrewFlow is commercial, so activation requires
      // a paid subscription and OPEN_METEO_API_KEY, plus the CC-BY 4.0
      // attribution rendered on every surface that shows the data.
      return null;
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
