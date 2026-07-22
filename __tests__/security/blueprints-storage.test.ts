import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Blueprint Centre — the file-access surface is safe by construction. Drawings
 * live in a PRIVATE bucket; the only way to reach bytes is a short-lived signed
 * URL minted AFTER an RLS-gated read. These are source contracts — a refactor
 * that drops a scope/check fails here.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("blueprints — private storage, signed-URL-only, hardened uploads", () => {
  const svc = read("server/services/blueprints.ts");

  it("signs a download only AFTER an RLS-gated tenant read (never trusts a client path)", () => {
    // getBlueprintVersionUrl: tenant createClient read, then admin createSignedUrl of the row's OWN path.
    expect(svc).toMatch(/getBlueprintVersionUrl/);
    expect(svc).toMatch(/const tenant = await createClient\(\)[\s\S]*?blueprint_versions[\s\S]*?createSignedUrl\(String\(version\.storage_path\)/);
    expect(svc).toMatch(/createSignedUrl\([^,]+,\s*60\)/); // 60s TTL
  });

  it("re-checks org ownership on the service-role revision path", () => {
    expect(svc).toMatch(/shell\.org_id !== ctx\.org\.id/);
  });

  it("verifies real bytes (magic sniff) + records a content hash", () => {
    expect(svc).toMatch(/sniffBlueprintType/);
    expect(svc).toMatch(/createHash\("sha256"\)/);
    expect(svc).toMatch(/sniffed !== file\.mime/); // reject spoofed MIME
  });

  it("never removes storage bytes on a denied (0-row) delete", () => {
    // count-gated: only remove after a row was actually deleted.
    expect(svc).toMatch(/delete\(\{ count: "exact" \}\)/);
    expect(svc).toMatch(/if \(!count\) return \{ ok: false/);
  });

  it("the serve route 404s (no enumeration) and goes through the scoped loader", () => {
    const route = read("app/(app)/jobs/[id]/blueprints/f/[versionId]/route.ts");
    expect(route).toMatch(/getBlueprintVersionUrl/);
    expect(route).toMatch(/status:\s*404/);
    expect(route).toMatch(/redirect\(res\.data\.url/);
  });

  it("uploads go to the private 'blueprints' bucket via the admin client", () => {
    expect(svc).toMatch(/const BUCKET = "blueprints"/);
    expect(svc).toMatch(/admin\.storage\.from\(BUCKET\)\.upload\([^)]*upsert: false/);
  });
});
