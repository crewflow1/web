import { MAX_BLUEPRINT_BYTES } from "./schema";

/**
 * Blueprint Offline Read (Programme E) — browser-local store for authorized
 * drawing BYTES so the real viewer renders with no connectivity. One IndexedDB
 * database, one object store, one atomic record per cached revision =
 * { metadata + Blob }. Partitioned by user+org so a shared device never serves
 * one user's cached drawing to another (defense-in-depth; server RLS remains the
 * authority whenever online). NEVER stores signed URLs / tokens / storage paths.
 *
 * Split into PURE helpers (unit-testable with no IndexedDB) and an async ADAPTER
 * (the DB is opened lazily inside functions, so importing this module never
 * touches `indexedDB`). Zero migration, zero runtime dependency.
 */

// ── constants ────────────────────────────────────────────────────────────────
export const OFFLINE_SCHEMA_VERSION = 2; // v2: added jobId (so the offline shell can reopen the viewer)
const DB_NAME = "crewflow-blueprints-offline";
const DB_VERSION = 1;
const STORE = "drawings";
const SEP = "::";
/** Always leave one max-drawing of slack in the shared origin bucket. */
export const OFFLINE_QUOTA_MARGIN_BYTES = MAX_BLUEPRINT_BYTES;

export type OfflineBlueprintMeta = {
  schemaVersion: number;
  userId: string;
  orgId: string;
  jobId: string;
  blueprintId: string;
  versionId: string;
  version: number;
  revision: string;
  revisionDate: string | null;
  drawingName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  downloadedAt: string;
  currentAtDownload: boolean;
};

export type OfflineRecord = { key: string; partition: string; versionId: string; blueprintId: string; meta: OfflineBlueprintMeta; blob: Blob };
export type PutError = "too_large" | "quota_exceeded" | "unsupported" | "write_failed";
export type PutResult = { ok: true; meta: OfflineBlueprintMeta } | { ok: false; error: PutError };

// ── pure helpers ─────────────────────────────────────────────────────────────
export function partitionPrefix(userId: string, orgId: string): string {
  return `${userId}${SEP}${orgId}${SEP}`;
}
export function offlineKey(userId: string, orgId: string, versionId: string): string {
  return `${partitionPrefix(userId, orgId)}${versionId}`;
}
/** Re-check a decoded record belongs to the live session — a tampered key can't slip a foreign record through. */
export function recordMatchesPartition(rec: { userId: string; orgId: string }, userId: string, orgId: string): boolean {
  return rec.userId === userId && rec.orgId === orgId;
}

const HEX64 = /^[0-9a-f]{64}$/;
export function isValidOfflineMeta(v: unknown): v is OfflineBlueprintMeta {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.schemaVersion === OFFLINE_SCHEMA_VERSION &&
    typeof m.userId === "string" && m.userId.length > 0 &&
    typeof m.orgId === "string" && m.orgId.length > 0 &&
    typeof m.jobId === "string" && typeof m.blueprintId === "string" && typeof m.versionId === "string" &&
    typeof m.revision === "string" && typeof m.drawingName === "string" &&
    typeof m.fileName === "string" && typeof m.mimeType === "string" &&
    typeof m.version === "number" &&
    typeof m.sizeBytes === "number" && m.sizeBytes >= 0 &&
    typeof m.sha256 === "string" && HEX64.test(m.sha256) &&
    typeof m.downloadedAt === "string" && typeof m.currentAtDownload === "boolean"
  );
}

export function buildOfflineMeta(input: Omit<OfflineBlueprintMeta, "schemaVersion">): OfflineBlueprintMeta {
  return {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    userId: input.userId, orgId: input.orgId, jobId: input.jobId, blueprintId: input.blueprintId, versionId: input.versionId,
    version: input.version, revision: input.revision, revisionDate: input.revisionDate,
    drawingName: input.drawingName, fileName: input.fileName, mimeType: input.mimeType,
    sizeBytes: input.sizeBytes, sha256: input.sha256, downloadedAt: input.downloadedAt,
    currentAtDownload: input.currentAtDownload,
  };
}

export function hasRoomFor(estimate: { usage?: number; quota?: number }, sizeBytes: number, marginBytes = OFFLINE_QUOTA_MARGIN_BYTES): boolean {
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  if (quota <= 0) return true; // browser withheld quota → don't pre-block; rely on QuotaExceededError
  return usage + sizeBytes + marginBytes <= quota;
}

export function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

export function isOfflineSupported(): boolean {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
}

// ── IDB adapter ──────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!isOfflineSupported()) return Promise.reject(new Error("offline storage unsupported"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "key" });
        os.createIndex("by_partition", "partition", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}
const reqP = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function estimate(): Promise<{ usage?: number; quota?: number }> {
  try { return (await navigator.storage?.estimate?.()) ?? {}; } catch { return {}; }
}

