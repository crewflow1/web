import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  partitionPrefix, offlineKey, recordMatchesPartition, isValidOfflineMeta, buildOfflineMeta,
  hasRoomFor, bytesToHex, isOfflineSupported,
  put, get, getByVersion, list, remove, clearForUser, clearAll, _resetForTest,
  OFFLINE_SCHEMA_VERSION, type OfflineBlueprintMeta,
} from "@/lib/blueprints/offline-store";
import { MAX_BLUEPRINT_BYTES } from "@/lib/blueprints/schema";

const A = "user-a", B = "user-b", ORG1 = "org-1", ORG2 = "org-2";
const descriptor = (versionId = "v1", over: Partial<OfflineBlueprintMeta> = {}) => ({
  blueprintId: "bp-1", versionId, version: 1, revision: "Rev A", revisionDate: "2026-01-01",
  drawingName: "A-201 GA", fileName: "A-201.pdf", mimeType: "application/pdf", currentAtDownload: true, ...over,
});
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

beforeEach(async () => {
  // clear the single store between tests (no deleteDatabase → no open-connection block)
  await clearAll();
});

describe("offline-store — pure helpers", () => {
  it("offlineKey composes userId::orgId::versionId and is partition-scoped", () => {
    expect(offlineKey(A, ORG1, "v1")).toBe("user-a::org-1::v1");
    expect(offlineKey(A, ORG1, "v1")).not.toBe(offlineKey(B, ORG1, "v1")); // different user
    expect(offlineKey(A, ORG1, "v1")).not.toBe(offlineKey(A, ORG2, "v1")); // different org
    expect(offlineKey(A, ORG1, "v1").startsWith(partitionPrefix(A, ORG1))).toBe(true);
  });
  it("recordMatchesPartition guards the live session", () => {
    expect(recordMatchesPartition({ userId: A, orgId: ORG1 }, A, ORG1)).toBe(true);
    expect(recordMatchesPartition({ userId: A, orgId: ORG1 }, B, ORG1)).toBe(false);
    expect(recordMatchesPartition({ userId: A, orgId: ORG1 }, A, ORG2)).toBe(false);
  });
  it("isValidOfflineMeta accepts a good record + rejects bad ones", () => {
    const good = buildOfflineMeta({ ...descriptor(), userId: A, orgId: ORG1, sizeBytes: 10, sha256: "a".repeat(64), downloadedAt: "2026-01-01T00:00:00Z" });
    expect(isValidOfflineMeta(good)).toBe(true);
    expect(isValidOfflineMeta({ ...good, schemaVersion: 99 })).toBe(false);
    expect(isValidOfflineMeta({ ...good, sizeBytes: -1 })).toBe(false);
    expect(isValidOfflineMeta({ ...good, sha256: "nothex" })).toBe(false);
    expect(isValidOfflineMeta(null)).toBe(false);
  });
  it("buildOfflineMeta stamps schemaVersion + persists NO url/token/path", () => {
    const m = buildOfflineMeta({ ...descriptor(), userId: A, orgId: ORG1, sizeBytes: 5, sha256: "b".repeat(64), downloadedAt: "t" });
    expect(m.schemaVersion).toBe(OFFLINE_SCHEMA_VERSION);
    const keys = Object.keys(m).join(",");
    expect(keys).not.toMatch(/url|token|path|bucket|signed|secret/i);
  });
  it("hasRoomFor respects usage+size+margin<=quota, quota<=0 => true", () => {
    expect(hasRoomFor({ usage: 0, quota: 1000 }, 10, 100)).toBe(true);
    expect(hasRoomFor({ usage: 900, quota: 1000 }, 10, 100)).toBe(false);
    expect(hasRoomFor({ usage: 0, quota: 0 }, 10, 100)).toBe(true);
    expect(hasRoomFor({}, 10, 100)).toBe(true);
  });
  it("bytesToHex", () => {
    expect(bytesToHex(new Uint8Array([]))).toBe("");
    expect(bytesToHex(new Uint8Array([0x00, 0xff]))).toBe("00ff");
    expect(bytesToHex(new Uint8Array([0x0a]))).toBe("0a");
  });
  it("isOfflineSupported true under fake-indexeddb + webcrypto", () => {
    expect(isOfflineSupported()).toBe(true);
  });
});

