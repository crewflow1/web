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
  // Hours source for payroll: a clamped read UNDERSTATES gross/PAYE/NI/net pay
  // for a >1000-entry month (createPayrollRun), and cross-tenant (RLS admits
  // every org the caller belongs to).
  "time_entries",
  // Quote line items: a clamped read serves a quote PDF / builder / portal view
  // with totals but only the first 1000 lines — and the builder re-save would
  // then wipe the dropped lines.
  "quote_line_items",
  "stock_movements",
  "bank_statement_lines",
  "telematics_connections",
  "telematics_readings",
  "fleet_vehicles",
  "weather_watches",
  "weather_readings",
]);

// "file:line" → reason. Keep tight; every entry is a documented smell.
const ALLOWLIST: Record<string, string> = {
  // Surfaced only once the guard learned to see the `table()` `.from`-wrapper
  // indirection (below). The read is GENUINELY BOUNDED, just not in a way the
  // static analyser can see: `.in("id", idsChunk)` where `idsChunk` is
  // `paymentIds.slice(i, i + JOIN_CHUNK)` with JOIN_CHUNK=500, and
  // supplier_payments.id is unique — so each call returns ≤500 rows, below the
  // 1000 cap. The snapshot set it joins is itself fully paged (listMonthSnapshots
  // above). Prefer fetchAllRows/.limit only if this ever stops being chunked.
  "server/services/cis-statements.ts:169":
    "bounded: chunked .in('id', slice(≤500 unique PKs)) — ≤500 rows, analyser can't see the slice bound",
  // Surfaced only once quote_line_items joined HIGH_VALUE_TABLES. This line is an
  // INSERT (`.from('quote_line_items').insert(rows)`), NOT a read — it cannot
  // truncate. It trips solely as a region artifact: the AFTER window bleeds into
  // the adjacent, fully-bounded `leads` `.select('status')…maybeSingle()`, whose
  // `.maybeSingle()`/`.eq('id')` bound markers fall just past the 1100-char cap.
  "app/(app)/quotes/actions.ts:192":
    "not a read: `.from('quote_line_items').insert(rows)` — flagged only because the region bleeds into an adjacent bounded leads .select whose bound falls outside the window. (Line moved 178→192 when verifyQuoteReferences was added to createQuote in 20261113000000.)",
};

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

/** A `.from`-wrapping local helper defeats a literal `.from("TABLE")` scan.
 *
 * weather-fetch.ts hid its F-1 truncation exactly this way: a local
 *   `const table = (c, name) => c.from(name)`
 * turned every read into `table(admin, "weather_watches")`, which the literal
 * `.from("...")` regex never matched — the guard was structurally blind to it.
 *
 * So we ALSO find such wrappers in each file and treat `wrapper(<x>, "TABLE")`
 * as if it were `.from("TABLE")`: an arrow (or function) whose body calls
 * `<something>.from(<param>)` is a `.from` wrapper, and its call sites are
 * indirect reads that must satisfy the same paged/single-row/count rule.
 */
