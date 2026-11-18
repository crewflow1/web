/**
 * Load-harness target guards — production must be IMPOSSIBLE to target.
 *
 * Two guards, both pure and both tested here:
 *   - load/k6/lib/guard.js   (k6 side: runs in every VU's init context + setup proof)
 *   - scripts/load/_guard.mjs (Node side: seed / teardown / collectors)
 * Modules are loaded through a computed path so the JS harness needs no .d.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const PROD_REF = "jzntbskdqdopzwdqwvkp";

type K6Guard = {
  PRODUCTION_SUPABASE_REF: string;
  classifyTarget: (baseUrl: string, supabaseUrl: string, env?: Record<string, string>) => "local" | "staging";
  sessionProofVerdict: (res: { status: number; body?: string; location?: string } | null, marker: string | null) => { ok: boolean; reason: string };
};
type NodeGuard = {
  PRODUCTION_SUPABASE_REF: string;
  authoriseTarget: (url: string, what: string) => "local" | "staging";
  assertNotProduction: (url: string, what: string) => void;
  stagingSentinelSql: (tag: string, ref?: string) => string;
  assertTag: (tag: string) => string;
  parseArgs: (argv: string[]) => Record<string, unknown> & { _: string[] };
};

const k6 = async () => (await import(path.join(ROOT, "load/k6/lib/guard.js"))) as K6Guard;
const node = async () => (await import(path.join(ROOT, "scripts/load/_guard.mjs"))) as NodeGuard;

const STAGING = { LOAD_STAGING_HOST: "crewflow-load.vercel.app", LOAD_STAGING_REF: "abcdefghijklmnopqrst" };

describe("k6 guard: classifyTarget", () => {
  it("both guards pin the same production ref", async () => {
    expect((await k6()).PRODUCTION_SUPABASE_REF).toBe(PROD_REF);
    expect((await node()).PRODUCTION_SUPABASE_REF).toBe(PROD_REF);
  });

  it("allows loopback app + loopback Supabase", async () => {
    const { classifyTarget } = await k6();
    expect(classifyTarget("http://localhost:3000", "http://127.0.0.1:54321")).toBe("local");
    expect(classifyTarget("http://127.0.0.1:3000/", "http://localhost:54321")).toBe("local");
    expect(classifyTarget("http://[::1]:3000", "http://127.0.0.1:54321")).toBe("local");
  });

  it.each([
    ["https://crewflow.uk", "http://127.0.0.1:54321"],
    ["https://www.crewflow.uk/dashboard", "http://127.0.0.1:54321"],
    ["https://app.crewflow.uk", "http://127.0.0.1:54321"],
    ["http://localhost.crewflow.uk:3000", "http://127.0.0.1:54321"],
    ["http://127.0.0.1@crewflow.uk/", "http://127.0.0.1:54321"],
    ["http://localhost:3000", `https://${PROD_REF}.supabase.co`],
    ["http://localhost:3000", `http://127.0.0.1:54321/?x=${PROD_REF}`],
    ["https://crewflow-load.vercel.app", `https://${PROD_REF}.supabase.co`],
  ])("refuses production %s + %s — even with staging confirmations set", async (app, db) => {
    const { classifyTarget } = await k6();
    expect(() => classifyTarget(app, db, STAGING)).toThrow(/REFUSED|not an http/);
    expect(() => classifyTarget(app, db, { LOAD_STAGING_HOST: new URL(app).hostname, LOAD_STAGING_REF: PROD_REF })).toThrow(/REFUSED|not an http/);
  });

  it("refuses a userinfo-port URL trick instead of misreading its host", async () => {
    const { classifyTarget } = await k6();
    expect(() => classifyTarget("http://127.0.0.1:80@crewflow.uk/", "http://127.0.0.1:54321")).toThrow();
  });

  it("refuses any non-local target without both confirmations", async () => {
    const { classifyTarget } = await k6();
    const app = "https://crewflow-load.vercel.app";
    const db = "https://abcdefghijklmnopqrst.supabase.co";
    expect(() => classifyTarget(app, db, {})).toThrow(/requires LOAD_STAGING_HOST and LOAD_STAGING_REF/);
    expect(() => classifyTarget(app, db, { LOAD_STAGING_HOST: STAGING.LOAD_STAGING_HOST })).toThrow(/requires/);
    expect(() => classifyTarget(app, db, { LOAD_STAGING_REF: STAGING.LOAD_STAGING_REF })).toThrow(/requires/);
    // a mixed target (local app, remote DB) is NOT local
    expect(() => classifyTarget("http://localhost:3000", db, {})).toThrow(/requires/);
  });

  it("refuses when the confirmations disagree with the URLs", async () => {
    const { classifyTarget } = await k6();
    const db = "https://abcdefghijklmnopqrst.supabase.co";
    expect(() => classifyTarget("https://other.vercel.app", db, STAGING)).toThrow(/does not match LOAD_STAGING_HOST/);
    expect(() => classifyTarget("https://crewflow-load.vercel.app", "https://zzzzzzzzzzzzzzzzzzzz.supabase.co", STAGING)).toThrow(/does not start with LOAD_STAGING_REF/);
    expect(() => classifyTarget("https://crewflow-load.vercel.app", db, { ...STAGING, LOAD_STAGING_REF: "not a ref!" })).toThrow(/bare Supabase project ref/);
  });

  it("accepts a fully confirmed staging target", async () => {
    const { classifyTarget } = await k6();
    expect(classifyTarget("https://crewflow-load.vercel.app", "https://abcdefghijklmnopqrst.supabase.co", STAGING)).toBe("staging");
  });

  it("refuses garbage URLs", async () => {
    const { classifyTarget } = await k6();
    expect(() => classifyTarget("crewflow.uk", "http://127.0.0.1:54321")).toThrow(/not an http/);
    expect(() => classifyTarget("ftp://localhost", "http://127.0.0.1:54321")).toThrow(/not an http/);
  });
});

describe("k6 guard: sessionProofVerdict (app must be wired to the guarded project)", () => {
  const marker = "ltm_0123456789ab";
  it("passes only on a 200 that renders the seeded tenant's marker", async () => {
    const { sessionProofVerdict } = await k6();
    expect(sessionProofVerdict({ status: 200, body: `<html>${marker}</html>` }, marker).ok).toBe(true);
  });
  it("fails when the app bounces the session (wired to another project)", async () => {
    const { sessionProofVerdict } = await k6();
    const v = sessionProofVerdict({ status: 307, body: "", location: "/login?next=/dashboard" }, marker);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/another Supabase project/);
  });
  it("fails on a 200 without the marker (wrong or unseeded database)", async () => {
    const { sessionProofVerdict } = await k6();
    expect(sessionProofVerdict({ status: 200, body: "<html>Dashboard</html>" }, marker).ok).toBe(false);
    expect(sessionProofVerdict({ status: 200, body: `<html>${marker}</html>` }, null).ok).toBe(false);
    expect(sessionProofVerdict(null, marker).ok).toBe(false);
  });
  it("fails if the app's response mentions the production project at all", async () => {
    const { sessionProofVerdict } = await k6();
    expect(sessionProofVerdict({ status: 200, body: `${marker} https://${PROD_REF}.supabase.co` }, marker).ok).toBe(false);
  });
});

describe("node guard: authoriseTarget / sentinel / tag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows the local database and API", async () => {
    const { authoriseTarget } = await node();
    expect(authoriseTarget("postgresql://postgres:postgres@127.0.0.1:54322/postgres", "db")).toBe("local");
    expect(authoriseTarget("http://127.0.0.1:54321", "api")).toBe("local");
  });

  it.each([
    `postgresql://postgres.${PROD_REF}:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
    `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`,
    `https://${PROD_REF}.supabase.co`,
    "https://crewflow.uk",
    "https://www.crewflow.uk",
    "https://app.crewflow.uk",
  ])("refuses production %s even when a staging ref is confirmed", async (url) => {
    vi.stubEnv("LOAD_STAGING_REF", "abcdefghijklmnopqrst");
    const { authoriseTarget } = await node();
    expect(() => authoriseTarget(url, "target")).toThrow(/REFUSED/);
  });

  it("refuses non-local targets unless LOAD_STAGING_REF is set, valid, non-prod and in the URL", async () => {
    const { authoriseTarget } = await node();
    const url = "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres";
    vi.stubEnv("LOAD_STAGING_REF", "");
    expect(() => authoriseTarget(url, "db")).toThrow(/LOAD_STAGING_REF is not set/);
    vi.stubEnv("LOAD_STAGING_REF", PROD_REF);
    expect(() => authoriseTarget(url, "db")).toThrow(/REFUSED/);
    vi.stubEnv("LOAD_STAGING_REF", "zzzzzzzzzzzzzzzzzzzz");
    expect(() => authoriseTarget(url, "db")).toThrow(/does not contain LOAD_STAGING_REF/);
    vi.stubEnv("LOAD_STAGING_REF", "abcdefghijklmnopqrst");
    expect(authoriseTarget(url, "db")).toBe("staging");
  });

  it("binds the database sentinel to the confirmed staging ref and refuses the production ref", async () => {
    const { stagingSentinelSql } = await node();
    expect(() => stagingSentinelSql("lt1", PROD_REF)).toThrow(/REFUSED/);
    expect(() => stagingSentinelSql("lt1", "")).toThrow(/REFUSED/);
    expect(() => stagingSentinelSql("lt1", "x'; drop table organizations; --")).toThrow(/REFUSED/);
    const sql = stagingSentinelSql("lt1", "abcdefghijklmnopqrst");
    expect(sql).toContain("staging_ref = ''abcdefghijklmnopqrst''");
    expect(sql).toContain("slug not like 'lt-%'");
    expect(sql).toMatch(/raise exception/);
  });

  it("only accepts boring tags (they are embedded in SQL, slugs and emails)", async () => {
    const { assertTag } = await node();
    expect(assertTag("lt1")).toBe("lt1");
    for (const bad of ["", "a", "LT1", "lt-1", "lt1'; drop", "abcdefghijklm", "lt_1"]) expect(() => assertTag(bad)).toThrow();
  });

  it("parses --key value / --key=value / --flag", async () => {
    const { parseArgs } = await node();
    expect(parseArgs(["x", "--orgs", "5", "--tag=lt1", "--fast"])).toEqual({ _: ["x"], orgs: "5", tag: "lt1", fast: true });
  });
});
