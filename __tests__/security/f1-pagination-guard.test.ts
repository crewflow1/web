import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F-1 CLAMP-TRAP GUARD — the guardrail that missed GAP 4 / GAP 5.
 *
 * THE TRAP. PostgREST clamps EVERY response to the project `max_rows`
 * (supabase/config.toml → 1000). So `.limit(N)` for any N returns at most
 * `min(N, 1000)` rows — a `.limit(MAX_ROWS + 1)` = `.limit(50001)` was SILENTLY
 * truncated to 1000. The accounting export therefore dropped invoices 1001+,
 * its `truncated` probe (length > 50000) was DEAD (the server never returned
 * more than 1000), the provider push re-read the earliest 1000 forever, and the
 * push-once anti-set capped at 1000 (letting entities beyond it be re-pushed).
 *
 * WHY THE FIRST F-1 SWEEP MISSED IT. That sweep's grep EXCLUDED `.limit(` lines
 * — the exact lines carrying the clamp trap. This guard closes that gap: it
 * INSPECTS `.limit()` in the accounting ledger/export subsystem, RESOLVES the
 * argument through the file's own `const` definitions (so `MAX_ROWS + 1`
 * resolves to 50001, not an opaque token), and FAILS on any value above the
 * 1000-row clamp. It also requires the money-table reads to page via
 * `fetchAllRows` (`.range()`), the correct pattern, so a bare unpaginated
 * `.select()` that feeds the export can't return either.
 *
 * SCOPE. Deliberately scoped to the accounting export/ledger subsystem — the
 * files GAP 4 / GAP 5 live in. The wider repo has intentional large `.limit()`
 * caps in HQ/internal (non-tenant-export) services; sweeping those is a separate
 * concern and out of this fix's scope. Keeping the allowlist to the subsystem
 * is what keeps this guard tight and true.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS/JS comments so we only inspect EXECUTABLE `.limit()` calls. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** The PostgREST project cap — supabase/config.toml `max_rows`. */
const CLAMP = 1000;

/**
 * Resolve every `.limit(<arg>)` in `code` to a concrete number where possible,
 * using the file's own top-level numeric `const` definitions. Returns the list
 * of { arg, value } for the calls we could resolve; unresolvable dynamic args
 * (`Math.min(...)`, `opts.limit ?? N`, a plain runtime `limit` variable) are
 * skipped — they are not the static clamp trap this guard targets.
 */
function resolvedLimits(code: string): Array<{ arg: string; value: number }> {
  // Top-level numeric const table: `const NAME = 50_000;` / `export const ...`.
  const consts = new Map<string, number>();
  const constRe = /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([0-9][0-9_]*)\s*;/g;
  for (let m: RegExpExecArray | null; (m = constRe.exec(code)); ) {
    consts.set(m[1]!, Number(m[2]!.replace(/_/g, "")));
  }

  const asNumber = (raw: string): number | null => {
    const arg = raw.trim();
    // Numeric literal (allowing `50_000`).
    if (/^[0-9][0-9_]*$/.test(arg)) return Number(arg.replace(/_/g, ""));
    // Bare identifier resolved through the const table.
    if (consts.has(arg)) return consts.get(arg)!;
    // `IDENT +/-/* <int>` (the pre-fix `MAX_ROWS + 1`).
    const bin = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*([+\-*])\s*([0-9][0-9_]*)$/);
    if (bin && consts.has(bin[1]!)) {
      const base = consts.get(bin[1]!)!;
      const k = Number(bin[3]!.replace(/_/g, ""));
      return bin[2] === "+" ? base + k : bin[2] === "-" ? base - k : base * k;
    }
    return null;
  };

  const out: Array<{ arg: string; value: number }> = [];
  const limitRe = /\.limit\(\s*([^)]*?)\s*\)/g;
  for (let m: RegExpExecArray | null; (m = limitRe.exec(code)); ) {
    const value = asNumber(m[1]!);
    if (value !== null) out.push({ arg: m[1]!, value });
  }
  return out;
}

/** The accounting export/ledger subsystem — where GAP 4 / GAP 5 live. */
const SUBSYSTEM = [
  "server/services/accounting-export.ts",
  "server/services/accounting-connections.ts",
];

