import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { recordAdminActivity } from "@/server/services/hq-audit";
import type { OrgContext } from "@/server/auth/session";
import {
  isOfflineWriteKind,
  offlineWriteEntity,
  offlineMergeFields,
  type OfflineWriteKind,
} from "@/lib/offline/registry";
import { threeWayMerge } from "@/lib/offline/merge";
import {
  createDiaryEntrySchema,
  updateDiaryEntrySchema,
} from "@/lib/site-diary/schema";
import { createSnagSchema, updateSnagSchema } from "@/lib/snags/schema";
import { materialRequestFormSchema } from "@/lib/material-requests/schema";
import { createDelayEventSchema, updateDelayEventSchema } from "@/lib/eot/schema";
import { createSiteReportSchema } from "@/lib/site-reports/schema";
import { createMaterialRequestDraftRecord } from "@/server/services/material-request-writes";
import { createDelayEventDraftRecord } from "@/server/services/delay-event-writes";
import { createSiteReportDraftRecord } from "@/server/services/site-report-writes";

/**
 * OFFLINE WRITE — the server side. ONE write path per entity, shared by the
 * online form and the queued replay.
 *
 * The security argument for this whole feature rests on a single sentence: a
 * queued write is not a special write. It runs under the caller's own session
 * (`requireOrgContext()` in the action), through the TENANT (user-JWT) Supabase
 * client, against the SAME RLS policies and the SAME Zod schema as the online
 * form, and lands via the SAME function. There is no service-role path, no RPC, no
 * SECURITY DEFINER, no "trusted replay" flag — because any of those would be a
 * privileged bypass that a stolen queue item could ride.
 *
 * `createDiaryEntryRecord` is therefore called by BOTH:
 *   - app/(app)/diary/actions.ts → createDiaryEntry (online form post), and
 *   - app/(app)/offline-sync-actions.ts → syncQueuedWrite (queued replay).
 * The only difference between them is where `clientKey` comes from (the browser's
 * queue vs freshly minted here) and whether `offlineAuthoredAt` is set. If a future
 * change hardens one path it hardens both; they cannot drift.
 *
 * Train 5 added `createSnagRecord` on exactly the same two-entry-point contract
 * (app/(app)/snags/actions.ts → createSnag, and the dispatch below), and
 * `createMaterialRequestDraftRecord`, which lives in its OWN module
 * (server/services/material-request-writes.ts) because a material request's
 * write path legitimately includes the pre-existing per-org number allocator —
 * a read-only helper the ONLINE action has always invoked under the caller's
 * JWT — while THIS file stays free of any remote-procedure surface so the
 * security suite can keep pinning that absence verbatim.
 *
 * The one service-role touch in this file is `recordAdminActivity`, the
 * pre-existing audit chokepoint, which writes ONLY to admin_activity_log and never
 * to a tenant table. It is called on the online path today, so calling it here
 * keeps audit parity rather than creating a queued write that leaves no trace.
 *
 * ── Failure classification: default to RETRY, never to discard ────────────────
 * A permanent rejection is the only outcome that stops retrying, so the set of
 * permanent errors is an explicit ALLOWLIST. Anything unrecognised is transient, so
 * an unexpected database or network condition can never quietly destroy a
 * foreman's day — the worst case is an item that keeps waiting and stays visible.
 */

export type OfflineWriteOutcome =
  /** Written. `id` is the new (create) or reconciled (update) row. */
  | { status: "accepted"; id: string }
  /** This exact clientKey was already written. Idempotent no-op; ONE row exists. */
  | { status: "duplicate"; id: string }
  /** PERMANENTLY refused. The client retains the item so the user can recover it. */
  | { status: "rejected"; reason: OfflineRejectReason }
  /** Try again later. The item stays pending. */
  | { status: "retry"; reason: string };

/**
 * An offline UPDATE whose fields DIVERGED from a concurrent server edit. Nothing was
 * written. The client holds the item as a conflict, shows the author what clashed,
 * and lets them resolve it (keep mine / discard). `serverVersion` is the row version
 * they must acknowledge for a "keep mine" to apply.
 *
 * It is kept OUT of OfflineWriteOutcome on purpose: a CREATE can never conflict, so
 * every create caller narrows to accepted/duplicate/rejected/retry without having to
 * handle a case that cannot occur. Only the update path widens to this.
 */
export type OfflineConflictOutcome = {
  status: "conflict";
  serverVersion: string;
  fields: { field: string; mine: unknown; theirs: unknown }[];
};

/** What an UPDATE replay (and the generic dispatch, which may route one) returns. */
export type OfflineUpdateOutcome = OfflineWriteOutcome | OfflineConflictOutcome;

