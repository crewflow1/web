import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRON_ROUTES,
  CRON_FAMILIES,
  cronFamily,
} from "@/lib/ops/cron-routes";

/**
 * Ops cron coverage — FULL-roster parity (L11 item 1).
 *
 * History: ops-snapshot carried a hard-coded 8-route tuple while
 * vercel.json scheduled 45, so /admin/ops silently monitored a fifth of
 * the estate. The roster is now DERIVED from vercel.json in
 * lib/ops/cron-routes.ts; this suite pins the parity BOTH directions:
 *
 *   vercel.json → ops : every scheduled cron is in CRON_ROUTES
 *   ops → vercel.json : CRON_ROUTES contains nothing vercel doesn't run
 *
 * plus: every scheduled route exists on disk, and the family grouping is
 * a total partition (no route can fall out of the ops table by having no
 * family).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const vercelCrons = (
  JSON.parse(read("vercel.json")) as {
    crons: Array<{ path: string; schedule: string }>;
  }
).crons;
const vercelRouteNames = vercelCrons.map((c) =>
  c.path.replace(/^\/api\/cron\//, ""),
);

describe("ops cron coverage — vercel.json parity (both directions)", () => {
  it("every cron scheduled in vercel.json is monitored by ops (vercel → ops)", () => {
    const monitored = new Set(CRON_ROUTES);
    const missing = vercelRouteNames.filter((r) => !monitored.has(r));
    expect(missing, `crons scheduled but NOT monitored: ${missing.join(", ")}`).toEqual([]);
  });

  it("ops monitors nothing vercel.json doesn't schedule (ops → vercel)", () => {
    const scheduled = new Set(vercelRouteNames);
    const phantom = CRON_ROUTES.filter((r) => !scheduled.has(r));
    expect(phantom, `ops monitors phantom crons: ${phantom.join(", ")}`).toEqual([]);
  });

  it("covers the FULL roster — no regression to a hard-coded subset", () => {
    // The bug this replaced tracked 8 of 45. Any hard-coded re-introduction
    // that trims the list trips the two parity tests above; this pins the
    // magnitude so a wholesale swap of both sources is still loud.
    expect(CRON_ROUTES.length).toBe(vercelCrons.length);
    expect(CRON_ROUTES.length).toBeGreaterThanOrEqual(45);
  });

  it("every scheduled cron path has a route handler on disk", () => {
    for (const c of vercelCrons) {
      const rel = `app${c.path}/route.ts`;
      expect(
        existsSync(resolve(ROOT, rel)),
        `${rel} missing for scheduled cron ${c.path}`,
      ).toBe(true);
    }
  });

  it("cron paths all live under /api/cron/ (the derivation's contract)", () => {
    for (const c of vercelCrons) {
      expect(c.path.startsWith("/api/cron/"), c.path).toBe(true);
    }
  });
});

describe("ops cron coverage — family grouping is a total partition", () => {
  it("assigns every route exactly one known family", () => {
    for (const route of CRON_ROUTES) {
      const family = cronFamily(route);
      expect(CRON_FAMILIES, `${route} → ${family}`).toContain(family);
    }
  });

  it("classifies by convention: hq-* → hq, *drain* → drains, *sync* → syncs", () => {
    expect(cronFamily("hq-runners-tick")).toBe("hq");
    // hq wins over drain for hq-apply-drain (HQ machinery groups together).
    expect(cronFamily("hq-apply-drain")).toBe("hq");
    expect(cronFamily("notifications-drain")).toBe("drains");
    expect(cronFamily("bank-sync")).toBe("syncs");
    expect(cronFamily("invoice-reminders")).toBe("maintenance");
  });
});

describe("ops snapshot + page consume the derived roster", () => {
  it("ops-snapshot derives CRON_ROUTES from lib/ops/cron-routes (no hard-coded tuple)", () => {
    const src = read("server/services/ops-snapshot.ts");
    expect(src).toMatch(/from "@\/lib\/ops\/cron-routes"/);
    // The old drift bug: a literal `CRON_ROUTES = [` tuple in this file.
    expect(src).not.toMatch(/CRON_ROUTES\s*=\s*\[/);
  });

  it("lib/ops/cron-routes derives from vercel.json itself", () => {
    const src = read("lib/ops/cron-routes.ts");
    expect(src).toMatch(/from "@\/vercel\.json"/);
    expect(src).toMatch(/\/api\/cron\//);
  });

  it("the ops page groups the cron table by family", () => {
    const page = read("app/admin/ops/page.tsx");
    expect(page).toMatch(/CRON_FAMILIES/);
    expect(page).toMatch(/CRON_FAMILY_LABEL/);
  });
});

describe("ops page — Sentry deep link (env-driven, no secret)", () => {
  it("snapshot exposes sentry_url from SENTRY_DASHBOARD_URL, https-only", () => {
    const src = read("server/services/ops-snapshot.ts");
    expect(src).toMatch(/SENTRY_DASHBOARD_URL/);
    expect(src).toMatch(/startsWith\("https:\/\/"\)/);
  });

  it("page renders the link only when set", () => {
    const page = read("app/admin/ops/page.tsx");
    expect(page).toMatch(/snapshot\.sentry_url \?/);
    expect(page).toMatch(/Open Sentry/);
  });
});
