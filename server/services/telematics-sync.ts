import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
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
import { safeBatchWrite } from "@/lib/supabase/safe-batch-write";
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

/**
 * Max rows per telematics_readings upsert statement — BATCH-POISONING containment.
 * The whole mapped set was written in ONE statement, so a single uninsertable row
 * aborted the entire org's write (0 rows). The mapper now guarantees no CHECK
 * violation, but a FUTURE CHECK it does not yet mirror must NOT be able to strand
 * an org: chunking bounds the blast radius and the per-row fallback isolates the
 * one bad row. This writer routes through the SHARED safe-batch-write helper
 * (lib/supabase/safe-batch-write) — the one place the whole class is contained.
 */
const READINGS_WRITE_CHUNK = 500;

/**
 * Wall-clock budget (ms) for a SINGLE sync pass — the C39/C70-D fair-ordering +
 * pass-budget class, applied to the telematics cron (the sibling of bank-sync).
 *
 * The cron that drives `runTelematicsSync` has maxDuration=60
 * (app/api/cron/telematics-sync). A pass iterates connected orgs SEQUENTIALLY,
 * and every connection costs several external round-trips (OAuth
 * proactive/reactive refresh + the Samsara /stats cursor loop paginated to
 * MAX_PAGES=40), so a realistic pass clears only a handful before the 60s limit.
 * Left unbounded, Vercel KILLS the loop mid-pass; combined with the old
 * tick-stable `id` ordering, the SAME low-id head was re-serviced every tick
 * while the identical high-id TAIL was never reached — those feeds silently never
 * synced (status stayed 'connected', last_sync_at frozen, no error).
 *
 * This budget is the guard: the loop starts no connection that could push the
 * pass past the budget, stopping CLEANLY with headroom under maxDuration instead
 * of being killed mid-connection. Un-processed connections are simply left for
 * the next pass — NEVER marked errored — and the last_sync_at fair ordering (see
 * the connected read) guarantees they LEAD next time, so the tail can never be
 * permanently starved. Mirrors bank-sync's PASS_BUDGET_MS / PER_ORG_BUDGET_MS.
 */
export const PASS_BUDGET_MS = 45_000;
/**
 * Headroom (ms) reserved for one connection's work when deciding whether to start
 * it — the "never start what you can't finish" discipline bank-sync + webhook-
 * dispatch use, so a started connection is guaranteed to finish within the pass.
 */
export const PER_ORG_BUDGET_MS = 5_000;

