import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMaintenanceBypassed, maintenanceResponse } from "@/lib/maintenance";

/**
 * Maintenance bypass token hardening (final launch audit F6).
 *
 * The bypass is an operator credential while a maintenance window is open. It
 * must be compared in constant time (edge-safe: middleware runs on the Edge
 * runtime, so no node:crypto), a weak configured token must never be honoured,
 * malformed or oversized presented values are rejected before comparison, and
 * the token never appears in any response.
 */

const STRONG = "mb_9f2c7a4e1d6b8f03a5c2e7d9b1f4a6c8";
const ENV = { ...process.env };
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

beforeEach(() => {
  delete process.env.MAINTENANCE_BYPASS;
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("maintenance bypass token", () => {
  it("compares through the shared edge-safe constant-time helper, never ===/includes on the token", () => {
    const src = readFileSync(join(__dirname, "../../lib/maintenance.ts"), "utf8");
    expect(src).toMatch(/from "@\/lib\/security\/constant-time-edge"/);
    expect(src).not.toMatch(/===\s*token|token\s*===|includes\(`maint_bypass=\$\{token\}`\)/);
    expect(src, "lib/maintenance.ts must stay Edge-safe").not.toMatch(/from "node:/);
  });

  it("never honours a weak configured token (shorter than 16 characters)", () => {
    process.env.MAINTENANCE_BYPASS = "s3cret";
    expect(isMaintenanceBypassed(req("https://x/app?maint_bypass=s3cret"))).toBe(false);
    expect(isMaintenanceBypassed(req("https://x/app", { "x-maintenance-bypass": "s3cret" }))).toBe(false);
    expect(isMaintenanceBypassed(req("https://x/app", { cookie: "maint_bypass=s3cret" }))).toBe(false);
  });

  it("accepts a strong token on each channel", () => {
    process.env.MAINTENANCE_BYPASS = STRONG;
    expect(isMaintenanceBypassed(req(`https://x/app?maint_bypass=${STRONG}`))).toBe(true);
    expect(isMaintenanceBypassed(req("https://x/app", { "x-maintenance-bypass": STRONG }))).toBe(true);
    expect(isMaintenanceBypassed(req("https://x/app", { cookie: `a=1; maint_bypass=${STRONG}; b=2` }))).toBe(true);
  });

  it("rejects prefixes, suffixes, case changes, oversized and malformed values", () => {
    process.env.MAINTENANCE_BYPASS = STRONG;
    const bad = [STRONG.slice(0, -1), `${STRONG}x`, STRONG.toUpperCase(), "A".repeat(10_000), `${STRONG.slice(0, 8)} ${STRONG.slice(8)}`];
    for (const b of bad) {
      const label = b.slice(0, 24);
      expect(isMaintenanceBypassed(req("https://x/app", { "x-maintenance-bypass": b })), label).toBe(false);
      expect(isMaintenanceBypassed(req(`https://x/app?maint_bypass=${encodeURIComponent(b)}`)), label).toBe(false);
    }
    expect(isMaintenanceBypassed(req(`https://x/app?maint_bypass=${encodeURIComponent(STRONG + "\n")}`))).toBe(false);
    expect(isMaintenanceBypassed(req("https://x/app", { cookie: `maint_bypass=${STRONG}x` }))).toBe(false);
    expect(isMaintenanceBypassed(req("https://x/app", { cookie: `xmaint_bypass=${STRONG}` }))).toBe(false);
  });

  it("an oversized presented value is rejected without being compared", () => {
    process.env.MAINTENANCE_BYPASS = STRONG;
    const huge = STRONG + "A".repeat(300);
    expect(isMaintenanceBypassed(req("https://x/app", { "x-maintenance-bypass": huge }))).toBe(false);
  });

  it("the maintenance response never contains the token", async () => {
    process.env.MAINTENANCE_BYPASS = STRONG;
    for (const kind of ["json", "html"] as const) {
      const res = maintenanceResponse(kind);
      const all = (await res.text()) + JSON.stringify([...res.headers]);
      expect(all).not.toContain(STRONG);
    }
  });
});
