import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TELEMATICS SYNC — fleet-index volume proof (F-1, C35-B).
 *
 * `buildFleetIndex` backs BOTH VIN→asset resolution and the forward-only
 * odometer guard for an org's WHOLE vehicle register. A bare `.select()` is
 * clamped at PostgREST max_rows (1000), so on a fleet larger than that the
 * vehicles past the cap were absent from the index — their VINs resolved to
 * null (their live readings silently skipped) and their odometers never
 * advanced. The read is now paged via fetchAllRows.
 *
 * This test seeds 1500 vehicles and delivers a Samsara reading for a vehicle
 * whose VIN sits at index 1400 — well past the clamp. With paging the reading
 * resolves to that vehicle; the pre-fix single-page read would drop it (0
 * written). Hermetic: Samsara HTTP + the admin client are mocked (no Supabase,
 * no realtime client under Node-20).
 */

const CLAMP = 1000;
type Row = Record<string, unknown>;

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    if (!admin.client) throw new Error("mock admin client not set");
    return admin.client;
  }),
}));

import { runTelematicsSync } from "@/server/services/telematics-sync";
import { encryptToken } from "@/lib/integrations/token-crypto";

const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

type Upsert = { rows: Row[]; opts: Record<string, unknown> };

/** A cap-emulating service-role builder: every read is clamped to 1000 rows. */
function makeDb(tables: { telematics_connections: Row[]; fleet_vehicles: Row[] }) {
  const upserts: Upsert[] = [];
  const updates: Row[] = [];

  function selectBuilder(rows: Row[]) {
    const preds: Array<(r: Row) => boolean> = [];
    const orderSpecs: Array<[string, boolean]> = [];
    const compute = (): Row[] => {
      let out = rows.filter((r) => preds.every((p) => p(r)));
      if (orderSpecs.length) {
        out = [...out].sort((a, b) => {
          for (const [c, asc] of orderSpecs) {
            const av = a[c] as string;
            const bv = b[c] as string;
            if (av < bv) return asc ? -1 : 1;
            if (av > bv) return asc ? 1 : -1;
          }
          return 0;
        });
      }
      return out;
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
      order: (c: string, o: { ascending: boolean }) => (orderSpecs.push([c, o.ascending !== false]), b),
      range: (from: number, to: number) =>
        Promise.resolve({ data: compute().slice(from, from + Math.min(to - from + 1, CLAMP)), error: null }),
      // A bare (unpaged) await is clamped to CLAMP, exactly like PostgREST.
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: compute().slice(0, CLAMP), error: null }).then(res),
    };
    return b;
  }

  const updateChain = (row: Row) => {
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
        return { select: () => selectBuilder(tables.telematics_connections), update: (r: Row) => updateChain(r) };
      }
      if (table === "fleet_vehicles") {
        return { select: () => selectBuilder(tables.fleet_vehicles), update: (r: Row) => updateChain(r) };
      }
      if (table === "telematics_readings") {
        return {
          upsert: (rows: Row[], opts: Record<string, unknown>) => {
            upserts.push({ rows, opts });
            return Promise.resolve({ error: null, count: rows.length });
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

// The target vehicle sits at index 1400 — past the 1000-row clamp.
const TARGET_INDEX = 1400;
const TARGET_VIN = `VIN${String(TARGET_INDEX).padStart(5, "0")}`;
const TARGET_ASSET = `veh-${String(TARGET_INDEX).padStart(5, "0")}`;

const STAT = {
  id: "sam-1",
  externalIds: { vin: TARGET_VIN.toLowerCase() },
  gps: { latitude: 51.5074, longitude: -0.1278, time: "2026-07-15T09:30:00Z" },
  obdOdometerMeters: { time: "2026-07-15T09:30:00Z", value: 1609344 },
};

beforeEach(() => {
  vi.clearAllMocks();
  admin.client = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runTelematicsSync — buildFleetIndex pages the whole register (F-1)", () => {
  it("resolves a VIN for a vehicle at index 1400 (a single clamped read would skip it)", async () => {
    connectableEnv();
    const db = makeDb({
      telematics_connections: [
        {
          id: CONN,
          org_id: ORG,
          provider: "samsara",
          status: "connected",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      fleet_vehicles: Array.from({ length: 1500 }, (_, i) => ({
        asset_id: `veh-${String(i).padStart(5, "0")}`,
        org_id: ORG,
        vin: `VIN${String(i).padStart(5, "0")}`,
        odometer_miles: null,
      })),
    });
    admin.client = db.client;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [STAT] }), { status: 200 })),
    );

    const summary = await runTelematicsSync();

    expect(summary.ran).toBe(true);
    expect(summary.connections).toBe(1);
    // The reading for VIN at index 1400 was written and VIN-resolved to its
    // asset — proving the register beyond the 1000-row clamp is in the index.
    expect(summary.written).toBe(1);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]!.rows[0]!.vehicle_id).toBe(TARGET_ASSET);
    expect(db.upserts[0]!.rows[0]!.org_id).toBe(ORG);
    // The odometer forward-update also found the (paged) vehicle.
    const odo = db.updates.find((u) => "odometer_miles" in u);
    expect(odo).toBeTruthy();
    expect(odo!.odometer_miles).toBe(1000);
  });
});