export type OfflineRejectReason =
  | "unknown_kind" // not in the registry
  | "invalid_payload" // failed the entity's own Zod schema
  | "org_mismatch" // authored in a different org — refused, never re-homed
  | "job_missing" // the parent job is gone, or belongs to another org
  | "assignee_missing" // the named assignee is not a member of the active org
  | "stock_item_missing" // a line's catalogue item is not in the active org
  | "target_missing" // an UPDATE's target row is gone, or belongs to another org
  | "not_editable" // an UPDATE's target is no longer in an editable state (e.g. a
  //                   delay event promoted out of 'draft' — frozen evidence now)
  | "not_permitted" // RLS refused the insert/update
  | "malformed_item"; // the queued envelope itself is not a queued write

/** Postgres/PostgREST codes that mean "this will NEVER succeed, stop retrying". */
const PERMANENT_CODES: Record<string, OfflineRejectReason> = {
  "23503": "job_missing", // foreign key violation
  "23514": "invalid_payload", // check constraint violation
  "22P02": "invalid_payload", // invalid input syntax for type
  "42501": "not_permitted", // RLS / insufficient privilege
};
const UNIQUE_VIOLATION = "23505";

/**
 * Shared with the sibling write core (material-request-writes.ts) so the
 * permanent-error ALLOWLIST cannot fork per entity. 23503 reads as
 * "job_missing" for every enabled entity because on each of them the only FK a
 * validated payload can still violate at insert time is a parent deleted (or
 * re-orged) since the guard ran: snags.job_id/assigned_to, diary job_id, and a
 * material request's job — all "the thing you filed this against is gone".
 */
export const OFFLINE_PERMANENT_CODES: Readonly<Record<string, OfflineRejectReason>> =
  PERMANENT_CODES;
export const OFFLINE_UNIQUE_VIOLATION = UNIQUE_VIOLATION;

type PgError = { message: string; code?: string } | null;

// The offline-write columns landed in 20261077000000 and site_diary_entries is
// itself newer than the generated Supabase types, so every statement goes through
// a minimal precise cast — the same idiom app/(app)/diary/actions.ts uses.
type InsertChain = {
  insert: (row: unknown) => Promise<{ error: PgError }>;
};
type FindByKeyChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      eq: (
        k: string,
        v: unknown,
      ) => { maybeSingle: () => Promise<{ data: { id: string } | null; error: PgError }> };
    };
  };
};
type JobLookupChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      eq: (
        k: string,
        v: unknown,
      ) => { maybeSingle: () => Promise<{ data: { id: string } | null; error: PgError }> };
    };
  };
};
type MembershipLookupChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        maybeSingle: () => Promise<{ data: { user_id: string } | null; error: PgError }>;
      };
    };
  };
};
/** Read one row by (id, org_id) returning an arbitrary column projection. */
type RowReadChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        maybeSingle: () => Promise<{
          data: Record<string, unknown> | null;
          error: PgError;
        }>;
      };
    };
  };
};
/**
 * COMPARE-AND-SWAP update: `update(...).eq(id).eq(org_id).eq(updated_at, version)`,
 * plus any entity-specific match (e.g. `.eq(status, 'draft')`). The eq on
 * updated_at is the optimistic-concurrency guard — a row changed since we read it
 * fails to match and returns count 0, so we never overwrite a version we did not
 * merge against. `.eq()` is chainable an arbitrary number of times and the chain is
 * awaitable, so the core can append extra guards without a fixed arity.
 */
type CasEqChain = {
  eq: (k: string, v: unknown) => CasEqChain;
} & PromiseLike<{ error: PgError; count: number | null }>;
type CasUpdateChain = {
  update: (patch: unknown, opts?: { count?: string }) => CasEqChain;
};

export type DiaryWriteInput = {
  entry_date: string;
  job_id?: string;
  weather?: string;
  labour_count?: number;
  work_summary?: string;
  delays?: string;
  notes?: string;
};

/**
 * Create one site diary entry. THE diary write — online and offline alike.
 *
 * `clientKey` is the idempotency key persisted in the DB (unique per org). The
 * online path mints a fresh one; the queued path passes the key the browser stored
 * when the entry was authored, so a retry after a lost response, a reinstalled
 * service worker or a second tab collapses onto the row that already exists.
 */
