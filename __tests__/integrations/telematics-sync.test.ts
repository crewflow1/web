import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Telematics reading SYNC — runtime proofs (20261103).
 *
 * The C26 audit found `syncTelematicsReadings` had NO caller: no cron / route /
 * button. This suite proves the wired sync trigger end-to-end with Samsara HTTP
 * MOCKED and the admin (service-role) client mocked:
 *
 *   1. fetch → readings WRITE: a connected org's Samsara snapshot is mapped and
 *      written service-role, every row carrying the CONNECTION's org_id, with the
 *      idempotent ON CONFLICT DO NOTHING contract (onConflict + ignoreDuplicates).
 *   2. IDEMPOTENT re-run: a re-delivered snapshot the DB dedupes (count 0) is an
 *      honest `empty` outcome, never a hard failure.
 *   3. TOKEN REFRESH on expiry: an expired access token is refreshed
 *      (grant_type=refresh_token), re-encrypted + persisted, and the subsequent
 *      fetch carries the NEW bearer.
 *   4. STATIC API TOKEN (no expiry) is NEVER refreshed — the token endpoint is not
 *      contacted.
 *   5. DARK REFUSE: unconfigured → { ran:false } with NO admin client and NO fetch.
 *   6. CRON no-op while dark: the route returns 204 without constructing a client.
 *   7. refreshAccessToken + resolveAccountHandle REFUSE (no network) while dark.
 */

// The cron auth reads env.CRON_SECRET, which lib/env.ts parses once at import —
// set it BEFORE any module import so the parsed env sees it.
vi.hoisted(() => {
  process.env.CRON_SECRET = "test-cron-secret";
});

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    if (!admin.client) throw new Error("mock admin client not set");
    return admin.client;
  }),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { runTelematicsSync } from "@/server/services/telematics-sync";
import {
  refreshAccessToken,
  resolveActiveTelematicsProvider,
} from "@/lib/integrations/telematics/oauth";
import { getTelematicsAdapter } from "@/lib/integrations/telematics/adapters";
import { encryptToken } from "@/lib/integrations/token-crypto";

const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VEH_A = "11111111-1111-1111-1111-111111111111";
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

type Conn = {
  id: string;
  org_id: string;
  provider: string;
  external_account_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  last_sync_at: string | null;
};

type Vehicle = { asset_id: string; vin: string | null; odometer_miles?: number | null };

/** An `assets` row projection: registration lives on the parent asset. */
type Asset = { id: string; registration: string | null };

type Upsert = { rows: Record<string, unknown>[]; opts: Record<string, unknown> };

