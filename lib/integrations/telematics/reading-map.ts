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

/** Round a coordinate to 6dp (~11cm) — the numeric(9,6) column precision. Pure. */
function coord(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

/** Round an odometer to a whole mile, clamped to >= 0. Pure; null passes through. */
function miles(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

/**
 * Map ONE provider sample onto a telematics_readings insert row. Pure.
 *
 * The latitude/longitude are treated as a PAIR (both present or both null) to
 * satisfy the telematics_readings_latlng_pair CHECK: a lone coordinate is not a
 * fix, so a half-fix is dropped to null/null.
 */
export function mapSampleToReading(
  sample: TelematicsSample,
  target: ReadingMapTarget,
): TelematicsReadingInsert {
  const lat = coord(sample.latitude);
  const lng = coord(sample.longitude);
  // A fix needs BOTH coordinates; drop a half-fix so the pair CHECK holds.
  const hasFix = lat !== null && lng !== null;
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
 * them here rather than manufacturing a row that cannot be inserted.
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
   * The vehicle's external identifiers as Samsara reports them (e.g.
   * `{ "vin": "1HGBH41JXMN109186", "maintenanceId": "250020" }`). The VIN is the
   * ONE identifier both Samsara and the CrewFlow fleet register (fleet_vehicles.vin)
   * carry, so it — not Samsara's opaque internal id — is the natural vehicle
   * resolution key. Optional: absent on older payloads, where we fall back to `id`.
   */
  externalIds?: Record<string, string> | null;
  gps?: {
    latitude?: number | null;
    longitude?: number | null;
    /** Samsara reports odometer in METRES. */
    odometerMeters?: number | null;
    time?: string | null;
  } | null;
};

/**
 * Extract a VIN from a Samsara externalIds map, normalised (trimmed, upper-cased)
 * so it matches a fleet_vehicles.vin lookup exactly. Samsara names this key `vin`
 * on the vehicles endpoint. Returns null when absent/blank. Pure.
 */
export function vinFromExternalIds(
  externalIds: Record<string, string> | null | undefined,
): string | null {
  if (!externalIds) return null;
  for (const [key, value] of Object.entries(externalIds)) {
    if (key.toLowerCase() === "vin" && typeof value === "string" && value.trim().length > 0) {
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
    // Resolve on the VIN both systems share when Samsara reports one; fall back to
    // the opaque Samsara vehicle id (older payloads / tests). The idempotency key
    // stays keyed to the stable Samsara id regardless.
    const resolutionKey = vinFromExternalIds(r.externalIds) ?? r.id;
    const vehicleId = resolveVehicleId(resolutionKey);
    if (!vehicleId) continue; // unmapped vehicle — skip rather than guess.
    const gps = r.gps ?? null;
    // recorded_at is NOT NULL in the DB. A sample with no provider timestamp
    // cannot be honestly placed in time, so DROP it rather than coin an empty
    // string that would fail the insert (or, worse, a fabricated "now"). This
    // keeps the mapper a faithful transcription and activation a config-flip.
    const recordedAt = gps?.time;
    if (typeof recordedAt !== "string" || recordedAt.length === 0) continue;
    const metres = gps?.odometerMeters;
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
