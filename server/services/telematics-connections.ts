import "server-only";

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  getTelematicsAdapter,
  type TelematicsProvider,
} from "@/lib/integrations/telematics/adapters";
import {
  mapSamplesToReadings,
  type TelematicsReadingInsert,
} from "@/lib/integrations/telematics/reading-map";

/**
 * Telematics connections service — org-pinned reads + admin writes over the
 * telematics_connections table, and the (dark) reading-sync composition that ties
 * a connection to the aggregator fetch adapter + the pure reading mapper.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. Every query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected".
 *
 * DARK. This service never writes a token or a `connected` status: that only
 * happens after a real OAuth exchange in the callback route, which is unreachable
 * without aggregator credentials. `syncTelematicsReadings` refuses BEFORE any
 * fetch when the adapter is unavailable and records nothing.
 */

export type TelematicsConnection = {
  provider: TelematicsProvider;
  status: "disconnected" | "connecting" | "connected" | "error";
  externalAccountId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

const PROVIDERS: readonly TelematicsProvider[] = ["samsara", "verizon_connect"];

/**
 * A minimal, token-FREE projection of the connection row. The token columns are
 * deliberately NEVER selected here — no tenant surface reads them back. Only the
 * connection state the UI needs is returned.
 */
const SELECT_COLUMNS =
  "provider, status, external_account_id, connected_at, last_sync_at, last_error";

type ConnectionRow = {
  provider: string;
  status: string;
  external_account_id: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};

function toConnection(row: ConnectionRow): TelematicsConnection {
  return {
    provider: row.provider as TelematicsProvider,
    status: row.status as TelematicsConnection["status"],
    externalAccountId: row.external_account_id,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  };
}

/** A disconnected placeholder for a provider with no row yet. */
function placeholder(provider: TelematicsProvider): TelematicsConnection {
  return {
    provider,
    status: "disconnected",
    externalAccountId: null,
    connectedAt: null,
    lastSyncAt: null,
    lastError: null,
  };
}

/**
 * List the org's telematics connection state — one entry per known provider,
 * placeholder-filled so the UI always renders every row. Org-pinned + token-free +
 * loud.
 */
export async function listTelematicsConnections(
  orgId: string,
): Promise<TelematicsConnection[]> {
  const supabase = await createClient();
  // telematics_connections post-dates the generated types.ts; cast to a minimal
  // select builder. RLS (member-read) is the real authorisation for this read.
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          col: string,
          val: string,
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            range: (
              from: number,
              to: number,
            ) => PromiseLike<{ data: ConnectionRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  // F-1: page the full connection set — a bare `.select()` is clamped to
  // PostgREST max_rows (1000), which for a large org would silently drop
  // providers past the cap. Order on the unique `provider` key (one row per
  // provider per org) for a stable page boundary.
  const { data, error } = await fetchAllRows<ConnectionRow>((from, to) =>
    loose
      .from("telematics_connections")
      .select(SELECT_COLUMNS)
      .eq("org_id", orgId)
      .order("provider", { ascending: true })
      .range(from, to) as PromiseLike<PageResult<ConnectionRow>>,
  );
  if (error) {
    throw readFailure("telematics connections: list", error as Parameters<typeof readFailure>[1]);
  }
  const byProvider = new Map<string, TelematicsConnection>();
  for (const row of data ?? []) {
    byProvider.set(row.provider, toConnection(row));
  }
  return PROVIDERS.map((p) => byProvider.get(p) ?? placeholder(p));
}

/**
 * Admin disconnect — clears the tokens + account handle and returns the row to
 * `disconnected`. Org-pinned; the admin-write RLS is the real authority.
 */
export async function disconnectTelematicsProvider(
  orgId: string,
  provider: TelematicsProvider,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (
            col: string,
            val: string,
          ) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("telematics_connections")
    .update({
      status: "disconnected",
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      external_account_id: null,
      connected_at: null,
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    console.error("[telematics] disconnect failed", { provider, message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export type TelematicsSyncResult = {
  ok: boolean;
  provider: TelematicsProvider;
  status: "mapped" | "skipped_dark" | "error";
  readingCount: number;
  /**
   * RAW vehicles the provider returned this pull, BEFORE resolution + the
   * has-signal filter. 0 on a dark/failed pull. The sync engine compares it with
   * `readingCount` to detect "connected but nothing resolved to a fleet vehicle"
   * and surface a non-terminal diagnostic (activation is wired but the fleet data
   * needs a VIN/registration), instead of a silent, indistinguishable `empty`.
   */
  fetchedVehicleCount: number;
  message: string;
  /** The mapped rows a live ingest would insert. Empty dark. */
  readings: TelematicsReadingInsert[];
  /**
   * TERMINAL fetch failure — the access token was REJECTED (a 401/403 from the
   * aggregator, `unauthorized`). The sync engine refreshes+retries once; if it is
   * still terminal it persists status='error' (reconnect required). Absent/false
   * means the failure (if any) is TRANSIENT (5xx / 429 / network) and the
   * connection stays 'connected' to self-heal on the next tick.
   */
  terminal?: boolean;
};

/**
 * Pull an org's vehicle readings via the aggregator and MAP them onto
 * telematics_readings insert rows. DARK: when the adapter is unavailable (no
 * credentials / flag off / provider unbound) NOTHING is fetched — the adapter
 * REFUSES before any network call — and an honest `skipped_dark` is returned.
 *
 * REFUSE-BEFORE-FETCH is enforced by the adapter: `fetchReadings` returns
 * `unavailable` without touching the network. This service calls it and only
 * reaches the pure mapper when real data came back — impossible dark. The actual
 * INSERT is activation work (there is no fetched data to insert while dark); it
 * runs as service-role because telematics_readings has no authenticated writer.
 */
export async function syncTelematicsReadings(params: {
  orgId: string;
  provider: TelematicsProvider;
  connectionId: string;
  accessToken: string;
  externalAccountId: string;
  resolveVehicleId: (providerVehicleId: string) => string | null;
  since?: string | null;
}): Promise<TelematicsSyncResult> {
  const { orgId, provider, connectionId, accessToken, externalAccountId } = params;
  const adapter = getTelematicsAdapter(provider);

  // Dark path: the adapter has no credentials, so it refuses before any fetch.
  if (!adapter.isAvailable()) {
    return {
      ok: false,
      provider,
      status: "skipped_dark",
      readingCount: 0,
      fetchedVehicleCount: 0,
      message: `${provider} telematics feed is not connected; nothing was fetched.`,
      readings: [],
    };
  }

  // LIVE (unreachable dark): fetch, then map through the PURE mapper.
  const fetched = await adapter.fetchReadings({
    accessToken,
    externalAccountId,
    resolveVehicleId: params.resolveVehicleId,
    since: params.since ?? null,
  });
  if (!fetched.ok) {
    return {
      ok: false,
      provider,
      status: fetched.reason === "unavailable" ? "skipped_dark" : "error",
      readingCount: 0,
      fetchedVehicleCount: 0,
      message: fetched.message,
      readings: [],
      // A rejected token (`unauthorized`) is TERMINAL after the engine's
      // refresh+retry; 5xx / 429 / network stay transient (terminal undefined).
      ...(fetched.reason === "unauthorized" ? { terminal: true } : {}),
    };
  }

  const readings = mapSamplesToReadings(fetched.samples, { orgId, connectionId });
  return {
    ok: true,
    provider,
    status: "mapped",
    readingCount: readings.length,
    fetchedVehicleCount: fetched.fetchedVehicleCount,
    message: `mapped ${readings.length} telematics readings`,
    readings,
  };
}
