import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VerizonConnectAdapter } from "@/lib/integrations/telematics/adapters/verizon-connect";
import {
  normalizeVerizonConnectSamples,
  type VerizonConnectVehicleStatus,
} from "@/lib/integrations/telematics/reading-map";

/**
 * Verizon Connect (Reveal) telematics adapter — unit tests (hermetic; provider
 * HTTP mocked, NEVER a real API call).
 *
 * Proves, mirroring the Samsara adapter's contract:
 *   • the pure normaliser resolves VIN → registration → name → vehicle-number in
 *     that priority, passes MILES through with no conversion, keys the idempotency
 *     id on the stable VehicleNumber, and drops unmapped / untimestamped rows;
 *   • the adapter REFUSES before any fetch while dark (refuse-when-dark);
 *   • the live path pages the snapshot, bearer-auths, splits terminal (401/403)
 *     from transient (5xx/429/network) failures, and returns the raw vehicle count;
 *   • the SSRF guard refuses a mis-set base host BEFORE any fetch; and
 *   • the account-handle resolver mirrors the same guard + parse.
 */

// ── connectable-substrate toggle (the two-switch + provider binding) ──────────
const CREDS = {
  NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT: "true",
  TELEMATICS_CLIENT_ID: "cid",
  TELEMATICS_CLIENT_SECRET: "csecret",
  TELEMATICS_PROVIDER: "verizon_connect",
} as const;

function enable() {
  for (const [k, v] of Object.entries(CREDS)) process.env[k] = v;
}
function disable() {
  for (const k of Object.keys(CREDS)) delete process.env[k];
  delete process.env.VERIZON_CONNECT_API_BASE_URL;
}

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const original = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  disable();
  enable();
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
});