describe("offline-store — IDB adapter", () => {
  it("put → get round-trips meta + exact bytes for the same user/org", async () => {
    const r = await put({ userId: A, orgId: ORG1, descriptor: descriptor(), bytes: bytes("hello-drawing") });
    expect(r.ok).toBe(true);
    const rec = await get(A, ORG1, "v1");
    expect(rec?.meta.revision).toBe("Rev A");
    expect(new TextDecoder().decode(await rec!.blob.arrayBuffer())).toBe("hello-drawing");
    expect(rec?.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("partition isolation — another user/org cannot read the record (security)", async () => {
    await put({ userId: A, orgId: ORG1, descriptor: descriptor(), bytes: bytes("secret") });
    expect(await get(B, ORG1, "v1")).toBeNull();
    expect(await get(A, ORG2, "v1")).toBeNull();
    expect(await getByVersion(B, ORG1, "v1")).toBeNull();
  });
  it("get returns null for an unknown version", async () => {
    expect(await get(A, ORG1, "nope")).toBeNull();
  });
  it("integrity — corrupt bytes vs stored sha => get returns null + evicts", async () => {
    await put({ userId: A, orgId: ORG1, descriptor: descriptor(), bytes: bytes("good") });
    // tamper the stored blob directly
    await new Promise<void>((resolve) => {
      const req = indexedDB.open("crewflow-blueprints-offline");
      req.onsuccess = () => {
        const db = req.result; const tx = db.transaction("drawings", "readwrite");
        const os = tx.objectStore("drawings");
        const g = os.get(offlineKey(A, ORG1, "v1"));
        g.onsuccess = () => { const rec = g.result; rec.blob = new Blob([bytes("tampered!!")]); os.put(rec); };
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });
    expect(await get(A, ORG1, "v1")).toBeNull();
    _resetForTest();
    expect(await getByVersion(A, ORG1, "v1")).toBeNull(); // evicted
  });
  it("getByVersion returns metadata (cheap presence path)", async () => {
    await put({ userId: A, orgId: ORG1, descriptor: descriptor(), bytes: bytes("x") });
    const m = await getByVersion(A, ORG1, "v1");
    expect(m?.versionId).toBe("v1");
  });
  it("list returns only the current user/org's records", async () => {
    await put({ userId: A, orgId: ORG1, descriptor: descriptor("v1"), bytes: bytes("1") });
    await put({ userId: A, orgId: ORG1, descriptor: descriptor("v2", { revision: "Rev B" }), bytes: bytes("2") });
    await put({ userId: B, orgId: ORG1, descriptor: descriptor("v3"), bytes: bytes("3") });
    const mine = await list(A, ORG1);
    expect(mine.map((m) => m.versionId).sort()).toEqual(["v1", "v2"]);
  });
  it("remove deletes one record, leaves others", async () => {
    await put({ userId: A, orgId: ORG1, descriptor: descriptor("v1"), bytes: bytes("1") });
    await put({ userId: A, orgId: ORG1, descriptor: descriptor("v2"), bytes: bytes("2") });
    await remove(A, ORG1, "v1");
    expect(await getByVersion(A, ORG1, "v1")).toBeNull();
    expect(await getByVersion(A, ORG1, "v2")).not.toBeNull();
  });
  it("clearForUser(user,org) purges that partition, leaves other users (logout safety)", async () => {
    await put({ userId: A, orgId: ORG1, descriptor: descriptor("v1"), bytes: bytes("1") });
    await put({ userId: A, orgId: ORG2, descriptor: descriptor("v2"), bytes: bytes("2") });
    await put({ userId: B, orgId: ORG1, descriptor: descriptor("v3"), bytes: bytes("3") });
    await clearForUser(A, ORG1);
    expect(await getByVersion(A, ORG1, "v1")).toBeNull();
    expect(await getByVersion(A, ORG2, "v2")).not.toBeNull(); // other org kept
    expect(await getByVersion(B, ORG1, "v3")).not.toBeNull(); // other user kept
    await clearForUser(A); // all orgs for A
    expect(await getByVersion(A, ORG2, "v2")).toBeNull();
    expect(await getByVersion(B, ORG1, "v3")).not.toBeNull();
  });
  it("put refuses bytes over MAX_BLUEPRINT_BYTES", async () => {
    const r = await put({ userId: A, orgId: ORG1, descriptor: descriptor(), bytes: new ArrayBuffer(MAX_BLUEPRINT_BYTES + 1) });
    expect(r).toEqual({ ok: false, error: "too_large" });
  });
  it("quota — estimate says no room => quota_exceeded", async () => {
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 999, quota: 1000 }) } });
    const r = await put({ userId: A, orgId: ORG1, descriptor: descriptor(), bytes: bytes("some-bytes") });
    expect(r).toEqual({ ok: false, error: "quota_exceeded" });
    vi.unstubAllGlobals();
  });
  it("schema guard — an older schemaVersion record is a miss", async () => {
    await put({ userId: A, orgId: ORG1, descriptor: descriptor(), bytes: bytes("x") });
    await new Promise<void>((resolve) => {
      const req = indexedDB.open("crewflow-blueprints-offline");
      req.onsuccess = () => { const db = req.result; const tx = db.transaction("drawings", "readwrite"); const os = tx.objectStore("drawings");
        const g = os.get(offlineKey(A, ORG1, "v1")); g.onsuccess = () => { const rec = g.result; rec.meta.schemaVersion = 0; os.put(rec); };
        tx.oncomplete = () => { db.close(); resolve(); }; };
    });
    _resetForTest();
    expect(await getByVersion(A, ORG1, "v1")).toBeNull();
  });
});
