import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * RED-fix pins from the full operational war-test.
 *
 * Three RED items were found during the static audit and fixed; this
 * file locks the fixes so they can't regress silently.
 *
 *   RED 1 — createPayrollRun() used to silently drop open time_entries.
 *   RED 2 — compliance-docs + tenant-attachments storage buckets shipped
 *           without explicit storage.objects RLS.
 *   RED 3 — /api/jobs/[id]/photos signed URL TTL was 1 hour, not 60s.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

describe("RED 1 — payroll guards against open time_entries", () => {
  const src = read("app/(app)/payroll/actions.ts");

  it("queries time_entries with ended_at is null + period overlap before run insert", () => {
    expect(src).toMatch(/Open-entry guard/);
    expect(src).toMatch(/\.is\("ended_at", null\)/);
  });

  it("returns formError listing the open users — no run is created", () => {
    expect(src).toMatch(/Some staff are still clocked in/);
    expect(src).toMatch(/their hours would be dropped from this run/);
  });

  it("guard runs BEFORE the payroll_runs insert (so no orphan run row)", () => {
    const guardIdx = src.indexOf("Open-entry guard");
    const insertIdx = src.indexOf('.from("payroll_runs")\n    .insert(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(insertIdx);
  });
});

describe("RED 2 — storage RLS for compliance-docs + tenant-attachments", () => {
  it("storage hardening migration exists", () => {
    expect(existsSync(resolve(root, "supabase/migrations/20260626000000_storage_rls_hardening.sql"))).toBe(true);
  });

  const mig = read("supabase/migrations/20260626000000_storage_rls_hardening.sql");

  it("compliance-docs: select policy scopes by current_org_ids() via path prefix", () => {
    expect(mig).toMatch(/"compliance-docs: members can read"/);
    expect(mig).toMatch(/bucket_id = 'compliance-docs'/);
    expect(mig).toMatch(/current_org_ids\(\)/);
  });

  it("compliance-docs: insert + delete gated by is_org_admin", () => {
    expect(mig).toMatch(/"compliance-docs: admins can insert"/);
    expect(mig).toMatch(/"compliance-docs: admins can delete"/);
    expect(mig).toMatch(/is_org_admin\(/);
  });

  it("tenant-attachments: select / insert / admin-delete policies present", () => {
    expect(mig).toMatch(/"tenant-attachments: members can read"/);
    expect(mig).toMatch(/"tenant-attachments: members can insert"/);
    expect(mig).toMatch(/"tenant-attachments: admins can delete"/);
  });

  it("uses split_part(name, '/', 1) to extract org_id from the storage path", () => {
    // Pattern matches `${org_id}/...` storage paths used by tenant-attachments
    // service + compliance upload action.
    expect(mig).toMatch(/split_part\(name, '\/', 1\)/);
  });
});

describe("RED 3 — job-photos signed URL TTL", () => {
  const src = read("app/api/jobs/[id]/photos/route.ts");

  it("uses 60-second expiry on createSignedUrls", () => {
    expect(src).toMatch(/createSignedUrls\(paths, 60\)/);
  });

  it("does not use the old 60 * 60 (1 hour) value", () => {
    expect(src).not.toMatch(/createSignedUrls\([^)]*60\s*\*\s*60[^)]*\)/);
  });
});
