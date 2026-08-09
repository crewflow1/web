import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

/**
 * STATIC GUARD — every string/template-literal `redirect(...)` base in the
 * operator + portal surface MUST resolve to a REAL page route.
 *
 * THE CLASS (C35, dead-redirect target). A server action's error branch
 * `redirect("/reviews/${id}?error=...")` points one segment too deep: there is
 * no `/reviews/[id]` page, so the user lands on app/(app)/not-found.tsx (a 404)
 * and the `?error=` the branch meant to surface is dropped. The happy branch of
 * the same action correctly targets the LIST route (`/reviews?...`), whose page
 * already renders the error banner. The accounting OAuth callback had this class
 * fixed; the operator error paths were left un-swept — reviews/actions.ts and
 * staff/actions.ts (leave review/cancel) shipped dead error redirects.
 *
 * This guard walks app/ ** /page.tsx to build the set of REAL routes (route
 * groups `(x)` stripped, `[x]` -> wildcard, `[...x]` -> catch-all), then checks
 * every literal redirect base in the target dirs resolves to one of them. It
 * was calibrated RED against the pre-fix `/reviews/[id]` + `/staff/leave/[id]`
 * redirects and GREEN after they were pointed at the list routes.
 *
 * Genuinely dynamic targets are NOT allowlisted by name — they pass because
 * their `[id]`/`[token]` route actually exists (e.g. `/jobs/${id}` resolves to
 * app/(app)/jobs/[id]/page.tsx). A template expression glued onto a literal
 * segment (a query string like `/customer-portal/${token}/requests${qs}`) is
 * treated as the literal segment plus a query, matching the real route.
 */

const ROOT = resolve(__dirname, "..", "..");
const APP = resolve(ROOT, "app");

// ---- build the set of real page routes ----
function walkPages(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walkPages(p, acc);
    else if (name === "page.tsx" || name === "page.ts") acc.push(p);
  }
  return acc;
}
function routeOf(pageFile: string): string {
  const relDir = relative(APP, pageFile).replace(/\/page\.tsx?$/, "");
  const kept: string[] = [];
  for (const s of relDir.split("/").filter(Boolean)) {
    if (/^\(.*\)$/.test(s)) continue; // route group — not a URL segment
    if (/^\[\[?\.\.\..*\]\]?$/.test(s)) { kept.push("**"); continue; } // catch-all
    if (/^\[.*\]$/.test(s)) { kept.push("*"); continue; } // dynamic
    kept.push(s);
  }
  return "/" + kept.join("/");
}
const REAL_ROUTES = new Set(walkPages(APP).map(routeOf));

// ---- normalize a redirect base to a comparable path ----
// A `${...}` that IS a whole segment -> "*" (dynamic). A `${...}` glued onto a
// literal (a trailing query string / suffix) -> stripped to the literal part.
// A literal `?`/`#` query/hash on a segment is stripped.
function normalize(base: string): string | null {
  if (/^[a-z]+:/i.test(base) || base.startsWith("//")) return null; // external / mailto
  if (!base.startsWith("/")) return null; // relative — Next resolves against current URL
  const out: string[] = [];
  const segs = base.split("/");
  for (let i = 1; i < segs.length; i++) {
    const seg = (segs[i] ?? "").split("?")[0]!.split("#")[0]!;
    if (seg === "") continue;
    const hadExpr = /\$\{/.test(seg);
    const literal = seg.replace(/\$\{[^}]*\}/g, "");
    out.push(hadExpr && literal === "" ? "*" : literal);
  }
  return "/" + out.join("/");
}
function resolves(candidate: string): boolean {
  if (REAL_ROUTES.has(candidate)) return true;
  const cs = candidate.split("/");
  for (const r of REAL_ROUTES) {
    const rs = r.split("/");
    const catchAll = rs.includes("**");
    if (!catchAll && rs.length !== cs.length) continue;
    let ok = true;
    for (let i = 0; i < rs.length; i++) {
      const rSeg = rs[i];
      if (rSeg === "**") { ok = true; break; }
      if (rSeg === "*") { if (cs[i] === undefined) { ok = false; break; } continue; }
      if (rSeg !== cs[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ---- collect literal redirect() bases across the operator + portal surface ----
const TARGET_DIRS = ["app/(app)", "app/q", "app/customer-portal"];
function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) collect(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}
// Drop comments so a redirect mentioned in prose (e.g. this file's own docs, or
// a "// was /reviews/${id}" note) is never scanned as executable code.
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const REDIRECT_RE = /\bredirect\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;

type Site = { file: string; line: number; base: string; norm: string };
function deadRedirects(): Site[] {
  const dead: Site[] = [];
  for (const d of TARGET_DIRS) {
    for (const f of collect(resolve(ROOT, d))) {
      const code = codeOf(readFileSync(f, "utf8"));
      let m: RegExpExecArray | null;
      while ((m = REDIRECT_RE.exec(code))) {
        const base = (m[1] ?? "").slice(1, -1);
        const norm = normalize(base);
        if (norm === null) continue; // external / relative — not our concern
        if (!resolves(norm)) {
          dead.push({
            file: relative(ROOT, f),
            line: code.slice(0, m.index).split("\n").length,
            base,
            norm,
          });
        }
      }
    }
  }
  return dead;
}

describe("redirect targets resolve to real routes", () => {
  it("discovers a non-trivial route + redirect surface (guard self-check)", () => {
    // Fail loud if the walkers silently found nothing (a moved app/ dir, etc.)
    expect(REAL_ROUTES.size).toBeGreaterThan(100);
    expect(REAL_ROUTES.has("/reviews")).toBe(true);
    expect(REAL_ROUTES.has("/staff/leave")).toBe(true);
    // The known-good dynamic route must resolve, proving wildcard matching works.
    expect(resolves("/jobs/*")).toBe(true);
  });

  it("has NO redirect() whose base points at a non-existent route", () => {
    const dead = deadRedirects();
    const report = dead
      .map((d) => `  ${d.file}:${d.line}  redirect('${d.base}')  →  ${d.norm} (no route)`)
      .join("\n");
    expect(dead, `Dead redirect targets found:\n${report}`).toEqual([]);
  });

  it("still flags the pre-fix dead shapes if they return (calibration)", () => {
    // Prove the matcher is genuinely RED on the exact pre-fix bases, so a
    // regression to `/reviews/[id]` or `/staff/leave/[id]` cannot slip past.
    expect(resolves(normalize("/reviews/${id}?error=no_email")!)).toBe(false);
    expect(resolves(normalize("/staff/leave/${requestId}?error=review_failed")!)).toBe(
      false,
    );
    // And the fixed list targets DO resolve.
    expect(resolves(normalize("/reviews?error=no_email")!)).toBe(true);
    expect(resolves(normalize("/staff/leave?error=review_failed")!)).toBe(true);
  });
});
