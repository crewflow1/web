import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Marketplace migration CONTRACT — hermetic SQL-text pins (no DB).
 *
 * These freeze the load-bearing invariants of the two marketplace migrations so
 * a future edit that weakens them fails CI: the composite (id, org_id) FKs that
 * make cross-tenant binding unrepresentable, the consent + approval gates, the
 * uninstall revocation of the entitlement rows AND the bound key, the audit
 * calls, and the service-role-only review grant.
 */

const ROOT = resolve(__dirname, "..", "..");
const M1 = readFileSync(
  resolve(ROOT, "supabase/migrations/20261195000000_marketplace_partners_listings.sql"),
  "utf8",
);
const M2 = readFileSync(
  resolve(ROOT, "supabase/migrations/20261196000000_marketplace_installs_entitlements.sql"),
  "utf8",
);

/** Collapse whitespace so multi-line SQL clauses match a single-line probe. */
const flat = (s: string) => s.replace(/\s+/g, " ");
const F1 = flat(M1);
const F2 = flat(M2);

describe("partners + listings migration (20261195000000)", () => {
  it("creates all four required entities across the two migrations", () => {
    expect(M1).toMatch(/create table if not exists public\.marketplace_partners/);
    expect(M1).toMatch(/create table if not exists public\.marketplace_listings/);
    expect(M2).toMatch(/create table if not exists public\.marketplace_installs/);
    expect(M2).toMatch(/create table if not exists public\.marketplace_entitlements/);
  });

  it("partners is org-scoped with a composite (id, org_id) candidate key", () => {
    expect(F1).toMatch(/org_id uuid not null references public\.organizations\(id\) on delete cascade/);
    expect(F1).toMatch(/constraint marketplace_partners_id_org_key unique \(id, org_id\)/);
  });

  it("listings carry NO org_id (global catalogue) and require app-validated scopes", () => {
    // No org_id column declared on the listings table body.
    const listingsBody = M1.slice(M1.indexOf("create table if not exists public.marketplace_listings"));
    expect(listingsBody.slice(0, listingsBody.indexOf(");"))).not.toMatch(/^\s*org_id\s/m);
    expect(F1).toMatch(/requested_scopes text\[\] not null/);
  });

  it("RLS enabled on both tables; discovery reads ONLY approved listings", () => {
    expect(F1).toMatch(/alter table public\.marketplace_partners enable row level security/);
    expect(F1).toMatch(/alter table public\.marketplace_listings enable row level security/);
    // Discovery policy admits approved listings.
    expect(F1).toMatch(/marketplace_listings: discover approved/);
    expect(F1).toMatch(/status = 'approved'/);
  });

  it("THE APPROVAL GATE: status is withheld from the tenant update grant", () => {
    // Tenant update grant lists editable metadata columns and must NOT include status.
    const grant = F1.match(/grant update \(([^)]*)\) on public\.marketplace_listings to authenticated/);
    expect(grant).toBeTruthy();
    expect(grant![1]).not.toMatch(/\bstatus\b/);
    expect(grant![1]).toMatch(/name/);
  });

  it("THE APPROVAL GATE: review RPC is service-role ONLY (no tenant execute)", () => {
    expect(F1).toMatch(/create or replace function public\.marketplace_review_listing/);
    expect(F1).toMatch(
      /revoke all on function public\.marketplace_review_listing\([^)]*\) from public, anon, authenticated/,
    );
    expect(F1).toMatch(
      /grant execute on function public\.marketplace_review_listing\([^)]*\) to service_role/,
    );
    // And it is NOT granted to authenticated anywhere.
    expect(F1).not.toMatch(/grant execute on function public\.marketplace_review_listing\([^)]*\) to authenticated/);
  });

  it("status transitions are guarded for every role (no draft → approved jump)", () => {
    expect(F1).toMatch(/tg_marketplace_listings_guard/);
    expect(F1).toMatch(/illegal listing status transition/);
    expect(F1).toMatch(/old\.status = 'pending_review' and new\.status in \('approved', 'rejected'\)/);
  });

  it("submit RPC only moves draft → pending_review and checks admin-of-owner-org", () => {
    expect(F1).toMatch(/create or replace function public\.marketplace_submit_listing/);
    expect(F1).toMatch(/is_org_admin\(p_org_id\)/);
    expect(F1).toMatch(/status = 'pending_review'/);
  });
});

