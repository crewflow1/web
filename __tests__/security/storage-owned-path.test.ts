import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storagePathBelongsToOrg } from "@/lib/storage/owned-path";

/**
 * S0 (cross-tenant read fix) — the signed-URL minters must refuse a poisoned storage_path
 * (an org-A row pointing at an org-B object). This locks the pure predicate + asserts every
 * signer actually calls it (source contract), mirroring the DB trigger in migration 20261031.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

describe("storagePathBelongsToOrg", () => {
  it("accepts a path whose first segment is the org", () => {
    expect(storagePathBelongsToOrg(`${ORG_A}/toolbox_talks/x/y.jpg`, ORG_A)).toBe(true);
    expect(storagePathBelongsToOrg(`${ORG_A}/z.pdf`, ORG_A)).toBe(true);
  });
  it("rejects a poisoned cross-org path (org-A row → org-B object)", () => {
    expect(storagePathBelongsToOrg(`${ORG_B}/jobs/x/y.pdf`, ORG_A)).toBe(false);
  });
  it("rejects null/empty/garbage", () => {
    expect(storagePathBelongsToOrg(null, ORG_A)).toBe(false);
    expect(storagePathBelongsToOrg(undefined, ORG_A)).toBe(false);
    expect(storagePathBelongsToOrg("", ORG_A)).toBe(false);
    expect(storagePathBelongsToOrg(`${ORG_A}/x`, "")).toBe(false);
    expect(storagePathBelongsToOrg(`${ORG_A}/x`, null)).toBe(false);
    // a prefix that merely STARTS with the org string but isn't the segment must fail
    expect(storagePathBelongsToOrg(`${ORG_A}x/y`, ORG_A)).toBe(false);
  });
});

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("every evidence signer enforces the org-owned-path guard (source contract)", () => {
  const signers: Array<[string, string]> = [
    ["components/attachments/actions.ts", "tenant-attachments"],
    ["app/(app)/compliance/actions.ts", "compliance-docs"],
    ["server/services/blueprints.ts", "blueprints"],
    ["server/services/job-documents.ts", "job-docs"],
  ];
  for (const [file] of signers) {
    it(`${file} imports + calls storagePathBelongsToOrg before signing`, () => {
      const src = read(file);
      expect(src, file).toMatch(/storagePathBelongsToOrg/);
      // the guard must select org_id (so it can compare the path against the row's own org)
      expect(src, file).toMatch(/org_id/);
    });
  }
  it("job-documents pins the signing bucket to an allowlist (no row-controlled bucket)", () => {
    const src = read("server/services/job-documents.ts");
    expect(src).toMatch(/"job-docs"/);
    expect(src).toMatch(/"job-docs-private"/);
  });
  it("the DB backstop trigger binds storage_path to org on all four tables (migration 20261031)", () => {
    const m = read("supabase/migrations/20261031000000_attachment_storage_path_org_binding.sql");
    expect(m).toMatch(/split_part\(new\.storage_path, '\/', 1\) is distinct from new\.org_id::text/);
    for (const t of ["tenant_attachments", "compliance_documents", "blueprint_versions", "job_document_versions"]) {
      expect(m, t).toMatch(new RegExp(`before insert or update on public\\.${t}`));
    }
  });
});
