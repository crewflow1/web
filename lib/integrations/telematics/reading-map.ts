/**
 * Telematics feed — the PURE mapper from a provider location/odometer payload onto
 * the `telematics_readings` row shape (20261103).
 *
 * THE GAP THIS CLOSES. CrewFlow already has a vehicle register — `fleet_vehicles`
 * (20261056) — that carries a single latest `odometer_miles`. The telematics
 * substrate does NOT invent a new vehicle model: once a feed is live, provider
 * samples are mapped by THIS function onto append-only `telematics_readings` rows
 * keyed to those vehicles, so a track/history lights up against the register the
 * product already renders. Activation is a config + CEO-provider-choice flip; the
 * data lands where the product already knows the vehicles.
 *
 * ── PROVIDER-AGNOSTIC INPUT ─────────────────────────────────────────────────
 * Aggregators disagree on field names and units (Samsara nests `gps` with
 * `latitude`/`longitude` and reports odometer in METRES; Verizon Connect uses
 * `Latitude`/`Longitude` and miles). To keep this mapper single-purpose and
 * deterministic, the ADAPTER normalises its native shape into `TelematicsSample`
 * first (absolute miles + a decimal-degree fix), and this mapper owns the ONE
 * canonical transform: sample → telematics_readings insert, plus the org/vehicle/
 * connection pinning the row requires. A per-provider normaliser
 * (`normalizeSamsaraSamples`) lives here too so the unit conversion lives once and
 * is unit-tested.
 *
 * ── PURITY IS STRUCTURAL ────────────────────────────────────────────────────
 * No I/O, no clock, no `server-only`, no network. The same inputs always produce
 * byte-identical output, so the mapper is exhaustively unit-testable. This file
 * NEVER fetches — it only shapes data an adapter has already fetched (and no
 * adapter fetches while dark).
 */

/** Metres in one statute mile — the Samsara odometer unit conversion. */
const METRES_PER_MILE = 1609.344;

/**
 * The provider-agnostic sample an adapter emits after normalising its native
 * shape. A decimal-degree fix and/or an absolute odometer in MILES, plus the
 * provider's own event id (idempotency) and the instant the sample was taken.
 */
export type TelematicsSample = {
  /** The vehicle this sample is for — a fleet_vehicles.asset_id. */
  vehicleId: string;
  /** Provider event/sample id — the idempotency key; carried into source_event_id. */
  eventId: string;
  /** ISO timestamp the sample was recorded at. */
  recordedAt: string;
  /** Decimal-degree latitude, or null for an odometer-only sample. */
  latitude?: number | null;
  /** Decimal-degree longitude, or null for an odometer-only sample. */
  longitude?: number | null;
  /** Odometer in MILES (>= 0), or null for a location-only sample. */
  odometerMiles?: number | null;
};

/**
 * The exact shape of a `public.telematics_readings` INSERT row (20261103). id /
 * created_at default; the immutability trigger makes the row append-only.
 */
export type TelematicsReadingInsert = {
  org_id: string;
  vehicle_id: string;
  connection_id: string;
  source_event_id: string;
  /** ISO timestamp. */
  recorded_at: string;
  latitude: number | null;
  longitude: number | null;
  odometer_miles: number | null;
};

/** Options binding a mapped sample to its org + source connection. */
export type ReadingMapTarget = {
  orgId: string;
  connectionId: string;
};

// ── telematics_readings CHECK-constraint bounds (20261103) ───────────────────
// The mapper MUST mirror EVERY range CHECK the table declares, so it can never
// emit a row the DB would reject (one such row aborts the whole ingest upsert →
// the org writes zero readings, tick after tick). Each constant below is bound to
// its migration CHECK; a NEW CHECK added to the table REQUIRES a matching guard
// here (and a matching assertion in telematics-reading-map.test.ts).
//   • latitude  numeric(9,6) check (latitude  is null or latitude  between -90  and 90)
const LAT_MIN = -90;
const LAT_MAX = 90;
//   • longitude numeric(9,6) check (longitude is null or longitude between -180 and 180)
const LNG_MIN = -180;
const LNG_MAX = 180;
//   • odometer_miles integer  check (odometer_miles is null or odometer_miles between 0 and 3000000)
const ODOMETER_MIN = 0;
const ODOMETER_MAX = 3_000_000;
// The remaining two CHECKs are STRUCTURAL, not range, and are enforced by the
// pair/has-signal logic below rather than a numeric bound:
//   • telematics_readings_latlng_pair   check ((latitude is null) = (longitude is null))
//   • telematics_readings_has_signal    check (latitude is not null or longitude is not null or odometer_miles is not null)