/** A minimal chainable mock of the service-role builder this service uses. */
function makeDb(opts: {
  connections: Conn[];
  vehicles: Vehicle[];
  /** Parent `assets` rows (registration source), keyed by fleet asset_id. */
  assets?: Asset[];
  readingCounts?: number[];
  /**
   * Optional bespoke handler for a telematics_readings upsert (per statement). Used
   * to model a 23514 CHECK-violation chunk + the per-row fallback. Receives the rows
   * of THIS upsert statement; returns the {error, count} that statement resolves to.
   */
  readingsUpsert?: (rows: Record<string, unknown>[]) => {
    error: { message: string; code?: string } | null;
    count: number | null;
  };
}) {
  const upserts: Upsert[] = [];
  const updates: Record<string, unknown>[] = [];
  const counts = [...(opts.readingCounts ?? [])];

  const selectChain = (data: unknown) => {
    const rows = Array.isArray(data) ? data : [];
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    // The connection + fleet reads now page via `.order().range()` (F-1); model
    // the range window by slicing the (small) result set.
    chain.order = () => chain;
    chain.range = (from: number, to: number) =>
      Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      res({ data, error: null });
    return chain;
  };
  const updateChain = (row: Record<string, unknown>) => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown) => {
      updates.push(row);
      return res({ error: null });
    };
    return chain;
  };

  const client = {
    from: (table: string) => {
      if (table === "telematics_connections") {
        return {
          select: () => selectChain(opts.connections),
          update: (row: Record<string, unknown>) => updateChain(row),
        };
      }
      if (table === "fleet_vehicles") {
        return {
          select: () => selectChain(opts.vehicles),
          update: (row: Record<string, unknown>) => updateChain(row),
        };
      }
      if (table === "assets") {
        return {
          select: () => selectChain(opts.assets ?? []),
        };
      }
      if (table === "telematics_readings") {
        return {
          upsert: (rows: Record<string, unknown>[], o: Record<string, unknown>) => {
            upserts.push({ rows, opts: o });
            if (opts.readingsUpsert) {
              return Promise.resolve(opts.readingsUpsert(rows));
            }
            const count = counts.length > 0 ? counts.shift()! : rows.length;
            return Promise.resolve({ error: null, count });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, upserts, updates };
}

function connectableEnv(): void {
  vi.stubEnv("NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT", "true");
  vi.stubEnv("TELEMATICS_PROVIDER", "samsara");
  vi.stubEnv("TELEMATICS_CLIENT_ID", "client-id");
  vi.stubEnv("TELEMATICS_CLIENT_SECRET", "client-secret");
  vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", KEY_B64);
}

// The REAL Samsara /fleet/vehicles/stats per-vehicle shape: `gps` is the fix
// only, and `obdOdometerMeters` is its OWN top-level { time, value } stat in
// METRES. (The old fixture nested odometerMeters inside gps — a shape the API
// never returns — which is exactly why the odometer feed was dead.)
const STAT = {
  id: "sam-1",
  externalIds: { vin: "vin123" },
  gps: {
    latitude: 51.5074,
    longitude: -0.1278,
    time: "2026-07-15T09:30:00Z",
  },
  obdOdometerMeters: {
    time: "2026-07-15T09:30:00Z",
    value: 1609344, // exactly 1000 miles
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  admin.client = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runTelematicsSync — fetch → readings write", () => {
  it("writes mapped readings service-role, org-pinned, idempotent contract", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null, // static token → no refresh
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [STAT] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runTelematicsSync();

    expect(summary.ran).toBe(true);
    expect(summary.provider).toBe("samsara");
    expect(summary.connections).toBe(1);
    expect(summary.written).toBe(1);

    // exactly one readings write
    expect(db.upserts).toHaveLength(1);
    const { rows, opts } = db.upserts[0]!;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // ORG-PINNED: the row carries the CONNECTION's org, not anything provider-sent.
    expect(row.org_id).toBe(ORG_A);
    expect(row.connection_id).toBe(CONN_A);
    // VIN-resolved to the org's fleet vehicle.
    expect(row.vehicle_id).toBe(VEH_A);
    expect(row.source_event_id).toBe("sam-1:2026-07-15T09:30:00Z");
    expect(row.odometer_miles).toBe(1000);
    // IDEMPOTENCY CONTRACT: ON CONFLICT DO NOTHING on the DB identity.
    expect(opts.onConflict).toBe("org_id,connection_id,source_event_id");
    expect(opts.ignoreDuplicates).toBe(true);

    // last_sync_at advanced, last_error cleared.
    const synced = db.updates.find((u) => "last_sync_at" in u);
    expect(synced).toBeTruthy();
    expect(synced!.last_error).toBeNull();
  });

  it("a re-delivered snapshot the DB dedupes (count 0) is an honest empty outcome", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: "2026-07-15T09:00:00Z",
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
      readingCounts: [0], // the DB returns 0 rows inserted (all duplicates)
    });
    admin.client = db.client;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [STAT] }), { status: 200 })),
    );

    const summary = await runTelematicsSync();
    expect(summary.written).toBe(0);
    expect(summary.outcomes[0]!.outcome).toBe("empty");
    // The write was still ATTEMPTED with the idempotent contract.
    expect(db.upserts[0]!.opts.ignoreDuplicates).toBe(true);
  });
});

