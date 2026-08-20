import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { submitCis300ReturnToHmrc } from "@/lib/integrations/hmrc/cis-submit";
import { submitFpsReturnToHmrc } from "@/lib/integrations/hmrc/rti-fps-submit";
import type { Cis300Return } from "@/lib/integrations/hmrc/cis-return";
import type { FpsReturn } from "@/lib/integrations/hmrc/rti-fps";

/**
 * HMRC CIS300 + RTI FPS SUBMIT adapters — trust-boundary proofs. DARK.
 *
 * The 20261130 VAT submit pipeline proved the shape: a provider adapter whose ONLY
 * `fetch` sits strictly AFTER the connectable (two-switch) guard, so the submission
 * network call is structurally unreachable while HMRC is dark. These new adapters
 * (lib/integrations/hmrc/cis-submit.ts, rti-fps-submit.ts) mirror it EXACTLY for
 * CIS300 monthly returns and RTI Full Payment Submissions. These proofs pin that
 * posture against the real source:
 *
 * Section 1: the adapters REFUSE with NO fetch while dark (runtime, env unset).
 * Section 2: the ONLY fetch in each adapter lives AFTER the connectable guard
 *            (structural dark path) — a single call site, versioned Accept header.
 * Section 3: the submit ORCHESTRATOR refuses before any claim/submit while dark and
 *            never logs a token; the tenant-facing prepare/hold service gains no fetch.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const CIS_SUBMIT = "lib/integrations/hmrc/cis-submit.ts";
const FPS_SUBMIT = "lib/integrations/hmrc/rti-fps-submit.ts";
const ORCH = "server/services/hmrc-submit.ts";
const PREPARE_SERVICE = "server/services/hmrc-connections.ts";

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const OAUTH_ENV = ["HMRC_CLIENT_ID", "HMRC_CLIENT_SECRET", "NEXT_PUBLIC_FEATURE_HMRC_CONNECT"];

const CIS_PAYLOAD: Cis300Return = {
  taxYear: "2026-27",
  taxMonth: { from: "2026-04-06", to: "2026-05-05" },
  contractor: {
    aoReference: null,
    employerPayeReference: "123/AB456",
    utr: null,
    name: "Acme",
  },
  nilReturn: false,
  subcontractors: [],
  declarations: {
    employmentStatus: null,
    verification: null,
    informationCorrect: null,
    inactivity: null,
  },
};

const FPS_PAYLOAD: FpsReturn = {
  taxYear: "2026-27",
  payDate: "2026-07-31",
  paymentFrequency: "monthly",
  employer: {
    employerPayeReference: "123/AB456",
    accountsOfficeReference: null,
    name: "Acme",
  },
  employees: [],
  totals: { taxablePay: 0, taxDeducted: 0, employeeNic: 0, netPay: 0 },
  finalSubmission: false,
};

// ---------------------------------------------------------------------------
// 1. THE ADAPTERS REFUSE WITH NO FETCH WHILE DARK
// ---------------------------------------------------------------------------

describe("CIS/RTI submit adapters refuse with NO fetch while dark", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("submitCis300ReturnToHmrc REFUSES (not_configured), never touching fetch", async () => {
    // A real fetch would throw in this env; a clean not_configured proves it was
    // never called (the connectable guard returned first).
    const res = await submitCis300ReturnToHmrc({
      contractorRef: "123/AB456",
      payload: CIS_PAYLOAD,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("submitFpsReturnToHmrc REFUSES (not_configured), never touching fetch", async () => {
    const res = await submitFpsReturnToHmrc({
      employerRef: "123/AB456",
      payload: FPS_PAYLOAD,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("credentials WITHOUT the feature flag still refuse (two-switch)", async () => {
    process.env.HMRC_CLIENT_ID = "id";
    process.env.HMRC_CLIENT_SECRET = "secret";
    // Flag deliberately left off.
    const cis = await submitCis300ReturnToHmrc({
      contractorRef: "123/AB456",
      payload: CIS_PAYLOAD,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    const fps = await submitFpsReturnToHmrc({
      employerRef: "123/AB456",
      payload: FPS_PAYLOAD,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(cis.ok).toBe(false);
    expect(fps.ok).toBe(false);
    if (!cis.ok) expect(cis.reason).toBe("not_configured");
    if (!fps.ok) expect(fps.reason).toBe("not_configured");
  });
});

// ---------------------------------------------------------------------------
// 2. THE ONLY FETCH LIVES AFTER THE CONNECTABLE GUARD (structural dark path)
// ---------------------------------------------------------------------------

describe("CIS/RTI submit fetch is UNREACHABLE dark — the connectable guard precedes it", () => {
  for (const [label, path, hostRe] of [
    ["cis-submit.ts", CIS_SUBMIT, /organisations\/cis/],
    ["rti-fps-submit.ts", FPS_SUBMIT, /organisations\/paye/],
  ] as const) {
    it(`${label}: guard precedes the single submission fetch, versioned Accept`, () => {
      const code = codeOf(read(path));
      const guardIdx = code.indexOf("isHmrcConnectable()");
      const fetchIdx = code.indexOf("fetch(");
      expect(guardIdx).toBeGreaterThan(-1);
      expect(fetchIdx).toBeGreaterThan(-1);
      // The refuse-before-submit guard sits strictly before the only network call.
      expect(guardIdx).toBeLessThan(fetchIdx);
      // Exactly one submission call site.
      expect(code.indexOf("fetch(", fetchIdx + 1)).toBe(-1);
      // It targets the HMRC organisations REST platform under the versioned Accept.
      expect(code).toMatch(hostRe);
      expect(code).toMatch(/application\/vnd\.hmrc\.1\.0\+json/);
      // Bearer auth + the mandatory fraud-prevention headers are attached.
      expect(code).toMatch(/authorization: `Bearer \$\{accessToken\}`/);
      expect(code).toMatch(/\.\.\.fraudHeaders/);
    });

    it(`${label}: never logs a token or secret`, () => {
      const code = codeOf(read(path));
      const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const c of logCalls) {
        expect(c).not.toMatch(/access_?token/i);
        expect(c).not.toMatch(/refresh_?token/i);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. THE ORCHESTRATOR — refuses before claim/submit while dark, no token logs
// ---------------------------------------------------------------------------

describe("CIS/RTI submit orchestrators are dark-gated and leak no token", () => {
  const code = codeOf(read(ORCH));

  it("both orchestrators refuse before any claim/submit while dark", () => {
    for (const [fn, adapter] of [
      ["submitCis300Return", "submitCis300ReturnToHmrc("],
      ["submitFpsReturn", "submitFpsReturnToHmrc("],
    ] as const) {
      const fnIdx = code.indexOf(`export async function ${fn}(`);
      expect(fnIdx, `${fn} must exist`).toBeGreaterThan(-1);
      const body = code.slice(fnIdx);
      const guardIdx = body.indexOf("isHmrcConnectable()");
      const claimIdx = body.indexOf('"submitting"');
      const submitIdx = body.indexOf(adapter);
      expect(guardIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(claimIdx);
      expect(guardIdx).toBeLessThan(submitIdx);
    }
  });

  it("the orchestrator NEVER logs a token or secret", () => {
    const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
    for (const c of logCalls) {
      expect(c).not.toMatch(/access_?token/i);
      expect(c).not.toMatch(/refresh_?token/i);
    }
  });

  it("the tenant-facing prepare/hold service gains NO fetch (submit is service-role only)", () => {
    const svc = codeOf(read(PREPARE_SERVICE));
    expect(svc).not.toMatch(/\bfetch\(/);
    expect(svc).not.toMatch(/service\.gov\.uk|hmrc\.gov\.uk/i);
  });
});
