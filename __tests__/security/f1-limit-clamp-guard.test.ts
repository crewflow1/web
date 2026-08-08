import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * F-1 CLASS GUARD (repo-wide, FAIL-CLOSED) — no Supabase read may carry a
 * `.limit(<arg>)` that is not STATICALLY PROVABLE as <= 1000, nor a
 * `.range(from, to)` whose literal window exceeds 1000 rows.
 *
 * WHY: PostgREST clamps every response to `max_rows` (supabase/config.toml =
 * 1000). So `.limit(50000)` / `.limit(MOVEMENT_LIMIT=5000)` silently returns AT
 * MOST 1000 rows — the stated cap is a lie and any aggregate / export / ledger /
 * balance-fold / sweep over it under-reports with NO error. This is the F-1
 * defect class that recurred across audit waves C28→C35. The durable fix is this
 * guard. The only two HONEST read shapes are:
 *   - COMPLETE read  → `fetchAllRows(...)` (pages under the cap), NO `.limit`.
 *   - BOUNDED sample → `.limit(N<=1000)` (honest — you can't get more anyway).
 *
 * FAIL-CLOSED (the C35 hardening). The earlier version only flagged a `.limit`
 * arg it could PROVE was > 1000 (a literal, or a same-file numeric const). That
 * left three silent holes, each of which had shipped a live truncation:
 *   - coalescing / expression args — `.limit(opts.limit ?? CONST)`,
 *     `.limit(x ?? 500)`, `.limit(a || N)`: the dynamic side can be > 1000, so
 *     the read can silently truncate. (This is exactly how the pre-C35 stock
 *     balance-fold hid `.limit(opts.limit ?? STOCK_MOVEMENT_LIMIT)`, 5000.)
 *   - imported / cross-file consts — the arg resolves to nothing in THIS file,
 *     so its size is unknown here.
 *   - `.range(from, to)` windows > 1000 — a paging window that itself exceeds
 *     the clamp.
 * So the rule is inverted: an arg is allowed ONLY when a PROVABLE UPPER BOUND
 * <= 1000 can be computed from literals + same-file consts + `Math.min(...)`
 * (which is <= any one of its args). Everything else FAILS unless ALLOWLISTed
 * with a written justification.
 *
 * DELIBERATELY STILL GREEN (provably bounded, not traps):
 *   - `.limit(1)`, `.limit(500)`, `.limit(STOCK_ITEM_LIMIT)` (const = 1000)
 *   - `.limit(Math.min(x, 50))`, `.limit(Math.min(Math.max(limit, 1), 200))`
 *     — a min with a literal/const <= 1000 can never exceed it
 *   - a same-file `const capped = Math.min(Math.max(limit, 1), 50)` then
 *     `.limit(capped)` — the local is resolved to its Math.min bound
 *   - `.limit(CONST - 1)` / `.limit(CONST + 1)` when the result is <= 1000
 *
 * This complements the accounting-subsystem guard (f1-pagination-guard.test.ts)
 * with a mechanical, whole-repo net, plus a targeted high-value paging assertion
 * below (payroll / stock / money-ledger reads must page, never read bare).
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "server", "lib"];
const CLAMP = 1000; // PostgREST max_rows

/**
 * file (repo-relative) → written justification. Keep as SMALL as possible;
 * every entry is a documented smell that is STILL clamped to 1000 at runtime.
 * An entry here means "this `.limit`/`.range` is unprovable statically but has
 * been human-verified safe". Prefer fetchAllRows or a provable `.limit(<=1000)`.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * THE .limit(1000) BOUNDARY net (companion to the bare-select guard's boundary
 * rule). A `.limit(N<=1000)` is "honest" to the clamp sweep above — but a
 * `.limit` resolving to EXACTLY 1000 on a HIGH-VALUE / PRODUCER read is
 * indistinguishable from silent truncation: a genuine top-1000 sample and a
 * 5000-row set clamped to 1000 look identical. That is exactly how the LIVE
 * invoice.overdue producer scan starved — `.limit(1000)` sat on the boundary and
 * passed both F-1 guards. So such a read must page via fetchAllRows (COMPLETE) or
 * be allowlisted as a genuinely-bounded top-1000 display sample WITH a reason.
 *
 * Mirrors the bare-select guard's HIGH_VALUE_TABLES: money / ledger /
 * reconciliation / export / cross-tenant producer tables whose completeness
 * matters.
 */
