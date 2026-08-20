import {
  isOfflineReadKind,
  offlineReadEntity,
  type OfflineReadKind,
} from "./read-cache-registry";

/**
 * OFFLINE READ CACHE — the browser-local store of server-authored entity
 * snapshots so a CrewFlow page renders with no connectivity.
 *
 * Built as a deliberate sibling of lib/blueprints/offline-store.ts (Programme E):
 * same shape (PURE helpers + a lazily-opened async IDB adapter, so importing this
 * module never touches `indexedDB`), same `userId::orgId` partitioning, same quota
 * discipline, same logout purge. It is a SEPARATE IndexedDB database from BOTH the
 * drawing cache and the write queue, and the reason is a hard safety boundary:
 *
 *   - the WRITE QUEUE (write-queue.ts) holds USER-AUTHORED work that exists nowhere
 *     else — it must never be evicted to make room for anything;
 *   - this READ CACHE holds a COPY of server data that is always re-downloadable —
 *     it is safe to clear at any time.
 *
 * Keeping them in one database would invite a "just clear the cache" reflex that
 * silently deletes a foreman's unsent day. They are separate so the read cache can
 * be discarded freely while the write queue never is; and the read cache always
 * refuses to grow into the headroom the write queue needs (READ_QUOTA_MARGIN_BYTES
 * is generous precisely so a snapshot never wins the last byte of quota from a
 * queued write).
 *
 * ── The three properties (see read-cache-registry.ts) ─────────────────────────
 * 1. ORG-PINNED + PARTITIONED. Keyed `userId::orgId::kind`, read only through its
 *    partition, purged for foreign users on mount and cleared on logout. A shared
 *    tablet never serves user A's cached jobs to user B, or Company A's to B.
 * 2. PAGED + BOUNDED. One record per (partition, kind); each holds at most the
 *    registry's pageLimit rows, and the whole store is byte-capped.
 * 3. SAFE COLUMNS ONLY. The server action (offline-read-actions.ts) projects the
 *    registry's column allowlist; this store just holds what it is handed.
 *
 * NEVER STORED: tokens, signed URLs, storage paths, cookies, session state — the
 * snapshots are plain scalar columns chosen by the registry allowlist.
 */

// ── constants ────────────────────────────────────────────────────────────────
export const READ_CACHE_SCHEMA_VERSION = 1;
const DB_NAME = "crewflow-offline-reads";
const DB_VERSION = 1;
const STORE = "snapshots";
const SEP = "::";

/** One snapshot's serialised ceiling. 200 rows of scalar columns is far under
 *  this; the cap exists so a pathological payload cannot monopolise the store. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Whole read-cache ceiling across every partition + kind on the device. */
export const MAX_READ_CACHE_BYTES = 8 * 1024 * 1024;
/**
 * Headroom left in the shared origin bucket. Deliberately LARGE: the read cache
 * must never win the last byte of quota from a queued WRITE (unsent user work),
 * so it refuses to store a snapshot that would eat into this margin.
 */
export const READ_QUOTA_MARGIN_BYTES = 16 * 1024 * 1024;

export type OfflineSnapshot = {
  schemaVersion: number;
  /** IDB primary key: `${userId}::${orgId}::${kind}`. */
  key: string;
  /** IDB index key: `${userId}::${orgId}::`. */
  partition: string;
  /** IDB index key — used ONLY by purgeForeignReads (shared-device safety). */
  userId: string;
  orgId: string;
  kind: OfflineReadKind;
  /** The projected rows (registry column allowlist). Scalars only. */
  rows: Record<string, unknown>[];
  /** How many rows are held (== rows.length; stored for a cheap count read). */
  rowCount: number;
  /** The page limit that was applied — surfaced so a viewer can say "showing the
   *  most recent N". */
  pageLimit: number;
  /** True when the server had MORE rows than the page — the cache is partial. */
  truncated: boolean;
  /** Device clock at hydration. UNTRUSTED: provenance for "cached 2h ago". */
  cachedAt: string;
};

export type PutSnapshotError =
  | "unsupported"
  | "unknown_kind"
  | "too_large"
  | "store_full"
  | "quota_exceeded"
  | "write_failed";
export type PutSnapshotResult =
  | { ok: true; snapshot: OfflineSnapshot }
  | { ok: false; error: PutSnapshotError };

