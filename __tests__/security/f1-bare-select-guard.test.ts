import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * F-1 BARE-SELECT GUARD (repo-wide) — a read on a HIGH-VALUE (money / ledger /
 * reconciliation / cross-tenant-producer) table must be paginated or bounded.
 *
 * WHY: PostgREST clamps every response to max_rows=1000 (supabase/config.toml).
 * A BARE `.from(TABLE).select(...)` that materialises a set for aggregation /
 * export / scoring / reconciliation silently returns AT MOST 1000 rows with NO
 * error — the F-1 truncation class. The sibling `.limit`-clamp guard
 * (f1-limit-clamp-guard.test.ts) cannot see this: a bare select carries no
 * `.limit(`/`.range(` for it to inspect.
 *
 * RULE: for every `.from("<HIGH_VALUE_TABLE>")` read, the same statement MUST
 * contain one of:
 *   - `.single(` / `.maybeSingle(`  → a single-row read (bounded)
 *   - `.range(`                     → paged (fetchAllRows) — the complete-read fix
 *   - `.limit(`                     → an explicit cap (its size is policed by the
 *                                     sibling f1-limit-clamp guard)
 * Anything else is a BARE unpaginated read → FAIL (silent 1000-row truncation).
 *
 * A genuinely-bounded read that the analyser cannot see (rare) may be added to
 * ALLOWLIST with a written justification — prefer fetchAllRows or an honest
 * `.limit(<=1000)` instead.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "server", "lib"];

// Tables whose completeness matters: money, ledgers, reconciliation, exports,
// and cross-tenant producers/aggregators. A read of one of these that is not a
// single-row lookup MUST page.
const HIGH_VALUE_TABLES = new Set<string>([
  "finances",
  "invoices",
  "invoice_payments",
  "invoice_line_items",
  "quotes",
  "supplier_payments",
  "supplier_payment_allocations",
  "purchase_orders",
  "purchase_order_line_items",
  "goods_received_notes",
  "goods_received_lines",
  "payroll_lines",
  "stock_movements",
  "bank_statement_lines",
  "telematics_connections",
  "telematics_readings",
  "fleet_vehicles",
  "weather_watches",
]);

// "file:line" → reason. Keep tight; every entry is a documented smell.
const ALLOWLIST: Record<string, string> = {};

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes("__tests__")) {
      out.push(p);
    }
  }
}

function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return out;
}

/**
 * Look at the enclosing region around a `.from("TABLE")` read: a window BEFORE
 * (to catch a `fetchAllRows(...)` wrapper, incl. the common multi-statement
 * `let q = supabase.from(...)…; return q.range(lo,hi)` shape) and AFTER (to catch
 * the chain's terminator methods across one `let q = …;` statement boundary).
 * Trades a little precision for not false-positiving paged reads.
 */
function regionAround(src: string, fromIdx: number): string {
  const BEFORE = 300;
  const AFTER = 1100; // wide enough to see the terminator past a long multi-line select list
  return src.slice(Math.max(0, fromIdx - BEFORE), fromIdx + AFTER);
}

describe("F-1 bare-select guard — high-value table reads must page or be single-row", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no bare unpaginated read on a money/ledger/producer table", () => {
    const offenders: string[] = [];
    const fromRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(".from(")) continue;
      const src = stripComments(raw);
      let m: RegExpExecArray | null;
      while ((m = fromRe.exec(src))) {
        const table = m[1];
        if (!table || !HIGH_VALUE_TABLES.has(table)) continue;
        const region = regionAround(src, m.index);
        // Must be a select (writes/upserts/rpc are not truncation-prone reads).
        if (!/\.select\(/.test(region)) continue;
        const bounded =
          /\.single\(/.test(region) ||
          /\.maybeSingle\(/.test(region) ||
          /\.range\(/.test(region) ||
          /\.limit\(/.test(region) ||
          /fetchAllRows/.test(region) || // paged via the helper
          /\.eq\(\s*["'`]id["'`]\s*,/.test(region) || // single-entity read by PK (<=1 row)
          /head:\s*true/.test(region) || // count/head read — returns a count, no rows to truncate
          /count:\s*["'`]exact["'`]/.test(region);
        if (bounded) continue;
        const line = src.slice(0, m.index).split("\n").length;
        const key = `${rel}:${line}`;
        if (ALLOWLIST[key]) continue;
        offenders.push(`${key} → bare .from("${table}").select(...) with no .range/.limit/.single`);
      }
    }
    expect(
      offenders,
      `F-1 bare-select truncation: a high-value-table read materialises a set but is silently ` +
        `capped at PostgREST max_rows (1000). Page it via fetchAllRows (COMPLETE) or make it a ` +
        `single-row read / honest .limit(<=1000):\n` + offenders.join("\n"),
    ).toEqual([]);
  });
});
