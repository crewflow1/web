/**
 * Stripe SANDBOX lifecycle gate — the pure, I/O-free decision function that
 * decides whether (and how) the real-sandbox integration lifecycle test may run.
 *
 * It is split out from the integration test itself for two reasons:
 *   1. It is UNIT-testable without any Stripe key — the "refuses a LIVE key" and
 *      "fails loud when explicitly enabled but no key" guarantees are proven
 *      deterministically from fixtures (see sandbox-gate.test.ts), never only in
 *      a run nobody can reproduce in CI.
 *   2. The integration file consumes ONE decision, so the skip / fail / refuse /
 *      run policy lives in exactly one place and cannot drift between the gate
 *      and the suite that depends on it.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 *   • DEFAULT: the suite is OPT-IN. Without STRIPE_SANDBOX_E2E set to a truthy
 *     value it SKIPS cleanly — a normal `npm run test:integration` never touches
 *     Stripe. This is why the harness is "runnable the moment a key is provided"
 *     without changing CI's green default.
 *   • ENABLED + NO KEY → FAIL LOUD. If the operator opted in but no test key is
 *     resolvable, that is a misconfiguration, not a reason to silently pass.
 *   • ENABLED + LIVE KEY → REFUSE. A key with an `sk_live_` / `rk_live_` prefix
 *     must NEVER drive this suite: it would create real money movement. The gate
 *     refuses before a single Stripe call is made.
 *   • ENABLED + UNRECOGNISED PREFIX → REFUSE (fail-closed). Anything that is not
 *     provably a test key is treated as unsafe.
 *   • ENABLED + TEST KEY → RUN. Only an `sk_test_` / `rk_test_` key runs the
 *     lifecycle, exclusively against Stripe test mode.
 *
 * Key resolution prefers an explicit STRIPE_TEST_SECRET_KEY (unambiguous intent)
 * over STRIPE_SECRET_KEY (which, in prod, holds the LIVE restricted key — the
 * live-prefix refusal above is the backstop that makes reusing that var safe).
 */

/** The opt-in switch. The suite is inert unless this is truthy. */
export const SANDBOX_ENABLE_VAR = "STRIPE_SANDBOX_E2E" as const;

/** Env vars a test secret key may be supplied through, in resolution order. */
export const SANDBOX_KEY_VARS = [
  "STRIPE_TEST_SECRET_KEY",
  "STRIPE_SECRET_KEY",
] as const;

export type SandboxKeySource = (typeof SANDBOX_KEY_VARS)[number];

export type SandboxGateDecision =
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "refuse"; reason: string }
  | { action: "run"; secretKey: string; keySource: SandboxKeySource };

/** A minimal env bag — `process.env` satisfies this, and so do test fixtures. */
export type EnvBag = Record<string, string | undefined>;

const TEST_KEY_PREFIX = /^(sk|rk)_test_/;
const LIVE_KEY_PREFIX = /^(sk|rk)_live_/;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether the opt-in switch is set to a truthy value. */
export function isSandboxEnabled(env: EnvBag): boolean {
  const raw = (env[SANDBOX_ENABLE_VAR] ?? "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

/** Resolve the test secret key, preferring the explicit test var. */
export function resolveSandboxKey(env: EnvBag): {
  key: string | null;
  source: SandboxKeySource | null;
} {
  for (const name of SANDBOX_KEY_VARS) {
    const v = env[name]?.trim();
    if (v) return { key: v, source: name };
  }
  return { key: null, source: null };
}

/** True ONLY for an `sk_test_` / `rk_test_` key. */
export function isTestModeKey(key: string): boolean {
  return TEST_KEY_PREFIX.test(key);
}

/** True for an `sk_live_` / `rk_live_` key — standard OR restricted live. */
export function isLiveModeKey(key: string): boolean {
  return LIVE_KEY_PREFIX.test(key);
}

/**
 * The single source of truth for the sandbox suite's run policy. Pure: reads the
 * bag, touches nothing. See the file header for the full contract.
 */
export function evaluateSandboxGate(env: EnvBag): SandboxGateDecision {
  if (!isSandboxEnabled(env)) {
    return {
      action: "skip",
      reason:
        `${SANDBOX_ENABLE_VAR} is not set — the real-sandbox Stripe lifecycle ` +
        `is opt-in. Set ${SANDBOX_ENABLE_VAR}=1 with a Stripe TEST key to run it.`,
    };
  }

  const { key, source } = resolveSandboxKey(env);
  if (!key) {
    return {
      action: "fail",
      reason:
        `${SANDBOX_ENABLE_VAR} is set but no Stripe test key is configured. ` +
        `Provide STRIPE_TEST_SECRET_KEY (preferred) or STRIPE_SECRET_KEY with ` +
        `an sk_test_ / rk_test_ value.`,
    };
  }

  if (isLiveModeKey(key)) {
    return {
      action: "refuse",
      reason:
        `REFUSING to run the sandbox lifecycle: ${source} is a LIVE key ` +
        `(${key.slice(0, 8)}…). This suite must only ever touch Stripe TEST ` +
        `mode. Supply an sk_test_ / rk_test_ key.`,
    };
  }

  if (!isTestModeKey(key)) {
    return {
      action: "refuse",
      reason:
        `REFUSING to run the sandbox lifecycle: ${source} has an unrecognised ` +
        `prefix (${key.slice(0, 8)}…). Only sk_test_ / rk_test_ keys are ` +
        `accepted (fail-closed).`,
    };
  }

  return { action: "run", secretKey: key, keySource: source as SandboxKeySource };
}
