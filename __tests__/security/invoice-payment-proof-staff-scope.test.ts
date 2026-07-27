import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Staff-side payment-proof surface — organisation isolation.
 *
 * `portal_uploads` has RLS enabled with NO policies (service-role only — see
 * supabase/migrations/20260620000000_portal_uploads.sql). Every other tenant
 * detail-page read (e.g. tenant_attachments via <AttachmentsPanel>) can lean on
 * RLS under the user JWT to scope rows to the caller's org. This surface CANNOT:
 * a user-JWT client reads zero rows from `portal_uploads`, so the staff panel
 * and its signed-URL action must run on the RLS-BYPASSING service-role client.
 *
 * That inverts where safety comes from. The explicit `org_id` filter is the ONLY
 * thing standing between one org's staff and another org's customer payment
 * proofs — there is no second line of defence behind it. If a refactor drops or
 * widens that filter, nothing else fails first; it just silently over-reads.
 * These assertions pin it on source, per the repo convention for service-role
 * reads (see portal-invoices-scope.test.ts and portal/phase3.test.ts).
 *
 * The same reasoning covers the signed URL: minting one for a `storage_path`
 * fetched without an org filter would hand out a readable link to another org's
 * file, so the lookup is scoped and fails closed to null.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PANEL = read("app/(app)/invoices/[id]/_payment-proofs-panel.tsx");
const ACTION = read("app/(app)/invoices/[id]/proof-actions.ts");
const CLIENT = read("app/(app)/invoices/[id]/_payment-proofs-client.tsx");

describe("payment-proof staff panel — org isolation on the service-role client", () => {
  it("authenticates + resolves org context before reading anything", () => {
    expect(PANEL).toMatch(/requireOrgContext\(\)/);
    const authIdx = PANEL.indexOf("requireOrgContext()");
    const readIdx = PANEL.indexOf('from("portal_uploads"');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(readIdx);
  });

  it("scopes the read by org_id — the ONLY isolation boundary here", () => {
    expect(PANEL).toMatch(
      /from\("portal_uploads"[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("narrows to THIS invoice's payment proofs (target_table + target_id + kind)", () => {
    expect(PANEL).toMatch(/\.eq\("target_table", "invoices"\)/);
    expect(PANEL).toMatch(/\.eq\("target_id", invoiceId\)/);
    expect(PANEL).toMatch(/\.eq\("kind", "payment_proof"\)/);
  });

  it("never scopes by org alone — org_id is paired with the invoice target", () => {
    // An org-only read would surface every customer's proofs in the org on a
    // page about one invoice. Both filters must survive together.
    const orgIdx = PANEL.indexOf('.eq("org_id", ctx.org.id)');
    const targetIdx = PANEL.indexOf('.eq("target_id", invoiceId)');
    expect(orgIdx).toBeGreaterThanOrEqual(0);
    expect(targetIdx).toBeGreaterThanOrEqual(0);
  });

  it("documents WHY the admin client is required (so the filter isn't 'cleaned up')", () => {
    expect(PANEL).toMatch(/service-role only|RLS/i);
    expect(PANEL).toMatch(/createAdminClient/);
  });

  it("is strictly read-only — no writes from the staff proof surface", () => {
    expect(PANEL).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(ACTION).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });
});

describe("payment-proof signed URL — fails closed, scoped, short-lived", () => {
  it("requires org context before minting anything", () => {
    expect(ACTION).toMatch(/requireOrgContext\(\)/);
    const authIdx = ACTION.indexOf("requireOrgContext()");
    const signIdx = ACTION.indexOf("createSignedUrl");
    expect(authIdx).toBeLessThan(signIdx);
  });

  it("validates the proof id as a uuid before querying", () => {
    expect(ACTION).toMatch(/z\.string\(\)\.uuid\(\)\.safeParse\(proofId\)/);
    expect(ACTION).toMatch(/if \(!id\.success\) return null/);
  });

  it("scopes the row lookup by org_id AND kind, not by id alone", () => {
    expect(ACTION).toMatch(
      /\.eq\("id", id\.data\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)[\s\S]*?\.eq\("kind", "payment_proof"\)/,
    );
  });

  it("fails closed to null when the row isn't this org's", () => {
    expect(ACTION).toMatch(/if \(!row\?\.storage_path\) return null/);
  });

  it("mints against the private portal-uploads bucket with a 60s expiry", () => {
    expect(ACTION).toMatch(/\.from\("portal-uploads"\)/);
    expect(ACTION).toMatch(/createSignedUrl\(row\.storage_path, 60\)/);
  });

  it("signs the path from the SCOPED row — never a caller-supplied path", () => {
    // Signing an arbitrary incoming path would bypass the org filter entirely.
    expect(ACTION).toMatch(/createSignedUrl\(row\.storage_path/);
    expect(ACTION).not.toMatch(/createSignedUrl\((?!row\.storage_path)/);
  });

  it("opens the URL without leaking the opener to the file host", () => {
    expect(CLIENT).toMatch(/window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  });
});
