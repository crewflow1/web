import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Health & Safety (RAMS) — security source-contracts. The runtime behaviour is
 * proven against real Postgres in __tests__/integration/health-safety + rls; these
 * lock the load-bearing rules at the source so a regression fails CI.
 */

const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/20261018000000_health_safety_rams.sql"), "utf8");
const actions = readFileSync(join(root, "app/(app)/health-safety/actions.ts"), "utf8");
const data = readFileSync(join(root, "app/(app)/health-safety/_data.ts"), "utf8");

describe("migration — tenant isolation + immutability are DB-enforced", () => {
  it("RLS is enabled on both RAMS tables", () => {
    expect(migration).toMatch(/alter table public\.risk_assessments\s+enable row level security/);
    expect(migration).toMatch(/alter table public\.risk_assessment_hazards enable row level security/);
  });
  it("every policy is scoped by org membership (current_org_ids) / is_org_admin", () => {
    expect(migration).toMatch(/current_org_ids\(\)/);
    expect(migration).toMatch(/is_org_admin\(org_id\)/); // admin-only hard delete on the header
  });
  it("hazards carry a composite-FK tenant integrity to their parent (id, org_id)", () => {
    expect(migration).toMatch(/references public\.risk_assessments \(id, org_id\)/);
    expect(migration).toMatch(/unique \(id, org_id\)/);
  });
  it("a hazard's org_id is trigger-derived from its parent, never trusted from the client", () => {
    expect(migration).toMatch(/tg_rah_derive_org/);
    expect(migration).toMatch(/new\.org_id\s*:=\s*parent_org/);
  });
  it("the optional job link is validated same-org", () => {
    expect(migration).toMatch(/tg_ra_validate_job_org/);
    expect(migration).toMatch(/does not belong to this organisation/);
  });
  it("issued records are immutable at the DB (content frozen, forward-only status)", () => {
    expect(migration).toMatch(/tg_ra_immutable_when_issued/);
    expect(migration).toMatch(/is immutable; raise a new revision instead/);
    // the reference/issue CHECKs that stop a draft skipping straight to a terminal state
    expect(migration).toMatch(/\(status = 'draft'\) = \(reference is null\)/);
  });
  it("every SECURITY DEFINER function pins search_path (no mutable-path escalation)", () => {
    const defs = migration.match(/security definer/g) ?? [];
    const pins = migration.match(/set search_path = public/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThanOrEqual(defs.length);
  });
});

describe("server actions — RLS-scoped, never service-role", () => {
  it("all writes go through the tenant (user-JWT) client, never the service-role client", () => {
    expect(actions).toMatch(/from "@\/lib\/supabase\/server"/);
    // match CODE identifiers only — prose like "service-role" in a doc comment is fine
    expect(actions).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
    expect(data).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });
  it("mutations are gated by requireOrgContext + org_id, and count-checked (no false success)", () => {
    expect(actions).toMatch(/requireOrgContext\(\)/);
    expect(actions).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(actions).toMatch(/if \(!count\)/);
  });
  it("issuing re-checks readiness (canIssue) before allocating a number", () => {
    expect(actions).toMatch(/canIssue\(/);
    expect(actions).toMatch(/next_ra_number/);
  });
});
