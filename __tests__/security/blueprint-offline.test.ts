import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordMatchesPartition, buildOfflineMeta } from "@/lib/blueprints/offline-store";

/**
 * Blueprint Offline Read — security source-contracts (§38). Behaviour is proven
 * against fake-indexeddb in __tests__/blueprints/offline-store.test.ts and in a
 * real browser in e2e/blueprint-offline.spec.ts; these lock the invariants at the
 * source so a regression fails CI.
 */

const root = join(__dirname, "..", "..");
const store = readFileSync(join(root, "lib/blueprints/offline-store.ts"), "utf8");
const byteSrc = readFileSync(join(root, "lib/blueprints/byte-source.ts"), "utf8");
const signOut = readFileSync(join(root, "app/(app)/_components/sign-out-button.tsx"), "utf8");
const appLayout = readFileSync(join(root, "app/(app)/layout.tsx"), "utf8");
const onbLayout = readFileSync(join(root, "app/onboarding/layout.tsx"), "utf8");

describe("offline store — partition isolation (shared-device safety)", () => {
  it("scopeGuard rejects a foreign user or org", () => {
    expect(recordMatchesPartition({ userId: "a", orgId: "o1" }, "a", "o1")).toBe(true);
    expect(recordMatchesPartition({ userId: "a", orgId: "o1" }, "b", "o1")).toBe(false);
    expect(recordMatchesPartition({ userId: "a", orgId: "o1" }, "a", "o2")).toBe(false);
  });
  it("the stored metadata contains NO url/token/path/secret (never-persist)", () => {
    const m = buildOfflineMeta({ userId: "a", orgId: "o", jobId: "j", blueprintId: "bp", versionId: "v", version: 1, revision: "Rev A", revisionDate: null, drawingName: "d", fileName: "f.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "a".repeat(64), downloadedAt: "t", currentAtDownload: true });
    expect(Object.keys(m).join(",")).not.toMatch(/url|token|path|bucket|signed|secret|cookie|authorization|bearer/i);
  });
});

describe("offline store source — never persists credentials", () => {
  it("does not reference signed URLs, tokens, storage paths, or service-role", () => {
    expect(store).not.toMatch(/createSignedUrl|signedUrl|\?token=|access_token|refresh_token|service_role|Authorization|Bearer|storage_path|storage\.from/);
  });
  it("keys every record by userId + orgId + versionId", () => {
    expect(store).toMatch(/\$\{userId\}\$\{SEP\}\$\{orgId\}\$\{SEP\}/);
  });
  it("verifies integrity (sha256 + size) on read and evicts a corrupt record", () => {
    expect(store).toMatch(/sha256Hex\(buf\)\)\s*!==\s*rec\.meta\.sha256/);
    expect(store).toMatch(/await remove\(userId, orgId, versionId\)/);
  });
});

describe("byte-source — online-first, cache is fallback (never an auth bypass)", () => {
  it("fetches the same-origin serve route BEFORE reading the cache", () => {
    const fetchIdx = byteSrc.indexOf("await fetch(src");
    const fallbackIdx = byteSrc.lastIndexOf("readCache()");
    expect(fetchIdx).toBeGreaterThan(-1);
    // the fallback readCache in the catch appears after the fetch
    expect(byteSrc.indexOf("credentials: \"same-origin\"")).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(fetchIdx);
  });
});

describe("logout purge — wired into the REAL lifecycle", () => {
  it("SignOutButton purges the offline cache BEFORE the server signOut", () => {
    expect(signOut).toMatch(/clearAll\(\)/);
    expect(signOut).toMatch(/await signOut\(\)/);
    expect(signOut.indexOf("clearAll()")).toBeLessThan(signOut.indexOf("await signOut()"));
  });
  it("both real logout controls use SignOutButton — no bare <form action={signOut}> remains", () => {
    expect(appLayout).toMatch(/<SignOutButton/);
    expect(appLayout).not.toMatch(/<form action=\{signOut\}>/);
    expect(onbLayout).toMatch(/<SignOutButton/);
    expect(onbLayout).not.toMatch(/<form action=\{signOut\}>/);
  });
});