const WRAPPER_DEF_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=;]*?)?=>\s*[^;{}]*?\.from\(/g;

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedRegion(region: string): boolean {
  return (
    /\.single\(/.test(region) ||
    /\.maybeSingle\(/.test(region) ||
    /\.range\(/.test(region) ||
    /\.limit\(/.test(region) ||
    /fetchAllRows/.test(region) || // paged via the helper
    /\.eq\(\s*["'`]id["'`]\s*,/.test(region) || // single-entity read by PK (<=1 row)
    /head:\s*true/.test(region) || // count/head read — returns a count, no rows to truncate
    /count:\s*["'`]exact["'`]/.test(region)
  );
}

/**
 * Every bare-select F-1 offender in one file's (raw) source, covering BOTH the
 * literal `.from("TABLE")` form and the `.from`-wrapper indirection form. Shared
 * by the repo-wide scan and the "would have caught the pre-fix weather-fetch"
 * regression proof, so both exercise identical detection.
 */
function offendersIn(rel: string, raw: string): string[] {
  if (!raw.includes(".from(")) return [];
  const src = stripComments(raw);
  const offenders: string[] = [];

  const consider = (table: string | undefined, index: number, shape: string): void => {
    if (!table || !HIGH_VALUE_TABLES.has(table)) return;
    const region = regionAround(src, index);
    // Must be a select (writes/upserts/rpc are not truncation-prone reads).
    if (!/\.select\(/.test(region)) return;
    if (boundedRegion(region)) return;
    const line = src.slice(0, index).split("\n").length;
    const key = `${rel}:${line}`;
    if (ALLOWLIST[key]) return;
    offenders.push(`${key} → bare ${shape} with no .range/.limit/.single`);
  };

  // 1. The direct form: `.from("high_value_table").select(...)`.
  const fromRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) consider(m[1], m.index, `.from("${m[1]}").select(...)`);

  // 2. The indirection form: a local `.from` wrapper + `wrapper(<x>, "table")`.
  const wrapperNames = new Set<string>();
  let wm: RegExpExecArray | null;
  WRAPPER_DEF_RE.lastIndex = 0;
  while ((wm = WRAPPER_DEF_RE.exec(src))) if (wm[1]) wrapperNames.add(wm[1]);
  for (const name of wrapperNames) {
    // `table(admin, "weather_watches")` — 2nd arg is the table-name literal.
    const callRe = new RegExp(escapeReg(name) + `\\(\\s*[^,()]+,\\s*["'\`]([a-z_]+)["'\`]\\s*\\)`, "g");
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(src))) {
      consider(cm[1], cm.index, `${name}(<client>, "${cm[1]}") [.from wrapper].select(...)`);
    }
  }

  return offenders;
}

describe("F-1 bare-select guard — high-value table reads must page or be single-row", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no bare unpaginated read on a money/ledger/producer table (direct OR .from-wrapper)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...offendersIn(rel, readFileSync(file, "utf8")));
    }
    expect(
      offenders,
      `F-1 bare-select truncation: a high-value-table read materialises a set but is silently ` +
        `capped at PostgREST max_rows (1000). Page it via fetchAllRows (COMPLETE) or make it a ` +
        `single-row read / honest .limit(<=1000):\n` + offenders.join("\n"),
    ).toEqual([]);
  });

  it("has TEETH: catches the pre-fix weather-fetch reads through the table() wrapper", () => {
    // The exact shape weather-fetch.ts shipped before this fix: a `.from` wrapper
    // plus two bare, unpaginated reads. The literal `.from("...")` scan alone was
    // blind to it; the hardened guard must flag BOTH reads.
    const preFix = [
      `const table = (c, name) => c.from(name);`,
      `const watches = await table(admin, "weather_watches")`,
      `  .select("postcode_district")`,
      `  .eq("active", true);`,
      `const recent = await table(admin, "weather_readings")`,
      `  .select("postcode_district, kind, fetched_at")`,
      `  .in("postcode_district", districts);`,
    ].join("\n");
    const flagged = offendersIn("server/services/weather-fetch.ts", preFix);
    expect(flagged.some((o) => o.includes("weather_watches"))).toBe(true);
    expect(flagged.some((o) => o.includes("weather_readings"))).toBe(true);
  });

  it("does not false-positive a PAGED .from-wrapper read (the post-fix shape)", () => {
    const postFix = [
      `const table = (c, name) => c.from(name);`,
      `const watchesRes = await fetchAllRows((from, to) =>`,
      `  table(admin, "weather_watches")`,
      `    .select("postcode_district")`,
      `    .eq("active", true)`,
      `    .order("id", { ascending: true })`,
      `    .range(from, to),`,
      `);`,
    ].join("\n");
    expect(offendersIn("server/services/weather-fetch.ts", postFix)).toEqual([]);
  });
});