export async function createDiaryEntryRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: DiaryWriteInput;
  /** Omit on the online path — one is minted so every row carries a key. */
  clientKey?: string;
  /** Device-clock authoring time; set only for a queued (offline-authored) write. */
  offlineAuthoredAt?: string | null;
}): Promise<OfflineWriteOutcome> {
  const orgId = args.ctx.org.id;
  const clientKey = args.clientKey ?? randomUUID();
  const tenant = await createClient();

  /**
   * CROSS-ORG JOB GUARD. `site_diary_entries.job_id` has no database-level org
   * guard (documented in app/(app)/diary/_data.ts: RLS admits every org a
   * multi-org member belongs to, so the FK alone would accept another company's
   * job). The picker is org-scoped, but a form post — or a queued item authored
   * before an org switch — is not the picker. Checking here covers BOTH write
   * paths at once, and turns "the parent job was deleted" into a clean permanent
   * rejection instead of an opaque FK error.
   *
   * Pinned to the ACTIVE org, not left to RLS, for exactly the reason above.
   */
  if (args.input.job_id) {
    const { data: job, error: jobErr } = await (
      tenant.from("jobs" as never) as unknown as JobLookupChain
    )
      .select("id")
      .eq("id", args.input.job_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (jobErr) return { status: "retry", reason: jobErr.code ?? "job_lookup_failed" };
    if (!job) return { status: "rejected", reason: "job_missing" };
  }

  const id = randomUUID();
  const { error } = await (
    tenant.from("site_diary_entries" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: orgId,
    entry_date: args.input.entry_date,
    job_id: args.input.job_id ?? null,
    weather: args.input.weather ?? null,
    labour_count: args.input.labour_count ?? null,
    work_summary: args.input.work_summary ?? null,
    delays: args.input.delays ?? null,
    notes: args.input.notes ?? null,
    created_by: args.user.id,
    client_write_key: clientKey,
    offline_authored_at: args.offlineAuthoredAt ?? null,
  });

  if (error) {
    /**
     * THE IDEMPOTENCY BRANCH. The partial unique index on
     * (org_id, client_write_key) — migration 20261077000000 — is what actually
     * prevents a duplicate; this just reports it honestly. The lookup is pinned to
     * the active org so a multi-org member can never be handed another org's row id.
     */
    if (error.code === UNIQUE_VIOLATION) {
      const { data: existing, error: lookupErr } = await (
        tenant.from("site_diary_entries" as never) as unknown as FindByKeyChain
      )
        .select("id")
        .eq("org_id", orgId)
        .eq("client_write_key", clientKey)
        .maybeSingle();
      /**
       * The lookup's OWN error must be bound and classified, not discarded. If it
       * is dropped, a transient failure here (a blip between the insert and this
       * read) falls through to the permanent rejection below — which would mark
       * the foreman's entry as permanently refused for a reason that had nothing
       * to do with his entry. A failed read is not evidence of anything.
       */
      if (lookupErr) {
        return { status: "retry", reason: lookupErr.code ?? "duplicate_lookup_failed" };
      }
      if (existing?.id) return { status: "duplicate", id: existing.id };
      // The lookup SUCCEEDED and returned nothing, so the key genuinely exists in a
      // row this caller cannot read. Refusing is the only safe answer: retrying
      // would loop forever, and claiming success would report a row we cannot show.
      return { status: "rejected", reason: "not_permitted" };
    }
    const permanent = error.code ? PERMANENT_CODES[error.code] : undefined;
    if (permanent) return { status: "rejected", reason: permanent };
    // Unrecognised → TRANSIENT by default. Never discard the user's content on an
    // error we did not explicitly classify.
    console.error("[offline-write] diary insert failed", error);
    return { status: "retry", reason: error.code ?? "insert_failed" };
  }

  await recordAdminActivity({
    actorId: args.user.id,
    actorEmail: args.user.email ?? null,
    action: "site_diary.created",
    targetTable: "site_diary_entries",
    targetId: id,
    metadata: {
      entry_date: args.input.entry_date,
      job_id: args.input.job_id ?? null,
      // Provenance in the audit trail: was this authored with no signal?
      offline: Boolean(args.offlineAuthoredAt),
    },
  });

  return { status: "accepted", id };
}

export type SnagWriteInput = {
  title: string;
  description?: string;
  location?: string;
  trade?: string;
  priority?: "low" | "medium" | "high";
  job_id?: string;
  assigned_to?: string;
  due_date?: string;
};

/**
 * Create one snag. THE snag write — online and offline alike, on exactly the
 * contract `createDiaryEntryRecord` established:
 *   - app/(app)/snags/actions.ts → createSnag (online form post), and
 *   - dispatchOfflineWrite below (queued replay)
 * both land here, so validation, org pinning, guards and audit cannot drift
 * between the path everyone watches and the path nobody would notice drifting.
 *
 * The row is born 'open' and the payload cannot say otherwise: a queued snag
 * replays no lifecycle state — the lifecycle STARTS when the row lands.
 */
export async function createSnagRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: SnagWriteInput;
  /** Omit on the online path — one is minted so every row carries a key. */
  clientKey?: string;
  /** Device-clock authoring time; set only for a queued (offline-authored) write. */
  offlineAuthoredAt?: string | null;
}): Promise<OfflineWriteOutcome> {
  const orgId = args.ctx.org.id;
  const clientKey = args.clientKey ?? randomUUID();
  const tenant = await createClient();

  /**
   * CROSS-ORG JOB GUARD — the diary's reason verbatim: `snags.job_id` has a
   * plain FK with NO database-level org guard (20260919), and RLS admits every
   * org a multi-org member belongs to, so the FK alone would accept another
   * company's job. The picker is org-scoped, but a form post — or a queued item
   * authored before an org switch — is not the picker. Checking here covers
   * BOTH write paths at once. Pinned to the ACTIVE org, not left to RLS.
   */
  if (args.input.job_id) {
    const { data: job, error: jobErr } = await (
      tenant.from("jobs" as never) as unknown as JobLookupChain
    )
      .select("id")
      .eq("id", args.input.job_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (jobErr) return { status: "retry", reason: jobErr.code ?? "job_lookup_failed" };
    if (!job) return { status: "rejected", reason: "job_missing" };
  }

  /**
   * ASSIGNEE GUARD. `snags.assigned_to` references users with NO membership
   * check anywhere (unlike material_requests, whose trigger guards
   * requested_by), so without this a crafted payload — queued or posted — could
   * put a stranger's name on this org's defect list. Members may read their own
   * org's memberships under RLS; the read is org-pinned (the #468 seam).
   */
  if (args.input.assigned_to) {
    const { data: member, error: memberErr } = await (
      tenant.from("memberships" as never) as unknown as MembershipLookupChain
    )
      .select("user_id")
      .eq("user_id", args.input.assigned_to)
      .eq("org_id", orgId)
      .maybeSingle();
    if (memberErr) {
      return { status: "retry", reason: memberErr.code ?? "assignee_lookup_failed" };
    }
    if (!member) return { status: "rejected", reason: "assignee_missing" };
  }

  const id = randomUUID();
  const { error } = await (
    tenant.from("snags" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: orgId,
    title: args.input.title,
    description: args.input.description ?? null,
    location: args.input.location ?? null,
    trade: args.input.trade ?? null,
    priority: args.input.priority ?? "medium",
    status: "open", // born open — never taken from the payload
    job_id: args.input.job_id ?? null,
    assigned_to: args.input.assigned_to ?? null,
    reported_by: args.user.id,
    due_date: args.input.due_date ?? null,
    client_write_key: clientKey,
    offline_authored_at: args.offlineAuthoredAt ?? null,
  });

  if (error) {
    // THE IDEMPOTENCY BRANCH — the partial unique index on
    // (org_id, client_write_key), migration 20261083000000, mirrored from the
    // diary branch above including the bound-and-classified lookup error.
    if (error.code === UNIQUE_VIOLATION) {
      const { data: existing, error: lookupErr } = await (
        tenant.from("snags" as never) as unknown as FindByKeyChain
      )
        .select("id")
        .eq("org_id", orgId)
        .eq("client_write_key", clientKey)
        .maybeSingle();
      if (lookupErr) {
        return { status: "retry", reason: lookupErr.code ?? "duplicate_lookup_failed" };
      }
      if (existing?.id) return { status: "duplicate", id: existing.id };
      return { status: "rejected", reason: "not_permitted" };
    }
    const permanent = error.code ? PERMANENT_CODES[error.code] : undefined;
    if (permanent) return { status: "rejected", reason: permanent };
    console.error("[offline-write] snag insert failed", error);
    return { status: "retry", reason: error.code ?? "insert_failed" };
  }

  await recordAdminActivity({
    actorId: args.user.id,
    actorEmail: args.user.email ?? null,
    action: "snag.created",
    targetTable: "snags",
    targetId: id,
    metadata: {
      title: args.input.title,
      priority: args.input.priority ?? "medium",
      job_id: args.input.job_id ?? null,
      // Provenance in the audit trail: was this authored with no signal?
      offline: Boolean(args.offlineAuthoredAt),
    },
  });

  return { status: "accepted", id };
}

/**
 * OFFLINE UPDATE — the shared conflict-resolving core, one per replayed edit.
 *
 * This is the generic engine both update wrappers below delegate to. It differs
 * from the create cores in one honest way: a create is genuinely identical online
 * and offline (one INSERT), but an UPDATE only needs conflict reconciliation when
 * there is a STALE BASE, which only the offline replay carries. So this core is the
 * OFFLINE update path; the online edit action writes against live data the user
 * just loaded. What they SHARE — and what keeps them from drifting — is the entity's
 * Zod schema (the anti-smuggle guarantee) and the column set (the registry's
 * mergeFields). No RPC, no SECURITY DEFINER, no service role: an ordinary
 * tenant-client read + a tenant-client compare-and-swap, both under the same RLS
 * UPDATE policy the online edit obeys.
 *
 * The protocol (see migration 20261129000000 for the DB reasoning):
 *   1. read the row (merge columns + updated_at + last_offline_write_key), pinned
 *      to (id, active org) — a by-id read alone would admit another org's row;
 *   2. IDEMPOTENCY: if this exact clientKey already stamped the row, it is a
 *      re-delivery — report `duplicate`, never re-apply over our own version bump;
 *   3. 3-way merge (lib/offline/merge.ts) of base (what the author edited from),
 *      mine (the queued edit) and theirs (the row now). A divergent field is a
 *      `conflict` (nothing written) unless the author has resolved "keep mine";
 *   4. entity guards on the MERGED result (the job/assignee that will actually be
 *      written), so a merge that pulled the server's job still gets guarded;
 *   5. COMPARE-AND-SWAP: update ... where updated_at = <the version we read>. A row
 *      that moved under us returns count 0 → `retry` (re-read next flush), never a
 *      silent overwrite.
 */
async function applyOfflineUpdate(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  kind: OfflineWriteKind;
  table: string;
  auditAction: string;
  /** Parsed update payload, including the target `id`. */
  input: Record<string, unknown> & { id: string };
  /** The row version (updated_at) the edit form was rendered with. */
  baseVersion: string;
  /** The field values the author started editing from (untrusted merge base). */
  baseValues: Record<string, unknown>;
  resolution?: "keep_mine";
  clientKey: string;
  offlineAuthoredAt?: string | null;
  /** Guards the MERGED result (e.g. job/assignee still valid in this org). */
  guard?: (
    tenant: unknown,
    orgId: string,
    merged: Record<string, unknown>,
  ) => Promise<OfflineWriteOutcome | null>;
  /**
   * OPTIONAL payload-key → DB-column map, for a schema whose keys differ from the
   * table's columns (delay events: camelCase schema, snake_case table). The 3-way
   * merge still runs in payload-key space; this only maps which column `theirs` is
   * read from and the patch is written to. Absent → the field name IS the column.
   */
  columnMap?: Readonly<Record<string, string>>;
  /**
   * OPTIONAL editable-state guard. `statusColumn` must hold one of `editableWhen`
   * for the row to be edited at all; otherwise the update is permanently rejected
   * (`not_editable`), matching the online edit action's own status guard. When
   * `editableWhen` is a single value it is ALSO appended to the compare-and-swap, so
   * a promotion racing between our read and our swap fails the swap rather than
   * editing a now-frozen row.
   */
  statusColumn?: string;
  editableWhen?: readonly string[];
}): Promise<OfflineUpdateOutcome> {
  const orgId = args.ctx.org.id;
  const tenant = await createClient();
  const fields = offlineMergeFields(args.kind);
  const id = args.input.id;
  /** payload key → the column it lives in (identity when unmapped). */
  const colOf = (f: string): string => args.columnMap?.[f] ?? f;

  // 1. read the current row, pinned to the ACTIVE org (a by-id read admits every
  //    org a multi-org member belongs to — the diary/_data.ts seam).
  const readCols = [
    ...fields.map(colOf),
    "updated_at",
    "last_offline_write_key",
    ...(args.statusColumn ? [args.statusColumn] : []),
  ].join(", ");
  const { data: row, error: readErr } = await (
    tenant.from(args.table as never) as unknown as RowReadChain
  )
    .select(readCols)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readErr) {
    return { status: "retry", reason: readErr.code ?? "target_lookup_failed" };
  }
  if (!row) return { status: "rejected", reason: "target_missing" };

  // 1b. EDITABLE-STATE GUARD. A delay event promoted out of 'draft' is frozen
  //     evidence; an offline edit of it is permanently refused (not retried — it
  //     will never become a draft again), matching the online edit's status guard.
  if (
    args.statusColumn &&
    args.editableWhen &&
    !args.editableWhen.includes(String(row[args.statusColumn]))
  ) {
    return { status: "rejected", reason: "not_editable" };
  }

  // 2. IDEMPOTENCY. A re-delivered update (lost response, reinstalled SW) is caught
  //    by the marker it stamped last time, BEFORE its own version bump could read
  //    as a concurrent change.
  if (
    typeof row.last_offline_write_key === "string" &&
    row.last_offline_write_key === args.clientKey
  ) {
    return { status: "duplicate", id };
  }

  const currentVersion = String(row.updated_at);
  const theirs: Record<string, unknown> = {};
  for (const f of fields) theirs[f] = row[colOf(f)];
  const preferMine = args.resolution === "keep_mine";

  // A "keep mine" resolution only applies while the version the author acknowledged
  // is still current. If the server moved again since they looked, re-surface the
  // conflict rather than clobber the newer edit.
  if (preferMine && currentVersion !== args.baseVersion) {
    const remerge = threeWayMerge(fields, args.baseValues, args.input, theirs);
    return {
      status: "conflict",
      serverVersion: currentVersion,
      fields: remerge.conflicts.map((c) => ({
        field: c.field,
        mine: c.mine,
        theirs: c.theirs,
      })),
    };
  }

  // 3. the merge.
  const merge = threeWayMerge(fields, args.baseValues, args.input, theirs, {
    preferMineOnConflict: preferMine,
  });
  if (!merge.clean && !preferMine) {
    return {
      status: "conflict",
      serverVersion: currentVersion,
      fields: merge.conflicts.map((c) => ({
        field: c.field,
        mine: c.mine,
        theirs: c.theirs,
      })),
    };
  }

  // 4. guard the values that will actually be written.
  if (args.guard) {
    const g = await args.guard(tenant, orgId, merge.merged);
    if (g) return g;
  }

  // 5. compare-and-swap on the version we read. Values are written to their mapped
  //    columns; an empty string (an emptied optional) is stored as NULL, matching
  //    the create cores' `?? null` and the online edit's orNull().
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const v = merge.merged[f];
    patch[colOf(f)] = v === "" || v === undefined ? null : v;
  }
  patch.last_offline_write_key = args.clientKey;

  let cas = (tenant.from(args.table as never) as unknown as CasUpdateChain)
    .update(patch, { count: "exact" })
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("updated_at", currentVersion);
  // A single-valued editable-state also guards the SWAP, so a promotion racing
  // between the read and the swap fails the swap instead of editing a frozen row.
  if (args.statusColumn && args.editableWhen && args.editableWhen.length === 1) {
    cas = cas.eq(args.statusColumn, args.editableWhen[0]);
  }
  const { error, count } = await cas;

  if (error) {
    const permanent = error.code ? PERMANENT_CODES[error.code] : undefined;
    if (permanent) return { status: "rejected", reason: permanent };
    console.error(`[offline-write] ${args.table} update failed`, error);
    return { status: "retry", reason: error.code ?? "update_failed" };
  }
  if (!count) {
    // The row moved between our read and our swap. If that was our OWN prior apply
    // (a lost response), the next attempt's idempotency check reports it a
    // duplicate; if it was a real concurrent edit, the next attempt re-reads and
    // re-merges. Either way transient — never a silent overwrite, never a loss.
    return { status: "retry", reason: "version_moved" };
  }

  await recordAdminActivity({
    actorId: args.user.id,
    actorEmail: args.user.email ?? null,
    action: args.auditAction,
    targetTable: args.table,
    targetId: id,
    metadata: {
      offline: Boolean(args.offlineAuthoredAt),
      resolution: args.resolution ?? null,
      merged_fields: Object.keys(merge.merged),
    },
  });

  return { status: "accepted", id };
}

