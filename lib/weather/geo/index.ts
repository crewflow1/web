/**
 * Weather intelligence — district → coordinate resolution.
 *
 * The closer of the activation blocker that was never a credential: every
 * realistic UK weather vendor is queried by latitude and longitude, and until
 * this module existed the build had no way to produce one. It resolves a
 * postcode district (outward code) to a WGS84 centroid from a CHECKED-IN
 * static dataset derived offline from the ONS Postcode Directory — see
 * ./district-centroids.ts (generated) and scripts/derive-district-centroids.ts
 * (the derivation, runnable offline against a downloaded ONSPD release).
 *
 * PURE, like the rest of the core: no I/O, no network, no `process.env`, no
 * clock, no `server-only`. Resolution is one Map lookup, O(1), built once at
 * module load from the sorted literal. The security suite scans this directory
 * with the same zero-egress pins as the rest of lib/weather — a dataset that
 * arrived over the wire at runtime would be an egress channel and a silent
 * dependency; a checked-in one is a reviewed diff.
 *
 * NO SILENT GUESSING. An unknown district resolves to `null`, full stop.
 * Callers must surface "cannot resolve this district" — never substitute a
 * neighbouring district, a national average, or (the classic) 0,0. This is the
 * same refusal contract as toPostcodeDistrict in ../postcode: a forecast for
 * the wrong place is worse than no forecast. `GIR` in particular resolves to
 * null — it is a payments artefact, not a place.
 *
 * THE PRECISION CAVEAT (the IV27 case). A district centroid is not a site
 * coordinate. In LS1 the centroid is within ~1 km of any address in the
 * district; in IV27 (Sutherland — the largest UK district by area) it can be
 * tens of kilometres from the actual job. That imprecision is inherent to the
 * district-level cache key, is priced into the schema (weather_readings is
 * keyed on district, with resolved_lat/resolved_lon recording WHAT coordinate
 * was actually asked about), and is surfaced to the verdict layer via
 * `WeatherWindow.resolvedDistanceKm` so the caveat can be shown rather than
 * hidden. `quality: "centroid"` on every result exists so no caller can
 * mistake this for geocoding.
 */

import type { DistrictCoordinates, PostcodeDistrict } from "../types";
import {
  DISTRICT_CENTROIDS,
  DISTRICT_CENTROID_ATTRIBUTION,
  DISTRICT_CENTROID_COUNT,
  DISTRICT_CENTROID_SOURCE,
  DISTRICT_CENTROID_VERSION,
} from "./district-centroids";

export {
  DISTRICT_CENTROIDS,
  DISTRICT_CENTROID_ATTRIBUTION,
  DISTRICT_CENTROID_COUNT,
  DISTRICT_CENTROID_SOURCE,
  DISTRICT_CENTROID_VERSION,
} from "./district-centroids";
export type { DistrictCentroidRow } from "./district-centroids";

/**
 * district → [lat, lon]. Built ONCE at module load, `const` — no lazy `let`,
 * so this module holds no mutable state and one lookup can never influence
 * the next. ~2,900 entries; construction is microseconds.
 */
const INDEX: ReadonlyMap<string, readonly [number, number]> = new Map(
  DISTRICT_CENTROIDS.map(([district, lat, lon]) => [district, [lat, lon] as const]),
);

/**
 * Resolve a postcode district to the coordinate a weather vendor would be
 * asked about.
 *
 * Returns `null` for any district the dataset does not carry — unknown
 * shapes, retired districts, GIR, and the Crown-dependency areas (GY/JE/IM)
 * for which the ONSPD publishes no coordinates. Null is a first-class answer:
 * the caller reports "cannot resolve", it does not guess.
 */
export function resolveDistrictCoordinates(
  district: PostcodeDistrict,
): DistrictCoordinates | null {
  const hit = INDEX.get(district);
  if (hit === undefined) return null;
  return {
    lat: hit[0],
    lon: hit[1],
    source: DISTRICT_CENTROID_SOURCE,
    quality: "centroid",
  };
}

/** Shape of {@link datasetInfo} — what a readiness or attribution surface shows. */
export type DistrictDatasetInfo = {
  /** Dataset identity, e.g. "ons_onspd". */
  readonly source: typeof DISTRICT_CENTROID_SOURCE;
  /** Human-readable release, e.g. "ONSPD May 2026". */
  readonly version: string;
  /** How many districts resolve. */
  readonly districtCount: number;
  /** The OGL v3 attribution lines a displaying surface must render. */
  readonly attribution: ReadonlyArray<string>;
};

/**
 * The dataset's provenance, for the readiness UI and any surface that renders
 * derived coordinates — the Open Government Licence requires the attribution
 * lines to be displayed, so they are part of the interface rather than a
 * comment someone would have to go looking for.
 */
export function datasetInfo(): DistrictDatasetInfo {
  return {
    source: DISTRICT_CENTROID_SOURCE,
    version: DISTRICT_CENTROID_VERSION,
    districtCount: DISTRICT_CENTROID_COUNT,
    attribution: DISTRICT_CENTROID_ATTRIBUTION,
  };
}