describe("installs + entitlements migration (20261196000000)", () => {
  it("CROSS-TENANT ISOLATION: the bound key is pinned by a composite (api_key_id, org_id) FK", () => {
    expect(F2).toMatch(
      /foreign key \(api_key_id, org_id\) references public\.api_keys \(id, org_id\)/,
    );
  });

  it("entitlements bind (install_id, org_id) → marketplace_installs(id, org_id)", () => {
    expect(F2).toMatch(
      /foreign key \(install_id, org_id\) references public\.marketplace_installs \(id, org_id\) on delete cascade/,
    );
  });

  it("installs + entitlements are org-scoped with composite candidate keys + RLS", () => {
    expect(F2).toMatch(/constraint marketplace_installs_id_org_key unique \(id, org_id\)/);
    expect(F2).toMatch(/constraint marketplace_entitlements_id_org_key unique \(id, org_id\)/);
    expect(F2).toMatch(/alter table public\.marketplace_installs enable row level security/);
    expect(F2).toMatch(/alter table public\.marketplace_entitlements enable row level security/);
  });

  it("NO tenant write grant on installs/entitlements (RPC-only lifecycle)", () => {
    expect(F2).toMatch(
      /revoke insert, update, delete, truncate, references, trigger on table public\.marketplace_installs from authenticated/,
    );
    expect(F2).toMatch(
      /revoke insert, update, delete, truncate, references, trigger on table public\.marketplace_entitlements from authenticated/,
    );
    // Admin-only select only.
    expect(F2).toMatch(/marketplace_installs: admins select/);
    expect(F2).toMatch(/is_org_admin\(org_id\)/);
  });

  it("THE CONSENT GATE: install RPC reads requested_scopes from the listing + requires exact-set equality + approved", () => {
    expect(F2).toMatch(/create or replace function public\.marketplace_install_with_consent/);
    // Reads the listing's requested scopes (source of truth, not the client).
    expect(F2).toMatch(/select status, requested_scopes/);
    // Refuses a non-approved listing.
    expect(F2).toMatch(/v_status <> 'approved'/);
    expect(F2).toMatch(/'not_installable'/);
    // Exact-set equality between consented + requested (containment both ways).
    expect(F2).toMatch(/p_consented_scopes <@ v_req and v_req <@ p_consented_scopes/);
    expect(F2).toMatch(/'scope_mismatch'/);
    // The bound key + entitlements are minted from the LISTING's requested set.
    expect(F2).toMatch(/insert into public\.api_keys \(org_id, name, key_prefix, key_hash, scopes, created_by\)/);
    expect(F2).toMatch(/insert into public\.marketplace_entitlements/);
  });

  it("install RPC is service-role ONLY", () => {
    expect(F2).toMatch(
      /revoke all on function public\.marketplace_install_with_consent\([^)]*\) from public, anon, authenticated/,
    );
    expect(F2).toMatch(
      /grant execute on function public\.marketplace_install_with_consent\([^)]*\) to service_role/,
    );
  });

  it("UNINSTALL revokes the entitlement rows AND the bound key AND pauses the webhook", () => {
    expect(F2).toMatch(/create or replace function public\.marketplace_uninstall/);
    // The bound key is revoked (org-pinned).
    expect(F2).toMatch(/update public\.api_keys set revoked_at = now\(\) where id = v_key_id and org_id = p_org_id/);
    // Entitlements flipped to revoked.
    expect(F2).toMatch(/update public\.marketplace_entitlements set status = 'revoked'/);
    // Install marked terminal.
    expect(F2).toMatch(/status = 'uninstalled'/);
    // Webhook endpoint paused so events stop routing to the removed app.
    expect(F2).toMatch(/update public\.webhook_endpoints set status = 'paused'/);
    expect(F2).toMatch(
      /grant execute on function public\.marketplace_uninstall\([^)]*\) to service_role/,
    );
  });

  it("uninstall is terminal (a uninstalled install cannot change status again)", () => {
    expect(F2).toMatch(/old\.status = 'uninstalled' and new\.status is distinct from old\.status/);
  });

  it("AUDIT: install + uninstall record into the org activity feed", () => {
    expect(F2).toMatch(/_record_activity\( p_org_id, 'marketplace\.installed'/);
    expect(F2).toMatch(/_record_activity\( p_org_id, 'marketplace\.uninstalled'/);
  });

  it("optional webhook endpoint is bound same-org (trigger) and born paused", () => {
    expect(F2).toMatch(/webhook endpoint must belong to the same org as the install/);
    expect(F2).toMatch(/'paused'/);
    expect(F2).toMatch(/webhook_enqueue_ping/);
  });
});
