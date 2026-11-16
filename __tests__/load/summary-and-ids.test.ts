/**
 * Load-harness output + determinism:
 *   - summary.js turns k6 summary data into JSON + markdown with the three-number model;
 *   - ids.js (k6) and scripts/load/_ids.mjs (seeder) derive byte-identical ids;
 *   - discover-actions / trace-summary pure helpers.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const imp = async <T>(rel: string) => (await import(path.join(ROOT, rel))) as T;

type Nums = Record<string, number>;
type Report = {
  json: { model: { wholeRun: Nums; peakPhase: Nums }; latencyMs: { byKind: Record<string, Nums> }; verdict: string };
  markdown: string;
};
type SummaryMod = { buildReport: (data: unknown, meta: unknown) => Report; failedThresholds: (d: unknown) => string[] };
type ModelMod = { STAGES: Record<string, unknown>; phasesOf: (p: unknown) => unknown[] };

const trend = (avg: number, p95: number) => ({ type: "trend", contains: "time", values: { avg, min: 1, med: avg, "p(90)": p95 * 0.9, "p(95)": p95, "p(99)": p95 * 1.5, max: p95 * 2 } });
function fixture(over: Record<string, unknown> = {}) {
  return {
    state: { testRunDurationMs: 315_000 },
    metrics: {
      vus_max: { type: "gauge", values: { value: 100, min: 0, max: 100 } },
      http_reqs: { type: "counter", values: { count: 9450, rate: 30 } },
      "http_reqs{phase:peak}": { type: "counter", values: { count: 7200, rate: 22.8 } },
      http_req_duration: trend(120, 400),
      "http_req_duration{phase:peak}": trend(150, 450),
      "http_req_duration{phase:peak,kind:page}": trend(200, 600),
      "http_req_duration{kind:page}": { ...trend(200, 600), thresholds: { "p(95)<4000": { ok: true } } },
      "http_reqs{kind:page}": { type: "counter", values: { count: 5000, rate: 15 } },
      http_req_failed: { type: "rate", values: { rate: 0.001 } },
      server_errors: { type: "rate", values: { rate: 0.0005 } },
      tenant_isolation_scans: { type: "counter", values: { count: 8000 } },
      tenant_isolation_violations: { type: "counter", values: { count: 0 }, thresholds: { "count==0": { ok: true } } },
      canary_probes: { type: "counter", values: { count: 40 } },
      canary_refused: { type: "counter", values: { count: 40 } },
      logins: { type: "counter", values: { count: 100 } },
      ...over,
    },
  };
}

async function meta() {
  const model = await imp<ModelMod>("load/k6/lib/model.js");
  const profile = model.STAGES.local;
  return { stage: "local", profile, phases: model.phasesOf(profile), targetKind: "local", thinkScale: 1, tag: "lt1", app: { url: "http://localhost:3000", buildId: "abc" } };
}

describe("summary.buildReport", () => {
  it("reports concurrent sessions, RPS and derived in-flight requests separately", async () => {
    const { buildReport } = await imp<SummaryMod>("load/k6/lib/summary.js");
    const { json, markdown } = buildReport(fixture(), await meta());
    expect(json.model.wholeRun.peakSessions).toBe(100);
    expect(json.model.wholeRun.rps).toBe(30);
    expect(json.model.peakPhase.seconds).toBe(240);
    expect(json.model.peakPhase.rps).toBe(30); // 7200 / 240 s
    expect(json.model.peakPhase.inFlightRequests).toBe(4.5); // 30 × 0.150 s
    expect(json.model.peakPhase.requestsPerSessionPerMinute).toBe(18);
    expect(markdown).toContain("concurrent sessions (VUs)");
    expect(markdown).toContain("requests/s (arrival)");
    expect(markdown).toContain("in-flight requests (derived");
    expect(markdown).toMatch(/LOCAL RUN.*says \*\*nothing\*\* about hosted capacity/s);
    expect(json.latencyMs.byKind.page.p95).toBe(600);
    expect(json.verdict).toBe("PASS");
  });

  it("fails the verdict on a single isolation violation or canary leak", async () => {
    const { buildReport } = await imp<SummaryMod>("load/k6/lib/summary.js");
    const v = buildReport(fixture({ tenant_isolation_violations: { type: "counter", values: { count: 1 } } }), await meta());
    expect(v.json.verdict).toBe("FAIL (tenant isolation)");
    const c = buildReport(fixture({ canary_leaks: { type: "counter", values: { count: 1 } } }), await meta());
    expect(c.json.verdict).toBe("FAIL (tenant isolation)");
  });

  it("lists failed thresholds", async () => {
    const { buildReport, failedThresholds } = await imp<SummaryMod>("load/k6/lib/summary.js");
    const data = fixture({ "http_req_duration{kind:page}": { ...trend(5000, 9000), thresholds: { "p(95)<4000": { ok: false } } } });
    expect(failedThresholds(data)).toEqual(["http_req_duration{kind:page}: p(95)<4000"]);
    expect(buildReport(data, await meta()).json.verdict).toBe("FAIL (thresholds)");
  });

  it("warns that compressed think time is not a user count", async () => {
    const { buildReport } = await imp<SummaryMod>("load/k6/lib/summary.js");
    const m = { ...(await meta()), thinkScale: 0.2 };
    expect(buildReport(fixture(), m).markdown).toMatch(/each VU behaved like ~5 people/);
  });
});

describe("deterministic ids: k6 ids.js ≡ seeder _ids.mjs ≡ Postgres md5()::uuid", () => {
  type IdsMod = {
    makeIds: (tag: string, md5: (s: string) => string) => {
      ltId: (k: string, o: number, n: number | string) => string;
      userId: (o: number, r: string, n: number) => string;
      emailOf: (o: number, r: string, n: number) => string;
      hqEmail: (n: number) => string;
    };
    isSyntheticEmail: (e: string) => boolean;
  };
  type SeedIds = { ltId: (key: string) => string; ltR: (key: string) => number };
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");

  it("derive the same uuid for every kind the generator recomputes", async () => {
    const { makeIds } = await imp<IdsMod>("load/k6/lib/ids.js");
    const seed = await imp<SeedIds>("scripts/load/_ids.mjs");
    const k6 = makeIds("lt1", md5);
    for (const kind of ["customer", "job", "quote", "invoice"]) {
      for (const [o, n] of [[1, 1], [7, 42], [25, 999]]) expect(k6.ltId(kind, o, n)).toBe(seed.ltId(`lt1:${kind}:${o}:${n}`));
    }
    expect(k6.userId(3, "staff", 2)).toBe(seed.ltId("lt1:user:3:staff:2"));
    // Postgres renders md5('lt1:org:1')::uuid as the 8-4-4-4-12 split of the hex digest
    const hex = md5("lt1:org:1");
    expect(seed.ltId("lt1:org:1")).toBe(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
    expect(seed.ltR("x")).toBeGreaterThanOrEqual(0);
    expect(seed.ltR("x")).toBeLessThan(1);
  });

  it("only ever produces / accepts synthetic, undeliverable identities", async () => {
    const { makeIds, isSyntheticEmail } = await imp<IdsMod>("load/k6/lib/ids.js");
    const ids = makeIds("lt1", md5);
    expect(ids.emailOf(4, "admin", 1)).toBe("lt-lt1-o4-admin1@loadtest.crewflow.invalid");
    expect(isSyntheticEmail(ids.emailOf(4, "staff", 12))).toBe(true);
    expect(isSyntheticEmail(ids.hqEmail(2))).toBe(true);
    for (const e of ["owner@crewflow.uk", "lt-lt1-o1-owner1@loadtest.crewflow.invalid.evil.com", "hc-owner@crewflow.test", "lt-lt1-o1-owner1@gmail.com"]) {
      expect(isSyntheticEmail(e)).toBe(false);
    }
  });
});

describe("pure helpers", () => {
  it("discover-actions maps <file>#<export> to the build's action ids", async () => {
    const { actionsFromManifest } = await imp<{ actionsFromManifest: (m: unknown) => Record<string, string> }>("scripts/load/discover-actions.mjs");
    expect(actionsFromManifest({
      node: { abc123: { filename: "app/(app)/me/actions.ts", exportedName: "clockIn" }, nope: { workers: {} } },
      edge: {},
    })).toEqual({ "app/(app)/me/actions.ts#clockIn": "abc123" });
  });

  it("trace-summary normalises ids, slugs and action ids", async () => {
    const { routeKey, pctl } = await imp<{ routeKey: (r: unknown, n: Record<string, string>) => string; pctl: (s: number[], p: number) => number | null }>("scripts/load/trace-summary.mjs");
    expect(routeKey({ method: "GET", path: "/jobs/0b6f3a1e-1111-2222-3333-444455556666", rsc: true }, {})).toBe("GET /jobs/[id] (rsc)");
    expect(routeKey({ method: "GET", path: "/l/lt-lt1-org-3" }, {})).toBe("GET /l/[slug]");
    expect(routeKey({ method: "POST", path: "/me", action: "deadbeef00" }, { deadbeef00: "clockIn" })).toBe("ACTION clockIn @ /me");
    expect(pctl([1, 2, 3, 4], 50)).toBe(2);
    expect(pctl([], 50)).toBeNull();
  });
});
