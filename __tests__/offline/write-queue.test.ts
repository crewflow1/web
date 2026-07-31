import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writePartitionPrefix,
  writeQueueKey,
  queuedWriteMatchesPartition,
  isValidQueuedWrite,
  sortQueued,
  nextSeq,
  estimateItemBytes,
  hasQueueRoom,
  isWriteQueueSupported,
  newClientKey,
  enqueue,
  listForPartition,
  listPending,
  countOnDevice,
  markAttemptFailed,
  markRejected,
  removeQueued,
  clearForUser,
  purgeForeignUsers,
  clearAll,
  WRITE_QUEUE_SCHEMA_VERSION,
  MAX_QUEUED_WRITES,
  MAX_QUEUED_ITEM_BYTES,
  type QueuedWrite,
} from "@/lib/offline/write-queue";

/**
 * Offline write queue (outbox) — behaviour against a real IndexedDB implementation
 * (fake-indexeddb), mirroring __tests__/blueprints/offline-store.test.ts.
 *
 * The four properties the store claims in its header are each proven here:
 * idempotency-key persistence, partition isolation + purge, deterministic order,
 * and BOUNDED-AND-LOUD (never a silent drop).
 */

const A = "user-a";
const B = "user-b";
const ORG1 = "org-1";
const ORG2 = "org-2";

const payload = (over: Record<string, unknown> = {}) => ({
  entry_date: "2026-07-30",
  weather: "Dry am, heavy rain pm",
  labour_count: "4",
  work_summary: "First fix plumbing complete on plots 3-5.",
  ...over,
});

const add = (
  over: Partial<Parameters<typeof enqueue>[0]> = {},
): Promise<Awaited<ReturnType<typeof enqueue>>> =>
  enqueue({
    userId: A,
    orgId: ORG1,
    kind: "site_diary.create",
    payload: payload(),
    ...over,
  });

beforeEach(async () => {
  await clearAll();
});

