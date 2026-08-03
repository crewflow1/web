import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  telematicsProviderReady,
  type TelematicsProvider,
} from "@/lib/integrations/telematics/adapters";
import {
  decryptStoredTokens,
  refreshAccessToken,
  resolveActiveTelematicsProvider,
} from "@/lib/integrations/telematics/oauth";
import { encryptToken } from "@/lib/integrations/token-crypto";
import { syncTelematicsReadings } from "@/server/services/telematics-connections";
import type { TelematicsReadingInsert } from "@/lib/integrations/telematics/reading-map";

/**
 * Telematics reading SYNC — the service-role caller that ties a connected org's
 * aggregator feed to the append-only `telematics_readings` table (20261103). This
 * is the piece the C26 audit found MISSING: `syncTelematicsReadings` fetches +
 * maps but had NO caller, so a live feed would never have landed a row. This
 * orchestrates the whole pass and is driven by the cron seam
 * (app/api/cron/telematics-sync).
 *
 * ── DARK SHORT-CIRCUIT COMES FIRST — zero DB, zero client construction ───────
 * Readiness is checked BEFORE anything: on a dark build (no credentials / flag
 * off / no bound provider — every environment today) this returns `{ ran: false }`
 * WITHOUT constructing a Supabase client, reading a row, or contacting a provider.
 * Same posture as runWeatherFetch and the AI governor's pre-reservation gate, and
 * pinned the same way by the security suite: the readiness guard precedes
 * createAdminClient.
 *
 * ── WHY SERVICE ROLE ────────────────────────────────────────────────────────
 * `telematics_readings` has NO authenticated writer by design (a tenant who could
 * forge a reading could forge a vehicle's location/odometer history). The feed is
 * therefore a service-role writer, one of the legitimate elevated call sites
 * lib/supabase/admin.ts enumerates. The cross-tenant control is NOT the client —
 * it is the COMPOSITE FKs on telematics_readings (vehicle_id/connection_id each
 * carry org_id), so a row can never bind a vehicle or connection from another org
 * even under service_role. Every row we write carries the CONNECTION'S org_id.
 *
 * ── TOKEN MODEL (accurate to Samsara) ───────────────────────────────────────
 * Tokens are decrypted on use and refreshed proactively ONLY when a
 * `token_expires_at` is set and near/past (grant_type=refresh_token). Samsara also
 * supports a static, long-lived API token — that carries no expiry, so it is never
 * refreshed; the same code is correct for both. A single retry-after-refresh
 * covers a token that expired mid-window (a 401).
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * Readings are written with ON CONFLICT DO NOTHING on the DB identity
 * (org_id, connection_id, source_event_id) — an UPSERT that UPDATED would hit the
 * append-only immutability trigger, so `ignoreDuplicates` is load-bearing, not a
 * nicety. A re-delivered snapshot (same vehicle + same provider timestamp) is a
 * no-op at the DB, so re-running a tick never duplicates a reading.
 */

/** Seconds before expiry at which we proactively refresh the access token. */
const REFRESH_SKEW_SECONDS = 120;

const READINGS_CONFLICT = "org_id,connection_id,source_event_id";

export type TelematicsConnectionSyncOutcome = {
  connectionId: string;
  orgId: string;
  outcome: "written" | "empty" | "skipped_dark" | "refresh_failed" | "error";
  written: number;
  refreshed: boolean;
  message: string;
};

export type TelematicsSyncSummary = {
  ran: boolean;
  provider: TelematicsProvider | null;
  connections: number;
  written: number;
  outcomes: TelematicsConnectionSyncOutcome[];
  note?: string;
};

/** A connection row as read service-role (token columns included). */
type ConnectionRow = {
  id: string;
  org_id: string;
  provider: string;
  external_account_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  last_sync_at: string | null;
};

type VehicleRow = { asset_id: string; vin: string | null; odometer_miles: number | null };

/**
 * The org's fleet register, indexed two ways for one service-role read: VIN →
 * asset_id (vehicle resolution) and asset_id → current odometer (the forward-only
 * odometer guard). Built once per connection sync.
 */
type FleetIndex = {
  resolveVehicleId: (providerVehicleId: string) => string | null;
  currentOdometerByAsset: Map<string, number | null>;
};