// Resolve only this org's known keys; everything else is unmapped (null).
const ASSET = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ASSET_REG = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function resolver(map: Record<string, string>) {
  return (key: string): string | null => map[key.trim().toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------------
// 1. THE PURE NORMALISER
// ---------------------------------------------------------------------------

describe("normalizeVerizonConnectSamples", () => {
  const resolve = resolver({
    "1HGBH41JXMN109186": ASSET,
    "AB12CDE": ASSET_REG,
  });

  it("maps a VIN-identified status: miles pass through (NO metres conversion), event id keyed on VehicleNumber", () => {
    const rows: VerizonConnectVehicleStatus[] = [
      {
        VehicleNumber: "V001",
        Vin: "1HGBH41JXMN109186",
        RegistrationNumber: "ZZ99 ZZZ",
        Name: "Transit",
        Odometer: 82345.7,
        Latitude: 51.5074,
        Longitude: -0.1278,
        UpdateUTC: "2026-08-01T10:15:00Z",
      },
    ];
    const [s] = normalizeVerizonConnectSamples(rows, resolve);
    expect(s).toEqual({
      vehicleId: ASSET,
      eventId: "V001:2026-08-01T10:15:00Z",
      recordedAt: "2026-08-01T10:15:00Z",
      latitude: 51.5074,
      longitude: -0.1278,
      // Reveal reports MILES already — the value is untouched (contrast Samsara's
      // metres/1609.344). If this were treated as metres it would be ~51 miles.
      odometerMiles: 82345.7,
    });
  });

  it("falls back to REGISTRATION when the VIN does not resolve", () => {
    // The normaliser passes RegistrationNumber THROUGH to the resolver as-is; the
    // real buildFleetIndex resolver is what whitespace-normalises the plate. Here
    // the resolver is keyed on the exact plate the normaliser forwards.
    const resolveByPlate = resolver({ "AB12 CDE": ASSET_REG });
    const rows: VerizonConnectVehicleStatus[] = [
      { VehicleNumber: "V002", Vin: "UNKNOWNVIN", RegistrationNumber: "AB12 CDE", UpdateUTC: "2026-08-01T11:00:00Z", Odometer: 100 },
    ];
    const [s] = normalizeVerizonConnectSamples(rows, resolveByPlate);
    expect(s?.vehicleId).toBe(ASSET_REG);
    expect(s?.eventId).toBe("V002:2026-08-01T11:00:00Z"); // idempotency still anchored on VehicleNumber
  });

  it("resolution PRIORITY is VIN > registration > name > vehicle-number", () => {
    const resolveAll = resolver({
      VIN9: "vin-asset",
      REG9: "reg-asset",
      NAME9: "name-asset",
      NUM9: "num-asset",
    });
    // VIN wins when present.
    expect(
      normalizeVerizonConnectSamples(
        [{ VehicleNumber: "NUM9", Vin: "vin9", RegistrationNumber: "reg9", Name: "name9", UpdateUTC: "t", Odometer: 1 }],
        resolveAll,
      )[0]?.vehicleId,
    ).toBe("vin-asset");
    // registration wins when VIN absent.
    expect(
      normalizeVerizonConnectSamples(
        [{ VehicleNumber: "NUM9", RegistrationNumber: "reg9", Name: "name9", UpdateUTC: "t", Odometer: 1 }],
        resolveAll,
      )[0]?.vehicleId,
    ).toBe("reg-asset");
    // name wins when VIN + reg absent.
    expect(
      normalizeVerizonConnectSamples(
        [{ VehicleNumber: "NUM9", Name: "name9", UpdateUTC: "t", Odometer: 1 }],
        resolveAll,
      )[0]?.vehicleId,
    ).toBe("name-asset");
    // vehicle-number is the final fallback.
    expect(
      normalizeVerizonConnectSamples(
        [{ VehicleNumber: "num9", UpdateUTC: "t", Odometer: 1 }],
        resolveAll,
      )[0]?.vehicleId,
    ).toBe("num-asset");
  });

  it("drops an UNMAPPED vehicle rather than guessing", () => {
    const rows: VerizonConnectVehicleStatus[] = [
      { VehicleNumber: "V9", Vin: "NOPE", UpdateUTC: "2026-08-01T00:00:00Z", Odometer: 5 },
    ];
    expect(normalizeVerizonConnectSamples(rows, resolve)).toEqual([]);
  });

  it("drops a record with NO timestamp (recorded_at is NOT NULL — never fabricated)", () => {
    const rows: VerizonConnectVehicleStatus[] = [
      { VehicleNumber: "V001", Vin: "1HGBH41JXMN109186", Odometer: 5, UpdateUTC: null },
      { VehicleNumber: "V001", Vin: "1HGBH41JXMN109186", Odometer: 5 }, // absent
    ];
    expect(normalizeVerizonConnectSamples(rows, resolve)).toEqual([]);
  });

  it("drops a record with NO VehicleNumber (no stable idempotency key)", () => {
    const rows: VerizonConnectVehicleStatus[] = [
      { Vin: "1HGBH41JXMN109186", UpdateUTC: "2026-08-01T00:00:00Z", Odometer: 5 },
      { VehicleNumber: "  ", Vin: "1HGBH41JXMN109186", UpdateUTC: "2026-08-01T00:00:00Z", Odometer: 5 },
    ];
    expect(normalizeVerizonConnectSamples(rows, resolve)).toEqual([]);
  });

  it("nulls a non-finite / absent odometer to no-signal", () => {
    const [s] = normalizeVerizonConnectSamples(
      [{ VehicleNumber: "V001", Vin: "1HGBH41JXMN109186", UpdateUTC: "t", Odometer: Number.NaN, Latitude: 1, Longitude: 2 }],
      resolve,
    );
    expect(s?.odometerMiles).toBeNull();
  });

  it("is DETERMINISTIC — same input, byte-identical output", () => {
    const rows: VerizonConnectVehicleStatus[] = [
      { VehicleNumber: "V001", Vin: "1HGBH41JXMN109186", UpdateUTC: "2026-08-01T10:15:00Z", Odometer: 10, Latitude: 1.5, Longitude: 2.5 },
    ];
    expect(normalizeVerizonConnectSamples(rows, resolve)).toEqual(
      normalizeVerizonConnectSamples(rows, resolve),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. fetchReadings — refuse-when-dark, live path, pagination, error split, SSRF
// ---------------------------------------------------------------------------

const INPUT = {
  accessToken: "PLAINTEXT_AT",
  externalAccountId: "acct-1",
  resolveVehicleId: resolver({ "1HGBH41JXMN109186": ASSET }),
  since: null,
};

describe("VerizonConnectAdapter.fetchReadings", () => {
  it("REFUSES with NO network call while dark", async () => {
    disable(); // flag + credentials + binding all removed
    const adapter = new VerizonConnectAdapter();
    expect(adapter.isAvailable()).toBe(false);
    const res = await adapter.fetchReadings(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REFUSES when the flag is on but the provider is NOT the bound one", async () => {
    process.env.TELEMATICS_PROVIDER = "samsara"; // bound to the OTHER aggregator
    const adapter = new VerizonConnectAdapter();
    expect(adapter.isAvailable()).toBe(false);
    const res = await adapter.fetchReadings(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("live: pulls the snapshot, bearer-auths, returns samples + raw vehicle count", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        Vehicles: [
          { VehicleNumber: "V001", Vin: "1HGBH41JXMN109186", UpdateUTC: "2026-08-01T10:15:00Z", Odometer: 42, Latitude: 51.5, Longitude: -0.1 },
          { VehicleNumber: "V002", Vin: "UNMAPPED", UpdateUTC: "2026-08-01T10:16:00Z", Odometer: 7 },
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonRes(200, { Vehicles: [] })); // empty page → done

    const adapter = new VerizonConnectAdapter();
    const res = await adapter.fetchReadings(INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Two raw vehicles fetched; only the mapped VIN resolves to a sample.
      expect(res.fetchedVehicleCount).toBe(2);
      expect(res.samples).toHaveLength(1);
      expect(res.samples[0]?.vehicleId).toBe(ASSET);
    }
    // Bearer auth + the Reveal host.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("fim.api.us.fleetmatics.com/rad/v1/vehicles/status");
    expect(String(url)).toContain("page=1");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer PLAINTEXT_AT" });
  });

  it("accepts a BARE array response shape (Reveal version variance)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, [{ VehicleNumber: "V001", Vin: "1HGBH41JXMN109186", UpdateUTC: "t", Odometer: 1 }]),
    );
    fetchMock.mockResolvedValueOnce(jsonRes(200, []));
    const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fetchedVehicleCount).toBe(1);
  });

  it("PAGINATES until an empty page (accumulates every page)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, { Vehicles: [{ VehicleNumber: "V1", Vin: "1HGBH41JXMN109186", UpdateUTC: "t1", Odometer: 1 }] }))
      .mockResolvedValueOnce(jsonRes(200, { Vehicles: [{ VehicleNumber: "V2", Vin: "1HGBH41JXMN109186", UpdateUTC: "t2", Odometer: 2 }] }))
      .mockResolvedValueOnce(jsonRes(200, { Vehicles: [] }));
    const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("page=1");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("page=2");
    expect(String(fetchMock.mock.calls[2]![0])).toContain("page=3");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fetchedVehicleCount).toBe(2);
  });

  it("classifies 401 as TERMINAL (unauthorized)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(401, {}));
    const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("classifies 403 as TERMINAL (unauthorized)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(403, {}));
    const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("classifies 429 / 5xx as TRANSIENT (error, not terminal)", async () => {
    for (const status of [429, 500, 503]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(jsonRes(status, {}));
      const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("error");
    }
  });

  it("a network throw is a TRANSIENT error (not unauthorized)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });

  it("SSRF: a private/IP-literal base host is REFUSED before any fetch", async () => {
    process.env.VERIZON_CONNECT_API_BASE_URL = "https://169.254.169.254"; // link-local metadata
    const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SSRF: a non-https base is REFUSED before any fetch", async () => {
    process.env.VERIZON_CONNECT_API_BASE_URL = "http://fim.api.us.fleetmatics.com";
    const res = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours a valid regional base override (EU host)", async () => {
    process.env.VERIZON_CONNECT_API_BASE_URL = "https://fim.api.eu.fleetmatics.com";
    fetchMock.mockResolvedValueOnce(jsonRes(200, { Vehicles: [] }));
    await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("fim.api.eu.fleetmatics.com");
  });

  it("IDEMPOTENCY: the same snapshot yields the same source_event_id anchors", async () => {
    const page = {
      Vehicles: [{ VehicleNumber: "V001", Vin: "1HGBH41JXMN109186", UpdateUTC: "2026-08-01T10:15:00Z", Odometer: 9, Latitude: 1, Longitude: 2 }],
    };
    fetchMock.mockResolvedValueOnce(jsonRes(200, page)).mockResolvedValueOnce(jsonRes(200, { Vehicles: [] }));
    const a = await new VerizonConnectAdapter().fetchReadings(INPUT);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonRes(200, page)).mockResolvedValueOnce(jsonRes(200, { Vehicles: [] }));
    const b = await new VerizonConnectAdapter().fetchReadings(INPUT);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.samples[0]?.eventId).toBe("V001:2026-08-01T10:15:00Z");
      expect(a.samples[0]?.eventId).toBe(b.samples[0]?.eventId);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. resolveAccountHandle — guard + parse mirror
// ---------------------------------------------------------------------------

describe("VerizonConnectAdapter.resolveAccountHandle", () => {
  it("REFUSES with NO network call while dark", async () => {
    disable();
    const res = await new VerizonConnectAdapter().resolveAccountHandle("AT");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the account id from the Reveal account endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { Account: { AccountId: "ACC-42", Name: "Acme Plumbing" } }));
    const res = await new VerizonConnectAdapter().resolveAccountHandle("AT");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.externalAccountId).toBe("ACC-42");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/rad/v1/account");
  });

  it("errors when the account lookup returns no id", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { Account: {} }));
    const res = await new VerizonConnectAdapter().resolveAccountHandle("AT");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });

  it("errors on a non-2xx account lookup", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(500, {}));
    const res = await new VerizonConnectAdapter().resolveAccountHandle("AT");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });

  it("SSRF: a private base host is refused before any account fetch", async () => {
    process.env.VERIZON_CONNECT_API_BASE_URL = "https://10.0.0.5";
    const res = await new VerizonConnectAdapter().resolveAccountHandle("AT");
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