/** Hash + gate size/quota, then atomically write { meta, blob } in one transaction. */
export async function put(args: {
  userId: string; orgId: string;
  descriptor: Omit<OfflineBlueprintMeta, "schemaVersion" | "userId" | "orgId" | "sha256" | "sizeBytes" | "downloadedAt"> & { downloadedAt?: string };
  bytes: ArrayBuffer;
}): Promise<PutResult> {
  if (!isOfflineSupported()) return { ok: false, error: "unsupported" };
  if (args.bytes.byteLength > MAX_BLUEPRINT_BYTES) return { ok: false, error: "too_large" };
  if (!hasRoomFor(await estimate(), args.bytes.byteLength)) return { ok: false, error: "quota_exceeded" };
  const sha256 = await sha256Hex(args.bytes);
  const meta = buildOfflineMeta({
    ...args.descriptor, userId: args.userId, orgId: args.orgId,
    sizeBytes: args.bytes.byteLength, sha256, downloadedAt: args.descriptor.downloadedAt ?? new Date().toISOString(),
  });
  const partition = partitionPrefix(args.userId, args.orgId);
  const key = offlineKey(args.userId, args.orgId, meta.versionId);
  const rec: OfflineRecord = { key, partition, versionId: meta.versionId, blueprintId: meta.blueprintId, meta, blob: new Blob([args.bytes], { type: meta.mimeType }) };
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    await txDone(tx);
    return { ok: true, meta };
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "QuotaExceededError") return { ok: false, error: "quota_exceeded" };
    return { ok: false, error: "write_failed" };
  }
}

async function readRec(userId: string, orgId: string, versionId: string): Promise<OfflineRecord | null> {
  const db = await open();
  const tx = db.transaction(STORE, "readonly");
  const rec = (await reqP(tx.objectStore(STORE).get(offlineKey(userId, orgId, versionId)))) as OfflineRecord | undefined;
  return rec ?? null;
}

/** Cheap metadata-only presence/stale check — never decodes the blob. */
export async function getByVersion(userId: string, orgId: string, versionId: string): Promise<OfflineBlueprintMeta | null> {
  if (!isOfflineSupported()) return null;
  try {
    const rec = await readRec(userId, orgId, versionId);
    if (!rec || !isValidOfflineMeta(rec.meta) || !recordMatchesPartition(rec.meta, userId, orgId)) return null;
    return rec.meta;
  } catch { return null; }
}

/** Full bytes + integrity verify. Corrupt/foreign → evict + null. */
export async function get(userId: string, orgId: string, versionId: string): Promise<OfflineRecord | null> {
  if (!isOfflineSupported()) return null;
  try {
    const rec = await readRec(userId, orgId, versionId);
    if (!rec || !isValidOfflineMeta(rec.meta) || !recordMatchesPartition(rec.meta, userId, orgId)) return null;
    const buf = await rec.blob.arrayBuffer();
    if (buf.byteLength !== rec.meta.sizeBytes || (await sha256Hex(buf)) !== rec.meta.sha256) {
      await remove(userId, orgId, versionId); // corrupt/partial → drop it
      return null;
    }
    return rec;
  } catch { return null; }
}

export async function list(userId: string, orgId: string): Promise<OfflineBlueprintMeta[]> {
  if (!isOfflineSupported()) return [];
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readonly");
    const recs = (await reqP(tx.objectStore(STORE).index("by_partition").getAll(IDBKeyRange.only(partitionPrefix(userId, orgId))))) as OfflineRecord[];
    return recs.map((r) => r.meta).filter((m) => isValidOfflineMeta(m) && recordMatchesPartition(m, userId, orgId));
  } catch { return []; }
}

export async function remove(userId: string, orgId: string, versionId: string): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(offlineKey(userId, orgId, versionId));
    await txDone(tx);
  } catch { /* best-effort */ }
}

/** Logout / org-switch purge. Omit orgId to clear every org for this user. */
export async function clearForUser(userId: string, orgId?: string): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (orgId) {
      const keys = (await reqP(store.index("by_partition").getAllKeys(IDBKeyRange.only(partitionPrefix(userId, orgId))))) as IDBValidKey[];
      for (const k of keys) store.delete(k);
    } else {
      const all = (await reqP(store.getAllKeys())) as string[];
      for (const k of all) if (typeof k === "string" && k.startsWith(`${userId}${SEP}`)) store.delete(k);
    }
    await txDone(tx);
  } catch { /* best-effort */ }
}

export async function estimateRoom(sizeBytes: number, marginBytes?: number): Promise<boolean> {
  return hasRoomFor(await estimate(), sizeBytes, marginBytes);
}

/** Nuke the entire CrewFlow offline DB — the logout purge (shared-device safety). */
export async function clearAll(): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } catch { /* best-effort */ }
}

/** Test-only: reset the memoized handle so a fresh fake-indexeddb is picked up. */
export function _resetForTest(): void { dbPromise = null; }

// ── offline identity marker (client-only) ────────────────────────────────────
// The offline shell renders with no server session, so it needs the last active
// user+org to scope its IndexedDB read. userId/orgId are opaque UUIDs (not
// secrets, not credentials). Written when authenticated, cleared on logout — a
// stale/tampered value only points at a different partition, which holds no data
// unless that user actually cached on this device.
const IDENTITY_KEY = "crewflow-offline-identity";
export type OfflineIdentity = { userId: string; orgId: string };

export function writeOfflineIdentity(userId: string, orgId: string): void {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ userId, orgId })); } catch { /* no localStorage */ }
}
export function readOfflineIdentity(): OfflineIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Record<string, unknown>;
    return typeof p?.userId === "string" && typeof p?.orgId === "string" ? { userId: p.userId, orgId: p.orgId } : null;
  } catch { return null; }
}
export function clearOfflineIdentity(): void {
  try { localStorage.removeItem(IDENTITY_KEY); } catch { /* no localStorage */ }
}
