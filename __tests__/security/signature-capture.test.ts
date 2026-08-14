import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * P2 Signature — security source-contracts. Locks the load-bearing rules of the
 * drawn e-signature feature at the source so a regression fails CI:
 *   * the storage bucket is PRIVATE + org-scoped RLS (no public/cross-tenant read);
 *   * the added columns are ADDITIVE + org-first path CHECK (no cross-tenant path);
 *   * the existing acceptance security (token scoping + salted IP HASH) is NOT weakened;
 *   * the H&S sign-off still hashes the IP (never stores the raw IP) and stays RLS-scoped.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const colMig = read("supabase/migrations/20261123000000_signature_capture.sql");
const bucketMig = read("supabase/migrations/20261123000001_signatures_bucket.sql");
const service = read("server/services/signature-capture.ts");
const dataUrl = read("lib/signatures/data-url.ts");
const quoteActions = read("app/(app)/quotes/actions.ts");
const publicActions = read("app/q/[token]/actions.ts");
const signoffActions = read("app/(app)/health-safety/signoff-actions.ts");
const ipHash = read("lib/security/ip-hash.ts");

describe("bucket migration — private + org-scoped RLS", () => {
  it("creates a PRIVATE signatures bucket (public = false)", () => {
    expect(bucketMig).toMatch(/insert into storage\.buckets[\s\S]*'signatures'[\s\S]*false/);
  });
  it("restricts the bucket to PNG only", () => {
    expect(bucketMig).toMatch(/array\['image\/png'\]/);
  });
  it("the only policy is an org-scoped READ (by the org_id first path segment)", () => {
    expect(bucketMig).toMatch(/for select to authenticated/);
    expect(bucketMig).toMatch(/split_part\(name, '\/', 1\)/);
    expect(bucketMig).toMatch(/current_org_ids\(\)/);
  });
  it("grants NO tenant byte-mutation policy (20261032 lockdown — writes are service-role only)", () => {
    expect(bucketMig).not.toMatch(/for insert to authenticated/);
    expect(bucketMig).not.toMatch(/for update to authenticated/);
    expect(bucketMig).not.toMatch(/for delete to authenticated/);
  });
  it("has no public/anon read of the bucket", () => {
    expect(bucketMig).not.toMatch(/to anon/);
    expect(bucketMig).not.toMatch(/public = true/);
  });
});

describe("column migration — additive + org-first path integrity", () => {
  it("adds signature image columns to BOTH tables idempotently (add column if not exists)", () => {
    expect(colMig).toMatch(/alter table public\.signatures[\s\S]*add column if not exists signature_image_path/);
    expect(colMig).toMatch(/alter table public\.safety_acknowledgements[\s\S]*add column if not exists signature_image_path/);
  });
  it("adds the missing provenance (ip_hash + user_agent) to the H&S table", () => {
    expect(colMig).toMatch(/safety_acknowledgements[\s\S]*add column if not exists ip_hash/);
    expect(colMig).toMatch(/add column if not exists user_agent/);
  });
  it("enforces an org-first path CHECK on both tables (no cross-tenant object reference)", () => {
    const checks = colMig.match(/split_part\(signature_image_path, '\/', 1\) = org_id::text/g) ?? [];
    expect(checks.length).toBe(2);
  });
  it("is purely additive — no DROP COLUMN / DROP TABLE / row mutation", () => {
    expect(colMig).not.toMatch(/drop column/i);
    expect(colMig).not.toMatch(/drop table/i);
    expect(colMig).not.toMatch(/\bupdate public\./i);
  });
});

describe("service — private-bucket discipline + org ownership re-check", () => {
  it("uploads only to the private signatures bucket via the admin client with upsert:false", () => {
    expect(service).toMatch(/SIGNATURE_BUCKET/);
    expect(service).toMatch(/upsert: false/);
    expect(service).toMatch(/createAdminClient/);
  });
  it("re-checks the stored path belongs to the org before upload AND before minting a URL", () => {
    const guards = service.match(/storagePathBelongsToOrg/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });
  it("only accepts a real PNG (magic-byte sniff), not the declared MIME", () => {
    expect(dataUrl).toMatch(/PNG_MAGIC/);
    expect(dataUrl).toMatch(/0x89, 0x50, 0x4e, 0x47/);
  });
});

describe("existing acceptance security is NOT weakened", () => {
  it("public accept still scopes by public_token and never trusts a client org_id", () => {
    expect(quoteActions).toMatch(/\.eq\("public_token", token\)/);
  });
  it("the IP is stored as a salted HASH via the shared helper, never the raw IP", () => {
    // Both provenance sites hash through lib/security/ip-hash (quote + H&S).
    expect(publicActions).toMatch(/hashIp/);
    expect(signoffActions).toMatch(/hashIp/);
    expect(ipHash).toMatch(/createHash\("sha256"\)/);
    // salted with the server secret, refusing a forgeable fallback
    expect(ipHash).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(ipHash).not.toMatch(/fallback-salt/);
  });
  it("H&S sign-off writes the ack ROW via the tenant (RLS) client, never the service role", () => {
    expect(signoffActions).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(signoffActions).toMatch(/user_id: user\.id/);
    // the ack action itself never instantiates a service-role DB client
    expect(signoffActions).not.toMatch(/createAdminClient/);
  });
  it("the drawn signature is OPTIONAL — a storage failure returns null and never blocks the record", () => {
    expect(service).toMatch(/return null/);
    // quote accept passes the drawn result spread conditionally
    expect(quoteActions).toMatch(/storeSignatureImage/);
    expect(signoffActions).toMatch(/storeSignatureImage/);
  });
});