export type TelematicsConnectionSyncOutcome = {
  connectionId: string;
  orgId: string;
  outcome:
    | "written"
    | "empty"
    | "empty_unresolved"
    | "skipped_dark"
    | "refresh_failed"
    | "error";
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
export type ConnectionRow = {
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
/** A parent `assets` projection: registration is the human key for a vehicle. */
type AssetRegRow = { id: string; registration: string | null };

/**
 * The org's fleet register, indexed for one service-role read: (VIN → asset_id)
 * AND (registration → asset_id) for vehicle resolution, plus asset_id → current
 * odometer (the forward-only odometer guard). Built once per connection sync.
 */
type FleetIndex = {
  resolveVehicleId: (providerVehicleId: string) => string | null;
  currentOdometerByAsset: Map<string, number | null>;
};

/**
 * Normalise a registration/plate for index + lookup: strip ALL whitespace and
 * upper-case, so "AB12 CDE" (Samsara plate) and "AB12CDE" (assets.registration)
 * collapse to the same key. Returns null for blank/absent. Pure.
 */
function normalizeReg(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalised = value.replace(/\s+/g, "").toUpperCase();
  return normalised.length > 0 ? normalised : null;
}

type DbResult<T> = { data: T | null; error: { message: string } | null };
type WriteResult = { error: { message: string } | null };

/**
 * A PostgREST-style filter chain: awaitable, `.eq(...)`-chainable, AND
 * pageable (`.order().range()`) so a set read can be driven through
 * `fetchAllRows` under the PostgREST max_rows (1000) cap. `T` is the ROW-ARRAY
 * type (e.g. ConnectionRow[]); `.range()` resolves to the same array shape.
 */
type SelectChain<T> = PromiseLike<DbResult<T>> & {
  eq(col: string, val: string): SelectChain<T>;
  order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): SelectChain<T>;
  range(from: number, to: number): PromiseLike<DbResult<T>>;
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
    select(
      c: string,
    ): SelectChain<ConnectionRow[]> & SelectChain<VehicleRow[]> & SelectChain<AssetRegRow[]>;
    upsert(
      rows: Record<string, unknown>[],
      opts: { onConflict: string; ignoreDuplicates: boolean; count?: string },
    ): PromiseLike<{ error: { message: string; code?: string } | null; count: number | null }>;
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
 * Options for a sync pass. `now`/budgets are injectable ONLY so the pass-budget
 * can be exercised deterministically in tests; production always uses the real
 * clock + the exported constants.
 */
export type RunTelematicsSyncOptions = {
  now?: () => number;
  passBudgetMs?: number;
  perOrgBudgetMs?: number;
};

/**
 * Run one telematics sync pass across every connected org for the bound provider.
 * Dark-safe: returns `{ ran:false }` with no DB access when not activated.
 */
export async function runTelematicsSync(
  opts: RunTelematicsSyncOptions = {},
): Promise<TelematicsSyncSummary> {
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

  // F-1: this cron must process EVERY connected org across the platform. A bare
  // `.select()` is clamped to PostgREST max_rows (1000), silently skipping
  // connections beyond that; page the full set.
  //
  // FAIR ORDERING (C71, the C39/C70-D class on the telematics cron): order by
  // last_sync_at ASC with NULLS FIRST, NOT by `id`. A pass has a wall-clock budget
  // (see the loop below) and clears only a handful of connections, so a tick-stable
  // `id` order re-serviced the same low-id head every tick while the high-id tail
  // was never reached and silently never synced. last_sync_at is a success-only
  // cursor (markSynced stamps it to `now` only on success), so never-synced
  // connections (NULL) lead, then the stalest — sinking each just-synced connection
  // to the back of the queue. `id` remains the deterministic tiebreak (unique, so
  // the paginate contract still has a total order), NOT the primary sort.
  const { data: connections, error } = await fetchAllRows<ConnectionRow>(
    (from, to) =>
      (loose
        .from("telematics_connections")
        .select(
          "id, org_id, provider, external_account_id, access_token, refresh_token, token_expires_at, last_sync_at",
        ) as SelectChain<ConnectionRow[]>)
        .eq("provider", provider)
        .eq("status", "connected")
        .order("last_sync_at", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<ConnectionRow>>,
  );

  if (error) {
    const message = (error as { message?: string } | null)?.message ?? String(error);
    return {
      ran: true,
      provider,
      connections: 0,
      written: 0,
      outcomes: [],
      note: `telematics_connections read failed: ${message}`,
    };
  }

  const { processed, written } = await runTelematicsConnectionPass(
    connections,
    (conn) => syncOneConnection(loose, provider, conn),
    opts,
  );

  return {
    ran: true,
    provider,
    // The number of connections actually PROCESSED this pass (not the full set) —
    // an honest count when the budget stops the pass early.
    connections: processed.length,
    written,
    outcomes: processed,
  };
}

/**
 * The budgeted pass loop, extracted so the PASS BUDGET is exercisable
 * deterministically (an injected clock + a fake `syncOne`) without a live DB.
 *
 * PASS BUDGET (C71): stop cleanly with headroom instead of being killed mid-
 * connection by the cron's maxDuration=60. Checked at the TOP of the loop so a
 * connection is only STARTED when it can finish within the budget; un-processed
 * connections are left untouched (NOT errored) for the next pass, and the
 * last_sync_at fair ordering of the connected read guarantees they LEAD it — so no
 * connection is ever permanently starved. `now`/budgets are injectable for
 * deterministic tests only; production uses the real clock + the exported consts.
 */
export async function runTelematicsConnectionPass(
  connections: readonly ConnectionRow[],
  syncOne: (conn: ConnectionRow) => Promise<TelematicsConnectionSyncOutcome>,
  opts: RunTelematicsSyncOptions = {},
): Promise<{ processed: TelematicsConnectionSyncOutcome[]; written: number }> {
  const now = opts.now ?? Date.now;
  const passBudgetMs = opts.passBudgetMs ?? PASS_BUDGET_MS;
  const perOrgBudgetMs = opts.perOrgBudgetMs ?? PER_ORG_BUDGET_MS;
  const startedAt = now();

  const processed: TelematicsConnectionSyncOutcome[] = [];
  let written = 0;
  for (const conn of connections) {
    if (now() - startedAt + perOrgBudgetMs > passBudgetMs) break;
    const outcome = await syncOne(conn);
    processed.push(outcome);
    written += outcome.written;
  }
  return { processed, written };
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
      // TERMINAL (dead grant) ⇒ status='error'; a transient refresh blip keeps the
      // connection 'connected' so a later tick retries it.
      await recordConnectionError(loose, conn.id, conn.org_id, message, r.terminal === true);
      return { ...base, outcome: "refresh_failed", written: 0, refreshed: false, message };
    }
    accessToken = r.tokens.accessToken;
    // A provider MAY rotate the refresh token; keep the prior one when it does not.
    refreshToken = r.tokens.refreshToken ?? refreshToken;
    refreshed = true;
    await persistRefreshedTokens(loose, conn.id, conn.org_id, r.tokens.accessToken, r.tokens.refreshToken, r.tokens.expiresAt);
  }

  // Build the fleet index from THIS org's register, keyed on BOTH VIN and
  // registration (assets.registration — the human key a UK-trades fleet actually
  // populates when the VIN is blank), plus each vehicle's current odometer for the
  // forward-only guard. Org-pinned: only this org's vehicles can ever be mapped, so
  // a foreign vehicle simply resolves to null.
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

  // Reactive refresh: an access token rejected mid-window returns a TERMINAL
  // (`unauthorized`) fetch result. If we have a refresh token and have not already
  // refreshed this pass, refresh and retry exactly once. A plain transient error
  // (5xx / 429 / network — `terminal` unset) does NOT trigger a refresh: a blip is
  // not a dead grant, and a wasted refresh would only burn the one retry.
  if (!result.ok && result.terminal === true && refreshToken && !refreshed) {
    const r = await refreshAccessToken({ provider, refreshToken });
    if (!r.ok) {
      // The refresh itself failed. TERMINAL (dead grant) ⇒ status='error'; a
      // transient refresh blip keeps the connection 'connected' to retry later.
      const message = `token refresh failed: ${r.message}`;
      await recordConnectionError(loose, conn.id, conn.org_id, message, r.terminal === true);
      return { ...base, outcome: "refresh_failed", written: 0, refreshed, message };
    }
    refreshed = true;
    // A provider MAY rotate the refresh token; keep the prior one when it does not.
    refreshToken = r.tokens.refreshToken ?? refreshToken;
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

  if (result.status === "skipped_dark") {
    return { ...base, outcome: "skipped_dark", written: 0, refreshed, message: result.message };
  }
  if (!result.ok) {
    // A still-`unauthorized` result after the refresh+retry (or one with no refresh
    // token to refresh with) is TERMINAL ⇒ status='error' (reconnect required). A
    // plain transient fetch error keeps status='connected' so a later tick
    // self-heals — the terminal/transient split that stops one blip stranding a
    // live feed forever.
    await recordConnectionError(loose, conn.id, conn.org_id, result.message, result.terminal === true);
    return { ...base, outcome: "error", written: 0, refreshed, message: result.message };
  }

  let written = 0;
  if (result.readings.length > 0) {
    const write = await writeReadingsChunked(loose, result.readings);
    written = write.written;

    if (write.transientError !== null) {
      // A NON-constraint write failure (network / 5xx / read glitch) — not a bad
      // row. Keep the connection 'connected' (default terminal=false) so a later
      // tick self-heals; never strand a live feed on a blip.
      await recordConnectionError(loose, conn.id, conn.org_id, write.transientError);
      return {
        ...base,
        outcome: "error",
        written,
        refreshed,
        message: `readings write failed: ${write.transientError}`,
      };
    }

    // Forward the newest odometer per vehicle onto the fleet register (forward-only
    // guard inside). Driven off the rows that actually LANDED — never a row a CHECK
    // dropped — so a glitch odometer that was rejected can't advance the register.
    // Even a fully-deduped re-run (written === 0) is safe: the guard makes a repeat
    // a no-op.
    await forwardUpdateOdometers(loose, conn.org_id, write.landedRows, currentOdometerByAsset);

    if (write.constraintError !== null) {
      // A row survived the mapper yet the DB's CHECK rejected it (23514). The
      // mapper is contracted to mirror EVERY CHECK, so this means schema drift — a
      // CHECK the mapper does not yet enforce. TERMINAL: the offending sample would
      // re-deliver every tick (Samsara /stats is a snapshot), so flip status='error'
      // to surface reconnect/repair instead of silently retrying the same poison
      // forever. The good rows above were still written; do NOT markSynced (it would
      // re-assert 'connected' and clear this terminal error).
      await recordConnectionError(
        loose,
        conn.id,
        conn.org_id,
        `readings CHECK violation (rows dropped): ${write.constraintError}`,
        true,
      );
      return {
        ...base,
        outcome: "error",
        written,
        refreshed,
        message: `readings CHECK violation (rows dropped): ${write.constraintError}`,
      };
    }
  }

  // ── ZERO-RESOLVED DIAGNOSTIC (no more silent-dead activation) ────────────────
  // A CONNECTED feed that fetched N raw vehicles yet mapped ZERO readings almost
  // always means the fleet register carries no VIN/registration the provider's
  // vehicles match (the exact silent failure this fix targets): the pull succeeds,
  // markSynced stamps a fresh last_sync_at + status='connected', and the view stays
  // empty forever with NO signal. Surface a NON-TERMINAL warn (last_error note,
  // status stays 'connected') so an operator sees activation is wired but the fleet
  // data needs a VIN/reg. NOT terminal — it is a mapping gap that self-heals the
  // moment the fleet data is corrected, so the cron must keep selecting it.
  const unresolved = result.fetchedVehicleCount > 0 && result.readingCount === 0;
  const note = unresolved
    ? "telematics connected but no fetched vehicles matched a fleet VIN/registration"
    : null;
  await markSynced(loose, conn.id, conn.org_id, note);
  return {
    ...base,
    outcome: written > 0 ? "written" : unresolved ? "empty_unresolved" : "empty",
    written,
    refreshed,
    message: unresolved
      ? `${result.fetchedVehicleCount} vehicles fetched, none matched a fleet VIN/registration`
      : `${result.readingCount} mapped, ${written} newly written`,
  };
}

/** The outcome of writing a mapped batch, splitting transient from constraint errors. */
type ReadingsWriteResult = {
  /** Newly-inserted rows (duplicates ignored), summed across chunks/rows. */
  written: number;
  /** Rows that landed OR were idempotent duplicates — i.e. NOT rejected by a CHECK. */
  landedRows: TelematicsReadingInsert[];
  /** A non-constraint (network/5xx/read) write error — caller keeps the connection connected. */
  transientError: string | null;
  /** A CHECK (23514) violation was seen and contained via per-row fallback — TERMINAL. */
  constraintError: string | null;
};

/**
 * Write a mapped batch to telematics_readings with BATCH-POISONING containment.
 *
 * The mapper already guarantees no row violates any current CHECK, so the happy
 * path is plain chunked upserts with the idempotent ON CONFLICT DO NOTHING
 * contract (onConflict + ignoreDuplicates + count:"exact") — chunking preserves
 * those semantics exactly (per-chunk dedupe, counts summed = one big statement's
 * count), so C50 idempotency is untouched.
 *
 * DEFENSE IN DEPTH: if a FUTURE CHECK the mapper does not yet mirror is added, a
 * chunk upsert can 23514. Rather than let ONE bad row abort the org's whole batch
 * (the exact defect this closes), fall back to per-row upserts for that chunk:
 * good rows land, the offending row(s) are dropped, and a constraintError is
 * surfaced so the caller can mark the connection TERMINAL (stop the silent retry
 * loop). Any OTHER error (transient/network/5xx) is not a bad-row problem — bail
 * immediately so the caller keeps the connection connected and self-heals.
 */
async function writeReadingsChunked(
  loose: LooseDb,
  readings: readonly TelematicsReadingInsert[],
): Promise<ReadingsWriteResult> {
  // The idempotency contract (onConflict + ignoreDuplicates + count:"exact") lives
  // in this closure, so the shared writer's chunking preserves C50 semantics
  // exactly: per-chunk dedupe, and the summed count equals one big statement's.
  const res = await safeBatchWrite(
    readings,
    (chunk) =>
      loose.from("telematics_readings").upsert(chunk as unknown as Record<string, unknown>[], {
        onConflict: READINGS_CONFLICT,
        ignoreDuplicates: true,
        count: "exact",
      }),
    { chunkSize: READINGS_WRITE_CHUNK },
  );
  return {
    written: res.written,
    landedRows: [...res.landedRows],
    transientError: res.transientError,
    constraintError: res.constraintError,
  };
}

/**
 * Build a vehicle resolver — (VIN → asset_id) AND (registration → asset_id) — plus
 * an asset_id → current odometer index for one org, from org-pinned reads. The
 * odometer index backs the forward-only guard on the odometer forward-update below.
 *
 * WHY REGISTRATION TOO. `fleet_vehicles.vin` is OPTIONAL and typically BLANK for a
 * UK-trades tenant, whereas `assets.registration` (the parent asset's human key) is
 * populated. A VIN-only resolver therefore resolved EVERY sample to null for such a
 * fleet, silently ingesting zero readings while the feed reported healthy. The
 * registration index closes that. Registration lives on the parent `assets` row
 * (fleet_vehicles is a 1:1 extension keyed on asset_id), so byReg is built from an
 * `assets` read SCOPED to this org's fleet asset_ids — a reading can only ever bind
 * a real fleet vehicle (the telematics_readings vehicle FK targets fleet_vehicles),
 * so a registration that belongs to a non-vehicle asset is deliberately excluded.
 */
async function buildFleetIndex(loose: LooseDb, orgId: string): Promise<FleetIndex> {
  // F-1: this backs BOTH VIN→asset resolution and the odometer guard for the
  // whole org register — a bare `.select()` clamped at 1000 would silently drop
  // vehicles 1001+, so their VINs would resolve to null (readings skipped) and
  // their odometers would never advance. Page the full register on the unique
  // `asset_id` order.
  const { data, error } = await fetchAllRows<VehicleRow>(
    (from, to) =>
      (loose
        .from("fleet_vehicles")
        .select("asset_id, vin, odometer_miles") as SelectChain<VehicleRow[]>)
        .eq("org_id", orgId)
        .order("asset_id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<VehicleRow>>,
  );
  const byVin = new Map<string, string>();
  const byReg = new Map<string, string>();
  const currentOdometerByAsset = new Map<string, number | null>();
  const fleetAssetIds = new Set<string>();
  if (!error) {
    for (const v of data ?? []) {
      fleetAssetIds.add(v.asset_id);
      if (v.vin && v.vin.trim().length > 0) {
        byVin.set(v.vin.trim().toUpperCase(), v.asset_id);
      }
      currentOdometerByAsset.set(
        v.asset_id,
        typeof v.odometer_miles === "number" ? v.odometer_miles : null,
      );
    }
  }

  // Registration index: read the org's `assets` (registration is the parent's
  // column) and key by normalised registration, but ONLY for asset_ids that are
  // fleet vehicles — so a reading can never resolve to a non-vehicle asset (which
  // would fail the telematics_readings vehicle_id FK). Org-pinned + paged (F-1).
  if (fleetAssetIds.size > 0) {
    const { data: assetRows, error: assetError } = await fetchAllRows<AssetRegRow>(
      (from, to) =>
        (loose
          .from("assets")
          .select("id, registration") as SelectChain<AssetRegRow[]>)
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to) as PromiseLike<PageResult<AssetRegRow>>,
    );
    if (!assetError) {
      for (const a of assetRows ?? []) {
        if (!fleetAssetIds.has(a.id)) continue;
        const reg = normalizeReg(a.registration);
        if (reg) byReg.set(reg, a.id);
      }
    }
  }

  return {
    // The normaliser passes each resolution key (VIN, licence plate, name, opaque
    // id) in turn. Match VIN first (case-insensitive), then normalised
    // registration. A key that matches neither index in THIS org resolves to null
    // (skipped, not guessed) — and only this org's vehicles are ever in the maps.
    resolveVehicleId: (providerVehicleId: string) => {
      const trimmed = providerVehicleId.trim();
      if (trimmed.length === 0) return null;
      const vinHit = byVin.get(trimmed.toUpperCase());
      if (vinHit) return vinHit;
      const reg = normalizeReg(trimmed);
      return (reg && byReg.get(reg)) || null;
    },
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
  note: string | null = null,
): Promise<void> {
  // SELF-HEAL: a successful pass RE-ASSERTS status='connected' and clears
  // last_error (note=null), so a connection recovering from a prior TRANSIENT
  // failure (which kept it 'connected' + stamped last_error) returns to a clean
  // healthy state. A row that reached a TERMINAL 'error' is never selected by the
  // cron, so it cannot be silently healed here — only re-consent (the callback
  // upsert) clears a terminal error. This mirrors bank-sync / calendar self-heal.
  //
  // NON-TERMINAL NOTE: `note` carries the zero-resolved diagnostic — status stays
  // 'connected' (the cron keeps selecting it so it self-heals once fleet VIN/reg
  // data is corrected) while last_error makes the mapping gap visible instead of a
  // silently-empty feed. A healthy pass passes null and clears it.
  await loose
    .from("telematics_connections")
    .update({ status: "connected", last_sync_at: new Date().toISOString(), last_error: note })
    .eq("id", connectionId)
    .eq("org_id", orgId);
}

async function recordConnectionError(
  loose: LooseDb,
  connectionId: string,
  orgId: string,
  message: string,
  terminal = false,
): Promise<void> {
  // Never persist a secret — `message` is a coarse failure signal only.
  //
  // TERMINAL (a revoked/expired grant — a token 400/401/403 / invalid_grant) ⇒
  // flip status='error' so the cron STOPS selecting this connection
  // (runTelematicsSync filters status='connected') and the panel's "reconnect
  // required" state goes live; re-consent (the callback upsert) is the only thing
  // that clears it. TRANSIENT (5xx / 429 / network / decrypt) keeps
  // status='connected' + last_error so a later tick self-heals — never strand a
  // live feed on one blip. This is the fix for the class the C47/C48 invariant
  // defines: before this, a revoked telematics token was written as last_error
  // ONLY, status was never set, so it retried forever and the reconnect UI was
  // dead code.
  const patch: Record<string, unknown> = { last_error: message };
  if (terminal) patch.status = "error";
  await loose
    .from("telematics_connections")
    .update(patch)
    .eq("id", connectionId)
    .eq("org_id", orgId);
}