const PRODUCER_TABLES = new Set<string>([
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
  "time_entries",
  "quote_line_items",
  "stock_movements",
  "bank_statement_lines",
  "telematics_connections",
  "telematics_readings",
  "fleet_vehicles",
  "weather_watches",
  "weather_readings",
]);

/** "file:line" → reason. Only GENUINELY-bounded top-1000 samples belong here.
 * The overdue producer scan is DELIBERATELY absent: it is the real offender and
 * was fixed by paging (fetchAllRows), not allowlisted. */
const BOUNDARY_ALLOWLIST: Record<string, string> = {
  // countPostedReceipts: `.in("purchase_order_id", purchaseOrderIds)` where
  // purchaseOrderIds is ONE purchase-orders list page's POs (itself paginated,
  // tens of rows), each carrying a handful of posted GRNs — the materialised set
  // is bounded well below the cap by the page, not a standing backlog.
  "app/(app)/purchase-orders/_receiving-data.ts:99":
    "bounded: delivery counts for ONE list page's POs (.in(purchaseOrderIds), page is tens of POs × few GRNs) — well below the 1000 cap",
  // material-fulfilment: both reads are `.in(<one material request's line/id set>)`
  // scoped to a single request's issue movements + their corrections — bounded by
  // the request size (a handful to dozens of lines), never a standing backlog.
  "server/services/material-fulfilment.ts:125":
    "bounded: stock issue movements for ONE material request (.in(lineIds)) — request-sized, well below 1000",
  "server/services/material-fulfilment.ts:150":
    "bounded: correction movements for ONE request's issued set (.in(rows.map(id))) — request-sized, well below 1000",
  // sites/van-stock: per-ORG fleet_vehicles scans (.eq(org_id)) for site-usage
  // counts / a van picker. An SME org's fleet is tens of vehicles, not thousands.
  "server/services/sites.ts:159":
    "bounded: per-org fleet_vehicles count sample (.eq(org_id)) — an org's fleet is tens of vehicles",
  "server/services/van-stock.ts:105":
    "bounded: per-org fleet_vehicles picker (.eq(org_id)) — an org's fleet is tens of vehicles",
};

/** Strip block + line comments so historical `.limit(...)` mentions in prose
 * don't count. Replaces comment bodies with same-length blanks to keep line
 * numbers accurate. */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return out;
}

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

/**
 * Extract the balanced-paren argument string for every `<method>(` call, so a
 * nested `Math.min(Math.max(a, 1), 50)` is captured WHOLE rather than truncated
 * at the first `)`. Returns [{ arg, index }] where index points at the method.
 */
function extractCalls(src: string, method: string): Array<{ arg: string; index: number }> {
  const out: Array<{ arg: string; index: number }> = [];
  const marker = `.${method}(`;
  let i = 0;
  while ((i = src.indexOf(marker, i)) !== -1) {
    // Ensure it's a real method call (`.limit(`) and not a substring like
    // `.delimit(` — require the char before `.` to not be an identifier char.
    const before = src[i - 1] ?? " ";
    if (/[A-Za-z0-9_$]/.test(before)) {
      i += marker.length;
      continue;
    }
    let depth = 0;
    let j = i + marker.length - 1; // at the '('
    const start = j + 1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ arg: src.slice(start, j).trim(), index: i });
    i = j + 1;
  }
  return out;
}

/** Split a call-argument list on TOP-LEVEL commas (respecting nested parens). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Same-file numeric consts/lets: `const NAME = 12345` (underscores allowed). */
function numericConsts(src: string): Map<string, number> {
  const m = new Map<string, number>();
  const re = /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9][0-9_]*)\b(?!\s*[.eE])/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src))) {
    if (mm[1] && mm[2]) m.set(mm[1], Number(mm[2].replace(/_/g, "")));
  }
  return m;
}