// ── pure helpers ─────────────────────────────────────────────────────────────
export function readPartitionPrefix(userId: string, orgId: string): string {
  return `${userId}${SEP}${orgId}${SEP}`;
}
export function snapshotKey(
  userId: string,
  orgId: string,
  kind: OfflineReadKind,
): string {
  return `${readPartitionPrefix(userId, orgId)}${kind}`;
}
/** Re-check a decoded record belongs to the live session — a tampered key cannot
 *  slip a foreign snapshot into a read (mirrors the write queue's guard). */
export function snapshotMatchesPartition(
  rec: { userId: string; orgId: string },
  userId: string,
  orgId: string,
): boolean {
  return rec.userId === userId && rec.orgId === orgId;
}

export function isValidSnapshot(v: unknown): v is OfflineSnapshot {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r.schemaVersion === READ_CACHE_SCHEMA_VERSION &&
    typeof r.key === "string" &&
    typeof r.partition === "string" &&
    typeof r.userId === "string" &&
    r.userId.length > 0 &&
    typeof r.orgId === "string" &&
    r.orgId.length > 0 &&
    isOfflineReadKind(r.kind) &&
    Array.isArray(r.rows) &&
    typeof r.rowCount === "number" &&
    typeof r.cachedAt === "string"
  );
}

export function estimateSnapshotBytes(snap: {
  rows: unknown;
  kind: string;
}): number {
  try {
    return new TextEncoder().encode(
      JSON.stringify({ r: snap.rows, k: snap.kind }),
    ).length;
  } catch {
    return Number.MAX_SAFE_INTEGER; // unserialisable → refuse loudly
  }
}

export function hasReadCacheRoom(
  estimate: { usage?: number; quota?: number },
  sizeBytes: number,
  marginBytes = READ_QUOTA_MARGIN_BYTES,
): boolean {
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  if (quota <= 0) return true; // browser withheld quota → rely on QuotaExceededError
  return usage + sizeBytes + marginBytes <= quota;
}

export function isReadCacheSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

// ── IDB adapter ──────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!isReadCacheSupported()) {
    return Promise.reject(new Error("offline read cache unsupported"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "key" });
        os.createIndex("by_partition", "partition", { unique: false });
        os.createIndex("by_user", "userId", { unique: false });
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
const reqP = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

async function estimate(): Promise<{ usage?: number; quota?: number }> {
  try {
    return (await navigator.storage?.estimate?.()) ?? {};
  } catch {
    return {};
  }
}

/**
 * Store (replace) one entity snapshot for a partition + kind. Overwrites the
 * previous snapshot of the same kind — the cache holds the LATEST page, never a
 * history. `rows` is trimmed to the registry pageLimit before storage, and the
 * caller learns whether it was truncated so the viewer can say so.
 */
export async function putSnapshot(args: {
  userId: string;
  orgId: string;
  kind: OfflineReadKind;
  rows: Record<string, unknown>[];
  /** The server's total-known count, if it read one — for the truncation flag. */
  serverTotal?: number;
  cachedAt?: string;
}): Promise<PutSnapshotResult> {
  if (!isReadCacheSupported()) return { ok: false, error: "unsupported" };
  if (!isOfflineReadKind(args.kind)) return { ok: false, error: "unknown_kind" };

  const entity = offlineReadEntity(args.kind);
  const rows = args.rows.slice(0, entity.pageLimit);
  const truncated =
    args.rows.length > entity.pageLimit ||
    (typeof args.serverTotal === "number" && args.serverTotal > rows.length);

  const bytes = estimateSnapshotBytes({ rows, kind: args.kind });
  if (bytes > MAX_SNAPSHOT_BYTES) return { ok: false, error: "too_large" };
  if (!hasReadCacheRoom(await estimate(), bytes)) {
    return { ok: false, error: "quota_exceeded" };
  }

  const partition = readPartitionPrefix(args.userId, args.orgId);
  const snapshot: OfflineSnapshot = {
    schemaVersion: READ_CACHE_SCHEMA_VERSION,
    key: snapshotKey(args.userId, args.orgId, args.kind),
    partition,
    userId: args.userId,
    orgId: args.orgId,
    kind: args.kind,
    rows,
    rowCount: rows.length,
    pageLimit: entity.pageLimit,
    truncated,
    cachedAt: args.cachedAt ?? new Date().toISOString(),
  };

  try {
    const db = await open();
    // Whole-store cap: sum every OTHER record and refuse if this one would push
    // the device over. Never evicts — the read cache refuses loudly, like the
    // write queue, so behaviour is uniform and predictable.
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const all = ((await reqP(store.getAll())) as OfflineSnapshot[]).filter(
      (r) => r.key !== snapshot.key,
    );
    const otherBytes = all.reduce((n, r) => n + estimateSnapshotBytes(r), 0);
    if (otherBytes + bytes > MAX_READ_CACHE_BYTES) {
      tx.abort();
      return { ok: false, error: "store_full" };
    }
    store.put(snapshot);
    await txDone(tx);
    return { ok: true, snapshot };
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "QuotaExceededError") return { ok: false, error: "quota_exceeded" };
    return { ok: false, error: "write_failed" };
  }
}

