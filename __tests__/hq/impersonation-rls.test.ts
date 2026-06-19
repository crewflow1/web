import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ-10.1 — RLS-aware impersonation tests.
 *
 * Verifies the migration text pins the security invariants the
 * directive demands:
 *   * HQ super-admin's auth.uid() can read target_org via the
 *     extended current_org_ids() — but ONLY when an active session
 *     row exists for them targeting that org.
 *   * 24h hard cap is enforced in SQL (not just the cookie).
 *   * ended_at IS NULL means Exit is instant (no SQL cache to
 *     invalidate).
 *   * is_org_admin() honours impersonation too — operator can
 *     write tenant data ("sees EXACT customer state").
 *   * The original membership branch is preserved — normal
 *     customer access is untouched.
 *   * SECURITY DEFINER so the function bypasses
 *     impersonation_sessions's RLS (which has no policies).
 *   * Performance: admin_user_id partial index added for the new
 *     RLS lookup.
 *   * Customer cannot impersonate — INSERTs into
 *     impersonation_sessions are gated by the super-admin server
 *     action (pinned by the existing HQ-10 impersonation tests).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260614000000_impersonation_rls_aware.sql");

// =====================================================================
// current_org_ids() is augmented
// =====================================================================

describe("HQ-10.1 — current_org_ids() includes active impersonation targets", () => {
  it("redefines current_org_ids()", () => {
    expect(MIGRATION).toMatch(
      /create or replace function public\.current_org_ids\(\)/,
    );
  });

  it("normal membership branch preserved (customer access untouched)", () => {
    expect(MIGRATION).toMatch(
      /select org_id from public\.memberships where user_id = auth\.uid\(\)/,
    );
  });

  it("UNIONs the active impersonation target org", () => {
    expect(MIGRATION).toMatch(/union[\s\S]*select target_org_id[\s\S]*from public\.impersonation_sessions/);
  });

  it("scoped to the CURRENT auth.uid (no cross-admin leak)", () => {
    expect(MIGRATION).toMatch(/admin_user_id = auth\.uid\(\)/);
  });

  it("only ACTIVE sessions (ended_at is null)", () => {
    expect(MIGRATION).toMatch(/ended_at is null/);
  });

  it("24h hard cap enforced in SQL — stale sessions stop granting access", () => {
    expect(MIGRATION).toMatch(/started_at > now\(\) - interval '24 hours'/);
  });

  it("SECURITY DEFINER so the function can read impersonation_sessions (RLS+no-policies)", () => {
    expect(MIGRATION).toMatch(/security definer/);
  });
});

// =====================================================================
// is_org_admin() honours impersonation
// =====================================================================

describe("HQ-10.1 — is_org_admin() recognises active impersonation", () => {
  it("redefines is_org_admin", () => {
    expect(MIGRATION).toMatch(
      /create or replace function public\.is_org_admin\(target_org uuid\)/,
    );
  });

  it("preserves the legacy membership-based admin path", () => {
    expect(MIGRATION).toMatch(/role in \('owner', 'admin'\)/);
  });

  it("OR-clauses an active-impersonation existence check", () => {
    // The OR in the function body lets operators with active
    // impersonation update tenant data (the directive's "EXACT
    // customer state").
    expect(MIGRATION).toMatch(/exists \([\s\S]*impersonation_sessions[\s\S]*target_org_id = target_org/);
  });

  it("impersonation-side admin grant also bounded by 24h", () => {
    // Count the 24h gate occurrences — once in current_org_ids,
    // once in is_org_admin.
    const occurrences = (MIGRATION.match(/started_at > now\(\) - interval '24 hours'/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

// =====================================================================
// Performance index
// =====================================================================

describe("HQ-10.1 — performance index for the new RLS lookup", () => {
  it("partial index on admin_user_id where ended_at is null", () => {
    expect(MIGRATION).toMatch(/impersonation_sessions_admin_active_idx/);
    expect(MIGRATION).toMatch(
      /on public\.impersonation_sessions \(admin_user_id, started_at desc\)[\s\S]*where ended_at is null/,
    );
  });
});

// =====================================================================
// Customer-side guarantees (regression pins from HQ-10)
// =====================================================================

describe("HQ-10.1 — customer cannot impersonate (regression pin)", () => {
  // Customers can't insert into impersonation_sessions because:
  //   1. RLS on impersonation_sessions has NO policies (service-role only)
  //   2. The server action gates on isSuperAdminEmail
  // Re-confirm both are in place.
  it("impersonation_sessions still service-role only (no policies)", () => {
    const hq10Migration = read(
      "supabase/migrations/20260613000000_impersonation_sessions.sql",
    );
    expect(hq10Migration).toMatch(
      /alter table public\.impersonation_sessions enable row level security/,
    );
    expect(hq10Migration).not.toMatch(/create policy/i);
  });

  it("start action still gates on HQ access via requireHq()", () => {
    const actions = read("app/admin/impersonation/actions.ts");
    expect(actions).toMatch(/import \{ requireHq \} from "@\/server\/auth\/hq"/);
    expect(actions).toMatch(/requireHq\(\)/);
  });
});
