import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENV-CONTRACT CENSUS — every production env read must be DECLARED (2026-10).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * lib/env.ts is the census of what this deployment consumes: an operator (or a
 * future wave) must be able to read ONE file and know every variable that can
 * change production behaviour. The 2026-10 audit found sixteen variables read
 * in production code but absent from the schema (COMPANIES_HOUSE_API_KEY,
 * GITHUB_TOKEN/REPO, VERCEL_TOKEN/PROJECT_ID/TEAM_ID, MAINTENANCE_MODE/BYPASS,
 * VAPI_WEBHOOK_HMAC, VAPI_CUSTOM_LLM_URL, SAGE account pins, KV creds, and
 * stragglers) — and two declared variables with ZERO readers quietly implying
 * gates that did not exist (VAPI_API_KEY, TWILIO_API_KEY_*).
 *
 * This guard makes the undeclared-consumption class a CI FAILURE FOREVER, by
 * ENUMERATION rather than by hand-list: it scans every production source file
 * for static `process.env` reads, parses the schema keys out of lib/env.ts
 * SOURCE, and asserts read ⊆ declared ∪ allowlist. A new env read in any
 * future wave either lands with its declaration or fails this tier — which is
 * what makes this test the reconciliation point for parallel waves.
 *
 * SCOPE — what "production source" means here:
 *   INCLUDED: app/, lib/, server/, and the root runtime entrypoints
 *     middleware.ts, instrumentation.ts, sentry.{server,edge,client}.config.ts
 *     — everything that executes while serving requests.
 *   EXCLUDED (each justified):
 *     - __tests__/, *.test.ts(x), e2e/ — test code; never deployed.
 *     - scripts/ — operator/CI harnesses (tsx), not part of the build output.
 *     - next.config.ts, *.config.{ts,mjs} at the root — BUILD-time only; they
 *       run in the build container, never in the serving runtime. (The sentry
 *       runtime configs above are the deliberate exception: they execute at
 *       boot in the deployed app, so they are scanned.)
 *     - *.d.ts — types carry no reads.
 *
 * LIMITS (documented, not hidden): the scan is static. It sees
 * `process.env.NAME` and `process.env["NAME"]`; it cannot resolve
 * `process.env[someExpression]`. The two known dynamic-key readers —
 * lib/cache/kv.ts (loops over KV_ENV_KEYS) and lib/maintenance/readiness.ts
 * (reads via its MAINTENANCE_REMINDERS_FLAG const) — have their names declared
 * in the schema regardless. Comment-stripped, so prose can neither satisfy nor
 * trip the census.
 */

const ROOT = resolve(__dirname, "..", "..");

/** Directories scanned recursively. */
const SCAN_DIRS = ["app", "lib", "server"] as const;

/** Root-level runtime entrypoints scanned as single files. */
const SCAN_FILES = [
  "middleware.ts",
  "instrumentation.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "sentry.client.config.ts",
] as const;

/**
 * Names that are read in production source but deliberately NOT in the schema.
 * Keep this list SHORT and framework-only — an application variable belongs in
 * lib/env.ts, full stop. Two companion assertions keep it from rotting: an
 * entry that becomes declared, or stops being read entirely, FAILS below.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    "NEXT_RUNTIME",
    "Framework-injected runtime discriminator ('nodejs'/'edge') Next.js sets while loading " +
      "instrumentation.ts. Never operator-set, never configuration — declaring it would imply it is.",
  ],
]);

/** Strip block + line comments; same idiom as the sibling source pins. */
function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function isScannable(name: string): boolean {
  return (
    /\.(ts|tsx)$/.test(name) &&
    !/\.d\.ts$/.test(name) &&
    !/\.(test|spec)\.(ts|tsx)$/.test(name)
  );
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules" || name === "e2e") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (isScannable(name)) yield p;
  }
}

