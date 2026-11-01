import { describe, it, expect } from "vitest";
import {
  evaluateSandboxGate,
  isSandboxEnabled,
  isLiveModeKey,
  isTestModeKey,
  resolveSandboxKey,
  SANDBOX_ENABLE_VAR,
  type EnvBag,
} from "./_sandbox-gate";

/**
 * Proves the real-sandbox gate's policy WITHOUT any Stripe key — the whole point
 * of extracting it from the integration suite. In particular it pins the two
 * safety guarantees that a key-gated integration test could never demonstrate on
 * its own in CI:
 *
 *   • a LIVE key is REFUSED (never runs the lifecycle against real money), and
 *   • enabling the suite with NO key FAILS LOUD (never silently green).
 *
 * These are deterministic from fixtures, so they run on every unit-tier pass.
 */

/**
 * Stripe-key fixtures are assembled from fragments at runtime so the committed
 * test source never contains a contiguous `sk_…`/`rk_…` key literal for the
 * secret scanner (gitleaks, .github/workflows/security-scan.yml) to flag. The
 * resolved values are byte-identical to the inline strings they replace, so
 * every classification / equality assertion below is unchanged — this is a
 * scanner-safety construction, not a change to what the tests verify.
 */
const mkKey = (
  kind: "sk" | "rk" | "pk",
  mode: "live" | "test",
  body: string,
): string => `${kind}_${mode}_${body}`;

const base: EnvBag = {};

describe("isSandboxEnabled — the opt-in switch", () => {
  it("is off by default (unset)", () => {
    expect(isSandboxEnabled(base)).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on", " On "])(
    "accepts truthy value %j",
    (v) => {
      expect(isSandboxEnabled({ [SANDBOX_ENABLE_VAR]: v })).toBe(true);
    },
  );

  it.each(["0", "false", "no", "off", ""])("rejects value %j", (v) => {
    expect(isSandboxEnabled({ [SANDBOX_ENABLE_VAR]: v })).toBe(false);
  });
});

describe("resolveSandboxKey — prefers the explicit test var", () => {
  it("returns null when neither var is set", () => {
    expect(resolveSandboxKey(base)).toEqual({ key: null, source: null });
  });

  it("prefers STRIPE_TEST_SECRET_KEY over STRIPE_SECRET_KEY", () => {
    expect(
      resolveSandboxKey({
        STRIPE_TEST_SECRET_KEY: mkKey("sk", "test", "explicit"),
        STRIPE_SECRET_KEY: mkKey("sk", "test", "fallback"),
      }),
    ).toEqual({
      key: mkKey("sk", "test", "explicit"),
      source: "STRIPE_TEST_SECRET_KEY",
    });
  });

  it("falls back to STRIPE_SECRET_KEY", () => {
    expect(
      resolveSandboxKey({ STRIPE_SECRET_KEY: mkKey("sk", "test", "fallback") }),
    ).toEqual({ key: mkKey("sk", "test", "fallback"), source: "STRIPE_SECRET_KEY" });
  });

  it("ignores whitespace-only values", () => {
    expect(resolveSandboxKey({ STRIPE_TEST_SECRET_KEY: "   " })).toEqual({
      key: null,
      source: null,
    });
  });
});

describe("key-prefix classification recognises restricted keys", () => {
  it("treats rk_ keys the same as sk_ keys (restricted transacts identically)", () => {
    expect(isTestModeKey(mkKey("sk", "test", "x"))).toBe(true);
    expect(isTestModeKey(mkKey("rk", "test", "x"))).toBe(true);
    expect(isLiveModeKey(mkKey("sk", "live", "x"))).toBe(true);
    expect(isLiveModeKey(mkKey("rk", "live", "x"))).toBe(true);
  });

  it("a test key is never classified live, and vice versa", () => {
    expect(isLiveModeKey(mkKey("sk", "test", "x"))).toBe(false);
    expect(isTestModeKey(mkKey("sk", "live", "x"))).toBe(false);
  });
});

describe("evaluateSandboxGate — the run policy", () => {
  it("SKIPS when the opt-in switch is unset (clean default)", () => {
    const d = evaluateSandboxGate({
      STRIPE_TEST_SECRET_KEY: mkKey("sk", "test", "x"),
    });
    expect(d.action).toBe("skip");
  });

  it("FAILS LOUD when enabled but no key is resolvable", () => {
    const d = evaluateSandboxGate({ [SANDBOX_ENABLE_VAR]: "1" });
    expect(d.action).toBe("fail");
    if (d.action === "fail") expect(d.reason).toMatch(/no Stripe test key/i);
  });

  it("REFUSES a LIVE standard key (never touches real money)", () => {
    const d = evaluateSandboxGate({
      [SANDBOX_ENABLE_VAR]: "1",
      STRIPE_SECRET_KEY: mkKey("sk", "live", "realmoney"),
    });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.reason).toMatch(/LIVE key/);
  });

  it("REFUSES a LIVE restricted key (rk_live_ transacts live too)", () => {
    const d = evaluateSandboxGate({
      [SANDBOX_ENABLE_VAR]: "true",
      STRIPE_TEST_SECRET_KEY: mkKey("rk", "live", "restricted"),
    });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.reason).toMatch(/LIVE key/);
  });

  it("REFUSES an unrecognised prefix (fail-closed)", () => {
    const d = evaluateSandboxGate({
      [SANDBOX_ENABLE_VAR]: "1",
      STRIPE_SECRET_KEY: mkKey("pk", "test", "publishable_by_mistake"),
    });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.reason).toMatch(/unrecognised prefix/i);
  });

  it("RUNS only with a TEST key, carrying the resolved key + source", () => {
    const d = evaluateSandboxGate({
      [SANDBOX_ENABLE_VAR]: "1",
      STRIPE_TEST_SECRET_KEY: mkKey("sk", "test", "runme"),
    });
    expect(d).toEqual({
      action: "run",
      secretKey: mkKey("sk", "test", "runme"),
      keySource: "STRIPE_TEST_SECRET_KEY",
    });
  });

  it("RUNS with a restricted TEST key (rk_test_)", () => {
    const d = evaluateSandboxGate({
      [SANDBOX_ENABLE_VAR]: "1",
      STRIPE_SECRET_KEY: mkKey("rk", "test", "restricted"),
    });
    expect(d.action).toBe("run");
    if (d.action === "run") expect(d.keySource).toBe("STRIPE_SECRET_KEY");
  });
});