/** Read one cached snapshot, scoped to the live partition. Foreign/invalid → null. */
export async function getSnapshot(
  userId: string,
  orgId: string,
  kind: OfflineReadKind,
): Promise<OfflineSnapshot | null> {
  if (!isReadCacheSupported()) return null;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readonly");
    const rec = (await reqP(
      tx.objectStore(STORE).get(snapshotKey(userId, orgId, kind)),
    )) as OfflineSnapshot | undefined;
    if (
      !rec ||
      !isValidSnapshot(rec) ||
      !snapshotMatchesPartition(rec, userId, orgId)
    ) {
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

/** Every cached snapshot for THIS partition (all kinds). Foreign records filtered. */
export async function listSnapshots(
  userId: string,
  orgId: string,
): Promise<OfflineSnapshot[]> {
  if (!isReadCacheSupported()) return [];
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readonly");
    const recs = (await reqP(
      tx
        .objectStore(STORE)
        .index("by_partition")
        .getAll(IDBKeyRange.only(readPartitionPrefix(userId, orgId))),
    )) as OfflineSnapshot[];
    return recs.filter(
      (r) => isValidSnapshot(r) && snapshotMatchesPartition(r, userId, orgId),
    );
  } catch {
    return [];
  }
}

/** Org-switch / targeted purge. Omit orgId to clear every org for this user. */
export async function clearReadsForUser(
  userId: string,
  orgId?: string,
): Promise<void> {
  if (!isReadCacheSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (orgId) {
      const keys = (await reqP(
        store
          .index("by_partition")
          .getAllKeys(IDBKeyRange.only(readPartitionPrefix(userId, orgId))),
      )) as IDBValidKey[];
      for (const k of keys) store.delete(k);
    } else {
      const keys = (await reqP(
        store.index("by_user").getAllKeys(IDBKeyRange.only(userId)),
      )) as IDBValidKey[];
      for (const k of keys) store.delete(k);
    }
    await txDone(tx);
  } catch {
    /* best-effort */
  }
}

/**
 * SHARED-DEVICE GATE. Deletes every cached snapshot that does NOT belong to
 * `userId` — called on mount with the SERVER-TRUSTED session identity, exactly as
 * the write queue's purgeForeignUsers is. Cached reads are less sensitive than
 * unsent writes (they are re-downloadable and RLS-governed), but a shared tablet
 * still must not serve one user's cached customer list to the next.
 */
export async function purgeForeignReads(userId: string): Promise<number> {
  if (!isReadCacheSupported()) return 0;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const all = (await reqP(store.getAll())) as OfflineSnapshot[];
    let removed = 0;
    for (const r of all) {
      if (!isValidSnapshot(r) || r.userId !== userId) {
        store.delete((r as { key?: IDBValidKey }).key ?? "");
        removed += 1;
      }
    }
    await txDone(tx);
    return removed;
  } catch {
    return 0;
  }
}

/** LOGOUT PURGE — the read cache is discarded on sign-out (shared-device safety). */
export async function clearAllReads(): Promise<void> {
  if (!isReadCacheSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } catch {
    /* best-effort */
  }
}

/** Test-only: drop the memoized handle so a fresh fake-indexeddb is picked up. */
export function _resetForTest(): void {
  dbPromise = null;
}