/** Guard a diary/snag job_id against the active org (the create cores' guard,
 *  applied to the MERGED value an edit will write). Returns an outcome to return, or
 *  null when the value is absent or valid. */
async function guardJob(
  tenant: unknown,
  orgId: string,
  jobId: unknown,
): Promise<OfflineWriteOutcome | null> {
  if (!jobId) return null;
  const { data: job, error } = await (
    (tenant as { from: (t: never) => unknown }).from("jobs" as never) as unknown as JobLookupChain
  )
    .select("id")
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return { status: "retry", reason: error.code ?? "job_lookup_failed" };
  if (!job) return { status: "rejected", reason: "job_missing" };
  return null;
}

/**
 * Reconcile one offline diary EDIT. Shares the diary create's cross-org job guard,
 * applied to the merged job_id, and the same Zod schema the online edit action uses.
 */
export async function updateDiaryEntryRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: { id: string } & DiaryWriteInput;
  baseVersion: string;
  baseValues: Record<string, unknown>;
  resolution?: "keep_mine";
  clientKey: string;
  offlineAuthoredAt?: string | null;
}): Promise<OfflineUpdateOutcome> {
  return applyOfflineUpdate({
    ctx: args.ctx,
    user: args.user,
    kind: "site_diary.update",
    table: "site_diary_entries",
    auditAction: "site_diary.updated",
    input: args.input,
    baseVersion: args.baseVersion,
    baseValues: args.baseValues,
    resolution: args.resolution,
    clientKey: args.clientKey,
    offlineAuthoredAt: args.offlineAuthoredAt,
    guard: (tenant, orgId, merged) => guardJob(tenant, orgId, merged.job_id),
  });
}