describe("runTelematicsSync — registration fallback + zero-resolved diagnostic (C69)", () => {
  const statusWrites = (updates: Record<string, unknown>[], v: string) =>
    updates.filter((u) => u.status === v);

  it("(a) a REGISTRATION-only vehicle (vin null) resolves via the plate and readings LAND", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      // The fleet vehicle carries NO vin — the typical UK-trades tenant.
      vehicles: [{ asset_id: VEH_A, vin: null }],
      // Registration lives on the parent asset, stored space-stripped/upper.
      assets: [{ id: VEH_A, registration: "AB12CDE" }],
    });
    admin.client = db.client;

    // Samsara reports the plate (with a space) and no VIN.
    const REG_STAT = {
      id: "sam-reg-1",
      externalIds: null,
      licensePlate: "AB12 CDE",
      gps: { latitude: 51.5074, longitude: -0.1278, time: "2026-07-15T09:30:00Z" },
      obdOdometerMeters: { time: "2026-07-15T09:30:00Z", value: 1609344 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [REG_STAT] }), { status: 200 })),
    );

    const summary = await runTelematicsSync();

    // Pre-fix: VIN-only resolution → 0 resolved → 0 written. Post-fix: the plate
    // resolves via the byReg index and the reading lands.
    expect(summary.written).toBe(1);
    expect(db.upserts).toHaveLength(1);
    const row = db.upserts[0]!.rows[0]!;
    expect(row.vehicle_id).toBe(VEH_A);
    expect(row.org_id).toBe(ORG_A);
    expect(row.source_event_id).toBe("sam-reg-1:2026-07-15T09:30:00Z");
    expect(summary.outcomes[0]!.outcome).toBe("written");
    // Clean self-heal: connected + last_error cleared.
    const synced = db.updates.find((u) => "last_sync_at" in u);
    expect(synced!.status).toBe("connected");
    expect(synced!.last_error).toBeNull();
  });

  it("(c) connected + N fetched + 0 resolved writes a NON-TERMINAL warn (not silent 'empty', not terminal)", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      // The org has a vehicle, but it shares NO identifier with the fetched sample.
      vehicles: [{ asset_id: VEH_A, vin: "VIN-DIFFERENT" }],
      assets: [{ id: VEH_A, registration: "ZZ99ZZZ" }],
    });
    admin.client = db.client;

    // Samsara returns a vehicle whose VIN/plate match nothing in the fleet.
    const UNMATCHED = {
      id: "sam-unknown",
      externalIds: { "samsara.vin": "NOTINFLEET1234567" },
      licensePlate: "XX00 XXX",
      gps: { latitude: 51.5, longitude: -0.1, time: "2026-07-15T09:30:00Z" },
      obdOdometerMeters: { time: "2026-07-15T09:30:00Z", value: 1609344 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [UNMATCHED] }), { status: 200 })),
    );

    const summary = await runTelematicsSync();

    // Nothing written, but this is DISTINCT from an honest empty fleet.
    expect(summary.written).toBe(0);
    expect(summary.outcomes[0]!.outcome).toBe("empty_unresolved");
    // NON-TERMINAL: status stays connected, and last_error carries the diagnostic
    // so an operator sees activation is wired but the fleet data needs a VIN/reg.
    const stamp = db.updates.find((u) => "last_sync_at" in u);
    expect(stamp!.status).toBe("connected");
    expect(String(stamp!.last_error)).toContain(
      "no fetched vehicles matched a fleet VIN/registration",
    );
    // NOT terminal — the connection is never flipped to 'error'.
    expect(statusWrites(db.updates, "error")).toHaveLength(0);
  });

  it("an honestly EMPTY fleet feed (0 fetched) stays a plain 'empty' with last_error cleared", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;
    // Provider returns zero vehicles — a genuinely empty snapshot, not a mismatch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );

    const summary = await runTelematicsSync();
    expect(summary.outcomes[0]!.outcome).toBe("empty");
    const stamp = db.updates.find((u) => "last_sync_at" in u);
    expect(stamp!.status).toBe("connected");
    expect(stamp!.last_error).toBeNull();
  });
});