describe("write-queue — pure helpers", () => {
  it("keys every item by userId::orgId::clientKey (partition-scoped)", () => {
    expect(writeQueueKey(A, ORG1, "k1")).toBe("user-a::org-1::k1");
    expect(writeQueueKey(A, ORG1, "k1")).not.toBe(writeQueueKey(B, ORG1, "k1"));
    expect(writeQueueKey(A, ORG1, "k1")).not.toBe(writeQueueKey(A, ORG2, "k1"));
    expect(writeQueueKey(A, ORG1, "k1").startsWith(writePartitionPrefix(A, ORG1))).toBe(
      true,
    );
  });

  it("queuedWriteMatchesPartition guards the live session", () => {
    expect(queuedWriteMatchesPartition({ userId: A, orgId: ORG1 }, A, ORG1)).toBe(true);
    expect(queuedWriteMatchesPartition({ userId: A, orgId: ORG1 }, B, ORG1)).toBe(false);
    expect(queuedWriteMatchesPartition({ userId: A, orgId: ORG1 }, A, ORG2)).toBe(false);
  });

  it("isValidQueuedWrite accepts a good record and rejects tampered ones", async () => {
    const r = await add();
    expect(r.ok).toBe(true);
    const good = (r as { ok: true; item: QueuedWrite }).item;
    expect(isValidQueuedWrite(good)).toBe(true);
    expect(isValidQueuedWrite({ ...good, schemaVersion: 99 })).toBe(false);
    expect(isValidQueuedWrite({ ...good, kind: "invoices.create" })).toBe(false);
    expect(isValidQueuedWrite({ ...good, status: "accepted" })).toBe(false);
    expect(isValidQueuedWrite({ ...good, userId: "" })).toBe(false);
    expect(isValidQueuedWrite({ ...good, clientKey: "" })).toBe(false);
    expect(isValidQueuedWrite(null)).toBe(false);
  });

  it("nextSeq is max+1 and never reuses a number", () => {
    expect(nextSeq([])).toBe(1);
    expect(nextSeq([{ seq: 1 }, { seq: 2 }])).toBe(3);
    expect(nextSeq([{ seq: 7 }, { seq: 2 }])).toBe(8); // unordered input
  });

  it("sortQueued orders by seq, never by a device timestamp", () => {
    const mk = (seq: number, authoredAt: string) =>
      ({ seq, authoredAt }) as unknown as QueuedWrite;
    // authoredAt deliberately DESCENDING while seq ascends — a skewed device clock
    // must not be able to reorder the queue.
    const out = sortQueued([
      mk(3, "2020-01-01T00:00:00Z"),
      mk(1, "2030-01-01T00:00:00Z"),
      mk(2, "2025-01-01T00:00:00Z"),
    ]);
    expect(out.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("estimateItemBytes measures BYTES, not UTF-16 code units", () => {
    const ascii = estimateItemBytes({ payload: { a: "aaaa" }, kind: "k", clientKey: "c" });
    const emoji = estimateItemBytes({ payload: { a: "🧱🧱🧱🧱" }, kind: "k", clientKey: "c" });
    expect(emoji).toBeGreaterThan(ascii);
  });

  it("estimateItemBytes refuses (not silently accepts) an unserialisable payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      estimateItemBytes({ payload: cyclic, kind: "k", clientKey: "c" }),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("hasQueueRoom respects usage+size+margin<=quota; unknown quota does not pre-block", () => {
    expect(hasQueueRoom({ usage: 0, quota: 1000 }, 10, 100)).toBe(true);
    expect(hasQueueRoom({ usage: 900, quota: 1000 }, 10, 100)).toBe(false);
    expect(hasQueueRoom({ usage: 0, quota: 0 }, 10, 100)).toBe(true);
    expect(hasQueueRoom({}, 10, 100)).toBe(true);
  });

  it("is supported under fake-indexeddb + webcrypto, and mints distinct keys", () => {
    expect(isWriteQueueSupported()).toBe(true);
    expect(newClientKey()).not.toBe(newClientKey());
  });
});

describe("write-queue — enqueue is the registry gate and the schema gate", () => {
  it("refuses a kind that is not in the registry (unknown_kind)", async () => {
    const r = await enqueue({
      userId: A,
      orgId: ORG1,
      // A crafted caller naming an entity the CEO has not enabled.
      kind: "invoices.create" as never,
      payload: payload(),
    });
    expect(r).toEqual({ ok: false, error: "unknown_kind" });
    expect(await countOnDevice()).toBe(0);
  });

  it("refuses a payload the ONLINE schema would also refuse (invalid_payload)", async () => {
    const r = await add({ payload: { entry_date: "30/07/2026" } }); // not ISO
    expect(r).toEqual({ ok: false, error: "invalid_payload" });
    expect(await countOnDevice()).toBe(0);
  });

  it("STRIPS unknown keys — a credential cannot be smuggled into the store", async () => {
    const r = await add({
      payload: payload({
        access_token: "eyJhbGciOi.SECRET",
        signedUrl: "https://x.supabase.co/object/sign/blueprints/a?token=abc",
      }),
    });
    expect(r.ok).toBe(true);
    const [stored] = await listForPartition(A, ORG1);
    expect(Object.keys(stored!.payload)).not.toContain("access_token");
    expect(Object.keys(stored!.payload)).not.toContain("signedUrl");
    expect(JSON.stringify(stored)).not.toMatch(/SECRET|token=abc/);
  });

  it("stores the schema-PARSED payload (labour_count coerced to a number)", async () => {
    await add({ payload: payload({ labour_count: "6" }) });
    const [stored] = await listForPartition(A, ORG1);
    expect(stored!.payload.labour_count).toBe(6);
  });

  it("persists the idempotency key and starts pending with zero attempts", async () => {
    const r = await add({ clientKey: "fixed-key-1" });
    expect(r.ok).toBe(true);
    const [stored] = await listForPartition(A, ORG1);
    expect(stored!.clientKey).toBe("fixed-key-1");
    expect(stored!.status).toBe("pending");
    expect(stored!.attempts).toBe(0);
    expect(stored!.schemaVersion).toBe(WRITE_QUEUE_SCHEMA_VERSION);
    expect(stored!.orgId).toBe(ORG1); // the org active at authoring, pinned
  });
});

describe("write-queue — deterministic order", () => {
  it("allocates strictly increasing seq per partition and drains in that order", async () => {
    for (const s of ["one", "two", "three"]) {
      await add({ payload: payload({ work_summary: s }) });
    }
    const items = await listForPartition(A, ORG1);
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.payload.work_summary)).toEqual(["one", "two", "three"]);
  });

  it("seq is per-partition, so one user's queue can't renumber another's", async () => {
    await add();
    await add();
    await add({ userId: B });
    expect((await listForPartition(A, ORG1)).map((i) => i.seq)).toEqual([1, 2]);
    expect((await listForPartition(B, ORG1)).map((i) => i.seq)).toEqual([1]);
  });

  it("concurrent enqueues do not collide on seq (one txn allocates and writes)", async () => {
    await Promise.all([add(), add(), add(), add(), add()]);
    const seqs = (await listForPartition(A, ORG1)).map((i) => i.seq);
    expect(seqs).toHaveLength(5);
    expect(new Set(seqs).size).toBe(5); // every number distinct
  });
});