/**
 * Reconcile one offline snag EDIT. Shares the snag create's job + assignee guards,
 * applied to the merged values, and the same Zod schema the online edit uses. The
 * snag STATUS lifecycle is never touched — the update schema carries no status.
 */
export async function updateSnagRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: { id: string } & SnagWriteInput;
  baseVersion: string;
  baseValues: Record<string, unknown>;
  resolution?: "keep_mine";
  clientKey: string;
  offlineAuthoredAt?: string | null;
}): Promise<OfflineUpdateOutcome> {
  return applyOfflineUpdate({
    ctx: args.ctx,
    user: args.user,
    kind: "snag.update",
    table: "snags",
    auditAction: "snag.updated",
    input: args.input,
    baseVersion: args.baseVersion,
    baseValues: args.baseValues,
    resolution: args.resolution,
    clientKey: args.clientKey,
    offlineAuthoredAt: args.offlineAuthoredAt,
    guard: async (tenant, orgId, merged) => {
      const jobOutcome = await guardJob(tenant, orgId, merged.job_id);
      if (jobOutcome) return jobOutcome;
      if (!merged.assigned_to) return null;
      const { data: member, error } = await (
        (tenant as { from: (t: never) => unknown }).from(
          "memberships" as never,
        ) as unknown as MembershipLookupChain
      )
        .select("user_id")
        .eq("user_id", merged.assigned_to)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) {
        return { status: "retry", reason: error.code ?? "assignee_lookup_failed" };
      }
      if (!member) return { status: "rejected", reason: "assignee_missing" };
      return null;
    },
  });
}

