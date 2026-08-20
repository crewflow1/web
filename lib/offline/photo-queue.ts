/**
 * OFFLINE PHOTO / FILE CAPTURE QUEUE — the browser-local store that holds BINARY
 * captures (a snag photo, a delivery-note scan) authored with no signal until the
 * server accepts them.
 *
 * The JSON write queue (lib/offline/write-queue.ts) deliberately carries NO binary:
 * its items are small, text-shaped, and merge-reconcilable, and every entity it
 * enables excludes photos "exactly as the diary excludes them (the queue carries
 * JSON, never binary)". This store is the answer to the other half of that promise
 * — the photos to follow. It is a SEPARATE IndexedDB database and a separate
 * subsystem because binary needs its own size discipline, its own upload transport
 * (multipart to storage, not a JSON action), and a different idempotency proof
 * (content bytes + a client key, not a row merge).
 *
 * ── The properties it shares with the write queue ─────────────────────────────
 * 1. IDEMPOTENT. Every capture carries a `clientKey` persisted WITH it and never
 *    regenerated on retry. The server dedupes on (org_id, client_write_key) —
 *    migration 20261194000000, a partial unique index on tenant_attachments — so a
 *    replay after a reinstalled service worker, a double-tap or two tabs yields ONE
 *    attachment, never a duplicate upload.
 * 2. PARTITIONED + PURGED. Keyed `userId::orgId::clientKey`, read only through its
 *    partition, purged for foreign users on mount and cleared on logout. A shared
 *    tablet never uploads user A's captured photo under user B's session.
 * 3. ORDERED. `seq` is allocated inside the insert transaction; the flush drains in
 *    seq order.
 * 4. BOUNDED, AND LOUD WHEN FULL. Photos are large, so the ceilings here are about
 *    bytes as much as count. Nothing is ever evicted to make room — a full store
 *    returns a typed error the UI surfaces, exactly like the write queue, because a
 *    silently dropped capture is a photo the foreman believes he took and did not.
 *
 * NEVER STORED: tokens, signed URLs, storage paths, session state — only the raw
 * bytes, the target the foreman chose, and the filename/MIME.
 */

// ── constants ────────────────────────────────────────────────────────────────
export const PHOTO_QUEUE_SCHEMA_VERSION = 1;
const DB_NAME = "crewflow-offline-photos";
const DB_VERSION = 1;
const STORE = "captures";
const SEP = "::";

/** Per-partition capture ceiling. */
export const MAX_QUEUED_PHOTOS = 100;
/** One capture's byte ceiling — mirrors tenant_attachments' 25 MB server cap so a
 *  capture that would be refused on upload is refused at authoring, not after a
 *  wasted store. */
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
/** Whole-store ceiling across every partition on the device. */
export const MAX_PHOTO_STORE_BYTES = 200 * 1024 * 1024;
/** Leave headroom in the shared origin bucket so a queued capture never loses a
 *  race with the drawing cache or the write queue for the last byte of quota. */
export const PHOTO_QUOTA_MARGIN_BYTES = 16 * 1024 * 1024;

/**
 * The tenant-attachment targets a FIELD capture may be queued against. A strict
 * subset of the server's ATTACHMENT_TARGET_TABLES (server/services/tenant-
 * attachments.ts) — the entities a foreman photographs on site. The SERVER
 * re-validates against its own list before any upload, so this is a UX gate, not
 * the trust boundary; but keeping it explicit means a capture can only ever be
 * queued for a target the product actually supports offline.
 */
export const PHOTO_TARGET_TABLES = [
  "jobs",
  "snags",
  "site_diary_entries",
  "site_reports",
  "goods_received_notes",
  "non_conformance_reports",
  "inspection_signoffs",
  "assets",
  "asset_inspections",
] as const;
export type PhotoTargetTable = (typeof PHOTO_TARGET_TABLES)[number];

/** Image MIME types a field capture may carry. The server's attachment whitelist
 *  is broader (PDF, spreadsheets); a no-signal CAPTURE is a photo. */
export const PHOTO_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);

export type QueuedPhotoStatus =
  /** Will be uploaded (again). The only status the flush ever sends. */
  | "pending"
  /** The server PERMANENTLY refused it (bad type, too large, target gone, wrong
   *  org, no permission). Retained so the user sees what could not be sent. */
  | "rejected";

export type QueuedPhoto = {
  schemaVersion: number;
  /** IDB primary key: `${userId}::${orgId}::${clientKey}`. */
  key: string;
  /** IDB index key: `${userId}::${orgId}::`. */
  partition: string;
  userId: string;
  orgId: string;
  /** The idempotency key. Generated once, persisted, NEVER regenerated on retry. */
  clientKey: string;
  targetTable: PhotoTargetTable;
  /** The row the capture is attached to (a job, a snag…). */
  targetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** The raw bytes. Stored as a Blob so IndexedDB keeps it off the JS heap. */
  blob: Blob;
  seq: number;
  authoredAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  status: QueuedPhotoStatus;
};

