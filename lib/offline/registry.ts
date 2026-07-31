import { z } from "zod";
import { createDiaryEntrySchema } from "@/lib/site-diary/schema";

/**
 * OFFLINE WRITE REGISTRY — the one place that decides what CrewFlow will accept
 * as an offline write.
 *
 * The queue (lib/offline/write-queue.ts) is deliberately generic: it can carry
 * any payload. That makes the question "which entities may be authored with no
 * signal?" a PRODUCT decision with real consequences (money, sequencing, other
 * people's concurrent edits) — not an engineering one. So the answer is not
 * scattered through the app; it is this table, and nothing outside it is writable
 * offline. The server re-checks this registry before dispatching any queued item
 * (server/services/offline-writes.ts), so a hand-crafted payload naming an
 * unregistered kind is refused at the trust boundary, not merely absent from the UI.
 *
 * Enabling a second entity takes THREE deliberate acts, by design:
 *   1. a migration adding `client_write_key` + a partial unique index to that table
 *      (the database-level idempotency gate — see 20261077000000);
 *   2. a row here;
 *   3. a server handler in server/services/offline-writes.ts.
 * A no-drift test asserts (2) and (3) stay in lockstep, and (1) cannot be faked in
 * code at all. Nothing becomes offline-writable by accident.
 *
 * ── ENABLED ───────────────────────────────────────────────────────────────────
 * `site_diary.create` only. A diary entry is the one write in the product that can
 * be replayed hours later with no merge policy and no lie:
 *   - APPEND-ONLY. It creates a new row; it never mutates a row someone else may
 *     have changed while the tablet was in a basement.
 *   - SINGLE-AUTHOR. One person records their own day. There is no realistic
 *     concurrent editor, so "last write wins" versus "merge" never arises.
 *   - NO FINANCIAL CONSEQUENCE. Nothing prices, invoices, allocates stock, pays
 *     anyone, or moves a lifecycle state. A late arrival changes no number.
 *   - NO SEQUENCING. It does not depend on, or invalidate, any other queued write.
 * So the queue can be proven end-to-end without this milestone having to settle a
 * conflict-resolution policy it cannot honestly settle.
 *
 * ── DELIBERATELY NOT ENABLED (and why) ────────────────────────────────────────
 * Everything else in the product stays READ-ONLY offline. The reasons are not
 * uniform, and that is the point — each needs its own product decision:
 *
 *   site_diary.update / delete  A diary entry may have been edited or deleted by an
 *                               admin while the device was offline. Replaying an
 *                               update silently reverts their change; there is no
 *                               conflict UI in this milestone to ask with.
 *   snags                       Append-only and tempting, BUT a snag carries a
 *                               lifecycle (open → closed) and assignment, and it is
 *                               usually raised WITH photos. Photos are binary
 *                               uploads to Storage, which this queue does not carry
 *                               (see write-queue.ts). A snag with no photo is a
 *                               worse record than no snag.
 *   timesheets / time entries   PAYROLL. A replayed or duplicated time entry becomes
 *                               money paid. Deserves its own approval design.
 *   expenses / receipts         Money out, plus a receipt image (binary).
 *   quotes / invoices / POs     Numbered, sequenced commercial documents. Offline
 *                               numbering forks the sequence; the number IS identity.
 *   stock movements             The stock ledger is order-dependent (20261069/71) and
 *                               already refuses a manufactured balance. Replaying a
 *                               movement out of order is a correctness fault, not a
 *                               UX one.
 *   H&S sign-offs / permits     A signature has legal force at the moment it is
 *                               given. "Signed at 14:00, recorded at 19:00, under a
 *                               RAMS that changed at 16:00" is not a signature.
 *   toolbox talks               Same: attendance is evidence with a provenance chain
 *                               (20261031-37) that a replay would weaken.
 *
 * Nothing here is a technical blocker. Each is a decision about what a builder is
 * allowed to promise a client, an insurer, or HMRC about a record created with no
 * signal — see docs/offline-write-queue.md for what the CEO must decide.
 */

/** Every kind the queue understands. Adding one here is step 2 of 3 (see header). */
export const OFFLINE_WRITE_KINDS = ["site_diary.create"] as const;
export type OfflineWriteKind = (typeof OFFLINE_WRITE_KINDS)[number];

export type OfflineWriteEntity = {
  /** Human label for the outbox UI ("2 diary entries waiting to sync"). */
  readonly label: string;
  readonly labelPlural: string;
  /** Where the user goes to see the accepted result. */
  readonly viewHref: string;
  /**
   * The SAME schema the online server action validates with. A queued write must
   * not be able to smuggle in a shape the online path would have rejected, so the
   * queue validates with this before storing AND the server validates with it
   * again before writing. One schema, two enforcement points.
   */
  readonly schema: z.ZodTypeAny;
  /**
   * Which fields to show a user when an item is permanently REJECTED, so they can
   * recover the words they wrote. Ordered for reading, not for storage.
   */
  readonly recoverFields: readonly string[];
};

export const OFFLINE_WRITE_REGISTRY: Readonly<
  Record<OfflineWriteKind, OfflineWriteEntity>
> = {
  "site_diary.create": {
    label: "diary entry",
    labelPlural: "diary entries",
    viewHref: "/diary",
    schema: createDiaryEntrySchema,
    recoverFields: [
      "entry_date",
      "weather",
      "labour_count",
      "work_summary",
      "delays",
      "notes",
    ],
  },
};

/**
 * THE GATE. Called on the client before enqueuing and again on the SERVER before
 * dispatching — a crafted payload naming an unregistered kind dies at the trust
 * boundary. Narrows an arbitrary string, so callers cannot skip it by casting.
 */
export function isOfflineWriteKind(kind: unknown): kind is OfflineWriteKind {
  return (
    typeof kind === "string" &&
    (OFFLINE_WRITE_KINDS as readonly string[]).includes(kind)
  );
}

/** Registry lookup that cannot return undefined for a validated kind. */
export function offlineWriteEntity(kind: OfflineWriteKind): OfflineWriteEntity {
  return OFFLINE_WRITE_REGISTRY[kind];
}

/** "2 diary entries" / "1 diary entry" — the outbox never says "2 diary entry". */
export function describeOfflineCount(kind: OfflineWriteKind, n: number): string {
  const e = offlineWriteEntity(kind);
  return `${n} ${n === 1 ? e.label : e.labelPlural}`;
}
