import {
  isOfflineWriteKind,
  offlineWriteEntity,
  type OfflineWriteKind,
} from "./registry";

/**
 * OFFLINE WRITE QUEUE (outbox) — the browser-local store that holds writes a
 * foreman authored with no signal until the server accepts them.
 *
 * Built as a deliberate sibling of lib/blueprints/offline-store.ts (Programme E):
 * same shape (PURE helpers + a lazily-opened async IDB adapter, so importing this
 * module never touches `indexedDB`), same `userId::orgId` partitioning, same
 * quota discipline, same logout purge. It is a SEPARATE IndexedDB database because
 * the two hold opposite things — Programme E holds a server-authored copy that is
 * safe to lose (re-downloadable), this holds USER-AUTHORED WORK THAT EXISTS
 * NOWHERE ELSE. Mixing them would invite a "just clear the cache" reflex that
 * silently deletes a foreman's day.
 *
 * ── The four properties this store must have ──────────────────────────────────
 *
 * 1. IDEMPOTENT. Every item carries a client-generated `clientKey` that is
 *    persisted WITH it and never regenerated on retry. The database enforces
 *    uniqueness on (org_id, client_write_key) — see migration 20261077000000 — so
 *    a replay after a reinstalled service worker, a double-tap, two open tabs or a
 *    crash mid-flush yields ONE row. JS-side dedupe is a convenience; the unique
 *    index is the guarantee.
 *
 * 2. PARTITIONED + PURGED. These are shared site tablets. An item is keyed by
 *    `userId::orgId::clientKey` and read only through its partition, so user B's
 *    outbox can never see (let alone flush) user A's unsent work. Reinforced by
 *    `purgeForeignUsers()` — called by the outbox with the SERVER-TRUSTED identity
 *    on every mount, which heals the case where A's session ended without a clean
 *    logout — and by `clearAll()` on sign-out. Unsent writes are user data; they do
 *    not survive a logout.
 *
 * 3. ORDERED. `seq` is allocated inside the same readwrite transaction as the
 *    insert, so two concurrent enqueues cannot take the same number, and the flush
 *    always drains in `seq` order. Wall-clock times are device clocks and are never
 *    used to order anything.
 *
 * 4. BOUNDED, AND LOUD WHEN FULL. A silent drop is the one unacceptable failure:
 *    the foreman believes his day is saved and it is not. Every limit below returns
 *    a typed error the UI must surface; nothing is ever evicted to make room, and
 *    the caller is expected to keep the form populated so the words are not lost.
 *
 * NEVER STORED: tokens, signed URLs, storage paths, cookies, session state. The
 * payload is re-parsed through the registry's Zod schema before it is written, and
 * Zod strips unknown keys — so a caller cannot smuggle a credential into this store
 * even by mistake. Asserted in __tests__/security/offline-write-queue.test.ts.
 */

// ── constants ────────────────────────────────────────────────────────────────
export const WRITE_QUEUE_SCHEMA_VERSION = 1;
const DB_NAME = "crewflow-offline-writes";
const DB_VERSION = 1;
const STORE = "outbox";
const SEP = "::";

/** Per-partition item ceiling. ~2 months of daily diary entries; far past the point
 *  where a device that never reconnects is the real problem to surface. */
export const MAX_QUEUED_WRITES = 200;
/** One item's serialised payload ceiling. A diary entry's longest field is 8,000
 *  chars, so 64 KB is generous for text and small enough that no single item can
 *  monopolise the store. Binary (photos) is NOT carried here — see the doc. */
export const MAX_QUEUED_ITEM_BYTES = 64 * 1024;
/** Whole-store ceiling across every partition on the device. */
export const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
/** Leave headroom in the shared origin bucket so a queued write never loses a race
 *  with the drawing cache for the last byte of quota. */
export const QUEUE_QUOTA_MARGIN_BYTES = 8 * 1024 * 1024;

export type QueuedWriteStatus =
  /** Will be attempted (again). The only status the flush ever sends. */
  | "pending"
  /** The server PERMANENTLY refused it. Never retried, never deleted by the app —
   *  retained so the user can read back and recover what they wrote. */
  | "rejected";

