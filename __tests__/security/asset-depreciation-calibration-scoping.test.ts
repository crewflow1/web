import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P3W2 asset depreciation + calibration register — source-pinned invariants.
 *
 * No mock harness exists for RSC pages / server actions, so (matching the house
 * convention) the tenant-isolation, RLS, composite-FK, loud-read, F-1 and GDPR
 * invariants are pinned against SOURCE here; the runtime is proven separately in
 * the integration RLS tier. These assertions fail loudly if a future edit drops
 * an org pin, weakens an RLS posture, or forgets the registry.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const DEPR_MIG = "supabase/migrations/20261145000000_asset_depreciation.sql";
const CAL_MIG = "supabase/migrations/20261145000001_asset_calibration_certificates.sql";

describe("depreciation migration — RLS + composite FK + admin-only writes", () => {
  const sql = src(DEPR_MIG);

  it("enables RLS", () => {
    expect(sql).toMatch(/alter table public\.asset_depreciation_settings enable row level security/);
  });

  it("scopes reads to org membership and gates writes to admins", () => {
    expect(sql).toMatch(/asset_depreciation_settings_select[\s\S]*current_org_ids\(\)/);
    expect(sql).toMatch(/asset_depreciation_settings_insert[\s\S]*is_org_admin\(org_id\)/);
    expect(sql).toMatch(/asset_depreciation_settings_update[\s\S]*is_org_admin\(org_id\)/);
    expect(sql).toMatch(/asset_depreciation_settings_delete[\s\S]*is_org_admin\(org_id\)/);
  });

  it("uses a COMPOSITE FK to the assets candidate key, not a bare asset_id FK", () => {
    expect(sql).toMatch(/foreign key \(asset_id, org_id\)\s*references public\.assets \(id, org_id\)/);
  });

  it("enforces method-conditional params and salvage <= cost at the DB", () => {
    expect(sql).toMatch(/asset_depreciation_method_params_check/);
    expect(sql).toMatch(/asset_depreciation_salvage_le_cost_check/);
  });
});

describe("calibration migration — RLS + composite FKs + guarded sync trigger", () => {
  const sql = src(CAL_MIG);

  it("enables RLS with member CRUD and admin delete", () => {
    expect(sql).toMatch(/alter table public\.asset_calibration_certificates enable row level security/);
    expect(sql).toMatch(/asset_calibration_certs_select[\s\S]*current_org_ids\(\)/);
    expect(sql).toMatch(/asset_calibration_certs_insert[\s\S]*current_org_ids\(\)/);
    expect(sql).toMatch(/asset_calibration_certs_delete[\s\S]*is_org_admin\(org_id\)/);
  });

  it("uses COMPOSITE FKs to both assets and asset_service_schedules", () => {
    expect(sql).toMatch(/foreign key \(asset_id, org_id\)\s*references public\.assets \(id, org_id\)/);
    expect(sql).toMatch(/foreign key \(schedule_id, org_id\)\s*references public\.asset_service_schedules \(id, org_id\)/);
  });

  it("adds the composite candidate key on asset_service_schedules for the FK target", () => {
    expect(sql).toMatch(/asset_service_schedules_id_org_key unique \(id, org_id\)/);
  });

  it("guards the linked schedule to the same asset and calibration type", () => {
    const code = codeOf(sql);
    expect(code).toMatch(/is not for asset/);
    expect(code).toMatch(/is not a calibration schedule/);
  });

  it("re-arms the schedule via a SECURITY DEFINER trigger that only moves next_due FORWARD", () => {
    const code = codeOf(sql);
    expect(code).toMatch(/security definer/i);
    expect(code).toMatch(/set search_path = public/);
    // forward-only: the update is gated on the new due being strictly later.
    expect(code).toMatch(/new\.next_due_date > next_due/);
    // and only ever touches a calibration schedule.
    expect(code).toMatch(/maintenance_type = 'calibration'/);
  });

  it("widens tenant_attachments preserving every prior target", () => {
    for (const t of [
      "customers",
      "assets",
      "asset_maintenance_cases",
      "asset_fuel_logs",
      "goods_received_notes",
      "inspection_signoffs",
      "non_conformance_reports",
      "blueprint_pins",
      "asset_calibration_certificates",
    ]) {
      expect(sql).toContain(`'${t}'`);
    }
  });

  it("enforces one certificate number per asset and a due-after-calibration check", () => {
    expect(sql).toMatch(/asset_calibration_certs_number_unique\s*\n?\s*unique \(org_id, asset_id, certificate_number\)/);
    expect(sql).toMatch(/asset_calibration_certs_due_after_cal_check/);
  });
});

describe("server actions — org pin + role gates", () => {
  it("depreciation writes are admin-gated and pinned to the active org", () => {
    const code = codeOf(src("app/(app)/assets/depreciation-actions.ts"));
    expect(code).toMatch(/isAdmin\(ctx\.membership\.role\)/);
    expect(code).toMatch(/org_id: ctx\.org\.id/);
    // deletes are org-pinned as well as admin-gated.
    expect(code).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("calibration records are org-pinned; deletes are admin-gated and org-pinned", () => {
    const code = codeOf(src("app/(app)/assets/calibration-actions.ts"));
    expect(code).toMatch(/org_id: ctx\.org\.id/);
    expect(code).toMatch(/isAdmin\(ctx\.membership\.role\)/);
    expect(code).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });
});

describe("reads — active-org pinned + loud + F-1", () => {
  it("asset detail pins both new reads to the active org", () => {
    const code = codeOf(src("app/(app)/assets/[id]/page.tsx"));
    // the depreciation + calibration reads both carry the org pin.
    expect(code).toMatch(/asset_depreciation_settings[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    expect(code).toMatch(/asset_calibration_certificates[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    // and fail loudly, never rendering an empty state on read error.
    expect(code).toMatch(/readFailure\("asset detail: depreciation settings"/);
    expect(code).toMatch(/readFailure\("asset detail: calibration certificates"/);
  });

  it("the register page pages via fetchAllRows (F-1), pins the org, and reads loudly", () => {
    const code = codeOf(src("app/(app)/assets/calibration/page.tsx"));
    expect(code).toMatch(/fetchAllRows/);
    expect(code).toMatch(/\.range\(from, to\)/);
    expect(code).toMatch(/\.order\("id", \{ ascending: true \}\)/); // stable tiebreak
    expect(code).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(code).toMatch(/throw readFailure\("calibration register: list"/);
  });
});

describe("GDPR registry — both tables registered", () => {
  const registry = JSON.parse(src("lib/gdpr/org-tables.json")) as {
    known: string[];
    order_keys: Record<string, string>;
  };

  it("lists both new org-scoped tables in `known`", () => {
    expect(registry.known).toContain("asset_calibration_certificates");
    expect(registry.known).toContain("asset_depreciation_settings");
  });

  it("gives the id-less depreciation table a stable order key", () => {
    expect(registry.order_keys.asset_depreciation_settings).toBe("asset_id");
  });
});