/**
 * Compute a PROVABLE UPPER BOUND for an expression using the env of resolved
 * numeric identifiers, or return null when no static upper bound is knowable.
 *
 *   - numeric literal            → its value
 *   - identifier in env          → its bound
 *   - Math.min(a, b, ...)        → the SMALLEST finite bound among the args
 *                                  (min <= any single arg; one bounded arg is
 *                                  enough to bound the whole call)
 *   - Math.max(a, b, ...)        → max of bounds, but ALL args must be bounded
 *   - `A + k` / `A - k` / `A * k` (k a literal int) → arithmetic on bound(A)
 *   - everything else (`x ?? N`, `a || b`, `input.limit`, a bare dynamic
 *     identifier, a call) → null (UNPROVABLE)
 */
function provableUpperBound(expr: string, env: Map<string, number>): number | null {
  let a = expr.trim();
  // Peel a single fully-enclosing paren pair: `(Math.min(...))`.
  while (a.startsWith("(") && a.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let k = 0; k < a.length; k++) {
      if (a[k] === "(") depth++;
      else if (a[k] === ")") {
        depth--;
        if (depth === 0 && k < a.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (wraps) a = a.slice(1, -1).trim();
    else break;
  }

  if (/^[0-9][0-9_]*$/.test(a)) return Number(a.replace(/_/g, ""));
  if (/^[A-Za-z_$][\w$]*$/.test(a)) return env.has(a) ? env.get(a)! : null;

  const minM = /^Math\.min\((.*)\)$/s.exec(a);
  if (minM) {
    const bounds = splitArgs(minM[1]!).map((x) => provableUpperBound(x, env));
    const finite = bounds.filter((b): b is number => b !== null);
    return finite.length ? Math.min(...finite) : null;
  }
  const maxM = /^Math\.max\((.*)\)$/s.exec(a);
  if (maxM) {
    const bounds = splitArgs(maxM[1]!).map((x) => provableUpperBound(x, env));
    return bounds.every((b) => b !== null) ? Math.max(...(bounds as number[])) : null;
  }

  // `A <op> k` with k a trailing literal (e.g. `MAX_ROWS_PER_TABLE + 1`).
  const bin = /^(.+?)\s*([+\-*])\s*([0-9][0-9_]*)$/s.exec(a);
  if (bin) {
    const base = provableUpperBound(bin[1]!, env);
    if (base === null) return null;
    const k = Number(bin[3]!.replace(/_/g, ""));
    return bin[2] === "+" ? base + k : bin[2] === "-" ? base - k : base * k;
  }
  return null; // `??`, `||`, member access, calls, etc. — unprovable
}

/** Build the identifier env: numeric consts, then `const X = Math.min(...)`. */
function buildEnv(src: string): Map<string, number> {
  const env = numericConsts(src);
  // Resolve `const/let NAME = <expr>` where <expr> has a provable bound and is
  // NOT already a bare numeric literal (those are in numericConsts). This greens
  // the `const capped = Math.min(Math.max(limit, 1), 50)` idiom.
  const re = /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src))) {
    const name = mm[1]!;
    const rhs = mm[2]!.trim();
    if (env.has(name)) continue;
    if (/^[0-9]/.test(rhs)) continue;
    const b = provableUpperBound(rhs, env);
    if (b !== null) env.set(name, b);
  }
  return env;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every high-value read in a file, covering the literal `.from("table")` form
 * AND the `.from`-wrapper indirection (arrow OR function-declaration wrapper —
 * e.g. `function table<T>(c, name) { return c.from(name) }` then
 * `table<...>(client, "table")`), which the literal scan is blind to. Returns
 * [{ table, index }] where index anchors the read for line reporting + region.
 */