export type QueuedWrite = {
  schemaVersion: number;
  /** IDB primary key: `${userId}::${orgId}::${clientKey}`. */
  key: string;
  /** IDB index key: `${userId}::${orgId}::`. */
  partition: string;
  /** IDB index key — used ONLY by purgeForeignUsers (shared-device safety). */
  userId: string;
  /** The org that was ACTIVE when this was authored. The server refuses to re-home
   *  a queued write into any other org; it is never rewritten here. */
  orgId: string;
  /** The idempotency key. Generated once, persisted, NEVER regenerated on retry. */
  clientKey: string;
  kind: OfflineWriteKind;
  /** Registry-schema-parsed payload. Unknown keys are already stripped. */
  payload: Record<string, unknown>;
  /** Deterministic flush order within a partition. */
  seq: number;
  /** Device clock at authoring. UNTRUSTED: provenance for display only. */
  authoredAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  status: QueuedWriteStatus;
};

export type EnqueueError =
  | "unsupported" // browser has no IndexedDB / crypto
  | "unknown_kind" // not in the registry — the gate
  | "invalid_payload" // failed the registry's own schema
  | "too_large" // one item over MAX_QUEUED_ITEM_BYTES
  | "queue_full" // partition at MAX_QUEUED_WRITES
  | "store_full" // device store at MAX_QUEUE_BYTES
  | "quota_exceeded" // browser refused the write
  | "write_failed";
export type EnqueueResult =
  | { ok: true; item: QueuedWrite }
  | { ok: false; error: EnqueueError };

// ── pure helpers ─────────────────────────────────────────────────────────────
export function writePartitionPrefix(userId: string, orgId: string): string {
  return `${userId}${SEP}${orgId}${SEP}`;
}
export function writeQueueKey(
  userId: string,
  orgId: string,
  clientKey: string,
): string {
  return `${writePartitionPrefix(userId, orgId)}${clientKey}`;
}
/** Re-check a decoded record belongs to the live session — a tampered key cannot
 *  slip a foreign record into a flush (mirrors Programme E's scope guard). */
export function queuedWriteMatchesPartition(
  rec: { userId: string; orgId: string },
  userId: string,
  orgId: string,
): boolean {
  return rec.userId === userId && rec.orgId === orgId;
}

export function isValidQueuedWrite(v: unknown): v is QueuedWrite {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r.schemaVersion === WRITE_QUEUE_SCHEMA_VERSION &&
    typeof r.key === "string" &&
    typeof r.partition === "string" &&
    typeof r.userId === "string" &&
    r.userId.length > 0 &&
    typeof r.orgId === "string" &&
    r.orgId.length > 0 &&
    typeof r.clientKey === "string" &&
    r.clientKey.length > 0 &&
    isOfflineWriteKind(r.kind) &&
    !!r.payload &&
    typeof r.payload === "object" &&
    typeof r.seq === "number" &&
    Number.isFinite(r.seq) &&
    typeof r.authoredAt === "string" &&
    typeof r.attempts === "number" &&
    (r.status === "pending" || r.status === "rejected")
  );
}

/** Deterministic flush order: seq ascending. Never a device timestamp. */
export function sortQueued(items: QueuedWrite[]): QueuedWrite[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

/** Next seq for a partition. Pure so the allocation rule is testable on its own. */
export function nextSeq(existing: { seq: number }[]): number {
  let max = 0;
  for (const e of existing) if (e.seq > max) max = e.seq;
  return max + 1;
}

export function estimateItemBytes(item: {
  payload: unknown;
  kind: string;
  clientKey: string;
}): number {
  try {
    // Byte length, not char length — a payload of emoji or accented site names must
    // not slip past a limit measured in UTF-16 code units.
    return new TextEncoder().encode(
      JSON.stringify({
        p: item.payload,
        k: item.kind,
        c: item.clientKey,
      }),
    ).length;
  } catch {
    return Number.MAX_SAFE_INTEGER; // unserialisable → refuse loudly
  }
}

export function hasQueueRoom(
  estimate: { usage?: number; quota?: number },
  sizeBytes: number,
  marginBytes = QUEUE_QUOTA_MARGIN_BYTES,
): boolean {
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  if (quota <= 0) return true; // browser withheld quota → rely on QuotaExceededError
  return usage + sizeBytes + marginBytes <= quota;
}

export function isWriteQueueSupported(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  );
}

