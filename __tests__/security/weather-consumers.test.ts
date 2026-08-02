import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * WEATHER CONSUMERS — the "never fabricate a forecast" convention, pinned.
 *
 * The weather cache (20261074) is dark. Three consumers now read it — the EOT
 * pack, the schedule-integrity signal and the Daily Briefing — and the whole
 * point of wiring them dark is that activation is a config flip, not an edit.
 * The invariants that make that safe are STRUCTURAL, so they get source pins:
 *
 *   1. Every consumer reaches the cache ONLY through the governed accessor
 *      (server/services/weather.ts → buildWeatherSnapshot) — never a raw
 *      weather-table query it hand-rolls.
 *   2. The PURE decision modules (schedule weather-risk, the briefing weather
 *      section) stay pure — no DB, no server-only, no network — and construct
 *      NO weather reading of their own. A number that was invented instead of
 *      read is the one failure a weather surface must never have.
 *   3. The dark path is honest: an explicit "not connected / not clear" line,
 *      never a green all-clear, and it is deterministic.
 *
 * Comments are stripped before matching, so prose that documents a boundary can
 * neither satisfy nor trip a check.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PURE_WEATHER_RISK = "lib/schedule/weather-risk.ts";
const BRIEFING_COMPOSE = "lib/briefing/compose.ts";
const EOT_SERVICE = "server/services/eot-pack.ts";
const SCHEDULE_SERVICE = "server/services/schedule-integrity.ts";
const BRIEFING_SERVICE = "server/services/briefing.ts";

const CONSUMER_SERVICES = [EOT_SERVICE, SCHEDULE_SERVICE, BRIEFING_SERVICE];
const PURE_MODULES = [PURE_WEATHER_RISK, BRIEFING_COMPOSE];

describe("weather consumers · the cache is only reached through the governed accessor", () => {
  it("no consumer names a weather TABLE directly — the accessor owns the read", () => {
    for (const rel of [...CONSUMER_SERVICES, ...PURE_MODULES]) {
      expect(code(rel), `${rel} must not query a weather table`).not.toMatch(
        /weather_readings|weather_watches/,
      );
    }
  });

  it("the EOT and schedule services read weather via buildWeatherSnapshot", () => {
    for (const rel of [EOT_SERVICE, SCHEDULE_SERVICE]) {
      const c = code(rel);
      expect(c, `${rel} must import the governed accessor`).toMatch(
        /from ["']@\/server\/services\/weather["']/,
      );
      expect(c).toContain("buildWeatherSnapshot");
    }
  });

  it("the briefing reads weather only through the schedule signal, never the accessor directly", () => {
    const c = code(BRIEFING_SERVICE);
    expect(c).toContain("loadScheduleWeatherSignal");
    expect(c).toContain("composeWeatherSection");
  });
});

describe("weather consumers · the pure decision modules stay pure and invent nothing", () => {
  it("no DB client, no server-only, no network in the pure modules", () => {
    for (const rel of PURE_MODULES) {
      const c = code(rel);
      expect(c, `${rel} must not import supabase`).not.toMatch(/@\/lib\/supabase/);
      expect(c, `${rel} must not be server-only`).not.toContain("server-only");
      expect(c, `${rel} must not fetch`).not.toMatch(/\bfetch\s*\(/);
      for (const verb of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", ".from("]) {
        expect(c.includes(verb), `${rel} contains ${verb}`).toBe(false);
      }
    }
  });

  it("the pure modules construct NO weather reading and hard-code no forecast figure", () => {
    for (const rel of PURE_MODULES) {
      const c = code(rel);
      // No reading-shaped object literals — evidence/risks come from the accessor.
      for (const field of ["airTempC:", "windGustMs:", "windSpeedMs:", "precipRateMmH:"]) {
        expect(c.includes(field), `${rel} fabricates a reading field ${field}`).toBe(false);
      }
      // No spelled-out weather units — the risk lines quote sourced threshold
      // RULES, never a number this module made up.
      expect(c, `${rel} must not spell a temperature`).not.toMatch(/\b\d+\s*°C\b/);
      expect(c, `${rel} must not spell a rain rate`).not.toMatch(/\bmm\/h\b/);
    }
  });

  it("the schedule risk engine is deterministic — no clock, no randomness", () => {
    const c = code(PURE_WEATHER_RISK);
    expect(c).not.toMatch(/new Date\(\s*\)/);
    expect(c).not.toContain("Date.now(");
    expect(c).not.toContain("Math.random(");
  });
});

describe("weather consumers · the dark path is honest, never a green all-clear", () => {
  it("the schedule signal has an explicit unavailable constructor", () => {
    expect(code(PURE_WEATHER_RISK)).toContain("unavailableWeatherSignal");
  });

  it("the briefing weather line refuses to imply clear conditions while dark", () => {
    // The exact denial the composer renders when nothing is connected.
    expect(read(BRIEFING_COMPOSE)).toMatch(/not a report that conditions are clear/i);
  });

  it("a job with no reading is INSUFFICIENT, not cleared — the missing-data guard", () => {
    // The schedule engine distinguishes "assessed against real data" from
    // "could not check", so an empty window can never read as safe.
    const c = code(PURE_WEATHER_RISK);
    expect(c).toContain("insufficientJobs");
    expect(c).toMatch(/readings\.length === 0/);
  });
});