function producerReadIndices(src: string): Array<{ table: string; index: number }> {
  const out: Array<{ table: string; index: number }> = [];

  const fromRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) out.push({ table: m[1]!, index: m.index });

  const wrapperNames = new Set<string>();
  const arrowRe =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=;]*?)?=>\s*[^;{}]*?\.from\(/g;
  const fnRe =
    /function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*\{[\s\S]{0,400}?\.from\(/g;
  let wm: RegExpExecArray | null;
  while ((wm = arrowRe.exec(src))) if (wm[1]) wrapperNames.add(wm[1]);
  while ((wm = fnRe.exec(src))) if (wm[1]) wrapperNames.add(wm[1]);
  for (const name of wrapperNames) {
    // `table<...>(client, "table")` — allow an optional generic before the call.
    const callRe = new RegExp(
      escapeReg(name) + `(?:<[^()]*?>)?\\s*\\(\\s*[^,()]+,\\s*["'\`]([a-z_]+)["'\`]\\s*\\)`,
      "g",
    );
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(src))) out.push({ table: cm[1]!, index: cm.index });
  }
  return out;
}

/** Boundary offenders in one file: a high-value read materialising a set, capped
 * at EXACTLY .limit(1000) (literal or same-file const), that neither pages
 * (.range/fetchAllRows) nor is allowlisted.
 *
 * LIMIT-ANCHORED (not region-scanned): each boundary `.limit()` is bound to the
 * NEAREST PRECEDING `.from`/wrapper read in the SAME statement (no intervening
 * `;`). A pure region window bled a `.limit(1000)` onto an adjacent read and
 * misreported the line — anchoring on the limit is exact. */
