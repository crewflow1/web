import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Schema-assertion suite for the company-logo storage migration. CI has no
 * database, so — like billing-schema-protections.test.ts — we pin the
 * migration SQL itself. These lock in the security-relevant guarantees:
 * a PRIVATE bucket, an image-only + size-capped upload surface, tenant-scoped
 * RLS where only owners/admins can write but any member can read, and that the
 * change is additive + non-destructive (legacy logo_url is preserved).
 */

const root = resolve(__dirname, "../..");
const mig = readFileSync(
  resolve(root, "supabase/migrations/20260712000000_company_logo_storage.sql"),
  "utf-8",
);

describe("company-logo migration — schema column", () => {
  it("adds organizations.logo_path additively (IF NOT EXISTS)", () => {
    expect(mig).toMatch(
      /alter\s+table\s+public\.organizations\s+add\s+column\s+if\s+not\s+exists\s+logo_path\s+text/i,
    );
  });

  it("is NON-destructive: never drops or nulls the legacy logo_url column", () => {
    expect(mig).not.toMatch(/drop\s+column[\s\S]*logo_url/i);
    expect(mig).not.toMatch(/alter\s+table\s+public\.organizations[\s\S]*drop\s+column\s+logo_url/i);
    // It must not bulk-clear existing logo_url values either.
    expect(mig).not.toMatch(/update\s+public\.organizations\s+set\s+logo_url/i);
  });
});

describe("company-logo migration — bucket is private, image-only, size-capped", () => {
  it("creates the company-logos bucket", () => {
    expect(mig).toMatch(/insert\s+into\s+storage\.buckets/i);
    expect(mig).toMatch(/'company-logos'/);
  });

  it("is PRIVATE (public = false) — no public bucket precedent in this app", () => {
    // values tuple is (id, name, public, ...) → id, name, then a literal false.
    expect(mig).toMatch(/'company-logos'\s*,\s*'company-logos'\s*,\s*false/i);
    // Defensive: the bucket must not be created/updated as public = true.
    expect(mig).not.toMatch(/public\s*=\s*true/i);
    expect(mig).not.toMatch(/'company-logos'\s*,\s*'company-logos'\s*,\s*true/i);
  });

  it("caps size at 2 MB and restricts to png/jpeg/webp", () => {
    expect(mig).toContain("2097152");
    expect(mig).toMatch(/array\[\s*'image\/png'\s*,\s*'image\/jpeg'\s*,\s*'image\/webp'\s*\]/i);
  });

  it("upserts the bucket idempotently (ON CONFLICT DO UPDATE)", () => {
    expect(mig).toMatch(/on\s+conflict\s*\(\s*id\s*\)\s+do\s+update/i);
  });
});

describe("company-logo migration — RLS: tenant-scoped, admin-only writes", () => {
  it("scopes every policy to bucket_id = 'company-logos'", () => {
    const policyBlocks = mig.match(/create\s+policy[\s\S]*?;/gi) ?? [];
    expect(policyBlocks.length).toBeGreaterThanOrEqual(4); // read + insert + update + delete
    for (const block of policyBlocks) {
      expect(block).toMatch(/bucket_id\s*=\s*'company-logos'/i);
    }
  });

  it("derives tenancy from the first path segment (org_id)", () => {
    expect(mig).toMatch(/split_part\(\s*name\s*,\s*'\/'\s*,\s*1\s*\)\)?::uuid/i);
  });

  it("lets any member of the owning org READ", () => {
    expect(mig).toMatch(/for\s+select[\s\S]*current_org_ids\(\)/i);
  });

  it("restricts INSERT/UPDATE/DELETE to org admins via is_org_admin", () => {
    for (const op of ["insert", "update", "delete"]) {
      const re = new RegExp(`for\\s+${op}[\\s\\S]*?is_org_admin`, "i");
      expect(mig).toMatch(re);
    }
  });

  it("does NOT grant write access through current_org_ids (members must not write)", () => {
    // A member-level predicate (current_org_ids) must only appear on the read
    // policy — writes are gated by is_org_admin.
    const insertBlock = (mig.match(/for\s+insert[\s\S]*?;/i) ?? [""])[0];
    expect(insertBlock).not.toMatch(/current_org_ids/i);
    expect(insertBlock).toMatch(/is_org_admin/i);
  });

  it("re-runs cleanly (DROP POLICY IF EXISTS before each CREATE)", () => {
    expect((mig.match(/drop\s+policy\s+if\s+exists/gi) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