type DbResult<T> = { data: T | null; error: { message: string } | null };
type WriteResult = { error: { message: string } | null };

/** A PostgREST-style filter chain: awaitable AND `.eq(...)`-chainable. */
type SelectChain<T> = PromiseLike<DbResult<T>> & {
  eq(col: string, val: string): SelectChain<T>;
};
type UpdateChain = PromiseLike<WriteResult> & {
  eq(col: string, val: string): UpdateChain;
};

/**
 * The minimal service-role builder this file uses. telematics_connections /
 * telematics_readings post-date the generated types.ts, so the admin client is
 * cast to this shape; the composite FKs + append-only trigger are the DB authority
 * regardless of the cast.
 */
type LooseDb = {
  from(t: string): {
    select(c: string): SelectChain<ConnectionRow[]> & SelectChain<VehicleRow[]>;
    upsert(
      rows: Record<string, unknown>[],
      opts: { onConflict: string; ignoreDuplicates: boolean; count?: string },
    ): PromiseLike<{ error: { message: string } | null; count: number | null }>;
    update(row: Record<string, unknown>): UpdateChain;
  };
};

/** True when the stored expiry is absent-safe or within the refresh skew window. */
function needsRefresh(tokenExpiresAt: string | null): boolean {
  if (!tokenExpiresAt) return false; // static API token / no expiry → never refresh.
  const expiry = Date.parse(tokenExpiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - Date.now() <= REFRESH_SKEW_SECONDS * 1000;
}

/**
 * Run one telematics sync pass across every connected org for the bound provider.
 * Dark-safe: returns `{ ran:false }` with no DB access when not activated.
 */
export async function runTelematicsSync(): Promise<TelematicsSyncSummary> {
  // ── DARK GATE FIRST — before any client / DB / network ──────────────────────
  const provider = resolveActiveTelematicsProvider();
  if (!provider || !telematicsProviderReady(provider)) {
    return {
      ran: false,
      provider: null,
      connections: 0,
      written: 0,
      outcomes: [],
      note: "telematics sync is dark: no bound, connectable provider.",
    };
  }

  const admin = createAdminClient();
  const loose = admin as unknown as LooseDb;

  const { data: connections, error } = await (loose
    .from("telematics_connections")
    .select(
      "id, org_id, provider, external_account_id, access_token, refresh_token, token_expires_at, last_sync_at",
    ) as SelectChain<ConnectionRow[]>)
    .eq("provider", provider)
    .eq("status", "connected");

  if (error) {
    return {
      ran: true,
      provider,
      connections: 0,
      written: 0,
      outcomes: [],
      note: `telematics_connections read failed: ${error.message}`,
    };
  }

  const rows = connections ?? [];
  const outcomes: TelematicsConnectionSyncOutcome[] = [];
  let totalWritten = 0;

  for (const conn of rows) {
    const outcome = await syncOneConnection(loose, provider, conn);
    outcomes.push(outcome);
    totalWritten += outcome.written;
  }

  return {
    ran: true,
    provider,
    connections: rows.length,
    written: totalWritten,
    outcomes,
  };
}

/** Sync a single connected org: refresh-if-needed, fetch+map, write, record state. */
async function syncOneConnection(
  loose: LooseDb,
  provider: TelematicsProvider,
  conn: ConnectionRow,
): Promise<TelematicsConnectionSyncOutcome> {
  const base: Omit<TelematicsConnectionSyncOutcome, "outcome" | "message" | "written" | "refreshed"> = {
    connectionId: conn.id,
    orgId: conn.org_id,
  };

  if (!conn.access_token) {
    await recordConnectionError(loose, conn.id, conn.org_id, "no access token stored");
    return { ...base, outcome: "error", written: 0, refreshed: false, message: "no access token stored" };
  }

  // Decrypt on use (throws on a wrong key / tamper — never silently proceeds).
  let accessToken: string;
  let refreshToken: string | null;
  try {
    const decrypted = decryptStoredTokens({
      accessToken: conn.access_token,
      refreshToken: conn.refresh_token,
    });
    accessToken = decrypted.accessToken;
    refreshToken = decrypted.refreshToken;
  } catch (e) {
    const message = `token decrypt failed: ${e instanceof Error ? e.message : "unknown"}`;
    await recordConnectionError(loose, conn.id, conn.org_id, message);
    return { ...base, outcome: "error", written: 0, refreshed: false, message };
  }

  let refreshed = false;

  // Proactive refresh when the stored token is near/past expiry (OAuth model).
  if (needsRefresh(conn.token_expires_at) && refreshToken) {
    const r = await refreshAccessToken({ provider, refreshToken });
    if (!r.ok) {
      const message = `token refresh failed: ${r.message}`;
      await recordConnectionError(loose, conn.id, conn.org_id, message);
      return { ...base, outcome: "refresh_failed", written: 0, refreshed: false, message };
    }
    accessToken = r.tokens.accessToken;
    // A provider MAY rotate the refresh token; keep the prior one when it does not.
    refreshToken = r.tokens.refreshToken ?? refreshToken;
    refreshed = true;
    await persistRefreshedTokens(loose, conn.id, conn.org_id, r.tokens.accessToken, r.tokens.refreshToken, r.tokens.expiresAt);
  }

  // Build the fleet index from THIS org's register, keyed on VIN — the one
  // identifier Samsara and fleet_vehicles share — plus each vehicle's current
  // odometer for the forward-only guard. Org-pinned: only this org's vehicles can
  // ever be mapped, so a foreign vehicle simply resolves to null.
  const { resolveVehicleId, currentOdometerByAsset } = await buildFleetIndex(loose, conn.org_id);

  let result = await syncTelematicsReadings({
    orgId: conn.org_id,
    provider,
    connectionId: conn.id,
    accessToken,
    externalAccountId: conn.external_account_id ?? "",
    resolveVehicleId,
    since: conn.last_sync_at,
  });

  // Retry-once-after-refresh: an access token that expired mid-window fails the
  // fetch (a 401). If we have a refresh token and have not already refreshed this
  // pass, refresh and retry exactly once.
  if (result.status === "error" && refreshToken && !refreshed) {
    const r = await refreshAccessToken({ provider, refreshToken });
    if (r.ok) {
      refreshed = true;
      await persistRefreshedTokens(loose, conn.id, conn.org_id, r.tokens.accessToken, r.tokens.refreshToken, r.tokens.expiresAt);
      result = await syncTelematicsReadings({
        orgId: conn.org_id,
        provider,
        connectionId: conn.id,
        accessToken: r.tokens.accessToken,
        externalAccountId: conn.external_account_id ?? "",
        resolveVehicleId,
        since: conn.last_sync_at,
      });
    }
  }

  if (result.status === "skipped_dark") {
    return { ...base, outcome: "skipped_dark", written: 0, refreshed, message: result.message };
  }
  if (!result.ok) {
    await recordConnectionError(loose, conn.id, conn.org_id, result.message);
    return { ...base, outcome: "error", written: 0, refreshed, message: result.message };
  }

  let written = 0;
  if (result.readings.length > 0) {
    const { error: insErr, count } = await loose.from("telematics_readings").upsert(result.readings, {
      onConflict: READINGS_CONFLICT,
      ignoreDuplicates: true,
      count: "exact",
    });
    if (insErr) {
      await recordConnectionError(loose, conn.id, conn.org_id, insErr.message);
      return { ...base, outcome: "error", written: 0, refreshed, message: `readings write failed: ${insErr.message}` };
    }
    written = count ?? 0;

    // Forward the newest odometer per vehicle onto the fleet register (forward-only
    // guard inside). Driven off the mapped readings — even a fully-deduped re-run
    // (written === 0) is safe: the guard makes a repeat a no-op.
    await forwardUpdateOdometers(loose, conn.org_id, result.readings, currentOdometerByAsset);
  }

  await markSynced(loose, conn.id, conn.org_id);
  return {
    ...base,
    outcome: written > 0 ? "written" : "empty",
    written,
    refreshed,
    message: `${result.readingCount} mapped, ${written} newly written`,
  };
}

/**
 * Build a VIN → fleet_vehicles.asset_id resolver AND an asset_id → current
 * odometer index for one org, from a single org-pinned read. The odometer index
 * backs the forward-only guard on the odometer forward-update below.
 */
async function buildFleetIndex(loose: LooseDb, orgId: string): Promise<FleetIndex> {
  const { data, error } = await (loose
    .from("fleet_vehicles")
    .select("asset_id, vin, odometer_miles") as SelectChain<VehicleRow[]>).eq("org_id", orgId);
  const byVin = new Map<string, string>();
  const currentOdometerByAsset = new Map<string, number | null>();
  if (!error) {
    for (const v of data ?? []) {
      if (v.vin && v.vin.trim().length > 0) {
        byVin.set(v.vin.trim().toUpperCase(), v.asset_id);
      }
      currentOdometerByAsset.set(
        v.asset_id,
        typeof v.odometer_miles === "number" ? v.odometer_miles : null,
      );
    }
  }
  return {
    // The normaliser passes the VIN (when Samsara reports one) or the opaque
    // vehicle id; match it case-insensitively against the org's VIN index. A key
    // that is not a known VIN in THIS org resolves to null (skipped, not guessed).
    resolveVehicleId: (providerVehicleId: string) =>
      byVin.get(providerVehicleId.trim().toUpperCase()) ?? null,
    currentOdometerByAsset,
  };
}

/** The newest odometer reading per vehicle in a batch (drops odometer-less rows). */
function newestOdometersByVehicle(
  readings: readonly TelematicsReadingInsert[],
): Map<string, { miles: number; recordedAt: string }> {
  const out = new Map<string, { miles: number; recordedAt: string }>();
  for (const r of readings) {
    if (r.odometer_miles == null) continue;
    const prev = out.get(r.vehicle_id);
    // ISO-8601 UTC timestamps sort correctly as strings.
    if (!prev || r.recorded_at > prev.recordedAt) {
      out.set(r.vehicle_id, { miles: r.odometer_miles, recordedAt: r.recorded_at });
    }
  }
  return out;
}

/**
 * Forward-update `fleet_vehicles.odometer_miles`/`odometer_recorded_at` from the
 * newest reading per vehicle — the piece the C28 audit found missing: the sync
 * wrote telematics_readings but never advanced the register's single latest
 * odometer, so a live feed left the mileage the fleet board renders stale.
 *
 * FORWARD-ONLY. An odometer only ever increases; a lower reading (a provider
 * glitch, a swapped unit, an out-of-order sample) must NEVER decrease the stored
 * value. There is no DB-layer forward-only guard on this column (update_vehicle
 * sets it directly), so the guard lives HERE: we skip any reading that is not
 * strictly greater than the current stored odometer. Org-pinned on both the read
 * (the index) and the write (.eq org_id).
 */
async function forwardUpdateOdometers(
  loose: LooseDb,
  orgId: string,
  readings: readonly TelematicsReadingInsert[],
  currentOdometerByAsset: Map<string, number | null>,
): Promise<void> {
  for (const [vehicleId, newest] of newestOdometersByVehicle(readings)) {
    const current = currentOdometerByAsset.get(vehicleId) ?? null;
    // Forward-only: only advance, never decrease (or equal — a no-op write).
    if (current !== null && newest.miles <= current) continue;
    await loose
      .from("fleet_vehicles")
      .update({
        odometer_miles: newest.miles,
        odometer_recorded_at: newest.recordedAt,
      })
      .eq("asset_id", vehicleId)
      .eq("org_id", orgId);
  }
}

async function persistRefreshedTokens(
  loose: LooseDb,
  connectionId: string,
  orgId: string,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: string | null,
): Promise<void> {
  const row: Record<string, unknown> = {
    access_token: encryptToken(accessToken),
    token_expires_at: expiresAt,
  };
  // Only overwrite the stored refresh token when the provider rotated it.
  if (refreshToken !== null) {
    row.refresh_token = encryptToken(refreshToken);
  }
  await loose.from("telematics_connections").update(row).eq("id", connectionId).eq("org_id", orgId);
}

async function markSynced(
  loose: LooseDb,
  connectionId: string,
  orgId: string,
): Promise<void> {
  await loose
    .from("telematics_connections")
    .update({ last_sync_at: new Date().toISOString(), last_error: null })
    .eq("id", connectionId)
    .eq("org_id", orgId);
}

async function recordConnectionError(
  loose: LooseDb,
  connectionId: string,
  orgId: string,
  message: string,
): Promise<void> {
  // Never persist a secret — `message` is a coarse failure signal only.
  await loose
    .from("telematics_connections")
    .update({ last_error: message })
    .eq("id", connectionId)
    .eq("org_id", orgId);
}
