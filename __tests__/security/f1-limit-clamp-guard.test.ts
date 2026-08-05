import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * F-1 CLASS GUARD (repo-wide) — no Supabase read may carry `.limit(N)` with
 * N > 1000.
 *
 * WHY: PostgREST clamps every response to `max_rows` (supabase/config.toml = 1000).
 * So `.limit(50000)` / `.limit(MOVEMENT_LIMIT=2000)` silently returns AT MOST
 * 1000 rows — the stated cap is a lie and any aggregate/export/ledger/sweep over
 * it under-reports with NO error. This is the F-1 defect class that recurred
 * across audit waves C28→C30c. The durable fix is this guard: a `.limit(N>1000)`
 * can never be honest, so it is banned outright. The two correct shapes are:
 *   - COMPLETE read  → `fetchAllRows(...)` (pages under the cap), NO `.limit`.
 *   - BOUNDED sample → `.limit(N<=1000)` (honest — you can't get more anyway).
 *
 * This complements the accounting-subsystem guard (f1-pagination-guard.test.ts)
 * with a mechanical, whole-repo net.
 *
 * If a NEW `.limit(N>1000)` is genuinely intentional (it is almost never), it
 * must be added to ALLOWLIST with a written justification — and even then it is
 * still clamped to 1000 at runtime, so prefer fetchAllRows or an honest cap.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "server", "lib"];
const CLAMP = 1000; // PostgREST max_rows

// file (repo-relative) → reason. Keep EMPTY; every entry is a documented smell.
const ALLOWLIST: Record<string, string> = {};

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

/** Numeric consts defined in a file: `const NAME = 12345` (underscores allowed). */
function numericConsts(src: string): Map<string, number> {
  const m = new Map<string, number>();
  const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9][0-9_]*)\b(?!\s*[.eE])/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src))) {
    if (mm[1] && mm[2]) m.set(mm[1], Number(mm[2].replace(/_/g, "")));
  }
  return m;
}

/** Resolve a `.limit(arg)` argument to a number when statically knowable. */
function resolveLimitArg(arg: string, consts: Map<string, number>): number | null {
  const a = arg.trim();
  if (/^[0-9][0-9_]*$/.test(a)) return Number(a.replace(/_/g, ""));
  // `CONST + 1` / `CONST - 1` (e.g. cap probes)
  const addM = /^([A-Za-z_$][\w$]*)\s*([+\-])\s*([0-9]+)$/.exec(a);
  if (addM && addM[1] && consts.has(addM[1])) {
    const base = consts.get(addM[1])!;
    return addM[2] === "+" ? base + Number(addM[3]) : base - Number(addM[3]);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(a) && consts.has(a)) return consts.get(a)!;
  return null; // dynamic (e.g. `.limit(limit)`, `.limit(Math.min(...))`) — not statically a clamp trap
}

describe("F-1 guard — no Supabase read carries .limit(N > 1000)", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it(`scans a non-trivial number of source files`, () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no .limit(<literal or same-file const> > 1000) anywhere", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(".limit(")) continue;
      const src = stripComments(raw);
      const consts = numericConsts(src);
      const re = /\.limit\(\s*([^)]+?)\s*\)/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(src))) {
        const arg = mm[1];
        if (!arg) continue;
        const val = resolveLimitArg(arg, consts);
        if (val !== null && val > CLAMP) {
          const line = src.slice(0, mm.index).split("\n").length;
          if (ALLOWLIST[rel]) continue;
          offenders.push(`${rel}:${line} → .limit(${arg.trim()}) = ${val} (> ${CLAMP})`);
        }
      }
    }
    expect(
      offenders,
      `F-1 clamp trap: .limit(N>1000) is silently capped to 1000 by PostgREST. ` +
        `Use fetchAllRows for a COMPLETE read, or .limit(<=1000) for an honest bounded sample:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
