import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Blueprint Pins — source-contract security proofs. These lock the DB-enforced
 * tenant/link invariants and the service's trust boundaries at the SOURCE, so a
 * future edit that quietly weakens them fails CI even if no behavioural test
 * happens to cover the regressed line. The behavioural proofs (real Postgres)
 * live in __tests__/integration/rls/blueprint-pins.test.ts.
 */

const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/20261016000000_blueprint_pins.sql"), "utf8");
const service = readFileSync(join(root, "server/services/blueprint-pins.ts"), "utf8");

describe("blueprint_pins migration — tenant + link integrity", () => {
  it("adds the (id, org_id) candidate keys the composite FKs require", () => {
    expect(migration).toMatch(/blueprint_versions[\s\S]*?unique\s*\(id,\s*org_id\)/i);
    expect(migration).toMatch(/snags[\s\S]*?unique\s*\(id,\s*org_id\)/i);
  });

  it("links to the version + snag with COMPOSITE FKs on (col, org_id) — the cross-tenant guard", () => {
    expect(migration).toMatch(/foreign key\s*\(blueprint_version_id,\s*org_id\)\s*references\s+public\.blueprint_versions\s*\(id,\s*org_id\)/i);
    expect(migration).toMatch(/foreign key\s*\(snag_id,\s*org_id\)\s*references\s+public\.snags\s*\(id,\s*org_id\)/i);
  });

  it("anchors to the immutable blueprint_version_id, never a bare blueprint_id column", () => {
    expect(migration).toMatch(/blueprint_version_id\s+uuid\s+not null/i);
    // no drawing-level anchor column that could silently float pins across revisions
    expect(migration).not.toMatch(/^\s*blueprint_id\s+uuid/im);
  });

  it("constrains coordinates to [0,1] and the sheet to >= 1", () => {
    expect(migration).toMatch(/u\s+double precision\s+not null\s+check\s*\(u\s*>=\s*0\s+and\s+u\s*<=\s*1\)/i);
    expect(migration).toMatch(/v\s+double precision\s+not null\s+check\s*\(v\s*>=\s*0\s+and\s+v\s*<=\s*1\)/i);
    expect(migration).toMatch(/page_number\s+integer\s+not null\s+default\s+1\s+check\s*\(page_number\s*>=\s*1\)/i);
  });

  it("derives org_id/job_id in a SECURITY DEFINER before-write trigger (client values ignored)", () => {
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = public/i);
    expect(migration).toMatch(/new\.org_id\s*:=\s*v_org/i);
    expect(migration).toMatch(/new\.job_id\s*:=\s*v_job/i);
    expect(migration).toMatch(/before insert or update on public\.blueprint_pins/i);
  });

  it("rejects a cross-JOB linked snag in the trigger", () => {
    expect(migration).toMatch(/different job/i);
  });

  it("RLS: members select/insert/update; hard delete is admin-only", () => {
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/for select using \(org_id in \(select public\.current_org_ids\(\)\)\)/i);
    expect(migration).toMatch(/for delete using \(public\.is_org_admin\(org_id\)\)/i);
  });

  it("the create-snag+pin RPC is SECURITY INVOKER (so both inserts run under the caller's RLS)", () => {
    expect(migration).toMatch(/function public\.create_blueprint_pin_with_snag/i);
    expect(migration).toMatch(/security invoker/i);
    // and is not exposed to anon
    expect(migration).toMatch(/grant execute on function public\.create_blueprint_pin_with_snag[\s\S]*?to authenticated/i);
    expect(migration).not.toMatch(/to anon/i);
  });
});

describe("blueprint_pins service — trust boundaries", () => {
  it("writes through the tenant client (RLS), not the service-role admin client", () => {
    expect(service).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(service).not.toMatch(/createAdminClient|service-role|createServiceClient/);
  });

  it("audits via recordAdminActivity — NOT the dead tenant `_record_activity` RPC", () => {
    expect(service).toMatch(/recordAdminActivity/);
    expect(service).not.toMatch(/_record_activity/);
  });

  it("does not audit pin MOVES (avoids HQ-log spam; create/link/delete only)", () => {
    expect(service).toMatch(/blueprint_pin\.created/);
    expect(service).toMatch(/blueprint_pin\.deleted/);
    // movePin must not record activity
    const moveFn = service.slice(service.indexOf("export async function movePin"), service.indexOf("export async function deletePin"));
    expect(moveFn).not.toMatch(/recordAdminActivity/);
  });

  it("count-gates the admin delete (a denied delete removes nothing)", () => {
    expect(service).toMatch(/delete\(\{ count: "exact" \}\)/);
    expect(service).toMatch(/if \(!count\)/);
  });
});