/**
 * Reconcile one offline DRAFT delay-event EDIT. Uses the delay schema's camelCase
 * keys against snake_case columns (the registry columnMap), and is enabled ONLY
 * while the row is a draft (editableWhen) — a promoted event is frozen evidence.
 * The job is not in the merge set, so an offline edit never re-homes a draft. Same
 * shared conflict-resolving core, same tenant client, same RLS.
 */
export async function updateDelayEventRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: Record<string, unknown> & { id: string };
  baseVersion: string;
  baseValues: Record<string, unknown>;
  resolution?: "keep_mine";
  clientKey: string;
  offlineAuthoredAt?: string | null;
}): Promise<OfflineUpdateOutcome> {
  return applyOfflineUpdate({
    ctx: args.ctx,
    user: args.user,
    kind: "delay_event.update",
    table: "delay_events",
    auditAction: "delay_event.updated",
    input: args.input,
    baseVersion: args.baseVersion,
    baseValues: args.baseValues,
    resolution: args.resolution,
    clientKey: args.clientKey,
    offlineAuthoredAt: args.offlineAuthoredAt,
    columnMap: {
      startedOn: "started_on",
      endedOn: "ended_on",
      workingDaysLost: "working_days_lost",
      diaryEntryId: "diary_entry_id",
      variationQuoteId: "variation_quote_id",
      weatherDistrict: "weather_district",
    },
    statusColumn: "status",
    editableWhen: ["draft"],
  });
}

