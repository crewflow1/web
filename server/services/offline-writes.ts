import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { recordAdminActivity } from "@/server/services/hq-audit";
import type { OrgContext } from "@/server/auth/session";
import {
  isOfflineWriteKind,
  offlineWriteEntity,
  type OfflineWriteKind,
} from "@/lib/offline/registry";
import { createDiaryEntrySchema } from "@/lib/site-diary/schema";
import { createSnagSchema } from "@/lib/snags/schema";
import { materialRequestFormSchema } from "@/lib/material-requests/schema";
import { createMaterialRequestDraftRecord } from "@/server/services/material-request-writes";

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
  /** Written. `id` is the new row. */
  | { status: "accepted"; id: string }
  /** This exact clientKey was already written. Idempotent no-op; ONE row exists. */
  | { status: "duplicate"; id: string }
  /** PERMANENTLY refused. The client retains the item so the user can recover it. */
  | { status: "rejected"; reason: OfflineRejectReason }
  /** Try again later. The item stays pending. */
  | { status: "retry"; reason: string };

export type OfflineRejectReason =
  | "unknown_kind" // not in the registry
  | "invalid_payload" // failed the entity's own Zod schema
  | "org_mismatch" // authored in a different org — refused, never re-homed
  | "job_missing" // the parent job is gone, or belongs to another org
  | "assignee_missing" // the named assignee is not a member of the active org
  | "stock_item_missing" // a line's catalogue item is not in the active org
  | "not_permitted" // RLS refused the insert
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

/** The envelope a client hands to the sync action. Untrusted; validated below. */
export type QueuedWriteEnvelope = {
  clientKey: string;
  kind: string;
  orgId: string;
  payload: unknown;
  authoredAt: string;
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
}): Promise<OfflineWriteOutcome> {
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

  // 5. dispatch. Exhaustive over OfflineWriteKind — a new registry kind without a
  //    handler is a TYPE error here, and a no-drift unit test says so out loud.
  const kind: OfflineWriteKind = item.kind;
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
    default: {
      // Unreachable while the switch is exhaustive; kept so adding a registry kind
      // without a handler fails to compile rather than silently returning success.
      const never: never = kind;
      void never;
      return { status: "rejected", reason: "unknown_kind" };
    }
  }
}