export type EnqueuePhotoError =
  | "unsupported"
  | "unknown_target" // target table not in PHOTO_TARGET_TABLES
  | "bad_target_id" // target id not a uuid
  | "bad_file_type" // MIME not in PHOTO_MIME_TYPES
  | "empty_file" // zero bytes
  | "too_large" // over MAX_PHOTO_BYTES
  | "queue_full" // partition at MAX_QUEUED_PHOTOS
  | "store_full" // device store at MAX_PHOTO_STORE_BYTES
  | "quota_exceeded" // browser refused the write
  | "write_failed";
export type EnqueuePhotoResult =
  | { ok: true; item: QueuedPhoto }
  | { ok: false; error: EnqueuePhotoError };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── pure helpers ─────────────────────────────────────────────────────────────
export function photoPartitionPrefix(userId: string, orgId: string): string {
  return `${userId}${SEP}${orgId}${SEP}`;
}
export function photoQueueKey(
  userId: string,
  orgId: string,
  clientKey: string,
): string {
  return `${photoPartitionPrefix(userId, orgId)}${clientKey}`;
}
export function queuedPhotoMatchesPartition(
  rec: { userId: string; orgId: string },
  userId: string,
  orgId: string,
): boolean {
  return rec.userId === userId && rec.orgId === orgId;
}

export function isPhotoTargetTable(t: unknown): t is PhotoTargetTable {
  return (
    typeof t === "string" &&
    (PHOTO_TARGET_TABLES as readonly string[]).includes(t)
  );
}

export function isValidQueuedPhoto(v: unknown): v is QueuedPhoto {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r.schemaVersion === PHOTO_QUEUE_SCHEMA_VERSION &&
    typeof r.key === "string" &&
    typeof r.partition === "string" &&
    typeof r.userId === "string" &&
    r.userId.length > 0 &&
    typeof r.orgId === "string" &&
    r.orgId.length > 0 &&
    typeof r.clientKey === "string" &&
    UUID_RE.test(r.clientKey) &&
    isPhotoTargetTable(r.targetTable) &&
    typeof r.targetId === "string" &&
    typeof r.filename === "string" &&
    typeof r.mimeType === "string" &&
    r.blob instanceof Blob &&
    typeof r.seq === "number" &&
    Number.isFinite(r.seq) &&
    typeof r.authoredAt === "string" &&
    typeof r.attempts === "number" &&
    (r.status === "pending" || r.status === "rejected")
  );
}

export function sortQueuedPhotos(items: QueuedPhoto[]): QueuedPhoto[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

export function nextPhotoSeq(existing: { seq: number }[]): number {
  let max = 0;
  for (const e of existing) if (e.seq > max) max = e.seq;
  return max + 1;
}

export function hasPhotoRoom(
  estimate: { usage?: number; quota?: number },
  sizeBytes: number,
  marginBytes = PHOTO_QUOTA_MARGIN_BYTES,
): boolean {
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  if (quota <= 0) return true;
  return usage + sizeBytes + marginBytes <= quota;
}

export function isPhotoQueueSupported(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  );
}

export function newPhotoClientKey(): string {
  return crypto.randomUUID();
}

// ── IDB adapter ──────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!isPhotoQueueSupported()) {
    return Promise.reject(new Error("offline photo queue unsupported"));
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
 * Store one authored-offline binary capture.
 *
 * `identity` MUST come from a server-rendered authenticated page (the session the
 * server validated), never from the client-side offline identity marker — the same
 * attribution rule the write queue enforces: attributing a captured PHOTO to
 * whoever the device last remembered is the same shared-tablet hazard.
 */
