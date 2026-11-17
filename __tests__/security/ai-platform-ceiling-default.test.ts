import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The CrewFlow-wide AI ceiling (one budget across every company, user and AI feature)
 * is £100 per Europe/London month — FINAL founder decision, 2026-11-17. It is enforced
 * inside ai_reserve_invocation on top of the per-company and per-user limits, so it
 * takes precedence over any higher company ceiling. This pins the seeded value and every
 * "row missing" fallback (forward migrations AND rollback files that restore a function
 * body), so no path can silently reintroduce the earlier £500 proposal.
 */
const FOUNDER_CEILING_PENCE = 10_000;
const SEED = "supabase/migrations/20261358000000_ai_platform_budget.sql";
const FALLBACK = /from public\.ai_platform_budget b where b\.id\),\s*(\d+)\)/g;

function sqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(dir, f))
    .filter((p) => readFileSync(p, "utf8").includes("ai_platform_budget"));
}

describe("CrewFlow-wide AI ceiling default = £100/month", () => {
  it("the platform budget is seeded at 10000p", () => {
    const s = readFileSync(SEED, "utf8");
    const m = s.match(/insert into public\.ai_platform_budget[\s\S]*?values \(true, (\d+),/);
    expect(Number(m?.[1])).toBe(FOUNDER_CEILING_PENCE);
  });

  it("every missing-row fallback for the platform ceiling is 10000p", () => {
    const hits: Array<[string, number]> = [];
    for (const p of [...sqlFiles("supabase/migrations"), ...sqlFiles("docs/engineering/release")]) {
      for (const m of readFileSync(p, "utf8").matchAll(FALLBACK)) hits.push([p, Number(m[1])]);
    }
    expect(hits.length).toBeGreaterThan(0);
    for (const [p, v] of hits) expect(v, p).toBe(FOUNDER_CEILING_PENCE);
  });
});