describe("runTelematicsSync — odometer forward-update (forward-only)", () => {
  it("advances fleet_vehicles.odometer from the newest reading when it is higher", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      // STAT reports 1000 miles; the register is behind at 500.
      vehicles: [{ asset_id: VEH_A, vin: "VIN123", odometer_miles: 500 }],
    });
    admin.client = db.client;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [STAT] }), { status: 200 })),
    );

    await runTelematicsSync();

    const odoUpdate = db.updates.find((u) => "odometer_miles" in u);
    expect(odoUpdate).toBeTruthy();
    expect(odoUpdate!.odometer_miles).toBe(1000);
    // Stamped with the reading's own instant, not "now".
    expect(odoUpdate!.odometer_recorded_at).toBe("2026-07-15T09:30:00Z");
  });

  it("does NOT decrease a stored odometer when the reading is lower (forward-only)", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      // Register already at 5000; the incoming 1000-mile reading is stale/lower.
      vehicles: [{ asset_id: VEH_A, vin: "VIN123", odometer_miles: 5000 }],
    });
    admin.client = db.client;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [STAT] }), { status: 200 })),
    );

    await runTelematicsSync();

    // The reading still lands (append-only history is faithful)...
    expect(db.upserts).toHaveLength(1);
    // ...but the register odometer is NOT walked backwards.
    const odoUpdate = db.updates.find((u) => "odometer_miles" in u);
    expect(odoUpdate).toBeUndefined();
  });
});

describe("runTelematicsSync — token model", () => {
  it("refreshes an EXPIRED access token, persists it, and re-fetches with the new bearer", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("stale-access"),
          refresh_token: encryptToken("refresh-tok-1"),
          token_expires_at: new Date(Date.now() - 60_000).toISOString(), // expired
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes("/oauth2/token")) {
        // Assert it is a refresh_token grant.
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh-tok-2",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      // The stats call must carry the NEW bearer.
      const auth = (init?.headers as Record<string, string>)?.authorization;
      expect(auth).toBe("Bearer fresh-access");
      return new Response(JSON.stringify({ data: [STAT] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runTelematicsSync();

    expect(summary.written).toBe(1);
    expect(summary.outcomes[0]!.refreshed).toBe(true);
    // token endpoint WAS contacted.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/oauth2/token"))).toBe(true);
    // the refreshed access token was persisted (encrypted — not the plaintext).
    const tokenUpdate = db.updates.find((u) => "access_token" in u);
    expect(tokenUpdate).toBeTruthy();
    expect(String(tokenUpdate!.access_token)).not.toContain("fresh-access");
    expect(String(tokenUpdate!.access_token)).toMatch(/^v1:/);
  });

  it("a STATIC API token (no expiry) is never refreshed — token endpoint untouched", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("static-api-token"),
          refresh_token: null,
          token_expires_at: null, // static token
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;
    const fetchMock = vi.fn(async (_url: string | URL) =>
      new Response(JSON.stringify({ data: [STAT] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runTelematicsSync();
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/oauth2/token"))).toBe(false);
    expect(calls.some((u) => u.includes("/fleet/vehicles/stats"))).toBe(true);
  });
});

describe("runTelematicsSync — terminal vs transient auth failure (GAP 3)", () => {
  // The C26/C28 audit shipped the sync with recordConnectionError writing ONLY
  // last_error and markSynced never touching status — so a REVOKED token retried
  // forever and the panel's "reconnect required" (status='error') UI was dead code.
  // These prove the C47/C48 invariant now holds for telematics.
  const statusWrites = (updates: Record<string, unknown>[], v: string) =>
    updates.filter((u) => u.status === v);

  it("TERMINAL: a rejected token with no refresh token persists status='error'", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("revoked-token"),
          refresh_token: null,
          token_expires_at: null, // static token — no proactive refresh
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;
    // The stats call returns 401 → the adapter reports `unauthorized` (terminal);
    // no refresh token exists, so no retry can recover it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );

    const summary = await runTelematicsSync();
    expect(summary.outcomes[0]!.outcome).toBe("error");
    // THE FIX: the row is flipped to status='error' (reconnect required).
    const errs = statusWrites(db.updates, "error");
    expect(errs.length).toBe(1);
    expect(typeof errs[0]!.last_error).toBe("string");
    // No spurious self-heal write.
    expect(statusWrites(db.updates, "connected").length).toBe(0);
  });

  it("TERMINAL: a proactive refresh that returns invalid_grant (400) persists status='error'", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("stale-access"),
          refresh_token: encryptToken("dead-refresh"),
          token_expires_at: new Date(Date.now() - 60_000).toISOString(), // expired → proactive refresh
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().includes("/oauth2/token")) {
        // A dead grant — 400 invalid_grant is TERMINAL.
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: [STAT] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runTelematicsSync();
    expect(summary.outcomes[0]!.outcome).toBe("refresh_failed");
    expect(statusWrites(db.updates, "error").length).toBe(1);
    // The stats endpoint was never reached — the refresh gate failed first.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/fleet/vehicles/stats"))).toBe(false);
  });

  it("TRANSIENT: a 5xx fetch blip keeps status='connected' and does NOT trigger a refresh", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("good-token"),
          refresh_token: encryptToken("refresh-tok"),
          token_expires_at: null, // static → no proactive refresh
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;
    const fetchMock = vi.fn(async (_url: string | URL) =>
      new Response(JSON.stringify({ error: "boom" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runTelematicsSync();
    expect(summary.outcomes[0]!.outcome).toBe("error");
    // NOT stranded: no status='error' write; last_error is stamped so it is visible.
    expect(statusWrites(db.updates, "error").length).toBe(0);
    const errStamp = db.updates.find((u) => "last_error" in u && u.status === undefined);
    expect(errStamp).toBeTruthy();
    // A 5xx is not a dead grant, so NO refresh was attempted (the retry is reserved
    // for a terminal `unauthorized`).
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/oauth2/token"))).toBe(false);
  });

  it("SUCCESS self-heals: a healthy pass re-asserts status='connected' and clears last_error", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("good-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [STAT] }), { status: 200 })),
    );

    await runTelematicsSync();
    // The success stamp restores status='connected' AND clears last_error — a
    // connection recovering from a prior transient failure heals itself.
    const heal = db.updates.find((u) => "last_sync_at" in u);
    expect(heal).toBeTruthy();
    expect(heal!.status).toBe("connected");
    expect(heal!.last_error).toBeNull();
  });

  it("TERMINAL after a successful refresh but a still-401 retry persists status='error'", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("expiring-access"),
          refresh_token: encryptToken("refresh-tok"),
          token_expires_at: null, // static-looking; the 401 drives the reactive refresh
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
    });
    admin.client = db.client;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }),
          { status: 200 },
        );
      }
      // Both the first fetch and the retry-after-refresh return 401 (unauthorized).
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runTelematicsSync();
    expect(summary.outcomes[0]!.outcome).toBe("error");
    expect(statusWrites(db.updates, "error").length).toBe(1);
    // The reactive refresh WAS attempted exactly once (token endpoint hit).
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes("/oauth2/token")).length).toBe(1);
  });
});

