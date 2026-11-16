// The hosted-run scripts must REFUSE before touching any network: production targets, missing env,
// non-staging names. These run the real shell scripts with fake values (nothing is contacted).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
function sh(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync("bash", [resolve(ROOT, script), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const STAGING = {
  LOAD_STAGING_HOST: "crewflow-load.example.dev",
  LOAD_STAGING_REF: "abcdefghijklmnop",
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  SUPABASE_ANON_KEY: "x",
  LOAD_USER_PASSWORD: "synthetic-password-1",
};

describe("run-staging.sh refuses", () => {
  it("when env is missing", () => {
    const r = sh("scripts/load/run-staging.sh", ["10k", "g1"], {});
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/REFUSED: LOAD_STAGING_HOST/);
  });
  it("an unknown or local stage", () => {
    expect(sh("scripts/load/run-staging.sh", ["local", "g1"], STAGING).out).toMatch(/unknown staging stage/);
  });
  it("the production Supabase project", () => {
    const r = sh("scripts/load/run-staging.sh", ["100", "g1"], { ...STAGING, LOAD_STAGING_REF: "jzntbskdqdopzwdqwvkp", SUPABASE_URL: "https://jzntbskdqdopzwdqwvkp.supabase.co" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/PRODUCTION/);
  });
  it("the production hostname", () => {
    const r = sh("scripts/load/run-staging.sh", ["100", "g1"], { ...STAGING, LOAD_STAGING_HOST: "crewflow.uk" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/production hostname/);
  });
  it("a Supabase URL that does not contain the confirmed ref", () => {
    const r = sh("scripts/load/run-staging.sh", ["100", "g1"], { ...STAGING, SUPABASE_URL: "https://zzzzzzzzzzzzzzzz.supabase.co" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/does not contain LOAD_STAGING_REF/);
  });
  it("a local target", () => {
    const r = sh("scripts/load/run-staging.sh", ["100", "g1"], { ...STAGING, SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/hosted staging only/);
  });
});

describe("teardown-staging.sh refuses", () => {
  const base = { LOAD_STAGING_REF: "abcdefghijklmnop", LOAD_VERCEL_PROJECT: "crewflow-load", LOAD_VERCEL_SCOPE: "x" };
  it("the production ref", () => {
    expect(sh("scripts/load/teardown-staging.sh", ["--yes"], { ...base, LOAD_STAGING_REF: "jzntbskdqdopzwdqwvkp" }).out).toMatch(/PRODUCTION/);
  });
  it("a production-looking Vercel project name", () => {
    expect(sh("scripts/load/teardown-staging.sh", [], { ...base, LOAD_VERCEL_PROJECT: "crewflow-web" }).out).toMatch(/REFUSED/);
    expect(sh("scripts/load/teardown-staging.sh", [], { ...base, LOAD_VERCEL_PROJECT: "myapp" }).out).toMatch(/must contain 'load'/);
  });
  it("is a dry run by default and deletes nothing", () => {
    const r = sh("scripts/load/teardown-staging.sh", [], base);
    expect(r.out).toMatch(/DRY-RUN: supabase projects delete abcdefghijklmnop/);
    expect(r.out).toMatch(/nothing was deleted/);
  });
});

describe("seed.mjs --plan (no database)", () => {
  const plan = (a: string[]) => spawnSync(process.execPath, ["--no-warnings", resolve(ROOT, "scripts/load/seed.mjs"), ...a, "--plan"], { encoding: "utf8", timeout: 30_000 });
  it("the 50k staging seed holds enough identities for every gate", () => {
    const r = plan(["--orgs", "6000", "--staff", "6", "--admin-ratio", "0.35", "--hq", "100"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).users).toBeGreaterThanOrEqual(50_000);
  });
  it("the old 2,000-org seed is flagged short for 50k", () => {
    expect(plan(["--orgs", "2000", "--staff", "12"]).status).toBe(2);
  });
});
