import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * RLS proof — the anonymous role must not see tenant data.
 *
 * This converts the *intent* of mocked unit tests (e.g.
 * __tests__/hq/impersonation-rls) into a real enforcement check: with RLS
 * applied by the actual migrations, a service_role client can read an
 * organisation it created, but an anon client cannot. If RLS were missing or
 * misconfigured the anon read would return the row and this test would fail.
 *
 * Runs only against a live database (describeIntegration): skips locally with
 * no DB, fails loudly in CI if the DB is missing.
 */
describeIntegration("RLS · organizations tenant isolation", () => {
  const slug = `it-rls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let orgId = "";

  beforeAll(async () => {
    const { data, error } = await serviceClient()
      .from("organizations")
      .insert({ name: "RLS Probe Org", slug })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    if (!data?.id) throw new Error("failed to create probe organisation");
    orgId = data.id;
  });

  afterAll(async () => {
    if (orgId) await serviceClient().from("organizations").delete().eq("id", orgId);
  });

  it("service_role can read the organisation it created (RLS bypassed)", async () => {
    const { data, error } = await serviceClient()
      .from("organizations")
      .select("id, name, slug")
      .eq("id", orgId);
    expect(error, error?.message).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.slug).toBe(slug);
  });

  it("anon cannot see the organisation (RLS enforced)", async () => {
    const { data, error } = await anonClient()
      .from("organizations")
      .select("id")
      .eq("id", orgId);
    // RLS filters rows rather than erroring → expect an empty result set.
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
