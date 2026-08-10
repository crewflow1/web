import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONSTRAINT_VIOLATION_CODES,
  BATCH_WRITE_CHUNK,
} from "@/lib/supabase/safe-batch-write";

/**
 * BATCH-WRITE POISONING — the systemic shape guard (closes the class, not instances).
 *
 * A mapped external-feed batch written in ONE `.upsert(allRows)` that throws on the
 * first error is the batch-poisoning primitive: one uninsertable row (a CHECK /
 * NOT NULL / datetime / numeric-overflow the mapper did not mirror) aborts the whole
 * write → 0 rows → and because these feeds re-deliver the same window every tick, the
 * same poison re-aborts forever, stranding the org's feed at zero while the UI reads
 * "connected"/"fresh". C61 fixed ONE writer; this guard asserts EVERY mapped-vendor
 * batch writer routes through the SHARED chunked + per-row-fallback safe writer, so
 * the class cannot silently recur in a sibling — or in a future sync adapter.
 *
 * This is the structural twin of the per-adapter constraint guards
 * (telematics-reading-map / banking-statement-map / open-meteo-adapter it.each),
 * which pin that each MAPPER mirrors every CHECK/NOT-NULL/precision constraint.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Strip comments so an example in a doc block can never satisfy (or trip) a match. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SHARED = "lib/supabase/safe-batch-write.ts";

/**
 * Every mapped external-feed writer: the table it writes + its source file. A NEW
 * sync adapter that writes a mapped vendor feed MUST be added here AND route through
 * the shared safe writer — that is the whole point of a systemic guard.
 */
const MAPPED_FEED_WRITERS = [
  { table: "telematics_readings", file: "server/services/telematics-sync.ts" },
  { table: "bank_statement_lines", file: "server/services/bank-sync.ts" },
  { table: "weather_readings", file: "server/services/weather-fetch.ts" },
] as const;

describe("the shared safe writer exists and enumerates the bad-row SQLSTATEs", () => {
  it("chunks at a bounded size and recognises CHECK / NOT-NULL / datetime / numeric constraint codes", () => {
    expect(BATCH_WRITE_CHUNK).toBeGreaterThan(0);
    expect(BATCH_WRITE_CHUNK).toBeLessThanOrEqual(1000);
    // The bad-row codes that MUST trigger the per-row fallback (drop + TERMINAL),
    // versus a transient blip (bail + keep the feed live).
    for (const code of ["23514", "23502", "22007", "22003"]) {
      expect(CONSTRAINT_VIOLATION_CODES.has(code)).toBe(true);
    }
  });

  it("the shared writer implements chunk + per-row fallback", () => {
    const code = codeOf(read(SHARED));
    expect(code).toMatch(/export async function safeBatchWrite/);
    // A per-row fallback loop exists inside (single-row retry after a chunk error).
    expect(code).toMatch(/for \(const row of chunk\)/);
    expect(code).toMatch(/transientError/);
    expect(code).toMatch(/constraintError/);
  });
});

describe("every mapped-feed writer routes its batch upsert through the shared safe writer", () => {
  it.each(MAPPED_FEED_WRITERS)("$table writer imports and uses safeBatchWrite", ({ file }) => {
    const code = codeOf(read(file));
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/safe-batch-write["']/);
    expect(code).toMatch(/safeBatchWrite\(/);
  });

  it.each(MAPPED_FEED_WRITERS)(
    "$table writer's EVERY .upsert() operates on the per-chunk arg — never a bare full array",
    ({ file }) => {
      const code = codeOf(read(file));
      // Capture the first argument of every `.upsert(` in the writer. Each must be
      // `chunk` — the safeBatchWrite closure's per-chunk parameter — so a reintroduced
      // bare single `.upsert(allRows)` (the poisoning primitive) is caught here.
      const upsertArgs = [...code.matchAll(/\.upsert\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
      expect(upsertArgs.length).toBeGreaterThan(0);
      for (const arg of upsertArgs) expect(arg).toBe("chunk");
    },
  );
});

describe("each mapper mirrors the DB constraints its writer's table declares", () => {
  it("the banking mapper drops an uninsertable line (isInsertableLine + filter)", () => {
    const code = codeOf(read("lib/integrations/banking/statement-map.ts"));
    expect(code).toMatch(/export function isInsertableLine/);
    expect(code).toMatch(/\.filter\(isInsertableLine\)/);
    // The two constraints the row shape under-mirrors are enforced.
    expect(code).toMatch(/AMOUNT_MAX/);
    expect(code).toMatch(/DATE_ONLY_RE/);
  });

  it("the weather mapper nulls out-of-range metrics (boundedMetric) via the shared bounds", () => {
    const bounds = codeOf(read("lib/weather/reading-bounds.ts"));
    expect(bounds).toMatch(/export function boundedMetric/);
    expect(bounds).toMatch(/WEATHER_METRIC_BOUNDS/);
    const adapter = codeOf(read("lib/weather/providers/open-meteo.ts"));
    expect(adapter).toMatch(/from\s+["']\.\.\/reading-bounds["']/);
    expect(adapter).toMatch(/boundedMetric\(/);
  });

  it("the telematics mapper nulls out-of-range readings (the C61 reference)", () => {
    const code = codeOf(read("lib/integrations/telematics/reading-map.ts"));
    // The reference posture: range CHECK bounds enforced before emitting a row.
    expect(code).toMatch(/ODOMETER_MAX/);
    expect(code).toMatch(/LAT_MIN|LAT_MAX/);
  });
});
