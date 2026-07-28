import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Destructive-target guard — WIRING invariants.
 *
 * lib/testing/destructive-db-guard.ts is unit-tested as a pure function in
 * __tests__/lib/destructive-db-guard.test.ts. That proves the POLICY. It proves
 * nothing about whether the policy is actually reached before a truncate.
 *
 * Wiring is the part that silently rots: someone adds a new E2E spec with its
 * own service-role client, or moves the guard below the first `createClient`,
 * and the pure tests stay green while the protection is gone. This suite pins
 * the wiring itself — runtime where a call can be made, and structurally over
 * the source where it cannot.
 *
 * Every destructive entry point in the repository is enumerated here. Adding a
 * new one without a guard should fail THIS file.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Source with comments removed, for checks that must see CODE only.
 *
 * These files describe the guard at length — including, deliberately, the
 * `ALLOW_DESTRUCTIVE`-style bypass that does NOT exist and the call sites the
 * guard must precede. Matching raw source would let prose both satisfy and trip
 * the structural assertions. Whole-line `//` only, so `http://` survives.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

/** A production-shaped target. Only ever a string — nothing here connects. */
const PROD_SHAPED = "https://jzntbskdqdopzwdqwvkp.supabase.co";
const LOCAL = "http://127.0.0.1:54321";

afterEach(() => {
  vi.unstubAllEnvs();
});

// =====================================================================
// 1. RUNTIME — the integration harness refuses a non-local target
// =====================================================================

describe("wiring · integration harness refuses at runtime", () => {
  /**
   * The real harness, called for real. All three connection vars are set so the
   * harness gets past its own "missing credentials" check — proving the REFUSAL
   * comes from the guard, not from an incidentally incomplete environment.
   *
   * Only the refusal path is asserted: the success path would reach
   * `createClient`, which needs a native WebSocket (Node 22+), and this tier
   * deliberately runs on Node 20.
   */
  async function harness() {
    return import("../integration/_harness");
  }

  function stubProdEnv() {
    vi.stubEnv("SUPABASE_URL", PROD_SHAPED);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROD_SHAPED);
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key-value");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-value");
  }

  it("serviceClient() — the RLS-BYPASSING client used for fixtures and teardown — refuses", async () => {
    stubProdEnv();
    const { serviceClient } = await harness();
    expect(() => serviceClient()).toThrow(/REFUSED/);
  });

  it("anonClient() refuses", async () => {
    stubProdEnv();
    const { anonClient } = await harness();
    expect(() => anonClient()).toThrow(/REFUSED/);
  });

  it("userClient() refuses", async () => {
    stubProdEnv();
    const { userClient } = await harness();
    expect(() => userClient("a.jwt.token")).toThrow(/REFUSED/);
  });

  it("the refusal names the harness and the variable it actually reads", async () => {
    stubProdEnv();
    const { serviceClient } = await harness();
    expect(() => serviceClient()).toThrow(/_harness\.ts/);
    expect(() => serviceClient()).toThrow(/SUPABASE_URL/);
  });

  it("the refusal leaks no key material, even though the keys were set", async () => {
    stubProdEnv();
    const { serviceClient } = await harness();
    try {
      serviceClient();
      throw new Error("expected serviceClient() to refuse");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("REFUSED");
      expect(message).not.toContain("service-role-key-value");
      expect(message).not.toContain("anon-key-value");
    }
  });

  it("still refuses when NEXT_PUBLIC_SUPABASE_URL is the production one and the bare name is unset", async () => {
    // readConn() falls back to NEXT_PUBLIC_SUPABASE_URL. The guard must follow
    // the SAME precedence, or it would check a variable the code does not use.
    // `undefined` (not "") because readConn uses `??`, which only falls back on
    // null/undefined — this reproduces a genuinely unset variable.
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROD_SHAPED);
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key-value");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-value");
    const { serviceClient } = await harness();
    expect(() => serviceClient()).toThrow(/REFUSED/);
  });
});

// =====================================================================
// 2. RUNTIME — the E2E guard helper
// =====================================================================