function boundaryOffendersIn(rel: string, raw: string): string[] {
  if (!raw.includes(".limit(")) return [];
  const src = stripComments(raw);
  const env = buildEnv(src);
  // Producer reads sorted by position so we can find the nearest preceding one.
  const reads = producerReadIndices(src).sort((a, b) => a.index - b.index);
  const offenders = new Set<string>();

  for (const { arg, index: limIdx } of extractCalls(src, "limit")) {
    if (provableUpperBound(arg, env) !== CLAMP) continue; // not on the boundary
    // Nearest producer read whose `.from`/wrapper starts before this `.limit`.
    let pRead: { table: string; index: number } | undefined;
    for (const r of reads) {
      if (r.index < limIdx) pRead = r;
      else break;
    }
    if (!pRead) continue;
    const between = src.slice(pRead.index, limIdx);
    if (between.includes(";")) continue; // the limit is a DIFFERENT statement
    if (!PRODUCER_TABLES.has(pRead.table)) continue;
    if (!/\.select\(/.test(between)) continue; // reads only
    if (/\.range\(/.test(between)) continue; // windowed, not a flat cap
    const line = src.slice(0, pRead.index).split("\n").length;
    const key = `${rel}:${line}`;
    if (BOUNDARY_ALLOWLIST[key]) continue;
    offenders.add(
      `${key} → .from("${pRead.table}") read capped at exactly .limit(${CLAMP}) — ` +
        `page via fetchAllRows or add a BOUNDARY_ALLOWLIST reason`,
    );
  }
  return [...offenders];
}

describe("F-1 guard — every .limit / .range is provably <= 1000", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it(`scans a non-trivial number of source files`, () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no .limit(<arg>) unless a provable upper bound <= 1000", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(".limit(")) continue;
      const src = stripComments(raw);
      const env = buildEnv(src);
      for (const { arg, index } of extractCalls(src, "limit")) {
        if (!arg) continue;
        const bound = provableUpperBound(arg, env);
        if (bound !== null && bound <= CLAMP) continue; // provably honest
        if (ALLOWLIST[rel]) continue;
        const line = src.slice(0, index).split("\n").length;
        const why =
          bound === null
            ? `NOT statically provable <= ${CLAMP} (dynamic / coalescing / imported)`
            : `= ${bound} (> ${CLAMP})`;
        offenders.push(`${rel}:${line} → .limit(${arg}) ${why}`);
      }
    }
    expect(
      offenders,
      `F-1 clamp trap. A .limit() is silently capped to ${CLAMP} by PostgREST, so ` +
        `an arg that can exceed ${CLAMP} — or that can't be PROVEN <= ${CLAMP} here — ` +
        `can silently truncate. Use fetchAllRows for a COMPLETE read, or a provable ` +
        `.limit(<=${CLAMP}) (e.g. Math.min(x, ${CLAMP})) for an honest bounded sample:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("no .range(from, to) with a literal window > 1000", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(".range(")) continue;
      const src = stripComments(raw);
      for (const { arg, index } of extractCalls(src, "range")) {
        const parts = splitArgs(arg);
        if (parts.length !== 2) continue;
        const from = parts[0]!.trim();
        const to = parts[1]!.trim();
        if (!/^[0-9][0-9_]*$/.test(from) || !/^[0-9][0-9_]*$/.test(to)) continue; // dynamic (fetchAllRows) — fine
        const window = Number(to.replace(/_/g, "")) - Number(from.replace(/_/g, "")) + 1;
        if (window <= CLAMP) continue;
        if (ALLOWLIST[rel]) continue;
        const line = src.slice(0, index).split("\n").length;
        offenders.push(`${rel}:${line} → .range(${from}, ${to}) window = ${window} (> ${CLAMP})`);
      }
    }
    expect(
      offenders,
      `F-1 clamp trap: a .range() window wider than ${CLAMP} rows is truncated by ` +
        `PostgREST. Page it with fetchAllRows (pages of <=${CLAMP}):\n` + offenders.join("\n"),
    ).toEqual([]);
  });

  it("no high-value/producer read capped at exactly .limit(1000) (page or allowlist)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...boundaryOffendersIn(rel, readFileSync(file, "utf8")));
    }
    expect(
      offenders,
      `F-1 .limit(1000) BOUNDARY trap. A high-value/producer read capped at EXACTLY ` +
        `the PostgREST clamp is indistinguishable from silent truncation (a genuine ` +
        `top-1000 sample vs a larger set clamped to 1000 look identical). Page it via ` +
        `fetchAllRows for a COMPLETE read, or add a BOUNDARY_ALLOWLIST entry with a ` +
        `written reason if it is a genuinely-bounded top-1000 sample:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // TEETH: the boundary net must flag the exact live shape (the invoice.overdue
  // producer scan) and go green on the paged fix — literal AND same-file const.
  it("boundary net has TEETH: flags a producer scan at exactly .limit(1000), passes when paged", () => {
    const litPreFix = [
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .lt("due_date", todayIso)`,
      `  .limit(1000);`,
    ].join("\n");
    expect(boundaryOffendersIn("lib/invoices/overdue-scheduler.ts", litPreFix).length).toBeGreaterThan(0);

    const constPreFix = [
      `const SCAN_LIMIT = 1000;`,
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .lt("due_date", todayIso)`,
      `  .limit(SCAN_LIMIT);`,
    ].join("\n");
    expect(boundaryOffendersIn("lib/invoices/overdue-scheduler.ts", constPreFix).length).toBeGreaterThan(0);

    // The COMPLETE-read fix pages via fetchAllRows → clean.
    const pagedFix = [
      `const { data, error } = await fetchAllRows((from, to) =>`,
      `  admin`,
      `    .from("invoices")`,
      `    .select("id, org_id")`,
      `    .lt("due_date", todayIso)`,
      `    .order("due_date", { ascending: true })`,
      `    .order("id", { ascending: true })`,
      `    .range(from, to),`,
      `);`,
    ].join("\n");
    expect(boundaryOffendersIn("lib/invoices/overdue-scheduler.ts", pagedFix)).toEqual([]);

    // An honest sub-cap sample is NOT a boundary trap.
    const honest = [
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .limit(500);`,
    ].join("\n");
    expect(boundaryOffendersIn("lib/invoices/overdue-scheduler.ts", honest)).toEqual([]);

    // Catches the function-declaration `.from`-wrapper form too (the shape the
    // goods_received_notes reader uses), not just literal `.from`.
    const wrapperPreFix = [
      `function table<T>(supabase, name) { return supabase.from(name); }`,
      `const { data } = await table<{ purchase_order_id: string }>(supabase, "goods_received_notes")`,
      `  .select("purchase_order_id")`,
      `  .eq("status", "posted")`,
      `  .limit(1000);`,
    ].join("\n");
    expect(boundaryOffendersIn("x.ts", wrapperPreFix).some((o) => o.includes("goods_received_notes"))).toBe(true);
  });

  // Self-test: the hardened resolver must actually catch the shapes the old
  // guard missed — otherwise a green suite proves nothing.
  it("resolver rejects the exact shapes the pre-C35 guard missed", () => {
    const env = new Map<string, number>([
      ["STOCK_MOVEMENT_LIMIT", 5000],
      ["STOCK_ITEM_LIMIT", 1000],
      ["SMALL", 200],
    ]);
    // coalescing (the pre-fix stock balance-fold) — dynamic side unprovable
    expect(provableUpperBound("opts.limit ?? STOCK_MOVEMENT_LIMIT", env)).toBeNull();
    expect(provableUpperBound("opts.limit ?? STOCK_ITEM_LIMIT", env)).toBeNull();
    expect(provableUpperBound("x ?? 500", env)).toBeNull();
    expect(provableUpperBound("a || 250", env)).toBeNull();
    // bare dynamic / member access
    expect(provableUpperBound("limit", env)).toBeNull();
    expect(provableUpperBound("input.limit", env)).toBeNull();
    // same-file const over the clamp
    expect(provableUpperBound("STOCK_MOVEMENT_LIMIT", env)).toBe(5000);
    // provably-safe shapes stay green
    expect(provableUpperBound("1", env)).toBe(1);
    expect(provableUpperBound("STOCK_ITEM_LIMIT", env)).toBe(1000);
    expect(provableUpperBound("Math.min(limit, 1000)", env)).toBe(1000);
    expect(provableUpperBound("Math.min(Math.max(limit, 1), 50)", env)).toBe(50);
    expect(provableUpperBound("Math.min(opts.limit ?? STOCK_MOVEMENT_LIMIT, 1000)", env)).toBe(1000);
    expect(provableUpperBound("MAX + 1", new Map([["MAX", 999]]))).toBe(1000);
  });

  // High-value paging tripwire: the money / balance-ledger reads MUST page via
  // fetchAllRows, never read a single (truncatable) bare page. This catches the
  // "no .limit at all" bare-select F-1 that the .limit sweep above can't see.
  it("known money / balance ledger reads page via fetchAllRows", () => {
    const failures: string[] = [];
    const mustPage: Array<{ file: string; needle: string }> = [
      { file: "app/(app)/payroll/[id]/page.tsx", needle: `.from("payroll_lines")` },
      { file: "app/api/payroll/[id]/csv/route.ts", needle: `.from("payroll_lines")` },
      { file: "app/(app)/payroll/page.tsx", needle: `.from("payroll_lines")` },
      { file: "app/(app)/tax/page.tsx", needle: `.from("payroll_lines")` },
    ];
    for (const { file, needle } of mustPage) {
      const src = stripComments(readFileSync(resolve(ROOT, file), "utf8"));
      if (!src.includes(needle)) {
        failures.push(`${file}: expected read ${needle} not found (moved? update this guard)`);
        continue;
      }
      if (!src.includes("fetchAllRows")) {
        failures.push(`${file}: reads ${needle} but does NOT page via fetchAllRows — F-1 bare-read risk`);
      }
    }
    // stock: the BALANCE-FOLD read (listStockMovements) must page; the bounded
    // grn-line lookup in the same file legitimately does not, so scope to the fn.
    const stockSrc = stripComments(
      readFileSync(resolve(ROOT, "server/services/stock.ts"), "utf8"),
    );
    const fnStart = stockSrc.indexOf("export async function listStockMovements");
    const fnBody =
      fnStart === -1
        ? ""
        : stockSrc.slice(fnStart, stockSrc.indexOf("\nexport ", fnStart + 1));
    if (fnStart === -1) {
      failures.push("server/services/stock.ts: listStockMovements not found (renamed?)");
    } else if (!fnBody.includes("fetchAllRows")) {
      failures.push(
        "server/services/stock.ts: listStockMovements (the balance-fold input) must page via fetchAllRows",
      );
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
