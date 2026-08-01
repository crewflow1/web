import { z } from "zod";
import { createDiaryEntrySchema } from "@/lib/site-diary/schema";
import { createSnagSchema } from "@/lib/snags/schema";
import { materialRequestFormSchema } from "@/lib/material-requests/schema";

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
 * Enabling an entity takes THREE deliberate acts, by design:
 *   1. a migration adding the database-level idempotency gate to that table
 *      (20261077000000 for the diary, 20261083000000 for snags + material
 *      requests);
 *   2. a row here;
 *   3. a server handler reachable from dispatchOfflineWrite
 *      (server/services/offline-writes.ts).
 * A no-drift test asserts (2) and (3) stay in lockstep, and (1) cannot be faked in
 * code at all. Nothing becomes offline-writable by accident.
 *
 * ── ENABLED ───────────────────────────────────────────────────────────────────
 * Three CREATEs, all sharing the properties that make a replay honest:
 * APPEND-ONLY (a new row, never a mutation of one somebody else may have edited),
 * SINGLE-AUTHOR (no realistic concurrent editor, so no merge policy to invent),
 * NO FINANCIAL CONSEQUENCE and NO SEQUENCING.
 *
 *   site_diary.create        The original vertical — see 20261077000000.
 *
 *   snag.create              A defect spotted where there is no signal is the
 *                            diary's exact shape. It is born 'open' (the core
 *                            pins the status; the payload cannot carry one), so
 *                            no lifecycle state is replayed — the lifecycle
 *                            STARTS when the row lands. Photos are excluded
 *                            offline exactly as the diary excludes them (the
 *                            queue carries JSON, never binary) and the form says
 *                            so honestly. The earlier "a snag with no photo is a
 *                            worse record than no snag" stance was reversed by
 *                            Train 5: a titled, located, traded defect record
 *                            with photos to follow beats a defect that lives in
 *                            someone's head until the van finds signal.
 *
 *   material_request.create  The site→office ask, as a DRAFT ONLY. The number
 *                            (MR-0007) is allocated at SYNC time by the existing
 *                            per-org allocator — never minted offline, so the
 *                            sequence cannot fork. Submission is deliberately
 *                            NOT captured offline: submitted_at is provenance
 *                            the database pins server-side (20261066) and
 *                            submitting fans out notifications; replaying it
 *                            hours later would forge the one timestamp the
 *                            trigger protects. After sync the worker opens
 *                            Materials and taps Send — stated in the form
 *                            wording, not hidden.
 *
 * ── DELIBERATELY NOT ENABLED (and why) ────────────────────────────────────────
 * Everything else in the product stays READ-ONLY offline. The reasons are not
 * uniform, and that is the point — each needs its own product decision:
 *
 *   site_diary/snag update/delete  A row may have been edited or deleted by an
 *                               admin while the device was offline. Replaying an
 *                               update silently reverts their change; there is no
 *                               conflict UI in this milestone to ask with.
 *   material_request.submit     Lifecycle transition with server-pinned
 *                               provenance + notification fan-out (see above).
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
 *   toolbox talks (acks)        Considered for this train and REJECTED on the same
 *                               ground, with the evidence read first: the ack engine
 *                               (tg_safety_ack_validate, 20261020/26) server-pins
 *                               acknowledged_at := now() — "the single most
 *                               load-bearing fact" — binds the signer to auth.uid(),
 *                               and requires the version anchor to match a talk that
 *                               is ISSUED at write time. An ack captured offline and
 *                               replayed later would carry a signing time that is not
 *                               the attestation moment, possibly against a revision
 *                               superseded in between. The engine's natural key would
 *                               make the replay idempotent, but idempotent capture of
 *                               dishonest evidence is still dishonest evidence.
 *
 * Nothing here is a technical blocker. Each is a decision about what a builder is
 * allowed to promise a client, an insurer, or HMRC about a record created with no
 * signal — see docs/offline-write-queue.md.
 */

/** Every kind the queue understands. Adding one here is step 2 of 3 (see header). */
export const OFFLINE_WRITE_KINDS = [
  "site_diary.create",
  "snag.create",
  "material_request.create",
] as const;
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
  /**
   * Optional per-field renderer for recovery text. Returns null to fall back to
   * the default `field: value` line. Exists because a material request's `lines`
   * is an array — String() would show "[object Object]" where the one copy of
   * what the site asked for should be.
   */
  readonly formatRecoverField?: (field: string, value: unknown) => string | null;
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
  "snag.create": {
    label: "snag",
    labelPlural: "snags",
    viewHref: "/snags",
    schema: createSnagSchema,
    recoverFields: [
      "title",
      "description",
      "location",
      "trade",
      "priority",
      "due_date",
    ],
  },
  "material_request.create": {
    label: "materials request",
    labelPlural: "materials requests",
    viewHref: "/materials/requests",
    schema: materialRequestFormSchema,
    recoverFields: ["lines", "needed_by", "priority", "notes"],
    formatRecoverField: (field, value) => {
      if (field !== "lines" || !Array.isArray(value)) return null;
      // "3 bag — Cement 25kg" per line: what was asked for, readable enough to
      // re-type. This text may be the only copy in existence.
      return value
        .map((l) => {
          const line = l as { description?: unknown; qty?: unknown; unit?: unknown };
          return `${String(line.qty ?? "")} ${String(line.unit ?? "")} — ${String(line.description ?? "")}`;
        })
        .join("\n");
    },
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