/** Fresh idempotency key. Only ever called at AUTHORING time — never on retry. */
export function newClientKey(): string {
  return crypto.randomUUID();
}

// ── IDB adapter ──────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!isWriteQueueSupported()) {
    return Promise.reject(new Error("offline write queue unsupported"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "key" });
        os.createIndex("by_partition", "partition", { unique: false });
        // Shared-device safety: lets purgeForeignUsers find every record that does
        // NOT belong to the signed-in user without decoding the whole store.
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
 * Store one authored-offline write.
 *
 * `identity` MUST come from a server-rendered authenticated page (the session the
 * server validated), never from the client-side offline identity marker — that
 * marker is enough to scope a READ of already-downloaded bytes, but attributing
 * newly authored WORK to whoever the device last remembered is an attribution
 * hazard on a shared tablet. See docs/offline-write-queue.md.
 */
export async function enqueue(args: {
  userId: string;
  orgId: string;
  kind: OfflineWriteKind;
  /** Raw form values; parsed through the registry schema before storage. */
  payload: unknown;
  /** Test seam only — production always mints a fresh key here. */
  clientKey?: string;
  authoredAt?: string;
}): Promise<EnqueueResult> {
  if (!isWriteQueueSupported()) return { ok: false, error: "unsupported" };
  // THE GATE, client side. The server applies it again before dispatching.
  if (!isOfflineWriteKind(args.kind)) return { ok: false, error: "unknown_kind" };

  // Validate with the SAME schema the online server action uses, and store the
  // PARSED value — Zod strips unknown keys, so nothing unexpected (a token, a URL)
  // can ride into IndexedDB even if a caller passes the whole form object.
  const parsed = offlineWriteEntity(args.kind).schema.safeParse(args.payload);
  if (!parsed.success) return { ok: false, error: "invalid_payload" };
  const payload = parsed.data as Record<string, unknown>;

  const clientKey = args.clientKey ?? newClientKey();
  const itemBytes = estimateItemBytes({ payload, kind: args.kind, clientKey });
  if (itemBytes > MAX_QUEUED_ITEM_BYTES) return { ok: false, error: "too_large" };
  if (!hasQueueRoom(await estimate(), itemBytes)) {
    return { ok: false, error: "quota_exceeded" };
  }

  try {
    const db = await open();
    // ONE readwrite transaction reads the partition, allocates seq, and writes —
    // so two concurrent enqueues (two tabs, a double-tap) cannot collide on seq.
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const partition = writePartitionPrefix(args.userId, args.orgId);
    const mine = ((await reqP(
      store.index("by_partition").getAll(IDBKeyRange.only(partition)),
    )) as QueuedWrite[]).filter(isValidQueuedWrite);

    if (mine.length >= MAX_QUEUED_WRITES) {
      tx.abort();
      return { ok: false, error: "queue_full" };
    }
    const deviceBytes = ((await reqP(store.getAll())) as QueuedWrite[]).reduce(
      (n, r) => n + estimateItemBytes(r),
      0,
    );
    if (deviceBytes + itemBytes > MAX_QUEUE_BYTES) {
      tx.abort();
      return { ok: false, error: "store_full" };
    }

    const item: QueuedWrite = {
      schemaVersion: WRITE_QUEUE_SCHEMA_VERSION,
      key: writeQueueKey(args.userId, args.orgId, clientKey),
      partition,
      userId: args.userId,
      orgId: args.orgId,
      clientKey,
      kind: args.kind,
      payload,
      seq: nextSeq(mine),
      authoredAt: args.authoredAt ?? new Date().toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
    };
    store.add(item); // add(), not put() — re-enqueuing an existing key is a bug
    await txDone(tx);
    return { ok: true, item };
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "QuotaExceededError") return { ok: false, error: "quota_exceeded" };
    if (name === "AbortError") return { ok: false, error: "write_failed" };
    return { ok: false, error: "write_failed" };
  }
}