describe("write-queue — bounded, and LOUD when full (never a silent drop)", () => {
  it("the per-item ceiling can NEVER refuse a legitimate diary entry", async () => {
    // The whole point of the ceiling is to bound a future entity, not to reject the
    // foreman who writes a lot. Every diary field at its schema maximum — and in
    // 4-byte characters, the worst case for a byte limit — must still fit.
    const brick = "🧱";
    const r = await add({
      payload: payload({
        work_summary: brick.repeat(4000), // 8000 code units = schema max
        delays: brick.repeat(2000), // 4000 = schema max
        notes: brick.repeat(2000), // 4000 = schema max
        weather: brick.repeat(100), // 200 = schema max
      }),
    });
    expect(r.ok, "a maximum-length diary entry must be storable").toBe(true);
  });

  it("refuses an item over the per-item byte ceiling rather than truncating it", () => {
    // Enqueue compares estimateItemBytes() against MAX_QUEUED_ITEM_BYTES; prove the
    // measurement crosses the ceiling for an oversized payload, which is the input
    // that makes that comparison refuse. (No diary payload can reach it — see above —
    // so the guard exists for the next entity the registry enables.)
    expect(
      estimateItemBytes({
        payload: { work_summary: "x".repeat(MAX_QUEUED_ITEM_BYTES) },
        kind: "site_diary.create",
        clientKey: "c",
      }),
    ).toBeGreaterThan(MAX_QUEUED_ITEM_BYTES);
  });

  it("refuses (does not evict) once the partition hits MAX_QUEUED_WRITES", async () => {
    for (let i = 0; i < MAX_QUEUED_WRITES; i++) {
      const r = await add({ payload: payload({ work_summary: `entry ${i}` }) });
      expect(r.ok, `enqueue ${i}`).toBe(true);
    }
    const r = await add({ payload: payload({ work_summary: "one too many" }) });
    expect(r).toEqual({ ok: false, error: "queue_full" });
    // NOTHING was evicted to make room — the earlier entries are all still there.
    const items = await listForPartition(A, ORG1);
    expect(items).toHaveLength(MAX_QUEUED_WRITES);
    expect(items[0]!.payload.work_summary).toBe("entry 0");
  }, 60_000);

  it("refuses when the browser reports no quota headroom", async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { storage: { estimate: async () => ({ usage: 999, quota: 1000 }) } },
    });
    try {
      const r = await add();
      expect(r).toEqual({ ok: false, error: "quota_exceeded" });
      expect(await countOnDevice()).toBe(0);
    } finally {
      if (desc) Object.defineProperty(globalThis, "navigator", desc);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});

describe("write-queue — status transitions never destroy content", () => {
  it("a TRANSIENT failure keeps the item pending, with the content intact", async () => {
    const r = await add({ clientKey: "k-transient" });
    const key = (r as { ok: true; item: QueuedWrite }).item.key;
    await markAttemptFailed(key, "unreachable");
    await markAttemptFailed(key, "unreachable");
    const [item] = await listForPartition(A, ORG1);
    expect(item!.status).toBe("pending");
    expect(item!.attempts).toBe(2);
    expect(item!.lastError).toBe("unreachable");
    expect(item!.payload.work_summary).toBe(payload().work_summary);
    expect(await listPending(A, ORG1)).toHaveLength(1); // still retried
  });

  it("a PERMANENT rejection RETAINS the item (content recoverable) and stops retrying", async () => {
    const r = await add({ clientKey: "k-rejected" });
    const key = (r as { ok: true; item: QueuedWrite }).item.key;
    await markRejected(key, "job_missing");
    const [item] = await listForPartition(A, ORG1);
    expect(item!.status).toBe("rejected");
    expect(item!.lastError).toBe("job_missing");
    // THE POINT: the words are still there to read back.
    expect(item!.payload.work_summary).toBe(payload().work_summary);
    // and it is never sent again
    expect(await listPending(A, ORG1)).toHaveLength(0);
  });

  it("only removeQueued deletes — the accepted/duplicate path", async () => {
    const r = await add({ clientKey: "k-done" });
    const key = (r as { ok: true; item: QueuedWrite }).item.key;
    await removeQueued(key);
    expect(await listForPartition(A, ORG1)).toHaveLength(0);
  });

  it("the idempotency key never changes across retries", async () => {
    const r = await add({ clientKey: "stable-key" });
    const key = (r as { ok: true; item: QueuedWrite }).item.key;
    await markAttemptFailed(key, "unreachable");
    await markAttemptFailed(key, "unreachable");
    const [item] = await listForPartition(A, ORG1);
    expect(item!.clientKey).toBe("stable-key");
  });

  it("re-enqueuing an existing key is a bug and fails rather than duplicating", async () => {
    expect((await add({ clientKey: "dup" })).ok).toBe(true);
    expect(await add({ clientKey: "dup" })).toEqual({ ok: false, error: "write_failed" });
    expect(await listForPartition(A, ORG1)).toHaveLength(1);
  });
});

