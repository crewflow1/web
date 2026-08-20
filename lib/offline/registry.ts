import { z } from "zod";
import {
  createDiaryEntrySchema,
  updateDiaryEntrySchema,
} from "@/lib/site-diary/schema";
import { createSnagSchema, updateSnagSchema } from "@/lib/snags/schema";
import { materialRequestFormSchema } from "@/lib/material-requests/schema";
import { createDelayEventSchema, updateDelayEventSchema } from "@/lib/eot/schema";
import { createSiteReportSchema } from "@/lib/site-reports/schema";

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
 *   delay_event.create       An EOT delay event (20261084), as a DRAFT ONLY. Its
 *                            entire value is CONTEMPORANEOUS capture — under
 *                            JCT/NEC an extension of time stands or falls on what
 *                            was recorded AT THE TIME work stopped — which is
 *                            precisely the no-signal moment the queue exists for.
 *                            It is born 'draft' (the core pins status; the payload
 *                            cannot carry one) and the 'recorded'/'withdrawn'
 *                            transitions are NOT captured offline: their
 *                            provenance (recorded_at/by) is server-pinned by the
 *                            transition trigger and a draft-CHECK makes pre-forged
 *                            provenance unrepresentable — replaying a "recorded"
 *                            hours later would forge the timestamp that trigger
 *                            protects. No money: working_days_lost is the
 *                            recorder's CLAIM, never computed, and no finances row
 *                            is touched. After sync a human opens Delays and taps
 *                            Record — stated in the form wording.
 *
 *   site_report.create       The site report (20260922), as a DRAFT ONLY. The
 *                            report NUMBER is a per-org COSMETIC label allocated
 *                            at SYNC time by the same helper the online action
 *                            uses (never minted offline), and the lifecycle
 *                            (ready_for_review → approved → issued, with
 *                            server-pinned issued_at and the customer-visible
 *                            snapshot freeze) stays online-only. The draft is the
 *                            honest offline artefact; a human completes and issues
 *                            it online.
 *
 * ── ENABLED — UPDATEs, made safe by CONFLICT RESOLUTION ───────────────────────
 * The earlier milestones deferred every offline UPDATE with one recurring reason:
 * "replaying an update silently reverts an admin's concurrent change, and there is
 * no conflict UI to ask with." There now IS one (lib/offline/merge.ts + the outbox
 * conflict state), so the two updates that reason blocked are enabled — and ONLY
 * those two, because a merge policy is only honest where the fields are owned,
 * free-text/scalar, and carry no server-pinned provenance or lifecycle:
 *
 *   site_diary.update        Amend a diary entry authored earlier. Each field is
 *                            reconciled by a deterministic 3-way merge against the
 *                            current server row (base = what the form was opened
 *                            with, mine = the edit, theirs = the server now): a
 *                            field only the foreman changed wins (last-writer-wins
 *                            on owned fields); a field only the admin changed is
 *                            kept; a field BOTH changed differently is surfaced as
 *                            a conflict for the author to resolve, never silently
 *                            overwritten. Idempotent via last_offline_write_key
 *                            (migration 20261129000000) so a re-delivered update is
 *                            recognised, not re-applied over its own version bump.
 *
 *   snag.update              The same, for a snag's owned free-text/scalar detail
 *                            (title, description, location, trade, priority,
 *                            job/assignee, due date). The STATUS lifecycle is NOT
 *                            part of it — the update schema carries no status field,
 *                            so 'fixed'/'verified' can never ride a queued edit
 *                            (that lifecycle stays online, with its server-pinned
 *                            resolved_at, for the toolbox-ack reason below).
 *
 *   delay_event.update       A DRAFT delay event's owned scalar detail (category,
 *                            dates, the working-days-lost CLAIM, description,
 *                            evidence links), amended on site with no signal and
 *                            reconciled by the same 3-way merge. Enabled ONLY while
 *                            the row is a draft — a 'recorded'/'withdrawn' event is
 *                            contemporaneous evidence whose provenance the
 *                            transition trigger pins, so it is frozen. Draft-only is
 *                            enforced in three places (the server core's status
 *                            re-read, the updated_at compare-and-swap, and the
 *                            existing tg_delay_event_transition trigger). The job is
 *                            NOT in the merge set — a draft is never re-homed to
 *                            another job offline. See 20261197000000. Idempotent via
 *                            last_offline_write_key, like the diary/snag updates.
 *                            Because the delay schema is camelCase and the table is
 *                            snake_case, the entity declares a `columnMap`; the merge
 *                            engine is unchanged and still runs in payload-key space.
 *
 * Both run through the SAME shared write core the online edit uses, on the tenant
 * client, under the same RLS UPDATE policy — a queued update is not a special write.
 * DELETE stays unenabled offline for every entity: a replayed delete cannot be
 * merged (there is nothing to reconcile against a row someone may have deliberately
 * kept), and a destructive replay is the one outcome the queue must never risk.
 *
 * ── DELIBERATELY NOT ENABLED (and why) ────────────────────────────────────────
 * Everything else in the product stays READ-ONLY offline. The reasons are not
 * uniform, and that is the point — each needs its own product decision:
 *
 *   any .delete                 A destructive replay cannot be reconciled by a merge
 *                               and is never risked offline (see above).
 *   snag status lifecycle       'fixed'/'verified' etc. stamp resolved_at server-
 *                               side and carry lifecycle meaning; kept online with
 *                               the material_request.submit / attestation reasoning.
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
 *   ITP inspection sign-offs    Considered for the "offl" train and REJECTED on the
 *                               toolbox-ack ground exactly: inspection_signoffs
 *                               (20261076) server-pins recorded_at ("the single most
 *                               load-bearing fact on the row"), version-anchors to
 *                               the plan's ISSUED reference, carries a typed-name
 *                               signature with contractual force, and computes a
 *                               HOLD-POINT breach stamp at insert against the plan's
 *                               live state. An offline capture replayed later would
 *                               misdate the attestation and could mis-stamp the gate.
 *   job progress observations   Its ONLINE write path is an UPSERT on the natural key
 *                               (job_id, observed_on) — a create-OR-CORRECT. Replaying
 *                               it hours later would silently revert a correction made
 *                               while offline (the site_diary/snag UPDATE reason), and
 *                               an insert-only offline fork would break the "a queued
 *                               write is not a special write" property.
 *   fuel / expense logs         Carry a monetary cost and (for expenses) a receipt
 *                               image — money out plus binary, the expenses exclusion.
 *
 * Nothing here is a technical blocker. Each is a decision about what a builder is
 * allowed to promise a client, an insurer, or HMRC about a record created with no
 * signal — see docs/offline-write-queue.md.
 */

/** Every kind the queue understands. Adding one here is step 2 of 3 (see header). */
export const OFFLINE_WRITE_KINDS = [
  "site_diary.create",
  "site_diary.update",
  "snag.create",
  "snag.update",
  "material_request.create",
  "delay_event.create",
  "delay_event.update",
  "site_report.create",
] as const;
export type OfflineWriteKind = (typeof OFFLINE_WRITE_KINDS)[number];

/** create = append a new row; update = reconcile owned fields of an existing row. */
export type OfflineWriteMode = "create" | "update";

export type OfflineWriteEntity = {
  /** Append a new row, or reconcile an existing one via the 3-way merge? */
  readonly mode: OfflineWriteMode;
  /**
   * UPDATE kinds only: the owned columns an offline edit may touch, and the exact
   * set the 3-way merge (lib/offline/merge.ts) reconciles field by field. Passing
   * this explicitly is a security boundary — the merge never iterates arbitrary
   * payload keys, so an edit can only ever change a column named here.
   */
  readonly mergeFields?: readonly string[];
  /**
   * UPDATE kinds only, OPTIONAL: maps a mergeField (the payload key the shared Zod
   * schema uses) to the database COLUMN it is stored in, for entities whose schema
   * is camelCase while their table is snake_case (e.g. delay events: `startedOn` →
   * `started_on`). When absent, or for a field not listed, the merge field name IS
   * the column name (the diary and snag schemas are already snake_case-aligned, so
   * they declare no map and behave exactly as before). The 3-way merge itself
   * (lib/offline/merge.ts) always runs in payload-key space and is UNCHANGED; this
   * only tells the server core which column to read `theirs` from and write back to.
   */
  readonly columnMap?: Readonly<Record<string, string>>;
  /**
   * UPDATE kinds only, OPTIONAL: a column that must hold one of `editableWhen` for
   * the row to be offline-editable at all (e.g. delay events are only editable
   * while `status = 'draft'`). The server core reads it and refuses a row that is
   * no longer editable, matching the online edit action's own status guard.
   */
  readonly statusColumn?: string;
  readonly editableWhen?: readonly string[];
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
    mode: "create",
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
  "site_diary.update": {
    mode: "update",
    label: "diary edit",
    labelPlural: "diary edits",
    viewHref: "/diary",
    schema: updateDiaryEntrySchema,
    // The owned columns a diary edit may touch — and the exact fields the merge
    // reconciles. `id` is the target, not a mergeable field, so it is not listed.
    mergeFields: [
      "entry_date",
      "job_id",
      "weather",
      "labour_count",
      "work_summary",
      "delays",
      "notes",
    ],
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
    mode: "create",
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
  "snag.update": {
    mode: "update",
    label: "snag edit",
    labelPlural: "snag edits",
    viewHref: "/snags",
    schema: updateSnagSchema,
    mergeFields: [
      "title",
      "description",
      "location",
      "trade",
      "priority",
      "job_id",
      "assigned_to",
      "due_date",
    ],
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
    mode: "create",
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
  "delay_event.create": {
    mode: "create",
    label: "delay event",
    labelPlural: "delay events",
    viewHref: "/delays",
    schema: createDelayEventSchema,
    // The recorder's own words + the facts of the stoppage — what they must be
    // able to read back and re-type if the server ever refuses the item.
    recoverFields: [
      "description",
      "category",
      "startedOn",
      "endedOn",
      "workingDaysLost",
    ],
  },
  "delay_event.update": {
    mode: "update",
    label: "delay edit",
    labelPlural: "delay edits",
    viewHref: "/delays",
    schema: updateDelayEventSchema,
    // The owned scalar detail of a DRAFT delay event. Payload keys (camelCase, the
    // shared Zod schema's) — mapped to their snake_case columns below. `jobId` is
    // DELIBERATELY EXCLUDED: re-homing a draft to another job with no signal is not
    // an owned-field edit, so an offline update never moves the job (do it online).
    // `id` is the target, not a mergeable field. No `status` — the update schema
    // carries none, so a lifecycle transition can never ride a queued edit.
    mergeFields: [
      "category",
      "startedOn",
      "endedOn",
      "workingDaysLost",
      "description",
      "diaryEntryId",
      "variationQuoteId",
      "weatherDistrict",
    ],
    columnMap: {
      startedOn: "started_on",
      endedOn: "ended_on",
      workingDaysLost: "working_days_lost",
      diaryEntryId: "diary_entry_id",
      variationQuoteId: "variation_quote_id",
      weatherDistrict: "weather_district",
    },
    // Only a draft is offline-editable — a recorded/withdrawn event is frozen
    // evidence (the transition trigger enforces this server-side too).
    statusColumn: "status",
    editableWhen: ["draft"],
    recoverFields: [
      "description",
      "category",
      "startedOn",
      "endedOn",
      "workingDaysLost",
    ],
  },
  "site_report.create": {
    mode: "create",
    label: "site report",
    labelPlural: "site reports",
    viewHref: "/site-reports",
    schema: createSiteReportSchema,
    recoverFields: ["title", "period_start", "period_end"],
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

/** True for a kind that reconciles an existing row (needs a version anchor + merge). */
export function isOfflineUpdateKind(kind: OfflineWriteKind): boolean {
  return offlineWriteEntity(kind).mode === "update";
}

/**
 * The owned columns an UPDATE kind may touch — the exact merge field set. Throws
 * for a create kind (a create has no merge), so a caller cannot silently merge one.
 */
export function offlineMergeFields(kind: OfflineWriteKind): readonly string[] {
  const e = offlineWriteEntity(kind);
  if (e.mode !== "update" || !e.mergeFields) {
    throw new Error(`offlineMergeFields called for non-update kind ${kind}`);
  }
  return e.mergeFields;
}

/** "2 diary entries" / "1 diary entry" — the outbox never says "2 diary entry". */
export function describeOfflineCount(kind: OfflineWriteKind, n: number): string {
  const e = offlineWriteEntity(kind);
  return `${n} ${n === 1 ? e.label : e.labelPlural}`;
}