/** Every statically visible env read: name → the files:lines that read it. */
function collectReads(): { reads: Map<string, string[]>; filesScanned: number } {
  const files: string[] = [];
  for (const d of SCAN_DIRS) files.push(...walk(join(ROOT, d)));
  for (const f of SCAN_FILES) files.push(join(ROOT, f));

  const DOT = /process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const BRACKET = /process\.env\[\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]/g;

  const reads = new Map<string, string[]>();
  for (const f of files) {
    const lines = codeOf(readFileSync(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const re of [DOT, BRACKET]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
          const name = m[1]!;
          const sites = reads.get(name) ?? [];
          sites.push(`${relative(ROOT, f)}:${i + 1}`);
          reads.set(name, sites);
        }
      }
    });
  }
  return { reads, filesScanned: files.length };
}

/** The schema keys, parsed from lib/env.ts SOURCE (comment-stripped). */
function collectDeclared(): Set<string> {
  const src = codeOf(readFileSync(join(ROOT, "lib/env.ts"), "utf8"));
  const declared = new Set<string>();
  const KEY = /^\s{2}([A-Za-z_$][A-Za-z0-9_$]*):\s*z\./gm;
  let m: RegExpExecArray | null;
  while ((m = KEY.exec(src))) declared.add(m[1]!);
  return declared;
}

const { reads, filesScanned } = collectReads();
const declared = collectDeclared();

describe("env-contract census — lib/env.ts is the single source of env truth", () => {
  it("scanner sanity: the walk and the schema parse both saw the real tree (never vacuous)", () => {
    // A broken walker or a schema-parse regression must fail LOUD here, not
    // pass an empty census. Floors, not exact counts — growth never trips them.
    expect(filesScanned).toBeGreaterThan(1000);
    expect(reads.size).toBeGreaterThan(50);
    expect(declared.size).toBeGreaterThan(100);
    // Tripwires: reads the census is known to contain, from three corners of
    // the tree — if any disappears from the SCAN (not from the code), the
    // scanner itself has gone blind.
    expect(reads.has("MAINTENANCE_MODE")).toBe(true); // lib/maintenance.ts
    expect(reads.has("COMPANIES_HOUSE_API_KEY")).toBe(true); // server/services
    expect(reads.has("SENTRY_DSN")).toBe(true); // sentry.server.config.ts
  });

  it("EVERY static process.env read in production source is declared in lib/env.ts (or allowlisted)", () => {
    const undeclared = [...reads.entries()]
      .filter(([name]) => !declared.has(name) && !ALLOWLIST.has(name))
      .map(([name, sites]) => `  ${name}\n    read at: ${sites.slice(0, 5).join(", ")}${sites.length > 5 ? ` (+${sites.length - 5} more)` : ""}`);
    expect(
      undeclared,
      `Undeclared production env consumption. Declare each name in lib/env.ts's schema with an ` +
        `honest comment (or, for a framework-injected name ONLY, allowlist it here with a ` +
        `justification):\n${undeclared.join("\n")}`,
    ).toEqual([]);
  });

  it("allowlist hygiene: no entry is also declared, and every entry is still read", () => {
    for (const name of ALLOWLIST.keys()) {
      expect(declared.has(name), `${name} is allowlisted AND declared — drop the allowlist entry`).toBe(false);
      expect(reads.has(name), `${name} is allowlisted but no longer read anywhere — drop the allowlist entry`).toBe(true);
    }
  });

  it("removed dead declarations STAY removed: a declared name must not imply a gate with zero readers", () => {
    // The 2026-10 census removed VAPI_API_KEY and TWILIO_API_KEY_SID/SECRET:
    // declared-with-zero-readers, each falsely implying an activation gate.
    // Pin the removal. (This is a targeted pin, not a general "declared ⇒ read"
    // rule — most declarations are legitimately read via the parsed `env`
    // object or dynamic keys, which this static census cannot see.)
    for (const ghost of ["VAPI_API_KEY", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"]) {
      expect(declared.has(ghost), `${ghost} re-declared without a reader`).toBe(false);
      expect(reads.has(ghost), `${ghost} is read again — re-declare it in lib/env.ts`).toBe(false);
    }
  });
});
