/**
 * Load model (load/k6/lib/model.js): persona mix, identity assignment, stage
 * profiles, phases, thresholds, and the sessions / RPS / in-flight split.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
type Profile = { target: string; vus: number; ramp: [string, number][]; p95: number; p99: number; errRate: number };
type Phase = { name: string; fromS: number; toS: number; startVUs: number; endVUs: number };
type Model = {
  PERSONA_SLOTS: [string, number][];
  SLOTS_TOTAL: number;
  assignVu: (id: number) => { persona: string; ordinal: number };
  personaCounts: (vus: number) => Record<string, number>;
  STAGES: Record<"smoke" | "local" | "100" | "500" | "1k" | "5k" | "10k" | "25k" | "50k", Profile>;
  LOCAL_MAX_VUS: number;
  stageProfile: (stage: string, target: string, allowBig?: boolean) => Profile;
  phasesOf: (p: Profile) => Phase[];
  phaseAt: (ph: Phase[], s: number) => string;
  phaseSeconds: (ph: Phase[], name: string) => number;
  totalSeconds: (p: Profile) => number;
  parseDuration: (d: string) => number;
  thresholdsFor: (p: Profile) => Record<string, unknown[]>;
  loadModel: (x: { sessions: number; requests: number; seconds: number; meanLatencyMs: number }) => {
    concurrentSessions: number; rps: number; inFlightRequests: number; requestsPerSessionPerMinute: number;
  };
};
const load = async () => (await import(path.join(ROOT, "load/k6/lib/model.js"))) as Model;

describe("persona mix + identity assignment", () => {
  it("slots sum to 1000 and the mix is exact per 1000 VUs", async () => {
    const m = await load();
    expect(m.SLOTS_TOTAL).toBe(1000);
    const counts = m.personaCounts(1000);
    for (const [name, n] of m.PERSONA_SLOTS) expect(counts[name]).toBe(n);
  });

  it("every VU gets a distinct (persona, ordinal) — no two VUs share an identity", async () => {
    const m = await load();
    const seen = new Set<string>();
    for (let vu = 1; vu <= 5000; vu++) {
      const { persona, ordinal } = m.assignVu(vu);
      const k = `${persona}:${ordinal}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("the mix is already representative early in a ramp", async () => {
    const m = await load();
    const c = m.personaCounts(100);
    expect(c.staff).toBeGreaterThanOrEqual(55);
    expect(c.staff).toBeLessThanOrEqual(61);
    expect(c.office).toBeGreaterThanOrEqual(18);
    expect(c.owner).toBeGreaterThanOrEqual(10);
  });
});

describe("stage profiles", () => {
  it("defines smoke, local and the staged ladder to 50k", async () => {
    const m = await load();
    for (const k of ["smoke", "local", "100", "500", "1k", "5k", "10k", "25k", "50k"] as const) expect(m.STAGES[k]).toBeDefined();
    expect(m.STAGES["50k"].vus).toBe(50000);
  });

  it("local profiles stay under the local ceiling; staged profiles are refused locally", async () => {
    const m = await load();
    for (const [k, p] of Object.entries(m.STAGES)) {
      if (p.target === "local") expect(p.vus).toBeLessThanOrEqual(m.LOCAL_MAX_VUS);
      if (p.vus > m.LOCAL_MAX_VUS) expect(() => m.stageProfile(k, "local")).toThrow(/staging profile/);
    }
    expect(m.stageProfile("local", "local").vus).toBe(100);
    expect(() => m.stageProfile("nope", "local")).toThrow(/Unknown STAGE/);
  });

  it("every staged profile has a peak hold, a recovery hold, and ends at zero", async () => {
    const m = await load();
    for (const p of Object.values(m.STAGES).filter((s) => s.target === "staging")) {
      const ph = m.phasesOf(p);
      expect(ph.some((x) => x.name === "peak")).toBe(true);
      expect(ph.some((x) => x.name === "recovery")).toBe(true);
      expect(ph.at(-1)?.endVUs).toBe(0);
      expect(Math.max(...p.ramp.map(([, t]) => t))).toBe(p.vus);
      expect(m.phaseSeconds(ph, "peak")).toBeGreaterThanOrEqual(600); // ≥10 min steady state
    }
  });

  it("phases tile the run and phaseAt maps elapsed time to the right phase", async () => {
    const m = await load();
    const p = m.STAGES.local;
    const ph = m.phasesOf(p);
    expect(ph.map((x) => x.name)).toEqual(["ramp", "peak", "end"]);
    expect(ph.at(-1)?.toS).toBe(m.totalSeconds(p));
    expect(m.phaseAt(ph, 10)).toBe("ramp");
    expect(m.phaseAt(ph, 61)).toBe("peak");
    expect(m.phaseAt(ph, 10_000)).toBe("end");
    expect(m.phasesOf(m.STAGES["1k"]).map((x) => x.name)).toEqual(["ramp", "step", "ramp", "peak", "drain", "recovery", "end"]);
    expect(m.parseDuration("90s")).toBe(90);
    expect(m.parseDuration("2m")).toBe(120);
    expect(() => m.parseDuration("2 minutes")).toThrow();
  });
});

describe("thresholds", () => {
  it("tenant isolation and canary leaks abort immediately on the first event", async () => {
    const m = await load();
    const t = m.thresholdsFor(m.STAGES["50k"]);
    expect(t.tenant_isolation_violations).toEqual([{ threshold: "count==0", abortOnFail: true, delayAbortEval: "0s" }]);
    expect(t.canary_leaks).toEqual([{ threshold: "count==0", abortOnFail: true, delayAbortEval: "0s" }]);
  });

  it("encodes the profile's p95/p99 and error budgets, with abort backstops", async () => {
    const m = await load();
    const p = m.STAGES["10k"];
    const t = m.thresholdsFor(p);
    expect(t["http_req_duration{kind:page}"]).toEqual(expect.arrayContaining([
      { threshold: `p(95)<${p.p95}` },
      { threshold: `p(99)<${p.p99}` },
      expect.objectContaining({ abortOnFail: true }),
    ]));
    expect(t.server_errors).toEqual(expect.arrayContaining([{ threshold: `rate<${p.errRate}` }, expect.objectContaining({ abortOnFail: true })]));
    expect(t["http_reqs{phase:peak}"]).toEqual(["count>=0"]);
  });
});

describe("sessions vs RPS vs in-flight (Little's law)", () => {
  it("keeps the three numbers distinct", async () => {
    const m = await load();
    const r = m.loadModel({ sessions: 1000, requests: 60_000, seconds: 600, meanLatencyMs: 250 });
    expect(r.concurrentSessions).toBe(1000);
    expect(r.rps).toBe(100);
    expect(r.inFlightRequests).toBe(25); // 100 req/s × 0.25 s
    expect(r.requestsPerSessionPerMinute).toBe(6);
  });
  it("is safe on empty windows", async () => {
    const m = await load();
    expect(m.loadModel({ sessions: 0, requests: 0, seconds: 0, meanLatencyMs: 0 })).toEqual({
      concurrentSessions: 0, rps: 0, inFlightRequests: 0, requestsPerSessionPerMinute: 0,
    });
  });
});