/** The envelope a client hands to the sync action. Untrusted; validated below. */
export type QueuedWriteEnvelope = {
  clientKey: string;
  kind: string;
  orgId: string;
  payload: unknown;
  authoredAt: string;
  /** UPDATE kinds only: the concurrency anchor, merge base, and any resolution. */
  baseVersion?: string;
  baseValues?: Record<string, unknown>;
  resolution?: "keep_mine";
};

/**
 * Replay one queued write. THE server-side trust boundary for the offline queue.
 *
 * Every check here is deliberate and ordered cheapest-first, and every one of them
 * would already be enforced for an online write:
 *   1. envelope shape — a hand-crafted request is not a queued write;
 *   2. REGISTRY GATE — only kinds the registry enables may be written at all, so
 *      naming `invoices.create` in a payload achieves nothing;
 *   3. ACTIVE-ORG PIN — the write lands in the org that was active when it was
 *      authored, or it does not land. Never re-homed. A queued entry authored for
 *      Company A must not become Company A's evidence filed under Company B just
 *      because the user switched the org switcher before the van found signal;
 *   4. the entity's own Zod schema — the same one the online action uses;
 *   5. the shared write core, on the tenant client, under RLS.
 *
 * `ctx`/`user` come from the CALLER's `requireOrgContext()` — this function never
 * resolves an identity itself, so it cannot be talked into acting as anyone else.
 */
