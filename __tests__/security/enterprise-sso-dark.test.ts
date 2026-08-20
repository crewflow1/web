import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isEnterpriseSsoEnabled } from "@/lib/enterprise-sso/flag";
import { loadLiveSsoConfig, resolveScimConfigByToken } from "@/lib/enterprise-sso/config";
import { KNOWN_ORG_SCOPED_TABLES, EXCLUDED_FROM_EXPORT } from "@/lib/gdpr/export-tables";

/**
 * Enterprise SSO + SCIM — DARK-by-default proofs (hermetic, no DB).
 *
 * The default env has FEATURE_ENTERPRISE_SSO unset (→ "false"). These prove the
 * surface does not exist while off (routes 404 / SCIM 401), the config gates
 * fail closed BEFORE any DB access, the migration is deny-by-default + RLS +
 * secret-withholding + adds NO anon SECURITY DEFINER RPC, and the new tables are
 * classified in the GDPR census.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/20261211000000_enterprise_sso_scim.sql"),
  "utf8",
);
const flat = (s: string) => s.replace(/\s+/g, " ");
const M = flat(MIGRATION);

describe("feature flag defaults OFF", () => {
  it("isEnterpriseSsoEnabled() is false by default", () => {
    expect(isEnterpriseSsoEnabled()).toBe(false);
  });

  it("loadLiveSsoConfig fails closed (null) with the flag off — no DB touched", async () => {
    await expect(loadLiveSsoConfig("00000000-0000-0000-0000-000000000000", "saml")).resolves.toBeNull();
    await expect(loadLiveSsoConfig("00000000-0000-0000-0000-000000000000", "oidc")).resolves.toBeNull();
  });

  it("resolveScimConfigByToken fails closed (null) with the flag off", async () => {
    await expect(resolveScimConfigByToken("anything")).resolves.toBeNull();
    await expect(resolveScimConfigByToken(null)).resolves.toBeNull();
  });
});

describe("routes deny while dark", () => {
  const ctx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

  it("SAML metadata + ACS + OIDC start return 404", async () => {
    const meta = await import("@/app/api/sso/saml/[orgId]/metadata/route");
    const acs = await import("@/app/api/sso/saml/[orgId]/acs/route");
    const start = await import("@/app/api/sso/oidc/[orgId]/start/route");

    const metaRes = await meta.GET(
      new Request("https://app.example.com/api/sso/saml/org1/metadata") as never,
      ctx("org1"),
    );
    expect(metaRes.status).toBe(404);

    const acsRes = await acs.POST(
      new Request("https://app.example.com/api/sso/saml/org1/acs", { method: "POST" }) as never,
      ctx("org1"),
    );
    expect(acsRes.status).toBe(404);

    const startRes = await start.GET(
      new Request("https://app.example.com/api/sso/oidc/org1/start") as never,
      ctx("org1"),
    );
    expect(startRes.status).toBe(404);
  });

  it("SCIM Users + Groups return 401 (bearer auth fails closed)", async () => {
    const users = await import("@/app/scim/v2/Users/route");
    const groups = await import("@/app/scim/v2/Groups/route");

    const uRes = await users.GET(
      new Request("https://app.example.com/scim/v2/Users", {
        headers: { authorization: "Bearer crewflow_sk_whatever" },
      }),
    );
    expect(uRes.status).toBe(401);

    const gRes = await groups.GET(new Request("https://app.example.com/scim/v2/Groups"));
    expect(gRes.status).toBe(401);
  });
});

describe("migration 20261211000000 — deny-by-default + RLS + secret handling", () => {
  it("creates the four tables (incl. the replay guard)", () => {
    expect(M).toMatch(/create table if not exists public\.org_sso_config/);
    expect(M).toMatch(/create table if not exists public\.org_scim_config/);
    expect(M).toMatch(/create table if not exists public\.sso_provisioning_audit/);
    expect(M).toMatch(/create table if not exists public\.sso_consumed_assertions/);
  });

  it("REPLAY guard (F1): consumed-assertions table is UNIQUE (org_id, assertion_id), RLS, no anon, no tenant write", () => {
    expect(M).toMatch(
      /constraint sso_consumed_assertions_org_assertion_key unique \(org_id, assertion_id\)/,
    );
    expect(M).toMatch(/constraint sso_consumed_assertions_id_org_key unique \(id, org_id\)/);
    expect(M).toMatch(/alter table public\.sso_consumed_assertions enable row level security/);
    expect(M).toMatch(/revoke all on table public\.sso_consumed_assertions from anon/);
    expect(M).toMatch(
      /revoke insert, update, delete on table public\.sso_consumed_assertions from authenticated/,
    );
    // No authenticated write policy on the replay table.
    expect(M).not.toMatch(/on public\.sso_consumed_assertions for insert to authenticated/);
    expect(M).not.toMatch(/on public\.sso_consumed_assertions for update to authenticated/);
  });

  it("both config switches default OFF (deny-by-default)", () => {
    // Two `enabled boolean not null default false` declarations (one per config).
    const matches = M.match(/enabled\s+boolean not null default false/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("org_id FKs cascade to organizations; config tables carry composite (id, org_id)", () => {
    expect(M).toMatch(/org_id uuid not null references public\.organizations\(id\) on delete cascade/);
    expect(M).toMatch(/constraint org_sso_config_id_org_key unique \(id, org_id\)/);
    expect(M).toMatch(/constraint org_scim_config_id_org_key unique \(id, org_id\)/);
  });

  it("RLS is enabled on all four tables", () => {
    expect(M).toMatch(/alter table public\.org_sso_config enable row level security/);
    expect(M).toMatch(/alter table public\.org_scim_config enable row level security/);
    expect(M).toMatch(/alter table public\.sso_provisioning_audit enable row level security/);
    expect(M).toMatch(/alter table public\.sso_consumed_assertions enable row level security/);
  });

  it("no anon access, and no tenant WRITE policy (writes are service-role only)", () => {
    expect(M).toMatch(/revoke all on table public\.org_sso_config from anon/);
    expect(M).toMatch(/revoke all on table public\.org_scim_config from anon/);
    expect(M).toMatch(/revoke insert, update, delete on table public\.org_sso_config from authenticated/);
    // There must be NO authenticated insert/update policy on these tables.
    expect(M).not.toMatch(/on public\.org_sso_config for insert to authenticated/);
    expect(M).not.toMatch(/on public\.org_sso_config for update to authenticated/);
    expect(M).not.toMatch(/on public\.org_scim_config for insert to authenticated/);
    expect(M).not.toMatch(/on public\.org_scim_config for update to authenticated/);
  });

  it("secret columns are WITHHELD from the authenticated select grant", () => {
    const ssoGrant = M.match(
      /grant select \(([^)]*)\)\s*on public\.org_sso_config to authenticated/,
    );
    expect(ssoGrant).toBeTruthy();
    expect(ssoGrant![1]).not.toMatch(/oidc_client_secret_ciphertext/);

    const scimGrant = M.match(
      /grant select \(([^)]*)\)\s*on public\.org_scim_config to authenticated/,
    );
    expect(scimGrant).toBeTruthy();
    expect(scimGrant![1]).not.toMatch(/token_hash/);
  });

  it("adds NO SECURITY DEFINER function (no new anon/authenticated RPC to guard)", () => {
    // Strip SQL comment lines (the header explains why there are none) and check
    // the executable SQL introduces no SECURITY DEFINER function.
    const executable = MIGRATION.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(executable).not.toContain("security definer");
  });
});

describe("GDPR census classifies the new tables (excluded, security config)", () => {
  it("all four are KNOWN and EXCLUDED with a reason", () => {
    for (const t of [
      "org_sso_config",
      "org_scim_config",
      "sso_provisioning_audit",
      "sso_consumed_assertions",
    ]) {
      expect(KNOWN_ORG_SCOPED_TABLES).toContain(t);
      expect(EXCLUDED_FROM_EXPORT[t]).toBeTruthy();
      expect(typeof EXCLUDED_FROM_EXPORT[t]).toBe("string");
    }
  });
});