/**
 * SAMSARA PROVIDER-FETCH PAGINATION (F-1, adapter cursor loop).
 *
 * Samsara's `/fleet/vehicles/stats` is cursor-paginated: the response carries
 * `pagination.hasNextPage` + `pagination.endCursor`, and the next page is the same
 * URL with `?after=<endCursor>`. The pre-fix adapter issued ONE GET and mapped only
 * page 1, so any fleet past the page boundary was silently dropped — no reading, no
 * odometer advance. This proves the adapter now follows the cursor: a page-2 vehicle
 * (delivered ONLY on the second request) lands a written telematics_readings row.
 */
const PAGE1_VIN = "VINPAGE0001";
const PAGE1_ASSET = "veh-page-1";
const PAGE2_VIN = "VINPAGE0002";
const PAGE2_ASSET = "veh-page-2";

const PAGE1_STAT = {
  id: "sam-page1",
  externalIds: { vin: PAGE1_VIN.toLowerCase() },
  gps: { latitude: 51.5074, longitude: -0.1278, time: "2026-07-15T09:30:00Z" },
  obdOdometerMeters: { time: "2026-07-15T09:30:00Z", value: 1609344 }, // 1000 miles
};
const PAGE2_STAT = {
  id: "sam-page2",
  externalIds: { vin: PAGE2_VIN.toLowerCase() },
  gps: { latitude: 53.4808, longitude: -2.2426, time: "2026-07-15T09:35:00Z" },
  obdOdometerMeters: { time: "2026-07-15T09:35:00Z", value: 3218688 }, // 2000 miles
};

describe("SamsaraAdapter — cursor loop pulls EVERY page (F-1)", () => {
  it("writes a reading for a vehicle that only appears on page 2 of the stats feed", async () => {
    connectableEnv();
    const db = makeDb({
      telematics_connections: [
        {
          id: CONN,
          org_id: ORG,
          provider: "samsara",
          status: "connected",
          external_account_id: "samsara-org-9",
          access_token: encryptToken("live-access-token"),
          refresh_token: null,
          token_expires_at: null,
          last_sync_at: null,
        },
      ],
      fleet_vehicles: [
        { asset_id: PAGE1_ASSET, org_id: ORG, vin: PAGE1_VIN, odometer_miles: null },
        { asset_id: PAGE2_ASSET, org_id: ORG, vin: PAGE2_VIN, odometer_miles: null },
      ],
    });
    admin.client = db.client;

    // Two-page Samsara feed: page 1 has hasNextPage=true + endCursor; page 2 (only
    // reachable via ?after=<cursor>) has hasNextPage=false. The mock keys off the
    // `after` param so page 2 is served ONLY on the follow-up request.
    const fetchMock = vi.fn(async (url: string) => {
      const after = new URL(url).searchParams.get("after");
      if (!after) {
        return new Response(
          JSON.stringify({
            data: [PAGE1_STAT],
            pagination: { hasNextPage: true, endCursor: "cursor-page-2" },
          }),
          { status: 200 },
        );
      }
      expect(after).toBe("cursor-page-2");
      return new Response(
        JSON.stringify({
          data: [PAGE2_STAT],
          pagination: { hasNextPage: false, endCursor: "cursor-page-2" },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runTelematicsSync();

    expect(summary.ran).toBe(true);
    expect(summary.connections).toBe(1);
    // The adapter followed the cursor: BOTH pages' vehicles produced readings.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.written).toBe(2);
    const writtenAssets = db.upserts.flatMap((u) => u.rows.map((r) => r.vehicle_id));
    expect(writtenAssets).toContain(PAGE1_ASSET);
    // The load-bearing assertion: the page-2 vehicle would be MISSING with a
    // single-GET adapter, and is present now.
    expect(writtenAssets).toContain(PAGE2_ASSET);
    // Its odometer (2000 mi) also forwarded onto the register.
    const page2Odo = db.updates.find((u) => u.odometer_miles === 2000);
    expect(page2Odo).toBeTruthy();
  });
});