describe("wiring · e2e guard helper refuses at runtime", () => {
  it("refuses a production target and names NEXT_PUBLIC_SUPABASE_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROD_SHAPED);
    const { assertLocalE2eTarget } = await import("../../e2e/_guard");
    expect(() => assertLocalE2eTarget("spec")).toThrow(/REFUSED/);
    expect(() => assertLocalE2eTarget("spec")).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("returns the url unchanged for a local target, so it can be passed straight to createClient", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOCAL);
    const { assertLocalE2eTarget } = await import("../../e2e/_guard");
    expect(assertLocalE2eTarget("spec")).toBe(LOCAL);
  });
});

// =====================================================================
// 3. STRUCTURAL — every E2E service-role client is guarded
// =====================================================================

describe("wiring · every e2e file that builds a service-role client is guarded", () => {
  const e2eDir = resolve(ROOT, "e2e");
  const files = readdirSync(e2eDir).filter((f) => f.endsWith(".ts"));
  const destructive = files.filter(
    (f) => f !== "_guard.ts" && read(`e2e/${f}`).includes("SUPABASE_SERVICE_ROLE_KEY"),
  );

  it("finds the destructive e2e files at all (guards against a vacuous pass)", () => {
    expect(destructive.length).toBeGreaterThanOrEqual(13);
  });

  for (const f of destructive) {
    it(`e2e/${f} imports the guard`, () => {
      expect(read(`e2e/${f}`)).toMatch(/from "\.\/_guard"/);
    });
  }

  it("no e2e file reads NEXT_PUBLIC_SUPABASE_URL raw to build a client — it must go through the guard", () => {
    for (const f of files) {
      if (f === "global-setup.ts") continue; // reads it AFTER guarding; asserted separately below
      const src = read(`e2e/${f}`);
      expect(src, `e2e/${f} must resolve its url via assertLocalE2eTarget`).not.toMatch(
        /createClient\(\s*process\.env\.NEXT_PUBLIC_SUPABASE_URL/,
      );
    }
  });
});

// =====================================================================
// 4. STRUCTURAL — ordering. A guard after the first write is decoration.
// =====================================================================

describe("wiring · the guard runs BEFORE any client is constructed", () => {
  it("e2e/global-setup.ts guards before its first createClient", () => {
    const src = code("e2e/global-setup.ts");
    const guard = src.indexOf("assertLocalE2eTarget(");
    const client = src.indexOf("createClient(", src.indexOf("export default"));
    expect(guard, "global-setup must call the guard").toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(-1);
    expect(guard, "guard must precede the first createClient").toBeLessThan(client);
  });

  it("e2e/global-setup.ts guards as the FIRST statement of globalSetup", () => {
    const src = read("e2e/global-setup.ts");
    const body = src.slice(src.indexOf("export default async function globalSetup"));
    // Nothing but the opening brace and comments before the guard call.
    expect(body).toMatch(/globalSetup\(\): Promise<void> \{\s*(\/\*[\s\S]*?\*\/\s*)?assertLocalE2eTarget\(/);
  });

  it("__tests__/integration/_harness.ts guards inside conn(), before createClient", () => {
    const src = code("__tests__/integration/_harness.ts");
    const conn = src.indexOf("function conn()");
    const guard = src.indexOf("assertLocalDestructiveTarget(", conn);
    const firstClient = src.indexOf("createClient<Database>(");
    expect(conn).toBeGreaterThan(-1);
    expect(guard, "conn() must guard the resolved url").toBeGreaterThan(-1);
    expect(guard, "the guard must sit before any client construction").toBeLessThan(firstClient);
  });

  it("__tests__/integration/setup.ts gates the whole tier before any test file loads", () => {
    const src = read("__tests__/integration/setup.ts");
    expect(src).toMatch(/assertLocalDestructiveTargetIfConfigured\(/);
    // Same resolution order as _harness.ts readConn() — a guard on a different
    // variable than the code uses would be theatre.
    expect(src).toMatch(/process\.env\.SUPABASE_URL \?\? process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("scripts/memory-bench.ts guards before createAdminClient()", () => {
    const src = code("scripts/memory-bench.ts");
    const guard = src.indexOf("assertLocalDestructiveTarget(");
    const client = src.indexOf("createAdminClient()", src.indexOf("async function main"));
    expect(guard).toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(client);
  });
});

// =====================================================================
// 5. STRUCTURAL — the integration tier has exactly ONE client chokepoint
// =====================================================================

describe("wiring · integration tests may only obtain clients from the guarded harness", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...walk(`${dir}/${entry.name}`));
      else if (entry.name.endsWith(".ts")) out.push(`${dir}/${entry.name}`);
    }
    return out;
  }

  const files = walk("__tests__/integration");

  it("sees the whole tier (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no integration file builds its own Supabase client — all 150+ go through _harness.ts", () => {
    const offenders = files.filter(
      (f) => !f.endsWith("_harness.ts") && /\bcreateClient\s*\(/.test(read(f)),
    );
    expect(offenders, `these bypass the guarded harness: ${offenders.join(", ")}`).toEqual([]);
  });
});

// =====================================================================
// 6. STRUCTURAL — the SQL script guards itself
// =====================================================================

describe("wiring · scripts/e2e-lifecycle.sql refuses a non-local database", () => {
  const sql = read("scripts/e2e-lifecycle.sql");
  /** Executable SQL only — `--` comments stripped, so prose cannot satisfy a match. */
  const exec = sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");

  it("checks the local-stack recognition token", () => {
    expect(exec).toMatch(/current_setting\('app\.settings\.jwt_secret', true\)/);
  });

  it("is an ALLOWLIST: it proceeds only on an exact match, and refuses NULL", () => {
    // `is distinct from` — not `<>` — so an unset (NULL) setting also refuses.
    expect(exec).toMatch(/is distinct from/);
    expect(exec).not.toMatch(/jwt_secret[^\n]*<>/);
  });

  it("raises before the first mutating statement", () => {
    const guard = exec.indexOf("app.settings.jwt_secret");
    const firstInsert = exec.toLowerCase().indexOf("insert into");
    expect(guard).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(-1);
    expect(guard, "the guard must precede every INSERT").toBeLessThan(firstInsert);
  });

  it("sits INSIDE the transaction, so a raise degrades commit to rollback even without ON_ERROR_STOP", () => {
    const begin = exec.toLowerCase().indexOf("begin;");
    const guard = exec.indexOf("app.settings.jwt_secret");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(guard);
  });

  it("never raises the recognition token's value into the error message", () => {
    const raise = exec.slice(exec.indexOf("raise exception"), exec.indexOf("end $$;"));
    expect(raise).not.toMatch(/current_setting/);
  });

  it("warns against --linked, and offers no override GUC", () => {
    expect(sql).toMatch(/--linked. is PRODUCTION/);
    expect(exec).not.toMatch(/allow_destructive|force_destructive/i);
  });
});

// =====================================================================
// 7. POLICY — no override escape hatch, anywhere
// =====================================================================

describe("wiring · there is no override escape hatch", () => {
  it("the guard module reads no environment variable at all", () => {
    // The guard is pure: callers pass the target they actually use. If it ever
    // grew a `process.env` bypass, it would have to read env to do it.
    expect(code("lib/testing/destructive-db-guard.ts")).not.toMatch(/process\.env/);
  });

  it("no entry point accepts a force/allow/skip flag", () => {
    const wired = [
      "lib/testing/destructive-db-guard.ts",
      "e2e/_guard.ts",
      "e2e/global-setup.ts",
      "__tests__/integration/_harness.ts",
      "__tests__/integration/setup.ts",
      "scripts/memory-bench.ts",
    ];
    for (const f of wired) {
      expect(code(f), `${f} must not offer a bypass`).not.toMatch(
        /(ALLOW|FORCE|SKIP)_(DESTRUCTIVE|GUARD|DB)/i,
      );
    }
  });

  it("the production ref is never used as a denylist entry in the guard", () => {
    // A denylist would break the moment a second project exists. The policy is
    // an allowlist of local hosts and nothing else.
    const guard = code("lib/testing/destructive-db-guard.ts");
    expect(guard).not.toMatch(/jzntbskdqdopzwdqwvkp/);
    expect(guard).not.toMatch(/supabase\.co/);
  });
});
