import { describe, expect, it } from "vitest";
import { hasLiveDb } from "./_harness";

/**
 * Wiring smoke test for the integration tier. Runs everywhere — no DB
 * required: it proves the integration vitest config + setup load and that
 * the live-DB guard resolves. The DB-dependent suites use
 * describeIntegration (see _harness.ts) and skip when no database is present.
 */
describe("integration harness wiring", () => {
  it("exposes a boolean live-DB guard", () => {
    expect(typeof hasLiveDb()).toBe("boolean");
  });

  it("agrees with the connection env it reads", () => {
    const configured =
      Boolean(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      Boolean(process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
      Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(hasLiveDb()).toBe(configured);
  });
});