/** Every item in THIS partition, flush order. Foreign records are filtered, not trusted. */
export async function listForPartition(
  userId: string,
  orgId: string,
): Promise<QueuedWrite[]> {
  if (!isWriteQueueSupported()) return [];
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readonly");
    const recs = (await reqP(
      tx
        .objectStore(STORE)
        .index("by_partition")
        .getAll(IDBKeyRange.only(writePartitionPrefix(userId, orgId))),
    )) as QueuedWrite[];
    return sortQueued(
      recs.filter(
        (r) =>
          isValidQueuedWrite(r) && queuedWriteMatchesPartition(r, userId, orgId),
      ),
    );
  } catch {
    return [];
  }
}

/** The items a flush may send: pending only, in seq order. */
export async function listPending(
  userId: string,
  orgId: string,
): Promise<QueuedWrite[]> {
  return (await listForPartition(userId, orgId)).filter(
    (r) => r.status === "pending",
  );
}

/**
 * How many items sit on this DEVICE across every partition. Used by the PUBLIC
 * offline shell, which has no server session — so it may learn the COUNT and
 * nothing else. No content, no author, no org, no dates.
 */
export async function countOnDevice(): Promise<number> {
  if (!isWriteQueueSupported()) return 0;
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
  fn: (r: QueuedWrite) => QueuedWrite,
): Promise<void> {
  if (!isWriteQueueSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const rec = (await reqP(store.get(key))) as QueuedWrite | undefined;
    if (rec && isValidQueuedWrite(rec)) store.put(fn(rec));
    await txDone(tx);
  } catch {
    /* best-effort: a failed bookkeeping write must never lose the item itself */
  }
}

/** A TRANSIENT failure. Stays pending — the content is never destroyed. */
export async function markAttemptFailed(
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

/**
 * A PERMANENT server refusal (validation, wrong org, RLS, missing parent job).
 * The item is RETAINED, not deleted: the user is told, and can read back and copy
 * what they wrote. Only an explicit user discard removes it.
 */
export async function markRejected(key: string, reason: string): Promise<void> {
  await patch(key, (r) => ({
    ...r,
    attempts: r.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: reason,
    status: "rejected",
  }));
}

/** Accepted by the server (or found already recorded) — the only path that deletes. */
export async function removeQueued(key: string): Promise<void> {
  if (!isWriteQueueSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    await txDone(tx);
  } catch {
    /* best-effort — the DB unique index makes a re-send harmless */
  }
}

/** Org-switch / targeted purge. Omit orgId to clear every org for this user. */
export async function clearForUser(
  userId: string,
  orgId?: string,
): Promise<void> {
  if (!isWriteQueueSupported()) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (orgId) {
      const keys = (await reqP(
        store
          .index("by_partition")
          .getAllKeys(IDBKeyRange.only(writePartitionPrefix(userId, orgId))),
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
 * SHARED-DEVICE GATE (defence 3). Deletes every queued write that does NOT belong
 * to `userId` — called by the outbox on mount with the SERVER-TRUSTED session
 * identity. Handles the case a clean logout cannot: user A's session simply expired
 * or the tablet was closed, then user B signed in. B must not inherit A's unsent
 * work, and "invisible because it is in another partition" is not enough for
 * content that is not B's to hold.
 *
 * This DOES destroy A's unsent items without asking. That is the deliberate
 * trade-off: on a device several people share, one person's words must not sit in
 * another person's browser storage. The sign-out path is where a user gets asked
 * (see SignOutButton); this path exists for when nobody signed out at all.
 * Returns how many were removed so the caller can log/surface it.
 */
export async function purgeForeignUsers(userId: string): Promise<number> {
  if (!isWriteQueueSupported()) return 0;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const all = (await reqP(store.getAll())) as QueuedWrite[];
    let removed = 0;
    for (const r of all) {
      // A record with no valid shape is also foreign — it cannot be proven to be
      // this user's, so it does not get to stay.
      if (!isValidQueuedWrite(r) || r.userId !== userId) {
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

/** LOGOUT PURGE — unsent writes are user data and do not survive a sign-out. */
export async function clearAll(): Promise<void> {
  if (!isWriteQueueSupported()) return;
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
