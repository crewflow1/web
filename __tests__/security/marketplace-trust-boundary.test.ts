import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_ORG_SCOPED_TABLES, EXCLUDED_FROM_EXPORT } from "@/lib/gdpr/export-tables";

/**
 * Marketplace TRUST-BOUNDARY proofs (security tier, hermetic).
 *
 * The marketplace introduces a cross-org install primitive (a tenant grants a
 * third-party app scoped access to its data via an install-bound API key). This
 * file pins the boundaries that keep one tenant's install from ever reaching
 * another tenant, keep self-approval unrepresentable, and keep the credential
 * off the tenant read path — the same stance as api_keys (20261086) + webhooks
 * (20261087), which this feature integrates with rather than reinvents.
 */

const ROOT = resolve(__dirname, "..", "..");
const M1 = readFileSync(
  resolve(ROOT, "supabase/migrations/20261195000000_marketplace_partners_listings.sql"),
  "utf8",
).replace(/\s+/g, " ");
const M2 = readFileSync(
  resolve(ROOT, "supabase/migrations/20261196000000_marketplace_installs_entitlements.sql"),
  "utf8",
).replace(/\s+/g, " ");

describe("cross-tenant isolation — an install of org A can never reach org B", () => {
  it("the install→key binding is a composite (api_key_id, org_id) FK (same-org, structural)", () => {
    expect(M2).toMatch(/foreign key \(api_key_id, org_id\) references public\.api_keys \(id, org_id\)/);
  });
  it("entitlements bind (install_id, org_id) → installs(id, org_id) — no cross-org child", () => {
    expect(M2).toMatch(/foreign key \(install_id, org_id\) references public\.marketplace_installs \(id, org_id\)/);
  });
  it("the optional webhook endpoint is verified same-org by the install guard trigger", () => {
    expect(M2).toMatch(/webhook endpoint must belong to the same org as the install/);
  });
  it("every marketplace RPC that mutates is org-pinned to a passed p_org_id", () => {
    // install + uninstall both take p_org_id and pin writes to it.
    expect(M2).toMatch(/marketplace_install_with_consent\( p_org_id uuid/);
    expect(M2).toMatch(/marketplace_uninstall\( p_org_id uuid/);
    expect(M2).toMatch(/where id = p_install_id and org_id = p_org_id/);
  });
});

describe("the approval gate — a tenant can never self-approve a listing", () => {
  it("status is NOT in the authenticated update grant on listings", () => {
    const grant = M1.match(/grant update \(([^)]*)\) on public\.marketplace_listings to authenticated/);
    expect(grant).toBeTruthy();
    expect(grant![1]).not.toMatch(/\bstatus\b/);
  });
  it("the review RPC is granted to service_role ONLY", () => {
    expect(M1).toMatch(/grant execute on function public\.marketplace_review_listing\([^)]*\) to service_role/);
    expect(M1).not.toMatch(/grant execute on function public\.marketplace_review_listing\([^)]*\) to authenticated/);
  });
  it("the transition trigger forbids illegal status jumps for every role", () => {
    expect(M1).toMatch(/illegal listing status transition/);
  });
});

describe("least privilege — admin-only, no tenant writes on install state", () => {
  it("partners + listings + installs + entitlements are all admin-gated (is_org_admin)", () => {
    expect(M1).toMatch(/marketplace_partners: admins select[\s\S]*?using \(public\.is_org_admin\(org_id\)\)/);
    expect(M2).toMatch(/marketplace_installs: admins select[\s\S]*?using \(public\.is_org_admin\(org_id\)\)/);
    expect(M2).toMatch(/marketplace_entitlements: admins select[\s\S]*?using \(public\.is_org_admin\(org_id\)\)/);
  });
  it("installs + entitlements have their tenant write grants revoked (RPC-only lifecycle)", () => {
    expect(M2).toMatch(/revoke insert, update, delete, truncate, references, trigger on table public\.marketplace_installs from authenticated/);
    expect(M2).toMatch(/revoke insert, update, delete, truncate, references, trigger on table public\.marketplace_entitlements from authenticated/);
  });
  it("anon has no access to any marketplace table", () => {
    expect(M1).toMatch(/revoke all on table public\.marketplace_partners from anon/);
    expect(M1).toMatch(/revoke all on table public\.marketplace_listings from anon/);
    expect(M2).toMatch(/revoke all on table public\.marketplace_installs from anon/);
    expect(M2).toMatch(/revoke all on table public\.marketplace_entitlements from anon/);
  });
});

describe("DSAR registration — new org-scoped tables are classified", () => {
  it("partners/installs/entitlements are KNOWN org-scoped tables (integration DSAR guard)", () => {
    for (const t of ["marketplace_partners", "marketplace_installs", "marketplace_entitlements"]) {
      expect(KNOWN_ORG_SCOPED_TABLES).toContain(t);
    }
  });
  it("they are tenant business data — exported, not on the credential deny-list", () => {
    for (const t of ["marketplace_partners", "marketplace_installs", "marketplace_entitlements"]) {
      expect(EXCLUDED_FROM_EXPORT[t]).toBeUndefined();
    }
  });
});