// ---------------------------------------------------------------------------
// 0. The resolver itself catches the clamp trap (proves the guard has teeth)
// ---------------------------------------------------------------------------

describe("the clamp-trap resolver", () => {
  it("resolves `MAX_ROWS + 1` (50000) to 50001 — the exact pre-fix value", () => {
    const preFix = `
      export const MAX_ROWS = 50_000;
      const q = supabase.from("invoices").select("*").eq("org_id", orgId).limit(MAX_ROWS + 1);
    `;
    const hits = resolvedLimits(preFix);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe(50_001);
    // …and would therefore be flagged as above the 1000-row clamp.
    expect(hits[0]!.value).toBeGreaterThan(CLAMP);
  });

  it("does NOT flag legitimate bounded reads (`.limit(1)`, small top-N)", () => {
    const ok = `
      const a = supabase.from("t").select("id").limit(1);
      const b = supabase.from("t").select("id").order("x").limit(50);
      const c = supabase.from("t").select("id").limit(Math.min(limit, 200));
    `;
    const hits = resolvedLimits(ok);
    // 1 and 50 resolve (both ≤ 1000); the Math.min(...) is skipped as dynamic.
    expect(hits.map((h) => h.value).sort((x, y) => x - y)).toEqual([1, 50]);
    expect(hits.every((h) => h.value <= CLAMP)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. No clamped `.limit()` anywhere in the accounting ledger/export subsystem
// ---------------------------------------------------------------------------

describe("accounting ledger/export subsystem — no PostgREST clamp trap", () => {
  for (const file of SUBSYSTEM) {
    it(`${file}: every static \`.limit()\` is at or below the ${CLAMP}-row clamp`, () => {
      const hits = resolvedLimits(codeOf(src(file)));
      const offenders = hits.filter((h) => h.value > CLAMP);
      expect(
        offenders,
        `clamp trap: ${file} has \`.limit(${offenders
          .map((o) => `${o.arg}=${o.value}`)
          .join(", ")})\` above ${CLAMP} — PostgREST silently truncates to ${CLAMP}. ` +
          `Page the read with fetchAllRows (@/lib/supabase/paginate) instead.`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The export ledger reads must PAGE (fetchAllRows), never a single-shot read
// ---------------------------------------------------------------------------

describe("accounting-export.ts pages the full ledger + anti-set", () => {
  const EXPORT = "server/services/accounting-export.ts";
  const code = () => codeOf(src(EXPORT));

  it("imports and uses fetchAllRows (the volume-safe full-table read)", () => {
    expect(code()).toMatch(/from\s+["']@\/lib\/supabase\/paginate["']/);
    expect(code()).toMatch(/fetchAllRows</);
    // Paging uses .range(from,to); a single-shot `.limit(N)` cannot page.
    expect(code()).toMatch(/\.range\(/);
  });

  it("carries NO `.limit()` on the export path (the clamp trap is gone entirely)", () => {
    // The export/push/push-once reads all page via fetchAllRows; a `.limit()`
    // reintroduced here is the pre-fix bug returning.
    expect(code()).not.toMatch(/\.limit\(/);
  });

  it("each paged read carries a UNIQUE id tiebreak so pages can't drop/repeat rows", () => {
    // fetchAllRows' contract: a STABLE total ordering. The primary sort
    // (created_at / paid_at) is not unique, so `id` must break ties.
    expect(code()).toMatch(/\.order\(\s*["']id["']\s*,\s*\{\s*ascending:\s*true\s*\}\s*\)/);
  });

  it("the reads stay LOUD (a failed page throws, never a silent partial export)", () => {
    const c = code();
    expect(c).toMatch(/if \(invErr\)[\s\S]{0,120}?throw readFailure\(/);
    expect(c).toMatch(/if \(payErr\)[\s\S]{0,120}?throw readFailure\(/);
    // The push-once anti-set read is loud too.
    expect(c).toMatch(/pushed-entity ledger/);
  });

  it("stays org-pinned on the paged reads (no cross-tenant blend)", () => {
    const pins = code().match(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/g) ?? [];
    // invoices + payments + push-once ledger.
    expect(pins.length).toBeGreaterThanOrEqual(3);
  });
});