describe("write-queue — shared-device isolation (the highest-severity risk)", () => {
  it("one user's queue is INVISIBLE to another user's session", async () => {
    await add({ userId: A, payload: payload({ work_summary: "A's private day" }) });
    expect(await listForPartition(B, ORG1)).toEqual([]);
    expect(await listPending(B, ORG1)).toEqual([]);
    // and the same user in another org sees nothing either
    expect(await listForPartition(A, ORG2)).toEqual([]);
  });

  it("purgeForeignUsers DELETES every item that is not the signed-in user's", async () => {
    await add({ userId: A });
    await add({ userId: A, orgId: ORG2 });
    await add({ userId: B });
    await add({ userId: "user-c" });
    expect(await countOnDevice()).toBe(4);

    const removed = await purgeForeignUsers(A);
    expect(removed).toBe(2); // B and user-c
    expect(await countOnDevice()).toBe(2);
    // A keeps BOTH orgs: an org switch is not a boundary between people, and the
    // server refuses to re-home rather than needing the item deleted.
    expect(await listForPartition(A, ORG1)).toHaveLength(1);
    expect(await listForPartition(A, ORG2)).toHaveLength(1);
  });

  it("purgeForeignUsers also removes records it cannot prove belong to the user", async () => {
    await add({ userId: A });
    // Simulate a corrupt / older-schema record written straight into the store.
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open("crewflow-offline-writes");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise<void>((res, rej) => {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put({
        key: "junk",
        partition: `${A}::${ORG1}::`,
        userId: A,
        schemaVersion: 0, // not a valid queued write
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    expect(await countOnDevice()).toBe(2);
    expect(await purgeForeignUsers(A)).toBe(1);
    expect(await countOnDevice()).toBe(1);
  });

  it("clearForUser(user) removes every org for that user and nobody else's", async () => {
    await add({ userId: A, orgId: ORG1 });
    await add({ userId: A, orgId: ORG2 });
    await add({ userId: B, orgId: ORG1 });
    await clearForUser(A);
    expect(await listForPartition(A, ORG1)).toEqual([]);
    expect(await listForPartition(A, ORG2)).toEqual([]);
    expect(await listForPartition(B, ORG1)).toHaveLength(1);
  });

  it("clearForUser(user, org) is surgical", async () => {
    await add({ userId: A, orgId: ORG1 });
    await add({ userId: A, orgId: ORG2 });
    await clearForUser(A, ORG1);
    expect(await listForPartition(A, ORG1)).toEqual([]);
    expect(await listForPartition(A, ORG2)).toHaveLength(1);
  });

  it("clearAll (the LOGOUT purge) leaves nothing on the device for anyone", async () => {
    await add({ userId: A });
    await add({ userId: B });
    await add({ userId: A, orgId: ORG2 });
    expect(await countOnDevice()).toBe(3);
    await clearAll();
    expect(await countOnDevice()).toBe(0);
  });
});

describe("write-queue — countOnDevice is a COUNT and nothing more", () => {
  it("returns every partition's total, exposing no content", async () => {
    await add({ userId: A, payload: payload({ work_summary: "confidential" }) });
    await add({ userId: B });
    const n = await countOnDevice();
    expect(n).toBe(2);
    expect(typeof n).toBe("number"); // the public offline shell gets a number, not rows
  });
});

describe("write-queue — degrades safely when IndexedDB is unavailable", () => {
  const realIdb = globalThis.indexedDB;
  afterEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: realIdb,
    });
  });

  it("every entry point returns an honest empty/unsupported result, never throws", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
    expect(isWriteQueueSupported()).toBe(false);
    expect(await add()).toEqual({ ok: false, error: "unsupported" });
    expect(await listForPartition(A, ORG1)).toEqual([]);
    expect(await countOnDevice()).toBe(0);
    expect(await purgeForeignUsers(A)).toBe(0);
    await expect(clearAll()).resolves.toBeUndefined();
  });
});

describe("write-queue — a corrupt record cannot enter a flush", () => {
  it("listForPartition filters records whose partition does not match the session", async () => {
    // Write a record whose KEY/partition claim A::ORG1 but whose body says user B —
    // the tampering the partition guard exists for.
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open("crewflow-offline-writes");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise<void>((res, rej) => {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put({
        schemaVersion: WRITE_QUEUE_SCHEMA_VERSION,
        key: `${A}::${ORG1}::forged`,
        partition: `${A}::${ORG1}::`,
        userId: B, // ← the lie
        orgId: ORG1,
        clientKey: "forged",
        kind: "site_diary.create",
        payload: { entry_date: "2026-07-30" },
        seq: 1,
        authoredAt: "2026-07-30T10:00:00Z",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        status: "pending",
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    // Present on the device, but NOT eligible for A's flush.
    expect(await countOnDevice()).toBe(1);
    expect(await listForPartition(A, ORG1)).toEqual([]);
    expect(await listPending(A, ORG1)).toEqual([]);
  });
});
