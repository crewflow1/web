import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isMaintenanceMode,
  isMaintenanceBypassed,
  maintenanceResponse,
} from "@/lib/maintenance";

/**
 * Maintenance-window gate — unit proof of the cutover mechanism. The gate must
 * be DB-free and env-only so it is safe to serve while the schema is mid-migration.
 */

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});
beforeEach(() => {
  delete process.env.MAINTENANCE_MODE;
  delete process.env.MAINTENANCE_BYPASS;
});

const req = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("isMaintenanceMode", () => {
  it("is OFF by default (env unset) — the gate is inert", () => {
    expect(isMaintenanceMode()).toBe(false);
  });
  it("is ON only for the exact value 'on'", () => {
    process.env.MAINTENANCE_MODE = "on";
    expect(isMaintenanceMode()).toBe(true);
  });
  it("stays OFF for 'off' / 'true' / anything else (no accidental trip)", () => {
    for (const v of ["off", "true", "1", "ON", "yes"]) {
      process.env.MAINTENANCE_MODE = v;
      expect(isMaintenanceMode()).toBe(false);
    }
  });
});

describe("isMaintenanceBypassed", () => {
  it("is false when no bypass token is configured", () => {
    expect(isMaintenanceBypassed(req("https://x/app"))).toBe(false);
  });
  it("accepts the token via query param, header, or cookie", () => {
    process.env.MAINTENANCE_BYPASS = "s3cret";
    expect(isMaintenanceBypassed(req("https://x/app?maint_bypass=s3cret"))).toBe(true);
    expect(isMaintenanceBypassed(req("https://x/app", { "x-maintenance-bypass": "s3cret" }))).toBe(true);
    expect(isMaintenanceBypassed(req("https://x/app", { cookie: "a=1; maint_bypass=s3cret" }))).toBe(true);
  });
  it("rejects a wrong or absent token", () => {
    process.env.MAINTENANCE_BYPASS = "s3cret";
    expect(isMaintenanceBypassed(req("https://x/app?maint_bypass=nope"))).toBe(false);
    expect(isMaintenanceBypassed(req("https://x/app"))).toBe(false);
    expect(isMaintenanceBypassed(req("https://x/app", { cookie: "maint_bypass=nope" }))).toBe(false);
  });
});

describe("maintenanceResponse", () => {
  it("returns a retry-safe 503 with no-store", async () => {
    const r = maintenanceResponse("json");
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("120");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toMatchObject({ ok: false, maintenance: true });
  });
  it("serves an HTML body when asked (browser navigations)", async () => {
    const r = maintenanceResponse("html");
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("scheduled");
  });
});