/** Round a coordinate to 6dp (~11cm) — the numeric(9,6) column precision. Pure. */
function coord(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Round an odometer to a whole mile within the CHECK range [0, 3,000,000]. The
 * lower bound clamps a small negative glitch to 0 (still a real "at the start"
 * reading); the UPPER bound cannot be clamped honestly — an odometer above
 * 3,000,000 miles is a corrupt/glitch sensor value, not a real mileage, so it is
 * dropped to null (no-signal) rather than manufactured into a row the
 * odometer_miles CHECK would reject and thereby poison the whole batch. Pure;
 * null passes through.
 */
function miles(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.max(ODOMETER_MIN, Math.round(n));
  // Upper CHECK bound: a value above the ceiling is not insertable — drop it.
  if (rounded > ODOMETER_MAX) return null;
  return rounded;
}

/**
 * Map ONE provider sample onto a telematics_readings insert row. Pure.
 *
 * The latitude/longitude are treated as a PAIR (both present or both null) to
 * satisfy the telematics_readings_latlng_pair CHECK: a lone coordinate is not a
 * fix, so a half-fix is dropped to null/null. The pair is ALSO range-validated
 * here — latitude within [-90, 90] AND longitude within [-180, 180] — because the
 * two coordinates have DIFFERENT ranges, so `coord()` alone cannot decide the
 * pair. A coordinate outside its range (corrupt NMEA reporting lat 99 / lng 200)
 * is not a fix: the WHOLE pair collapses to null/null so no row can violate the
 * latitude/longitude range CHECKs. A resulting all-null row (no fix, no odometer)
 * is then dropped by the has-signal filter in mapSamplesToReadings.
 */
export function mapSampleToReading(
  sample: TelematicsSample,
  target: ReadingMapTarget,
): TelematicsReadingInsert {
  const lat = coord(sample.latitude);
  const lng = coord(sample.longitude);
  // A fix needs BOTH coordinates AND each within its own CHECK range; otherwise
  // it is not a fix — drop the whole pair so the pair + range CHECKs hold.
  const hasFix =
    lat !== null &&
    lng !== null &&
    lat >= LAT_MIN &&
    lat <= LAT_MAX &&
    lng >= LNG_MIN &&
    lng <= LNG_MAX;
  return {
    org_id: target.orgId,
    vehicle_id: sample.vehicleId,
    connection_id: target.connectionId,
    source_event_id: sample.eventId,
    recorded_at: sample.recordedAt,
    latitude: hasFix ? lat : null,
    longitude: hasFix ? lng : null,
    odometer_miles: miles(sample.odometerMiles),
  };
}

/**
 * Map a whole batch of provider samples onto telematics_readings insert rows.
 * Pure. Samples carrying NEITHER a fix NOR an odometer are dropped — the
 * telematics_readings_has_signal CHECK would reject them, so the mapper filters
 * them here rather than manufacturing a row that cannot be inserted. This filter
 * is ALSO what drops a sample whose only signals were out-of-range and therefore
 * nulled by mapSampleToReading (bad coordinate pair) / miles() (odometer above
 * the ceiling): once every signal is nulled the row carries no signal, so a
 * single glitchy vehicle can never contribute an uninsertable row to the batch.
 * NET GUARANTEE: the returned set can never contain a row that violates any
 * telematics_readings CHECK (range, latlng-pair, or has-signal).
 */
export function mapSamplesToReadings(
  samples: readonly TelematicsSample[],
  target: ReadingMapTarget,
): TelematicsReadingInsert[] {
  return samples
    .map((s) => mapSampleToReading(s, target))
    .filter(
      (r) =>
        r.latitude !== null || r.longitude !== null || r.odometer_miles !== null,
    );
}

// ── Per-provider normalisers (native shape → TelematicsSample) ────────────────
// These keep the adapters thin and the unit/field arithmetic in one tested place.

/** A Samsara vehicle-stats sample (the subset the mapper needs). */
export type SamsaraVehicleStat = {
  /** Samsara vehicle id — opaque to CrewFlow; used only for the idempotency key. */
  id: string;
  /**
   * The vehicle's Samsara display name — returned natively on the vehicle-stats
   * endpoint. Many trades fleets label the vehicle by its REGISTRATION plate, so
   * it is a last-resort resolution key after VIN and licensePlate. Optional.
   */
  name?: string | null;
  /**
   * The vehicle's licence/number plate as Samsara reports it. This is the primary
   * REGISTRATION key a UK-trades fleet resolves on: `assets.registration` is the
   * human key and `fleet_vehicles.vin` is usually blank, so without threading the
   * plate through, a registration-keyed fleet resolves ZERO samples. Optional.
   */
  licensePlate?: string | null;
  /**
   * The vehicle's external identifiers as Samsara reports them. Samsara emits the
   * VIN under a NAMESPACED key (`samsara.vin`), not a bare `vin` — e.g.
   * `{ "samsara.vin": "1HGBH41JXMN109186", "maintenanceId": "250020" }`. The VIN is
   * the strongest identifier both Samsara and the CrewFlow fleet register
   * (fleet_vehicles.vin) carry, so it is the FIRST resolution key. Optional: absent
   * on older payloads / registration-keyed fleets, where the plate/name resolve.
   */
  externalIds?: Record<string, string> | null;
  gps?: {
    latitude?: number | null;
    longitude?: number | null;
    time?: string | null;
  } | null;
  /**
   * The odometer. Samsara's `/fleet/vehicles/stats` returns `obdOdometerMeters`
   * as its OWN TOP-LEVEL per-vehicle stat — a `{ time, value }` object where
   * `value` is METRES — NOT a field nested inside `gps` (the `gps` stat carries
   * only latitude/longitude/heading/speed/address/time). Reading it off `gps`
   * left the odometer feed dead: it was always undefined, so every sample
   * mapped to a null odometer and the register never forward-updated.
   */
  obdOdometerMeters?: { time?: string | null; value?: number | null } | null;
};

/**
 * Extract a VIN from a Samsara externalIds map, normalised (trimmed, upper-cased)
 * so it matches a fleet_vehicles.vin lookup exactly. Samsara emits the VIN under a
 * NAMESPACED key — `samsara.vin` — NOT a bare `vin`, so a match on the literal
 * `vin` alone resolved zero VINs for a real Samsara payload. Accept EITHER a key
 * equal to `vin` OR one ending in `.vin` (e.g. `samsara.vin`, a provider-prefixed
 * custom id). Returns null when absent/blank. Pure.
 */
export function vinFromExternalIds(
  externalIds: Record<string, string> | null | undefined,
): string | null {
  if (!externalIds) return null;
  for (const [key, value] of Object.entries(externalIds)) {
    const k = key.toLowerCase();
    if ((k === "vin" || k.endsWith(".vin")) && typeof value === "string" && value.trim().length > 0) {
      return value.trim().toUpperCase();
    }
  }
  return null;
}

/**
 * Normalise Samsara vehicle-stats into the provider-agnostic sample shape. The
 * caller supplies the vehicle-id → fleet_vehicles.asset_id resolution (a tenant
 * mapping that lives outside this pure module). Odometer metres → miles is done
 * HERE so the conversion lives once and is unit-tested. Pure.
 */
export function normalizeSamsaraSamples(
  rows: readonly SamsaraVehicleStat[],
  resolveVehicleId: (samsaraVehicleId: string) => string | null,
): TelematicsSample[] {
  const out: TelematicsSample[] = [];
  for (const r of rows) {
    // Resolution KEY SET, tried in priority order against BOTH fleet indexes (VIN
    // then registration — see buildFleetIndex). VIN (namespaced or bare) is the
    // strongest key; the licence plate is the primary key for a registration-keyed
    // fleet (blank VIN, populated assets.registration — the typical UK trades
    // tenant); the Samsara display name is a last resort (fleets often name a
    // vehicle by its plate); the opaque Samsara id is the final fallback for older
    // payloads / tests. The FIRST key that resolves wins. The idempotency key stays
    // keyed to the stable Samsara id regardless of which key resolved the vehicle.
    const candidateKeys = [
      vinFromExternalIds(r.externalIds),
      r.licensePlate,
      r.name,
      r.id,
    ];
    let vehicleId: string | null = null;
    for (const key of candidateKeys) {
      if (typeof key !== "string" || key.trim().length === 0) continue;
      vehicleId = resolveVehicleId(key);
      if (vehicleId) break;
    }
    if (!vehicleId) continue; // unmapped vehicle — skip rather than guess.
    const gps = r.gps ?? null;
    const odo = r.obdOdometerMeters ?? null;
    // recorded_at is NOT NULL in the DB. A sample with no provider timestamp
    // cannot be honestly placed in time, so DROP it rather than coin an empty
    // string that would fail the insert (or, worse, a fabricated "now"). This
    // keeps the mapper a faithful transcription and activation a config-flip.
    // gps.time drives it for a fix; an ODOMETER-ONLY sample (no gps stat) is
    // still placed in time via the odometer stat's own timestamp so it persists.
    const rawTime =
      typeof gps?.time === "string" && gps.time.length > 0 ? gps.time : odo?.time;
    if (typeof rawTime !== "string" || rawTime.length === 0) continue;
    const recordedAt = rawTime;
    // Samsara reports the odometer in METRES on the TOP-LEVEL obdOdometerMeters
    // stat ({ time, value }) — never nested in gps.
    const metres = odo?.value;
    const odometerMiles =
      typeof metres === "number" && Number.isFinite(metres)
        ? metres / METRES_PER_MILE
        : null;
    out.push({
      vehicleId,
      eventId: `${r.id}:${recordedAt}`,
      recordedAt,
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      odometerMiles,
    });
  }
  return out;
}