export async function enqueuePhoto(args: {
  userId: string;
  orgId: string;
  targetTable: PhotoTargetTable;
  targetId: string;
  filename: string;
  mimeType: string;
  bytes: ArrayBuffer;
  clientKey?: string;
  authoredAt?: string;
}): Promise<EnqueuePhotoResult> {
  if (!isPhotoQueueSupported()) return { ok: false, error: "unsupported" };
  if (!isPhotoTargetTable(args.targetTable)) {
    return { ok: false, error: "unknown_target" };
  }
  if (typeof args.targetId !== "string" || !UUID_RE.test(args.targetId)) {
    return { ok: false, error: "bad_target_id" };
  }
  if (!PHOTO_MIME_TYPES.has(args.mimeType)) {
    return { ok: false, error: "bad_file_type" };
  }
  if (args.bytes.byteLength === 0) return { ok: false, error: "empty_file" };
  if (args.bytes.byteLength > MAX_PHOTO_BYTES) {
    return { ok: false, error: "too_large" };
  }
  if (!hasPhotoRoom(await estimate(), args.bytes.byteLength)) {
    return { ok: false, error: "quota_exceeded" };
  }

  const clientKey = args.clientKey ?? newPhotoClientKey();
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const partition = photoPartitionPrefix(args.userId, args.orgId);
    const mine = ((await reqP(
      store.index("by_partition").getAll(IDBKeyRange.only(partition)),
    )) as QueuedPhoto[]).filter(isValidQueuedPhoto);

    if (mine.length >= MAX_QUEUED_PHOTOS) {
      tx.abort();
      return { ok: false, error: "queue_full" };
    }
    const deviceBytes = ((await reqP(store.getAll())) as QueuedPhoto[]).reduce(
      (n, r) => n + (typeof r.sizeBytes === "number" ? r.sizeBytes : 0),
      0,
    );
    if (deviceBytes + args.bytes.byteLength > MAX_PHOTO_STORE_BYTES) {
      tx.abort();
      return { ok: false, error: "store_full" };
    }

    const item: QueuedPhoto = {
      schemaVersion: PHOTO_QUEUE_SCHEMA_VERSION,
      key: photoQueueKey(args.userId, args.orgId, clientKey),
      partition,
      userId: args.userId,
      orgId: args.orgId,
      clientKey,
      targetTable: args.targetTable,
      targetId: args.targetId,
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: args.bytes.byteLength,
      blob: new Blob([args.bytes], { type: args.mimeType }),
      seq: nextPhotoSeq(mine),
      authoredAt: args.authoredAt ?? new Date().toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
    };
    store.add(item);
    await txDone(tx);
    return { ok: true, item };
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "QuotaExceededError") return { ok: false, error: "quota_exceeded" };
    return { ok: false, error: "write_failed" };
  }
}

export async function listPhotosForPartition(
  userId: string,
  orgId: string,
): Promise<QueuedPhoto[]> {
  if (!isPhotoQueueSupported()) return [];
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readonly");
    const recs = (await reqP(
      tx
        .objectStore(STORE)
        .index("by_partition")
        .getAll(IDBKeyRange.only(photoPartitionPrefix(userId, orgId))),
    )) as QueuedPhoto[];
    return sortQueuedPhotos(
      recs.filter(
        (r) =>
          isValidQueuedPhoto(r) && queuedPhotoMatchesPartition(r, userId, orgId),
      ),
    );
  } catch {
    return [];
  }
}

export async function listPendingPhotos(
  userId: string,
  orgId: string,
): Promise<QueuedPhoto[]> {
  return (await listPhotosForPartition(userId, orgId)).filter(
    (r) => r.status === "pending",
  );
}

/** Device-wide count (all partitions) — for the sign-out warning. No content. */
export async function countPhotosOnDevice(): Promise<number> {
  if (!isPhotoQueueSupported()) return 0;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readonly");
    return await reqP(tx.objectStore(STORE).count());
  } catch {
    return 0;
  }
}

async function patch(
  key: string,
  fn: (r: QueuedPhoto) => QueuedPhoto,
): Promise<void> {
  if (!isPhotoQueueSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const rec = (await reqP(store.get(key))) as QueuedPhoto | undefined;
    if (rec && isValidQueuedPhoto(rec)) store.put(fn(rec));
    await txDone(tx);
  } catch {
    /* best-effort: a failed bookkeeping write must never lose the capture itself */
  }
}

export async function markPhotoAttemptFailed(
  key: string,
  error: string,
): Promise<void> {
  await patch(key, (r) => ({
    ...r,
    attempts: r.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
    status: "pending",
  }));
}

export async function markPhotoRejected(
  key: string,
  reason: string,
): Promise<void> {
  await patch(key, (r) => ({
    ...r,
    attempts: r.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: reason,
    status: "rejected",
  }));
}

/** Accepted (or found already recorded) — the only path that deletes. */
export async function removeQueuedPhoto(key: string): Promise<void> {
  if (!isPhotoQueueSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    await txDone(tx);
  } catch {
    /* best-effort — the DB unique index makes a re-send harmless */
  }
}

export async function clearPhotosForUser(
  userId: string,
  orgId?: string,
): Promise<void> {
  if (!isPhotoQueueSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (orgId) {
      const keys = (await reqP(
        store
          .index("by_partition")
          .getAllKeys(IDBKeyRange.only(photoPartitionPrefix(userId, orgId))),
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

/** SHARED-DEVICE GATE — deletes every capture NOT belonging to `userId`. */
export async function purgeForeignPhotos(userId: string): Promise<number> {
  if (!isPhotoQueueSupported()) return 0;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const all = (await reqP(store.getAll())) as QueuedPhoto[];
    let removed = 0;
    for (const r of all) {
      if (!isValidQueuedPhoto(r) || r.userId !== userId) {
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

/** LOGOUT PURGE — unsent captures are user data and do not survive a sign-out. */
export async function clearAllPhotos(): Promise<void> {
  if (!isPhotoQueueSupported()) return;
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
