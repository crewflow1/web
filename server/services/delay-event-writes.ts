import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import type { OrgContext } from "@/server/auth/session";
import { orNull, type CreateDelayEventInput } from "@/lib/eot/schema";
import {
  OFFLINE_PERMANENT_CODES,
  OFFLINE_UNIQUE_VIOLATION,
  type OfflineWriteOutcome,
} from "@/server/services/offline-writes";

/**
 * DELAY EVENT — the shared write core (train "offl"). ONE write path for the
 * DRAFT create, used by BOTH:
 *   - app/(app)/delays/actions.ts → createDelayEvent (online form post), and
 *   - server/services/offline-writes.ts → dispatchOfflineWrite (queued replay).
 *
 * It lives in its own module, on exactly the contract material-request-writes.ts
 * established: tenant (user-JWT) client, RLS, active-org pin, the SHARED
 * permanent-error allowlist, no service role, no SECURITY DEFINER, no RPC. The
 * only difference between the two entry points is where `clientKey` comes from
 * (the browser's queue vs freshly minted here) and whether `offlineAuthoredAt`
 * is set — so a future hardening of one path hardens both; they cannot drift.
 *
 * ── DRAFT ONLY, by design ────────────────────────────────────────────────────
 * `delay_events` is born 'draft' and this core writes nothing else, ever. The
 * 'recorded' / 'withdrawn' transitions are lifecycle acts whose provenance
 * (recorded_at/by, withdrawn_at/by) the transition trigger pins server-side, and
 * whose draft-CHECK (delay_events_draft_unprovenanced, 20261084) makes a
 * pre-forged provenance stamp unrepresentable. Replaying a "recorded" hours
 * after it was authored would misdate the one fact that trigger protects — so
 * the offline artefact stops at the draft, exactly as material_request.submit is
 * not captured offline. A human promotes it online.
 *
 * ── No money ─────────────────────────────────────────────────────────────────
 * `working_days_lost` is the recorder's CLAIM, typed in by hand and never
 * derived; nothing here writes to finances. A delay event records what happened,
 * never what it entitles anyone to (20261084 header).
 */

type PgError = { message: string; code?: string } | null;

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: PgError }>;
};
type LookupChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        maybeSingle: () => Promise<{ data: { id: string } | null; error: PgError }>;
      };
    };
  };
};

export async function createDelayEventDraftRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: CreateDelayEventInput;
  /** Omit on the online path — one is minted so every row carries a key. */
  clientKey?: string;
  /** Device-clock authoring time; set only for a queued (offline-authored) write. */
  offlineAuthoredAt?: string | null;
}): Promise<OfflineWriteOutcome> {
  const orgId = args.ctx.org.id;
  const clientKey = args.clientKey ?? randomUUID();
  const tenant = await createClient();

  /**
   * CROSS-ORG JOB GUARD. `delay_events.job_id` is protected at the database by a
   * COMPOSITE FK (job_id, org_id) → jobs(id, org_id), so a cross-tenant job is
   * already unrepresentable for every role. This explicit, org-pinned read still
   * earns its place: it turns "the parent job was deleted, or a queued item was
   * authored before an org switch" into the clean permanent `job_missing` the
   * diary and snag cores give, instead of an opaque FK error — and covers BOTH
   * write paths at once.
   */
  const { data: job, error: jobErr } = await (
    tenant.from("jobs" as never) as unknown as LookupChain
  )
    .select("id")
    .eq("id", args.input.jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (jobErr) return { status: "retry", reason: jobErr.code ?? "job_lookup_failed" };
  if (!job) return { status: "rejected", reason: "job_missing" };

  const id = randomUUID();
  const { error } = await (
    tenant.from("delay_events" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: orgId,
    job_id: args.input.jobId,
    category: args.input.category,
    started_on: args.input.startedOn,
    ended_on: orNull(args.input.endedOn),
    working_days_lost:
      args.input.workingDaysLost === "" || args.input.workingDaysLost === undefined
        ? null
        : args.input.workingDaysLost,
    description: args.input.description,
    diary_entry_id: orNull(args.input.diaryEntryId),
    variation_quote_id: orNull(args.input.variationQuoteId),
    weather_district: orNull(args.input.weatherDistrict),
    status: "draft", // born draft — never taken from the payload
    created_by: args.user.id,
    client_write_key: clientKey,
    offline_authored_at: args.offlineAuthoredAt ?? null,
  });

  if (error) {
    // THE IDEMPOTENCY BRANCH — the partial unique index on
    // (org_id, client_write_key), migration 20261101000000, mirrored from the
    // diary/snag branch including the bound-and-classified lookup error.
    if (error.code === OFFLINE_UNIQUE_VIOLATION) {
      const { data: existing, error: lookupErr } = await (
        tenant.from("delay_events" as never) as unknown as LookupChain
      )
        .select("id")
        .eq("org_id", orgId)
        .eq("client_write_key", clientKey)
        .maybeSingle();
      if (lookupErr) {
        return { status: "retry", reason: lookupErr.code ?? "duplicate_lookup_failed" };
      }
      if (existing?.id) return { status: "duplicate", id: existing.id };
      // The key exists in a row this caller cannot read — refusing is the only
      // safe answer (retrying loops forever; claiming success reports a row we
      // cannot show).
      return { status: "rejected", reason: "not_permitted" };
    }
    const permanent = error.code ? OFFLINE_PERMANENT_CODES[error.code] : undefined;
    if (permanent) return { status: "rejected", reason: permanent };
    // Unrecognised → TRANSIENT by default. Never discard the user's account of
    // what stopped the work on an error we did not explicitly classify.
    console.error("[offline-write] delay event insert failed", error);
    return { status: "retry", reason: error.code ?? "insert_failed" };
  }

  return { status: "accepted", id };
}
