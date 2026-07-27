import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Schema-assertion suite for the company-logo storage migration. CI has no
 * database, so — like billing-schema-protections.test.ts — we pin the
 * migration SQL itself. These lock in the security-relevant guarantees:
 * a PRIVATE bucket, an image-only + size-capped upload surface, that the change
 * is additive + non-destructive (legacy logo_url is preserved), and that the
 * bucket ships with ZERO `authenticated` storage.objects policies so byte
 * access stays service-role-only per the 20261032 storage-mutation lockdown.
 *
 * The cross-migration version of that last invariant (no migration anywhere may
 * re-grant tenant writes) lives in
 * __tests__/security/storage-company-logos-lockdown.test.ts.
 */

const root = resolve(__dirname, "../..");
const mig = readFileSync(
  resolve(root, "supabase/migrations/20261041000000_company_logo_storage.sql"),
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

describe("company-logo migration — service-role-only byte access (no RLS grants)", () => {
  // Comments legitimately DISCUSS the removed policies, so every assertion here
  // runs against SQL with `--` comment lines stripped, never the raw text.
  const sql = mig
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");

  it("creates NO storage.objects policy of any kind", () => {
    // Guard the stripper itself: if it ever nuked the whole file, the bucket
    // insert below would vanish and these assertions would pass vacuously.
    expect(sql).toMatch(/insert\s+into\s+storage\.buckets/i);
    expect(sql).not.toMatch(/create\s+policy/i);
  });

  it("grants nothing to the authenticated or anon roles", () => {
    expect(sql).not.toMatch(/\bto\s+authenticated\b/i);
    expect(sql).not.toMatch(/\bto\s+anon\b/i);
    expect(sql).not.toMatch(/\bgrant\b/i);
  });

  it("never re-introduces a tenant write verb on storage.objects", () => {
    for (const verb of ["insert", "update", "delete"]) {
      expect(sql, verb).not.toMatch(new RegExp(`for\\s+${verb}\\b`, "i"));
    }
    expect(sql).not.toMatch(/for\s+select\b/i);
    expect(sql).not.toMatch(/for\s+all\b/i);
  });

  it("does not lean on tenant RLS predicates (is_org_admin / current_org_ids)", () => {
    expect(sql).not.toMatch(/is_org_admin/i);
    expect(sql).not.toMatch(/current_org_ids/i);
  });

  it("defensively drops the four policies an earlier draft created", () => {
    for (const p of [
      "company-logos: members can read",
      "company-logos: admins can insert",
      "company-logos: admins can update",
      "company-logos: admins can delete",
    ]) {
      expect(sql, p).toMatch(
        new RegExp(
          `drop\\s+policy\\s+if\\s+exists\\s+"${p.replace(/[-]/g, "\\-")}"\\s+on\\s+storage\\.objects`,
          "i",
        ),
      );
    }
  });
});