describe("runTelematicsSync — batch-poisoning containment (defense in depth)", () => {
  // The ingest wrote the whole mapped set in ONE statement, so a single
  // uninsertable row aborted the org's ENTIRE batch (0 rows), tick after tick. The
  // mapper now guarantees no CHECK violation; these prove the write-path also
  // survives a FUTURE CHECK the mapper does not yet mirror — one bad row is
  // isolated (per-row fallback) and the connection surfaces reconnect/repair
  // (TERMINAL) rather than silently re-delivering the poison forever.
  const VEH_B = "22222222-2222-2222-2222-222222222222";
  const statusWrites = (updates: Record<string, unknown>[], v: string) =>
    updates.filter((u) => u.status === v);

  const STAT_A = {
    id: "sam-1",
    externalIds: { vin: "vin123" },
    gps: { latitude: 51.5074, longitude: -0.1278, time: "2026-07-15T09:30:00Z" },
    obdOdometerMeters: { time: "2026-07-15T09:30:00Z", value: 1609344 },
  };
  const STAT_B = {
    id: "sam-2",
    externalIds: { vin: "vin456" },
    gps: { latitude: 52.0, longitude: 0.2, time: "2026-07-15T09:31:00Z" },
    obdOdometerMeters: { time: "2026-07-15T09:31:00Z", value: 3218688 },
  };
  const POISON_EVENT = "sam-2:2026-07-15T09:31:00Z";

  it("a 23514 chunk falls back per-row: good rows land, the bad row is dropped, connection goes TERMINAL", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      vehicles: [
        { asset_id: VEH_A, vin: "VIN123" },
        { asset_id: VEH_B, vin: "VIN456" },
      ],
      // Model a FUTURE CHECK the mapper does not mirror: the multi-row chunk 23514s;
      // the per-row fallback lands the good row (count 1) and 23514s the poison row.
      readingsUpsert: (rows) => {
        if (rows.length > 1) {
          return { error: { message: "new_check_violation", code: "23514" }, count: null };
        }
        const isPoison = rows[0]?.source_event_id === POISON_EVENT;
        return isPoison
          ? { error: { message: "new_check_violation", code: "23514" }, count: null }
          : { error: null, count: 1 };
      },
    });
    admin.client = db.client;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [STAT_A, STAT_B] }), { status: 200 })),
    );

    const summary = await runTelematicsSync();

    // The good row still landed — the org's feed is NOT stranded at zero.
    expect(summary.written).toBe(1);
    expect(summary.outcomes[0]!.outcome).toBe("error");
    // The write path: 1 chunk upsert (2 rows) + 2 per-row fallback upserts.
    expect(db.upserts).toHaveLength(3);
    expect(db.upserts[0]!.rows).toHaveLength(2);
    expect(db.upserts[1]!.rows).toHaveLength(1);
    expect(db.upserts[2]!.rows).toHaveLength(1);
    // TERMINAL: a persistent CHECK violation flips status='error' (reconnect/repair)…
    expect(statusWrites(db.updates, "error").length).toBe(1);
    // …and the connection is NOT self-healed back to 'connected' this pass.
    expect(statusWrites(db.updates, "connected").length).toBe(0);
    expect(db.updates.find((u) => "last_sync_at" in u)).toBeUndefined();
  });

  it("a TRANSIENT (non-23514) write error keeps status='connected' to self-heal", async () => {
    connectableEnv();
    const db = makeDb({
      connections: [
        {
          id: CONN_A,
          org_id: ORG_A,
          provider: "samsara",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      vehicles: [{ asset_id: VEH_A, vin: "VIN123" }],
      // A DB connection blip (not a bad row) — must NOT strand the feed terminally.
      readingsUpsert: () => ({ error: { message: "server closed the connection", code: "08006" }, count: null }),
    });
    admin.client = db.client;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [STAT_A] }), { status: 200 })),
    );

    const summary = await runTelematicsSync();
    expect(summary.outcomes[0]!.outcome).toBe("error");
    // No terminal flip — the connection stays selectable so a later tick retries.
    expect(statusWrites(db.updates, "error").length).toBe(0);
    // last_error is stamped (status untouched) so the blip is visible.
    const errStamp = db.updates.find((u) => "last_error" in u && u.status === undefined);
    expect(errStamp).toBeTruthy();
    // No per-row fallback for a transient error — one chunk attempt, then bail.
    expect(db.upserts).toHaveLength(1);
  });
});

