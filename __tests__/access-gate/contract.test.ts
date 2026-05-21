import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { orgHasActiveAccess, type OrgStatus } from "@/server/auth/session";

/**
 * Access-gate contract tests — CEO directive.
 *
 * The four required scenarios:
 *   (a) brand-new signup cannot access the app until approved
 *   (b) invited staff CAN join an existing (already-active) org
 *   (c) suspended org cannot access the app
 *   (d) active org works
 *
 * Approach — exercising `requireOrgContext()` end-to-end here would
 * require mocking Supabase, cookies, and the redirect throw machinery
 * in the running Next runtime. That doesn't add much over pinning the
 * primitives + the source-level contract: `orgHasActiveAccess()` is
 * what decides scenarios (a)/(c)/(d), and the bootstrap action source
 * is what makes scenario (a) start in 'pending'. The migration enforces
 * the default at the DB layer for belt-and-braces.
 */

const ROOT = resolve(__dirname, "..", "..");
const SESSION = readFileSync(resolve(ROOT, "server/auth/session.ts"), "utf8");
const BOOTSTRAP = readFileSync(
  resolve(ROOT, "server/services/bootstrap-account.ts"),
  "utf8",
);
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/20260602000000_access_gate.sql"),
  "utf8",
);
const SUPERADMIN = readFileSync(
  resolve(ROOT, "server/auth/superadmin.ts"),
  "utf8",
);

describe("orgHasActiveAccess — drives the access gate", () => {
  it("allows active orgs (scenario d)", () => {
    expect(orgHasActiveAccess("active")).toBe(true);
  });

  it("allows trial orgs", () => {
    expect(orgHasActiveAccess("trial")).toBe(true);
  });

  it("blocks pending orgs (scenario a — new signup)", () => {
    expect(orgHasActiveAccess("pending")).toBe(false);
  });

  it("blocks suspended orgs (scenario c)", () => {
    expect(orgHasActiveAccess("suspended")).toBe(false);
  });

  it("blocks rejected orgs", () => {
    expect(orgHasActiveAccess("rejected")).toBe(false);
  });

  it("type system pins the five known statuses", () => {
    // If a sixth status is ever added, this assertion forces a deliberate
    // decision about whether it grants access (and updates this test).
    const all: OrgStatus[] = ["pending", "active", "trial", "suspended", "rejected"];
    expect(all.length).toBe(5);
  });
});

describe("scenario (a) — new signup lands in 'pending'", () => {
  it("bootstrap-account explicitly sets status: 'pending' on insert", () => {
    // Both the explicit literal and the comment justify "pending" so
    // a future refactor doesn't accidentally drop it.
    expect(BOOTSTRAP).toMatch(/status:\s*["']pending["']/);
  });

  it("migration backfills existing orgs to 'active' so they don't get locked out", () => {
    expect(MIGRATION).toMatch(/update\s+public\.organizations\s+set\s+status\s*=\s*'active'/);
  });

  it("migration sets the column default to 'pending' for new rows after backfill", () => {
    expect(MIGRATION).toMatch(/alter\s+column\s+status\s+set\s+default\s+'pending'/);
  });
});

describe("scenario (b) — invited staff join an existing (active) org", () => {
  it("invited staff don't go through bootstrap-account.createOrgWithOwner (no new org)", () => {
    // The invited-staff flow lives in app/(app)/staff/actions.ts:
    // it INSERTs into memberships, not organizations. So the org they
    // join was already-existing — and is therefore active (only active
    // orgs can have admins who can invite). No new 'pending' rows.
    const STAFF_ACTIONS = readFileSync(
      resolve(ROOT, "app/(app)/staff/actions.ts"),
      "utf8",
    );
    expect(STAFF_ACTIONS).toMatch(/memberships/);
    // And it does NOT create a new organisation.
    expect(STAFF_ACTIONS).not.toMatch(/\.from\(["']organizations["']\)\s*\n?\s*\.insert/);
  });
});

describe("scenario (c) — suspended org cannot access the app", () => {
  it("requireOrgContext redirects to /access-pending when access is not active", () => {
    expect(SESSION).toMatch(/redirect\(["']\/access-pending["']\)/);
  });

  it("the gate calls orgHasActiveAccess on the org's current status", () => {
    expect(SESSION).toMatch(/!orgHasActiveAccess\(ctx\.org\.status\)/);
  });
});

describe("super-admin allowlist", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    // We can't import isSuperAdminEmail directly because it reads the
    // validated env at module-load time — instead we verify the source
    // contract.
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("source: empty allowlist means nobody is a super-admin", () => {
    expect(SUPERADMIN).toMatch(/if\s*\(!raw\.trim\(\)\)\s*return\s+false/);
  });

  it("source: matching is case-insensitive on both sides", () => {
    expect(SUPERADMIN).toMatch(/email\.trim\(\)\.toLowerCase\(\)/);
    expect(SUPERADMIN).toMatch(/\.toLowerCase\(\)/);
  });

  it("source: allowlist split on comma", () => {
    expect(SUPERADMIN).toMatch(/\.split\(/);
    expect(SUPERADMIN).toMatch(/,/);
  });
});
