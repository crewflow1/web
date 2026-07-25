import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareSearch, parseCompareState, defaultRevisionPair, type CompareVersion } from "@/lib/blueprints/compare";

/**
 * Revision Comparison — security source-contracts (§22/§36). The compare feature
 * adds NO endpoint and NO migration: both revisions flow through the existing
 * RLS-gated /f/[versionId] serve route, each independently tenant-gated. These
 * lock that at the source; the authenticated behaviour is proven in
 * e2e/blueprint-compare.spec.ts and the DB tenancy in the pins/markup integration.
 */

const root = join(__dirname, "..", "..");
const surface = readFileSync(join(root, "app/(app)/jobs/[id]/blueprints/_drawing-render-surface.tsx"), "utf8");
const compare = readFileSync(join(root, "app/(app)/jobs/[id]/blueprints/_compare.tsx"), "utf8");

const chain: CompareVersion[] = [
  { id: "22222222-2222-2222-2222-222222222222", version: 2, revision: "Rev B", revision_date: "2026-03-01", uploaded_at: "2026-03-02", mime_type: "application/pdf" },
  { id: "11111111-1111-1111-1111-111111111111", version: 1, revision: "Rev A", revision_date: "2026-01-01", uploaded_at: "2026-01-02", mime_type: "application/pdf" },
];

describe("compare — no weakened file access", () => {
  it("both surfaces fetch ONLY the existing per-version serve route (no compare endpoint)", () => {
    expect(surface).toMatch(/\/jobs\/\$\{jobId\}\/blueprints\/f\/\$\{versionId\}/);
    expect(surface).not.toMatch(/createSignedUrl|storage\.from|service-role|createAdminClient/);
    // compare composes surfaces; it never signs or reads storage itself
    expect(compare).not.toMatch(/createSignedUrl|storage\.from|createAdminClient|service-role/);
  });

  it("keeps the hardened pdf.js config identical (no loosening)", () => {
    expect(surface).toMatch(/isEvalSupported:\s*false/);
    expect(surface).toMatch(/enableXfa:\s*false/);
    expect(surface).toMatch(/disableAutoFetch:\s*true/);
    expect(surface).not.toMatch(/isEvalSupported:\s*true|enableScripting|renderInteractiveForms/);
  });

  it("fetches same-origin bytes once per surface (containment preserved)", () => {
    expect(surface).toMatch(/credentials:\s*"same-origin"/);
    expect((surface.match(/await fetch\(/g) ?? []).length).toBe(1);
  });
});

describe("compare — view-only (no mutation surface)", () => {
  it("wires NO create/move/delete action into compare", () => {
    expect(compare).not.toMatch(/createPinAction|placePin|movePin|createMarkupAction|removeMarkupAction|deleteMarkupAction|createMarkup/);
  });
  it("reads annotations only through the version-scoped getters", () => {
    expect(compare).toMatch(/getPinsAction|getMarkupAction/);
  });
});

describe("compare — URL state carries no secrets (§15)", () => {
  it("serializes UUIDs + view params only — never a signed URL, token, or storage path", () => {
    const s = parseCompareState({ mode: "overlay", ann: "ap,bm" }, chain)!;
    const q = compareSearch("bp-1", s);
    expect(q).not.toMatch(/https?:|sign|token|storage|\.pdf|Bearer/i);
    expect(q).toContain("a=11111111-1111-1111-1111-111111111111");
    expect(q).toContain("b=22222222-2222-2222-2222-222222222222");
  });
  it("falls back to the safe default pair on tampered ids (no crash, no leak)", () => {
    expect(parseCompareState({ a: "evil", b: "../secret" }, chain)).toMatchObject(defaultRevisionPair(chain)!);
  });
});
