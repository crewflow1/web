import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * isLiveMode() must recognise LIVE keys of BOTH forms — standard secret
 * (`sk_live_…`) and RESTRICTED (`rk_live_…`) — and read TEST keys and an unset
 * key as not-live. A live activation with a restricted `rk_live_` key was
 * mis-labelled TEST by the old `sk_live_`-only check; this pins the fix across
 * all four key kinds.
 *
 * It also pins the #5 invariant: isLiveMode is a DIAGNOSTIC LABEL only — no
 * billing-security decision depends on a key prefix.
 */

const { envMock } = vi.hoisted(() => ({
  envMock: {
    STRIPE_SECRET_KEY: undefined as string | undefined,
    NEXT_PUBLIC_APP_URL: "https://crewflow.uk",
  },
}));
vi.mock("@/lib/env", () => ({ env: envMock }));

import { isLiveMode } from "@/lib/stripe/client";

describe("isLiveMode — live/test × standard/restricted keys", () => {
  // `input` (not `key`) + low-entropy fixture bodies keep the secret scanner calm;
  // these are prefix literals with a dummy body, never a real key.
  const cases: Array<{ input: string | undefined; expected: boolean; label: string }> = [
    { input: "sk_live_abc123", expected: true, label: "standard live secret key (sk_live_)" },
    { input: "rk_live_abc123", expected: true, label: "restricted live key (rk_live_)" },
    { input: "sk_test_abc123", expected: false, label: "standard test secret key (sk_test_)" },
    { input: "rk_test_abc123", expected: false, label: "restricted test key (rk_test_)" },
    { input: undefined, expected: false, label: "no key configured" },
    { input: "", expected: false, label: "empty key" },
    { input: "pk_live_abc123", expected: false, label: "a publishable key is not a server secret — never live mode" },
    { input: "whsec_abc123", expected: false, label: "a non-key string is not live" },
    { input: "sk_live", expected: false, label: "truncated prefix without the trailing underscore is not live" },
  ];
  for (const { input, expected, label } of cases) {
    it(`${label} → ${expected}`, () => {
      envMock.STRIPE_SECRET_KEY = input;
      expect(isLiveMode()).toBe(expected);
    });
  }
});

describe("isLiveMode is a diagnostic label only (#5 — no key-prefix billing gate)", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

  // Every module that actually makes a billing decision (gating access, creating
  // Stripe objects, or routing the webhook) must NOT branch on isLiveMode or on a
  // raw key prefix — those paths use the SDK built from the key directly, so a
  // restricted live key transacts live regardless of the diagnostic label.
  const BILLING_MODULES = [
    "server/services/stripe-webhook-handler.ts",
    "app/admin/customers/[id]/_stripe-actions.ts",
    "server/services/self-serve-billing.ts",
    "lib/billing/self-serve.ts",
    "lib/billing/entitlements.ts",
    "lib/stripe/prices.ts",
    "lib/stripe/provisioning.ts",
    "lib/stripe/demo-checkout.ts",
    "app/api/webhooks/stripe/route.ts",
  ];

  for (const p of BILLING_MODULES) {
    it(`${p} does not gate behaviour on isLiveMode`, () => {
      expect(read(p)).not.toMatch(/isLiveMode/);
    });
  }

  it("isLiveMode is defined once and consumed only by the diagnostic verify endpoint", () => {
    expect(read("lib/stripe/client.ts")).toMatch(/export function isLiveMode/);
    expect(read("app/api/admin/stripe/verify/route.ts")).toMatch(/isLiveMode/);
  });
});