describe("runTelematicsSync — DARK refuse", () => {
  it("returns { ran:false } with NO admin client and NO network when unconfigured", async () => {
    // No connectable env stubbed.
    vi.stubEnv("NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT", "false");
    vi.stubEnv("TELEMATICS_PROVIDER", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runTelematicsSync();
    expect(summary.ran).toBe(false);
    expect(summary.provider).toBeNull();
    expect((createAdminClient as unknown as Mock).mock.calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // sanity: the provider really is unbound in this env.
    expect(resolveActiveTelematicsProvider()).toBeNull();
  });
});

describe("cron seam — dark 204 no-op", () => {
  it("returns 204 with no client/network while dark, on an authorised call", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT", "false");
    vi.stubEnv("TELEMATICS_PROVIDER", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/cron/telematics-sync/route");
    const res = await GET(
      new Request("https://app.example/api/cron/telematics-sync", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(res.status).toBe(204);
    expect((createAdminClient as unknown as Mock).mock.calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthorised call with 401", async () => {
    const { GET } = await import("@/app/api/cron/telematics-sync/route");
    const res = await GET(
      new Request("https://app.example/api/cron/telematics-sync"),
    );
    expect(res.status).toBe(401);
  });
});

describe("oauth + adapter refuse before any network while dark", () => {
  it("refreshAccessToken REFUSES with no fetch when dark", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT", "false");
    vi.stubEnv("TELEMATICS_PROVIDER", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await refreshAccessToken({ provider: "samsara", refreshToken: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolveAccountHandle REFUSES with no fetch when dark", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT", "false");
    vi.stubEnv("TELEMATICS_PROVIDER", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await getTelematicsAdapter("samsara").resolveAccountHandle("token");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
