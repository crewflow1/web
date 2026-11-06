import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ gate COMPLETENESS — every HQ server action + route handler is gated.
 *
 * The HQ layout (`app/admin/layout.tsx`) calls `requireHqPage()`, which 404s
 * every non-operator. But a Next.js **server action** and a **route handler**
 * do NOT render inside that layout — they are independent server entry points
 * reachable by a direct POST/GET. So layout gating protects the page render and
 * nothing else: each action and each handler must re-assert the HQ gate itself,
 * or it is an open door into service-role (RLS-bypassing) writes.
 *
 * Other suites pin individual files by hand (super-admin-routing, routing-rules,
 * the per-module invariants). None of them proves the property is TOTAL — that
 * there is no ungated action anywhere under the HQ surface, including one added
 * next week. This test enumerates the real filesystem and fails the moment any
 * HQ server action or route handler ships without a gate, so coverage can't rot
 * as the surface grows.
 *
 * Gate signals (any one satisfies an entry):
 *   - `isSuperAdminEmail(` referenced directly in the action/handler body, or
 *   - `requireHqPage(` / `requireHqApi(` (the single-source-of-truth helpers), or
 *   - a call to a local helper whose own body checks `isSuperAdminEmail` (the
 *     `requireAdmin()` / `requireSuperAdmin()` pattern used across HQ).
 *
 * Ordering: where an action both gates AND uses the service-role admin client,
 * the gate must come FIRST (no service-role work before the caller is proven to
 * be an operator).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (abs: string) => readFileSync(abs, "utf8");

/** Collect files matching a predicate under a directory, recursively. */
function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const recurse = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const abs = resolve(d, e.name);
      const rel = abs.slice(ROOT.length + 1);
      if (e.isDirectory()) recurse(abs);
      else if (keep(rel)) out.push(rel);
    }
  };
  recurse(dir);
  return out;
}

/** Names of local (non-exported) helper functions whose body checks the gate. */
function gateHelperNames(src: string): Set<string> {
  const names = new Set<string>();
  const fnRe = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(src))) {
    // Look a bounded distance into the declaration body for the predicate.
    const body = src.slice(m.index, m.index + 600);
    if (m[1] && body.includes("isSuperAdminEmail")) names.add(m[1]);
  }
  // Also arrow-const helpers: `const requireAdmin = async () => { … }`.
  const arrowRe = /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{/g;
  while ((m = arrowRe.exec(src))) {
    const body = src.slice(m.index, m.index + 600);
    if (m[1] && body.includes("isSuperAdminEmail")) names.add(m[1]);
  }
  return names;
}

const DIRECT_GATE = /\b(isSuperAdminEmail|requireHqPage|requireHqApi)\s*\(/;

/** Does this body gate itself — directly, or via a known local helper? */
function bodyIsGated(body: string, helpers: Set<string>): boolean {
  if (DIRECT_GATE.test(body)) return true;
  for (const h of helpers) {
    if (new RegExp(`(?:await\\s+)?${h}\\s*\\(`).test(body)) return true;
  }
  return false;
}

/** Slice a source file into its exported entry-point bodies. */
function entryBodies(
  src: string,
  entryRe: RegExp,
): { name: string; body: string; start: number }[] {
  const starts: { name: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(entryRe.source, "g");
  while ((m = re.exec(src))) starts.push({ name: m[1] ?? "<anon>", idx: m.index });
  return starts.map((s, i) => {
    const next = starts[i + 1];
    return {
      name: s.name,
      start: s.idx,
      body: src.slice(s.idx, next ? next.idx : src.length),
    };
  });
}

// =====================================================================
// 1. Every HQ server action (app/admin/**/actions.ts) is gated.
// =====================================================================

describe("every HQ server action re-asserts the gate", () => {
  const files = walk(resolve(ROOT, "app/admin"), (rel) => rel.endsWith("/actions.ts"));

  it("finds the HQ action files (sanity — the walk is pointed at real code)", () => {
    // If this ever drops to zero the walk is broken and the suite would pass
    // vacuously; keep a floor well under today's count (26).
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it("each file declares 'use server' (these are real action modules)", () => {
    for (const rel of files) {
      expect(read(resolve(ROOT, rel)).slice(0, 40), rel).toMatch(/^["']use server["']/);
    }
  });

  const offenders: string[] = [];
  for (const rel of files) {
    const src = read(resolve(ROOT, rel));
    const helpers = gateHelperNames(src);
    for (const fn of entryBodies(src, /export\s+async\s+function\s+(\w+)/)) {
      if (!bodyIsGated(fn.body, helpers)) offenders.push(`${rel}#${fn.name}`);
    }
  }

  it("no exported action is missing its gate", () => {
    expect(offenders, `UNGATED HQ actions: ${offenders.join(", ")}`).toEqual([]);
  });
});

// =====================================================================
// 2. Every HQ route handler (app/admin/**/route.ts + app/api/hq/**) is gated.
// =====================================================================

describe("every HQ route handler re-asserts the gate", () => {
  const files = [
    ...walk(resolve(ROOT, "app/admin"), (rel) => rel.endsWith("/route.ts")),
    ...walk(resolve(ROOT, "app/api/hq"), (rel) => rel.endsWith("/route.ts")),
  ];

  it("finds the HQ route handlers (sanity)", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  const offenders: string[] = [];
  for (const rel of files) {
    const src = read(resolve(ROOT, rel));
    const helpers = gateHelperNames(src);
    for (const h of entryBodies(
      src,
      /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)/,
    )) {
      if (!bodyIsGated(h.body, helpers)) offenders.push(`${rel}#${h.name}`);
    }
  }

  it("no HQ route handler is missing its gate", () => {
    expect(offenders, `UNGATED HQ route handlers: ${offenders.join(", ")}`).toEqual([]);
  });
});

// =====================================================================
// 3. The gate precedes any service-role (admin-client) work in an action.
// =====================================================================

describe("the HQ gate runs BEFORE any service-role (createAdminClient) use", () => {
  const files = walk(resolve(ROOT, "app/admin"), (rel) => rel.endsWith("/actions.ts"));
  const violations: string[] = [];

  for (const rel of files) {
    const src = read(resolve(ROOT, rel));
    const helpers = gateHelperNames(src);
    for (const fn of entryBodies(src, /export\s+async\s+function\s+(\w+)/)) {
      const adminIdx = fn.body.search(/createAdminClient\s*\(/);
      if (adminIdx === -1) continue; // no service-role use in this action
      // earliest gate position in the body
      const positions: number[] = [];
      const direct = fn.body.search(DIRECT_GATE);
      if (direct !== -1) positions.push(direct);
      for (const h of helpers) {
        const gi = fn.body.search(new RegExp(`(?:await\\s+)?${h}\\s*\\(`));
        if (gi !== -1) positions.push(gi);
      }
      const gateIdx = positions.length ? Math.min(...positions) : -1;
      if (gateIdx === -1 || gateIdx > adminIdx) {
        violations.push(`${rel}#${fn.name}`);
      }
    }
  }

  it("no action touches the admin client before gating", () => {
    expect(
      violations,
      `service-role use before gate in: ${violations.join(", ")}`,
    ).toEqual([]);
  });
});