export async function dispatchOfflineWrite(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  item: QueuedWriteEnvelope;
}): Promise<OfflineUpdateOutcome> {
  const { item } = args;

  // 1. envelope. clientKey must be UUID-SHAPED, not merely non-empty: the
  // column is uuid, so a malformed key 22P02s — on the snag INSERT that
  // surfaces as a permanent rejection, but on the material-request key
  // LOOKUP it surfaced as a transient, and a permanently-transient item at
  // the head of a seq-ordered outbox wedges everything behind it (the
  // adversarial review's liveness P2). Refuse the shape here, uniformly.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !item ||
    typeof item.clientKey !== "string" ||
    !UUID_RE.test(item.clientKey) ||
    typeof item.orgId !== "string" ||
    item.orgId.length === 0
  ) {
    return { status: "rejected", reason: "malformed_item" };
  }

  // 2. THE REGISTRY GATE
  if (!isOfflineWriteKind(item.kind)) {
    return { status: "rejected", reason: "unknown_kind" };
  }

  // 3. ACTIVE-ORG PIN — refuse, never re-home.
  if (item.orgId !== args.ctx.org.id) {
    return { status: "rejected", reason: "org_mismatch" };
  }

  // 4. the entity's own schema
  const parsed = offlineWriteEntity(item.kind).schema.safeParse(item.payload);
  if (!parsed.success) return { status: "rejected", reason: "invalid_payload" };

  // 4b. UPDATE kinds carry a concurrency anchor + merge base + optional resolution.
  //     A hand-crafted update with none of these cannot be merged — refuse it as a
  //     malformed envelope rather than let it fall through to a create-shaped write.
  const kind: OfflineWriteKind = item.kind;
  const isUpdate = offlineWriteEntity(kind).mode === "update";
  let baseVersion = "";
  let baseValues: Record<string, unknown> = {};
  let resolution: "keep_mine" | undefined;
  if (isUpdate) {
    if (
      typeof item.baseVersion !== "string" ||
      item.baseVersion.length === 0 ||
      !item.baseValues ||
      typeof item.baseValues !== "object"
    ) {
      return { status: "rejected", reason: "malformed_item" };
    }
    if (item.resolution !== undefined && item.resolution !== "keep_mine") {
      return { status: "rejected", reason: "malformed_item" };
    }
    baseVersion = item.baseVersion;
    baseValues = item.baseValues;
    resolution = item.resolution;
  }

  // 5. dispatch. Exhaustive over OfflineWriteKind — a new registry kind without a
  //    handler is a TYPE error here, and a no-drift unit test says so out loud.
  switch (kind) {
    case "site_diary.create": {
      const input = createDiaryEntrySchema.parse(parsed.data);
      return createDiaryEntryRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    case "site_diary.update": {
      const input = updateDiaryEntrySchema.parse(parsed.data);
      return updateDiaryEntryRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        baseVersion,
        baseValues,
        resolution,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    case "snag.create": {
      const input = createSnagSchema.parse(parsed.data);
      return createSnagRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    case "snag.update": {
      const input = updateSnagSchema.parse(parsed.data);
      return updateSnagRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        baseVersion,
        baseValues,
        resolution,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    case "material_request.create": {
      const input = materialRequestFormSchema.parse(parsed.data);
      return createMaterialRequestDraftRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    case "delay_event.create": {
      const input = createDelayEventSchema.parse(parsed.data);
      return createDelayEventDraftRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    case "delay_event.update": {
      const input = updateDelayEventSchema.parse(parsed.data) as Record<
        string,
        unknown
      > & { id: string };
      return updateDelayEventRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        baseVersion,
        baseValues,
        resolution,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    case "site_report.create": {
      const input = createSiteReportSchema.parse(parsed.data);
      return createSiteReportDraftRecord({
        ctx: args.ctx,
        user: args.user,
        input,
        clientKey: item.clientKey,
        offlineAuthoredAt:
          typeof item.authoredAt === "string" ? item.authoredAt : null,
      });
    }
    default: {
      // Unreachable while the switch is exhaustive; kept so adding a registry kind
      // without a handler fails to compile rather than silently returning success.
      const never: never = kind;
      void never;
      return { status: "rejected", reason: "unknown_kind" };
    }
  }
}
