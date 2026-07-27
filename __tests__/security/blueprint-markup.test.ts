import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Blueprint Markup — source-contract security proofs. Lock the DB-enforced
 * geometry/tenancy/lifecycle invariants + the service trust boundaries at the
 * source, so a future edit weakening them fails CI. Behaviour is proven against
 * real Postgres in __tests__/integration/rls/blueprint-markup.test.ts.
 */

const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/20261017000000_blueprint_markup.sql"), "utf8");
const service = readFileSync(join(root, "server/services/blueprint-markup.ts"), "utf8");

describe("blueprint_markup migration — geometry + tenant integrity", () => {
  it("guards the (id, org_id) candidate key with `if not exists` (already added by pins — no double-add)", () => {
    expect(migration).toMatch(/if not exists \(select 1 from pg_constraint where conname = 'blueprint_versions_id_org_key'\)/i);
    expect((migration.match(/add constraint blueprint_versions_id_org_key unique/gi) ?? []).length).toBe(1);
  });

  it("anchors to the immutable version via a composite FK on (version_id, org_id)", () => {
    expect(migration).toMatch(/foreign key\s*\(blueprint_version_id,\s*org_id\)\s*references\s+public\.blueprint_versions\s*\(id,\s*org_id\)/i);
    expect(migration).toMatch(/blueprint_version_id\s+uuid\s+not null/i);
  });

  it("lists exactly the six shapes the geometry lib defines", () => {
    expect(migration).toMatch(/shape\s+text\s+not null[\s\S]*?check \(shape in \('freehand','line','arrow','rect','ellipse','text'\)\)/i);
  });

  it("derives bbox + tenancy server-side in a SECURITY DEFINER trigger (client values ignored)", () => {
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = public/i);
    expect(migration).toMatch(/new\.org_id\s*:=\s*v_org/i);
    expect(migration).toMatch(/new\.job_id\s*:=\s*v_job/i);
    expect(migration).toMatch(/new\.bbox_u\s*:=\s*v_min_u/i);
    expect(migration).toMatch(/before insert or update on public\.blueprint_markup/i);
  });

  it("validates geom point-count per shape + [0,1] range + a DoS cap in the trigger/CHECK", () => {
    expect(migration).toMatch(/requires exactly 2 points/i);
    expect(migration).toMatch(/is outside \[0,1\]/i);
    expect(migration).toMatch(/jsonb_array_length\(geom->'points'\) between 1 and 2000/i);
  });

  it("freezes the anchor (version/page) on UPDATE", () => {
    expect(migration).toMatch(/anchor \(version\/page\) is immutable/i);
    expect(migration).toMatch(/is distinct from old\.blueprint_version_id/i);
  });

  it("stamps created_by/updated_by from auth.uid() (unspoofable attribution)", () => {
    expect(migration).toMatch(/new\.created_by\s*:=\s*coalesce\(auth\.uid\(\)/i);
    expect(migration).toMatch(/new\.updated_by\s*:=\s*coalesce\(auth\.uid\(\)/i);
  });

  it("enforces text payload, colour, stroke, and soft-delete consistency CHECKs", () => {
    expect(migration).toMatch(/color\s+text\s+not null\s+default\s+'#ef4444'\s+check \(color ~ '\^#\[0-9a-fA-F\]\{6\}\$'\)/i);
    expect(migration).toMatch(/stroke_width\s+smallint\s+not null[\s\S]*?between 1 and 12/i);
    expect(migration).toMatch(/char_length\(btrim\(text_content\)\) between 1 and 500/i);
    expect(migration).toMatch(/status = 'removed' and deleted_at is not null/i);
  });

  it("RLS: members select/insert/update; hard delete admin-only", () => {
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/for update using \(org_id in \(select public\.current_org_ids\(\)\)\)/i);
    expect(migration).toMatch(/for delete using \(public\.is_org_admin\(org_id\)\)/i);
  });
});

describe("blueprint_markup service — trust boundaries", () => {
  it("writes through the tenant client, not the service-role admin client", () => {
    expect(service).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(service).not.toMatch(/createAdminClient|service-role|createServiceClient/);
  });

  it("omits org_id/job_id/bbox from the insert (the trigger is the authority)", () => {
    const insertBlock = service.slice(service.indexOf(".insert({"), service.indexOf('.select("id")'));
    expect(insertBlock).not.toMatch(/org_id|job_id|bbox_/);
  });

  it("audits via recordAdminActivity (create/remove/delete), NOT _record_activity, never on read", () => {
    expect(service).toMatch(/recordAdminActivity/);
    expect(service).not.toMatch(/_record_activity/);
    expect(service).toMatch(/blueprint_markup\.created/);
    expect(service).toMatch(/blueprint_markup\.removed/);
    expect(service).toMatch(/blueprint_markup\.deleted/);
  });

  it("soft-remove is an UPDATE to status='removed'; admin hard-delete is count-gated", () => {
    expect(service).toMatch(/status: "removed"/);
    expect(service).toMatch(/delete\(\{ count: "exact" \}\)/);
    expect(service).toMatch(/if \(!count\)/);
  });

  it("quantises points before insert so client + DB bbox agree", () => {
    expect(service).toMatch(/quantizePoints\(parsed\.data\.geom\.points\)/);
  });
});
