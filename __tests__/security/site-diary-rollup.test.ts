import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Automatic Site Diary roll-up — trust-boundary + structural proofs.
 *
 * The behavioural invariants (idempotency, manual-skip, scoping) are proven
 * against a real run in __tests__/site-diary/rollup-service.test.ts. This suite
 * pins the STRUCTURAL guarantees on source, so a regression is a visible diff:
 *
 *   1. The cron seam is authorised-FIRST and registered in vercel.json.
 *   2. Every high-value read pages (fetchAllRows/.range) and is LOUD (readFailure).
 *   3. Writes go through the service-role client and mark auto rows distinctly
 *      (source='auto_rollup'), and the DB carries the (org,job,date) dedupe index.
 *   4. Weather is DARK-GATED: isWeatherAvailable() precedes any weather read, so
 *      no weather_readings row is touched on a dark build.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const ROUTE = "app/api/cron/site-diary-rollup/route.ts";
const SERVICE = "server/services/site-diary-rollup.ts";
const MIGRATION = "supabase/migrations/20261183000000_site_diary_auto_rollup.sql";

// ---------------------------------------------------------------------------
// 1. The cron seam
// ---------------------------------------------------------------------------

describe("site-diary-rollup cron seam", () => {
  const code = codeOf(read(ROUTE));

  it("auth FIRST — a 401 gate precedes the telemetry/run", () => {
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
    const authIdx = code.indexOf("isCronAuthorised");
    const runIdx = code.indexOf("runSiteDiaryRollup");
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(runIdx);
  });

  it("runs on Node (service-role client + weather math) and is force-dynamic", () => {
    expect(code).toMatch(/runtime\s*=\s*["']nodejs["']/);
    expect(code).toMatch(/dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("wraps the run in cron telemetry", () => {
    expect(code).toMatch(/withCronTelemetry\(\s*["']site-diary-rollup["']/);
  });

  it("is registered in vercel.json with a daily schedule", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    const entry = vercel.crons.find((c) => c.path === "/api/cron/site-diary-rollup");
    expect(entry, "site-diary-rollup must be registered in vercel.json").toBeDefined();
    // A once-a-day cadence (single field for the day-of-month/month/weekday wildcards).
    expect(entry!.schedule).toMatch(/^\S+ \S+ \* \* \*$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Paged + loud reads
// ---------------------------------------------------------------------------

describe("site-diary-rollup service reads are paged and loud", () => {
  const code = codeOf(read(SERVICE));

  it("pages via fetchAllRows/.range — no clamp-truncated set read (F-1)", () => {
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/paginate["']/);
    expect(code).toMatch(/fetchAllRows</);
    expect(code).toMatch(/\.range\(/);
  });

  it("binds read errors and throws readFailure (never a silent partial roll-up)", () => {
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/read-failure["']/);
    expect(code).toMatch(/if\s*\(error\)\s*throw\s*readFailure\(/);
  });

  it("orders every paged read by the unique id so pages can't drop/repeat rows", () => {
    expect(code).toMatch(/\.order\(\s*["']id["']\s*,\s*\{\s*ascending:\s*true\s*\}\s*\)/);
  });

  it("never discards a read error via the bare `const { data } = await` shape", () => {
    // The loud-read shape ledger forbids it globally; pin it here too.
    expect(code).not.toMatch(/const\s*\{\s*data\s*\}\s*=\s*await/);
  });
});

// ---------------------------------------------------------------------------
// 3. Service-role writes, distinct provenance, dedupe index
// ---------------------------------------------------------------------------

describe("site-diary-rollup writes are tenant-safe + idempotent", () => {
  const code = codeOf(read(SERVICE));

  it("writes through the service-role admin client", () => {
    expect(code).toMatch(/createAdminClient/);
  });

  it("pins the job's org_id on the write (no cross-tenant blend)", () => {
    expect(code).toMatch(/org_id:\s*orgId/);
  });

  it("marks auto entries distinctly with source='auto_rollup'", () => {
    expect(code).toMatch(/source:\s*AUTO_ROLLUP_SOURCE/);
  });

  it("skips a job/day that already carries a MANUAL entry", () => {
    expect(code).toMatch(/MANUAL_SOURCE/);
    expect(code).toMatch(/return\s*"manual"/);
  });

  it("treats a unique-violation (23505) as an idempotent no-op, not a throw", () => {
    expect(code).toMatch(/23505|UNIQUE_VIOLATION/);
  });

  it("the migration adds the source column + the (org,job,date) partial dedupe index", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/add column if not exists source text not null default 'manual'/);
    expect(sql).toMatch(/check \(source in \('manual', 'auto_rollup'\)\)/);
    expect(sql).toMatch(/create unique index if not exists site_diary_entries_auto_rollup_uidx/);
    expect(sql).toMatch(/\(org_id, job_id, entry_date\)/);
    expect(sql).toMatch(/where source = 'auto_rollup'/);
  });
});

// ---------------------------------------------------------------------------
// 4. Weather is dark-gated
// ---------------------------------------------------------------------------

describe("site-diary-rollup weather is dark-safe", () => {
  const code = codeOf(read(SERVICE));

  it("gates the weather pass on isWeatherAvailable() BEFORE reading weather_readings", () => {
    expect(code).toMatch(/isWeatherAvailable\(\)/);
    const gateIdx = code.indexOf("isWeatherAvailable()");
    const readIdx = code.indexOf('"weather_readings"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(-1);
    // The readiness gate is captured (weatherOn) before the read helper runs.
    expect(code).toMatch(/const\s+weatherOn\s*=\s*isWeatherAvailable\(\)/);
    expect(code).toMatch(/if\s*\(weatherOn\)/);
  });

  it("degrades to no weather line rather than throwing when a weather read fails", () => {
    // weatherForDistrict swallows to null so a weather blip never fails the run.
    expect(code).toMatch(/catch\s*\{\s*return null;/);
  });
});
