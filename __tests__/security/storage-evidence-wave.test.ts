import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Storage-evidence security wave — migration + app source contracts. Runtime behaviour is
 * proven against real Postgres in __tests__/integration/attachments/storage-evidence-security
 * and .../health-safety/rams-permit-authz; these lock the load-bearing rules at the source.
 */
const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("S1 — storage mutation lockdown (20261032)", () => {
  const m = read("supabase/migrations/20261032000000_storage_evidence_mutation_lockdown.sql");
  it("drops the authenticated INSERT/UPDATE/DELETE storage policies on the evidence + attachment buckets", () => {
    for (const p of [
      "tenant-attachments: members can insert", "tenant-attachments: admins can delete",
      "compliance-docs: admins can insert", "compliance-docs: admins can delete",
      "blueprints: members can insert", "blueprints: admins can delete",
      "job-docs: members can insert", "job-docs: admins can delete",
      "job-docs-private: members can insert", "job-docs-private: admins can delete",
      "job-photos: members can upload", "job-photos: members can update", "job-photos: admins can delete",
      "receipts: members can upload", "receipts: members can update", "receipts: admins can delete",
      "imports: admins upload", "imports: admins delete",
    ]) {
      expect(m, p).toMatch(new RegExp(`drop policy if exists "${p.replace(/[-]/g, "\\-")}" on storage.objects`));
    }
  });
  it("does NOT drop any SELECT/read policy (reads are deliberately untouched)", () => {
    // only DROP statements matter (the header comment legitimately mentions read policies)
    const drops = m.split("\n").filter((l) => /^\s*drop policy/i.test(l));
    expect(drops.length).toBeGreaterThan(0);
    for (const d of drops) {
      expect(d, `must not drop a read policy: ${d}`).not.toMatch(/read/i);
      expect(d).not.toMatch(/select/i);
    }
  });
});

describe("S2 — content_hash + universal write-once immutability (20261033 + app)", () => {
  const m = read("supabase/migrations/20261033000000_tenant_attachment_content_hash.sql");
  const svc = read("server/services/tenant-attachments.ts");
  it("adds a hex-CHECKed content_hash column", () => {
    expect(m).toMatch(/add column if not exists content_hash text/);
    expect(m).toMatch(/content_hash is null or content_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  });
  it("freezes content_hash/storage_path/size_bytes/mime_type via a universal BEFORE UPDATE trigger", () => {
    expect(m).toMatch(/tg_tenant_attachment_evidence_immutable/);
    expect(m).toMatch(/before update on public\.tenant_attachments/);
    for (const c of ["content_hash", "storage_path", "size_bytes", "mime_type"]) {
      expect(m, c).toMatch(new RegExp(`${c} is`));
    }
  });
  it("the upload path computes a SHA-256 of the raw bytes and stores it", () => {
    expect(svc).toMatch(/createHash\("sha256"\)\.update\(input\.bytes\)\.digest\("hex"\)/);
    expect(svc).toMatch(/content_hash: contentHash/);
  });
});

describe("S4 — RAMS draft->terminal integrity fix (20261034)", () => {
  const m = read("supabase/migrations/20261034000000_rams_draft_terminal_integrity.sql");
  it("rejects a JWT draft->non-issued transition (closes the forgery bypass), service role exempt", () => {
    expect(m).toMatch(/tg_ra_lifecycle/);
    expect(m).toMatch(/a draft risk assessment can only be issued, not moved directly to/);
    expect(m).toMatch(/old\.status = 'draft' and auth\.uid\(\) is not null and new\.status not in \('draft', 'issued'\)/);
    // preserves the readiness gate + provenance pin (not a role change)
    expect(m).toMatch(/needs a named assessor/);
    expect(m).toMatch(/new\.issued_by := auth\.uid\(\)/);
  });
});
