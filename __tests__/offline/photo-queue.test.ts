import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  photoPartitionPrefix,
  photoQueueKey,
  queuedPhotoMatchesPartition,
  isPhotoTargetTable,
  isValidQueuedPhoto,
  nextPhotoSeq,
  hasPhotoRoom,
  enqueuePhoto,
  listPhotosForPartition,
  listPendingPhotos,
  countPhotosOnDevice,
  markPhotoAttemptFailed,
  markPhotoRejected,
  removeQueuedPhoto,
  purgeForeignPhotos,
  clearAllPhotos,
  PHOTO_QUEUE_SCHEMA_VERSION,
  MAX_PHOTO_BYTES,
  _resetForTest,
} from "@/lib/offline/photo-queue";

/**
 * Offline PHOTO / FILE capture queue — behaviour against a real IndexedDB
 * (fake-indexeddb). Proves: binary is actually queued, the idempotency key is
 * persisted and never regenerated, partitions are isolated and purged, order is
 * deterministic, and the store is BOUNDED-AND-LOUD (typed refusals, no eviction).
 */

const A = "user-a";
const B = "user-b";
const O1 = "org-1";
const KEY = "55555555-5555-4555-8555-555555555555";
const TARGET = "11111111-1111-4111-8111-111111111111";

const png = (label = "x") => new TextEncoder().encode(`png-bytes-${label}`).buffer;

const enq = (over: Partial<Parameters<typeof enqueuePhoto>[0]> = {}) =>
  enqueuePhoto({
    userId: A,
    orgId: O1,
    targetTable: "snags",
    targetId: TARGET,
    filename: "snag.png",
    mimeType: "image/png",
    bytes: png(),
    ...over,
  });

beforeEach(async () => {
  await clearAllPhotos();
  _resetForTest();
});
afterEach(async () => {
  await clearAllPhotos();
  _resetForTest();
});

describe("photo queue — pure helpers", () => {
  it("keys and scopes by userId::orgId::clientKey", () => {
    expect(photoPartitionPrefix(A, O1)).toBe("user-a::org-1::");
    expect(photoQueueKey(A, O1, KEY)).toBe(`user-a::org-1::${KEY}`);
    expect(queuedPhotoMatchesPartition({ userId: A, orgId: O1 }, A, O1)).toBe(true);
    expect(queuedPhotoMatchesPartition({ userId: A, orgId: O1 }, B, O1)).toBe(false);
  });

  it("gates the target table and seq allocation", () => {
    expect(isPhotoTargetTable("snags")).toBe(true);
    expect(isPhotoTargetTable("invoices")).toBe(false); // not a field-capture target
    expect(nextPhotoSeq([{ seq: 1 }, { seq: 4 }])).toBe(5);
  });

  it("room check leaves the shared bucket headroom", () => {
    expect(hasPhotoRoom({ usage: 0, quota: 10 * 1024 * 1024 }, 1)).toBe(false);
    expect(hasPhotoRoom({ usage: 0, quota: 64 * 1024 * 1024 }, 1024)).toBe(true);
    expect(hasPhotoRoom({}, 1024)).toBe(true);
  });
});

describe("photo queue — queues binary and persists the idempotency key", () => {
  it("stores the bytes as a Blob and keeps the clientKey stable across a reload", async () => {
    const res = await enq({ clientKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.item.clientKey).toBe(KEY);
    expect(isValidQueuedPhoto(res.item)).toBe(true);

    const [reloaded] = await listPhotosForPartition(A, O1);
    expect(reloaded?.clientKey).toBe(KEY); // NEVER regenerated
    expect(reloaded?.schemaVersion).toBe(PHOTO_QUEUE_SCHEMA_VERSION);
    expect(reloaded?.blob).toBeInstanceOf(Blob);
    expect(reloaded?.sizeBytes).toBeGreaterThan(0);
    expect(reloaded?.status).toBe("pending");
  });

  it("allocates deterministic seq order", async () => {
    await enq({ clientKey: "11111111-1111-4111-8111-111111111111" });
    await enq({ clientKey: "22222222-2222-4222-8222-222222222222" });
    const items = await listPhotosForPartition(A, O1);
    expect(items.map((i) => i.seq)).toEqual([1, 2]);
  });
});

describe("photo queue — bounded and loud (typed refusals, never a silent drop)", () => {
  it("refuses a non-image MIME, an empty file, and an oversized file", async () => {
    expect(await enq({ mimeType: "application/zip" })).toEqual({
      ok: false,
      error: "bad_file_type",
    });
    expect(await enq({ bytes: new ArrayBuffer(0) })).toEqual({
      ok: false,
      error: "empty_file",
    });
    expect(await enq({ bytes: new ArrayBuffer(MAX_PHOTO_BYTES + 1) })).toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("refuses an unknown target table and a non-uuid target id", async () => {
    // @ts-expect-error deliberately invalid target
    expect(await enq({ targetTable: "invoices" })).toEqual({
      ok: false,
      error: "unknown_target",
    });
    expect(await enq({ targetId: "not-a-uuid" })).toEqual({
      ok: false,
      error: "bad_target_id",
    });
  });
});

describe("photo queue — status transitions never destroy content", () => {
  it("a transient failure stays pending; a rejection is retained; only remove deletes", async () => {
    const r = await enq({ clientKey: KEY });
    expect(r.ok).toBe(true);
    const key = r.ok ? r.item.key : "";

    await markPhotoAttemptFailed(key, "unreachable");
    expect((await listPhotosForPartition(A, O1))[0]?.status).toBe("pending");

    await markPhotoRejected(key, "bad_file_type");
    expect((await listPhotosForPartition(A, O1))[0]?.status).toBe("rejected");
    // a rejected capture is NOT sent again, but is still on the device
    expect((await listPendingPhotos(A, O1)).length).toBe(0);
    expect(await countPhotosOnDevice()).toBe(1);

    await removeQueuedPhoto(key); // the only delete path
    expect(await countPhotosOnDevice()).toBe(0);
  });
});

describe("photo queue — shared-device safety", () => {
  it("user B never sees or flushes user A's captures; purge removes foreign", async () => {
    await enqueuePhoto({
      userId: A,
      orgId: O1,
      targetTable: "snags",
      targetId: TARGET,
      filename: "a.png",
      mimeType: "image/png",
      bytes: png("a"),
      clientKey: "aaaaaaaa-1111-4111-8111-111111111111",
    });
    expect(await listPhotosForPartition(B, O1)).toEqual([]);

    const removed = await purgeForeignPhotos(B); // B signs in on the shared tablet
    expect(removed).toBe(1);
    expect(await countPhotosOnDevice()).toBe(0);
  });
});
