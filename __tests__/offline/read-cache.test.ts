import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readPartitionPrefix,
  snapshotKey,
  snapshotMatchesPartition,
  isValidSnapshot,
  estimateSnapshotBytes,
  hasReadCacheRoom,
  putSnapshot,
  getSnapshot,
  listSnapshots,
  clearReadsForUser,
  purgeForeignReads,
  clearAllReads,
  READ_CACHE_SCHEMA_VERSION,
  MAX_SNAPSHOT_BYTES,
  _resetForTest,
} from "@/lib/offline/read-cache";

/**
 * Offline READ cache — behaviour against a real IndexedDB (fake-indexeddb),
 * mirroring the write-queue / blueprint-store tests. Proves the three properties
 * the header claims: ORG-PINNED + PARTITIONED (+ purge), PAGED + BOUNDED (loud, no
 * eviction), and that a cached snapshot is SERVED back for offline viewing.
 */

const A = "user-a";
const B = "user-b";
const O1 = "org-1";
const O2 = "org-2";

const jobRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `job-${i}`,
    status: "in-progress",
    updated_at: `2026-08-0${(i % 9) + 1}`,
  }));

beforeEach(async () => {
  await clearAllReads();
  _resetForTest();
});
afterEach(async () => {
  await clearAllReads();
  _resetForTest();
});

describe("offline read cache — pure helpers", () => {
  it("keys and scopes by userId::orgId::kind", () => {
    expect(readPartitionPrefix(A, O1)).toBe("user-a::org-1::");
    expect(snapshotKey(A, O1, "jobs")).toBe("user-a::org-1::jobs");
    expect(snapshotMatchesPartition({ userId: A, orgId: O1 }, A, O1)).toBe(true);
    expect(snapshotMatchesPartition({ userId: A, orgId: O1 }, B, O1)).toBe(false);
    expect(snapshotMatchesPartition({ userId: A, orgId: O1 }, A, O2)).toBe(false);
  });

  it("validates a snapshot's shape", () => {
    expect(
      isValidSnapshot({
        schemaVersion: READ_CACHE_SCHEMA_VERSION,
        key: "k",
        partition: "p",
        userId: A,
        orgId: O1,
        kind: "jobs",
        rows: [],
        rowCount: 0,
        cachedAt: "now",
      }),
    ).toBe(true);
    expect(isValidSnapshot({ kind: "not_a_kind", rows: [] })).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
  });

  it("room check leaves the write-queue headroom (never fills the last byte)", () => {
    // With 10MB free and the 16MB margin, even a tiny snapshot is refused room —
    // the read cache must never win quota from an unsent write.
    expect(hasReadCacheRoom({ usage: 0, quota: 10 * 1024 * 1024 }, 1)).toBe(false);
    expect(hasReadCacheRoom({ usage: 0, quota: 64 * 1024 * 1024 }, 1024)).toBe(true);
    // withheld quota → don't pre-block
    expect(hasReadCacheRoom({}, 1024)).toBe(true);
  });
});

describe("offline read cache — stores and SERVES a snapshot for offline viewing", () => {
  it("round-trips the rows for a partition + kind", async () => {
    const put = await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(3) });
    expect(put.ok).toBe(true);

    // The serve path is a plain IDB read — it works with no network at all.
    const got = await getSnapshot(A, O1, "jobs");
    expect(got?.rowCount).toBe(3);
    expect(got?.rows[0]).toMatchObject({ id: "job-0" });
    expect(got?.truncated).toBe(false);
  });

  it("marks the snapshot truncated when the server had more than the page", async () => {
    const put = await putSnapshot({
      userId: A,
      orgId: O1,
      kind: "jobs",
      rows: jobRows(3),
      serverTotal: Number.MAX_SAFE_INTEGER, // server saw more than we cached
    });
    expect(put.ok).toBe(true);
    const got = await getSnapshot(A, O1, "jobs");
    expect(got?.truncated).toBe(true);
  });

  it("replaces (does not append) the snapshot of the same kind", async () => {
    await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(3) });
    await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(5) });
    const got = await getSnapshot(A, O1, "jobs");
    expect(got?.rowCount).toBe(5); // the latest page, not 8
  });

  it("lists every cached kind for a partition", async () => {
    await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(2) });
    await putSnapshot({ userId: A, orgId: O1, kind: "customers", rows: [{ id: "c1", name: "Acme" }] });
    const all = await listSnapshots(A, O1);
    expect(all.map((s) => s.kind).sort()).toEqual(["customers", "jobs"]);
  });
});

describe("offline read cache — org-pinned + partitioned (shared-device safety)", () => {
  it("a snapshot cached for org-1 is never served for org-2", async () => {
    await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(2) });
    expect(await getSnapshot(A, O2, "jobs")).toBeNull();
    expect(await listSnapshots(A, O2)).toEqual([]);
  });

  it("a snapshot cached for user A is never served to user B", async () => {
    await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(2) });
    expect(await getSnapshot(B, O1, "jobs")).toBeNull();
  });

  it("purgeForeignReads deletes every other user's cache, keeps mine", async () => {
    await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(2) });
    await putSnapshot({ userId: B, orgId: O1, kind: "jobs", rows: jobRows(2) });
    const removed = await purgeForeignReads(A);
    expect(removed).toBe(1);
    expect(await getSnapshot(A, O1, "jobs")).not.toBeNull();
    expect(await getSnapshot(B, O1, "jobs")).toBeNull();
  });

  it("clearReadsForUser(org) clears only that org; logout clears all", async () => {
    await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: jobRows(2) });
    await putSnapshot({ userId: A, orgId: O2, kind: "jobs", rows: jobRows(2) });
    await clearReadsForUser(A, O1);
    expect(await getSnapshot(A, O1, "jobs")).toBeNull();
    expect(await getSnapshot(A, O2, "jobs")).not.toBeNull();
    await clearAllReads();
    expect(await getSnapshot(A, O2, "jobs")).toBeNull();
  });
});

describe("offline read cache — bounded and loud (never silently over-fills)", () => {
  it("refuses a single snapshot over the item cap", async () => {
    const big = [{ id: "x", blob: "y".repeat(MAX_SNAPSHOT_BYTES + 10) }];
    const put = await putSnapshot({ userId: A, orgId: O1, kind: "jobs", rows: big });
    expect(put).toEqual({ ok: false, error: "too_large" });
  });

  it("unknown kind is refused (the read registry is the gate)", async () => {
    const put = await putSnapshot({
      userId: A,
      orgId: O1,
      // @ts-expect-error — deliberately not a read kind
      kind: "invoices_secret",
      rows: [],
    });
    expect(put).toEqual({ ok: false, error: "unknown_kind" });
  });

  it("estimateSnapshotBytes is byte length, not char length", () => {
    const asciiN = estimateSnapshotBytes({ rows: [{ a: "aa" }], kind: "jobs" });
    const emojiN = estimateSnapshotBytes({ rows: [{ a: "😀😀" }], kind: "jobs" });
    expect(emojiN).toBeGreaterThan(asciiN);
  });
});
