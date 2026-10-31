import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { isMissingDbObject } from "@/lib/supabase/schema-compat";
import type { OrgContext } from "@/server/auth/session";
import type { MaterialRequestFormInput } from "@/lib/material-requests/schema";
import { isStockModuleAbsent } from "@/server/services/material-fulfilment";
import {
  OFFLINE_PERMANENT_CODES,
  OFFLINE_UNIQUE_VIOLATION,
  type OfflineWriteOutcome,
} from "@/server/services/offline-writes";

/**
 * MATERIAL REQUEST — the shared write core (Train 5). ONE write path for the
 * draft create, used by BOTH:
 *   - app/(app)/materials/requests/actions.ts → createMaterialRequest (online), and
 *   - server/services/offline-writes.ts → dispatchOfflineWrite (queued replay).
 *
 * It lives in its OWN module — not in offline-writes.ts with its siblings —
 * for one narrow reason: this entity's write path legitimately includes the
 * pre-existing per-org number allocator `next_material_request_number`
 * (20261066), invoked under the caller's OWN JWT exactly as the online action
 * has always invoked it, while offline-writes.ts keeps its blanket "no
 * remote-procedure surface at all" property that the security suite pins
 * verbatim. The allocator is stable and read-only; the unique (org_id, number)
 * constraint — not the allocator — is the real guard against a number race.
 * Nothing else here is different: tenant client, RLS, active-org pin, the same
 * permanent-error allowlist, no service role anywhere.
 *
 * ── The two-statement problem, and the replay protocol that closes it ────────
 * A request is a header plus its lines (two tables; supabase-js issues one
 * statement per call). The idempotency key lives on the HEADER
 * (20261083000000), so a crash BETWEEN the two statements would strand a
 * header with no lines — and a naive "23505 ⇒ already recorded" replay would
 * then green-tick a request that never says what the site asked for: the exact
 * receipts-table data-loss machine the 20261077 header warns about, one level
 * up. The protocol is therefore KEY-FIRST WITH LINE RECOVERY:
 *
 *   1. look the key up          → found, has lines : duplicate (done)
 *                                 found, no lines  : insert the lines NOW
 *   2. guards (job, stock item) → permanent rejections, before anything writes
 *   3. allocate number, insert header (23505 → step 1's found-branch, or a
 *      number race → plain retry with a fresh number next attempt)
 *   4. insert the lines (one array statement — atomic per statement)
 *
 * Two concurrent recoveries can both see "no lines"; the unique
 * (material_request_id, sort_order) index (20261083000000) makes the loser's
 * insert a 23505 that is reported as duplicate, never a doubled ask.
 *
 * ── DRAFT ONLY, by design ────────────────────────────────────────────────────
 * This core writes status 'draft' and nothing else, ever. Submission is a
 * lifecycle transition whose provenance (submitted_at) the database pins
 * server-side and which fans out notifications; the ONLINE action layers it on
 * top (intent=submit) AFTER this core returns, and the offline path stops at
 * the draft — stated in the form wording. The number is allocated HERE, at
 * write time, never offline: offline numbering would fork the per-org sequence.
 */

type PgError = { message: string; code?: string } | null;

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: PgError }>;
};
type HeaderLookupChain = {
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
type LinesProbeChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        limit: (n: number) => Promise<{ data: { id: string }[] | null; error: PgError }>;
      };
    };
  };
};
type NumberRpc = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: string | null; error: PgError }>;
};

export async function createMaterialRequestDraftRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: MaterialRequestFormInput;
  /** Omit on the online path — one is minted so every row carries a key. */
  clientKey?: string;
  /** Device-clock authoring time; set only for a queued (offline-authored) write. */
  offlineAuthoredAt?: string | null;
}): Promise<OfflineWriteOutcome> {
  const orgId = args.ctx.org.id;
  const clientKey = args.clientKey ?? randomUUID();
  const tenant = await createClient();

  // ── 1. KEY-FIRST LOOKUP, pinned to this caller's OWN row (org + key +
  // created_by). Found means a previous attempt got at least the header in;
  // ensureLines decides whether anything is still owed. Via the TENANT client +
  // a self-scoped SECURITY DEFINER RPC (find_own_material_request) so a job-less
  // / now-unassigned request stays detectable after the Phase 3 SELECT narrowing
  // WITHOUT a service-role client in the write path (trust-boundary invariant).
  const { id: priorId, error: priorErr } = await findOwnRequestId(
    tenant,
    orgId,
    clientKey,
    args.user.id,
  );
  if (priorErr) {
    // A failed READ is not evidence of anything — retry, never reject.
    return { status: "retry", reason: priorErr.code ?? "key_lookup_failed" };
  }
  if (priorId) {
    return ensureLines(tenant, orgId, priorId, args.input, /*headerPreexisted*/ true);
  }

  // ── 2. Guards, before anything is written.
  // CROSS-ORG JOB GUARD: the DB's org-integrity trigger (20261066) would also
  // refuse, but as an opaque check violation; guarding here gives both paths
  // the same clean "job_missing" the diary and snag cores give, and covers the
  // queued-item-authored-before-an-org-switch case identically.
  if (args.input.job_id) {
    const { data: job, error: jobErr } = await (
      tenant.from("jobs" as never) as unknown as HeaderLookupChain
    )
      .select("id")
      .eq("id", args.input.job_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (jobErr) return { status: "retry", reason: jobErr.code ?? "job_lookup_failed" };
    if (!job) return { status: "rejected", reason: "job_missing" };
  }
  const stockGuard = await checkStockItems(tenant, orgId, args.input);
  if (stockGuard) return stockGuard;

  // ── 3. Allocate the per-org number and insert the header. The unique
  // (org_id, number) constraint — not the allocator — is the race guard; a
  // collision surfaces as 23505 below and is retried with a fresh number.
  const { data: number, error: numberError } = await (
    tenant as unknown as NumberRpc
  ).rpc("next_material_request_number", { target_org: orgId });
  if (numberError || !number) {
    if (numberError) {
      console.error("[offline-write] MR number allocation failed", numberError);
    }
    return { status: "retry", reason: numberError?.code ?? "number_allocation_failed" };
  }

  const id = randomUUID();
  const { error } = await (
    tenant.from("material_requests" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: orgId,
    job_id: args.input.job_id ?? null,
    number,
    status: "draft", // born draft — the database refuses anything else
    requested_by: args.user.id,
    needed_by: args.input.needed_by ?? null,
    priority: args.input.priority,
    notes: args.input.notes ?? null,
    created_by: args.user.id,
    client_write_key: clientKey,
    offline_authored_at: args.offlineAuthoredAt ?? null,
  });

  if (error) {
    if (error.code === OFFLINE_UNIQUE_VIOLATION) {
      /**
       * TWO constraints can 23505 this insert: the idempotency key (a
       * concurrent replay of the SAME item won the race) and (org_id, number)
       * (an unrelated request took the number first). They are told apart by
       * RE-READING THE KEY, never by sniffing constraint names out of the
       * message: key found → the write exists, ensure its lines; key absent →
       * it was the number race, which is TRANSIENT — the next attempt
       * allocates a fresh number. A number race must never be reported as
       * "duplicate": that would green-tick a request that was never written.
       */
      const { id: winnerId, error: winnerErr } = await findOwnRequestId(
        tenant,
        orgId,
        clientKey,
        args.user.id,
      );
      if (winnerErr) {
        return { status: "retry", reason: winnerErr.code ?? "duplicate_lookup_failed" };
      }
      if (winnerId) {
        return ensureLines(tenant, orgId, winnerId, args.input, true);
      }
      return { status: "retry", reason: "number_conflict" };
    }
    const permanent = error.code ? OFFLINE_PERMANENT_CODES[error.code] : undefined;
    if (permanent) return { status: "rejected", reason: permanent };
    console.error("[offline-write] material request insert failed", error);
    return { status: "retry", reason: error.code ?? "insert_failed" };
  }

  // ── 4. The lines. Header freshly inserted ⇒ no lines can exist yet.
  const lineOutcome = await insertLines(tenant, orgId, id, args.input);
  if (lineOutcome) return lineOutcome;

  // No recordAdminActivity here, matching the online path this core replaced:
  // material_requests has a DATABASE activity trigger (20261066 §8) that logs
  // the create on every path, and triggers are the only legal activity_log
  // writers. offline_authored_at on the row is the offline provenance.
  return { status: "accepted", id };
}

/**
 * Self-scoped own-row lookup: the id of THIS caller's material request for
 * (org_id, client_write_key). Routed through the TENANT client + the
 * find_own_material_request SECURITY DEFINER RPC (migration 20261255), which is
 * self-scoped to created_by = auth.uid() so it can never surface another
 * member's row. The RPC is the ONE read that sees past the Phase 3 SELECT
 * narrowing (a job-less / now-unassigned request is invisible to the member's
 * own tenant table read), so the offline replay can still detect its own prior
 * write — WITHOUT a service-role client in the write path. Not a visibility
 * change: a member still cannot browse any request that isn't their own.
 */
async function findOwnRequestId(
  tenant: unknown,
  orgId: string,
  clientKey: string,
  userId: string,
): Promise<{ id: string | null; error: PgError }> {
  const { data, error } = await (
    tenant as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: PgError }>;
    }
  ).rpc("find_own_material_request", {
    p_org_id: orgId,
    p_client_write_key: clientKey,
  });
  if (error && isMissingDbObject(error)) {
    // SCHEMA-COMPAT (R5 deploy window): the find_own_material_request RPC is
    // created by migration 20261255. Until it is applied, fall back to the pre-R5
    // tenant-client lookup pinned to the SAME three axes the RPC self-scopes on
    // (org + client_write_key + created_by = this caller). Still the TENANT client,
    // never service-role, so the trust-boundary invariant holds; and pre-migration
    // the Phase 3 SELECT narrowing isn't applied, so the caller can still read its
    // own row. Only on a missing function; any real error is returned unchanged.
    const { data: row, error: qErr } = await (
      tenant as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              eq: (k: string, v: string) => {
                eq: (k: string, v: string) => {
                  maybeSingle: () => Promise<{ data: { id: string } | null; error: PgError }>;
                };
              };
            };
          };
        };
      }
    )
      .from("material_requests")
      .select("id")
      .eq("org_id", orgId)
      .eq("client_write_key", clientKey)
      .eq("created_by", userId)
      .maybeSingle();
    return { id: row?.id ?? null, error: qErr };
  }
  return { id: (data as string | null) ?? null, error };
}

/**
 * The recovery half of the protocol: the header exists (this attempt or an
 * earlier one); make sure its lines do too, then answer honestly.
 * "duplicate" is only ever said when the WHOLE write — header AND lines — is
 * already in the database.
 */
async function ensureLines(
  tenant: unknown,
  orgId: string,
  requestId: string,
  input: MaterialRequestFormInput,
  headerPreexisted: boolean,
): Promise<OfflineWriteOutcome> {
  // Probe for existing lines via the TENANT client + the self-scoped
  // own_material_request_line_count RPC: requestId has already been proven to be
  // THIS caller's own row, and under Phase 3 a job-less / now-unassigned
  // request's lines are invisible to a tenant table read — which would make the
  // probe read empty and re-insert over an existing set. The RPC counts lines
  // only for a request the caller OWNS (created_by = auth.uid()); no service-role
  // client in the write path.
  const probe = await (
    tenant as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: PgError }>;
    }
  ).rpc("own_material_request_line_count", {
    p_org_id: orgId,
    p_request_id: requestId,
  });
  let lineCount = probe.data as number | null;
  let probeErr = probe.error;
  if (probeErr && isMissingDbObject(probeErr)) {
    // SCHEMA-COMPAT (R5 deploy window): the own_material_request_line_count RPC is
    // created by migration 20261255. Until applied, count the request's lines via
    // the TENANT client. requestId was already proven to be THIS caller's own row
    // (findOwnRequestId), and pre-migration the Phase 3 narrowing isn't applied, so
    // the tenant read is accurate — still no service-role client. Only on a missing
    // function; a real count error still retries loud.
    const { count, error: cErr } = await (
      tenant as {
        from: (t: string) => {
          select: (c: string, o: { count: "exact"; head: true }) => {
            eq: (k: string, v: string) => {
              eq: (k: string, v: string) => Promise<{ count: number | null; error: PgError }>;
            };
          };
        };
      }
    )
      .from("material_request_lines")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("material_request_id", requestId);
    lineCount = count ?? 0;
    probeErr = cErr;
  }
  if (probeErr) {
    // Empty-on-error must not read as "no lines" here: that would re-insert
    // over a read blip. LOUD and transient instead.
    return { status: "retry", reason: probeErr.code ?? "lines_probe_failed" };
  }
  if ((lineCount ?? 0) > 0) {
    return headerPreexisted
      ? { status: "duplicate", id: requestId }
      : { status: "accepted", id: requestId };
  }

  // Zero lines: the earlier attempt died between the two statements. The
  // stock-item guard must run again on THIS path — the lines being written now
  // are the payload's lines, and a crafted payload reaching recovery directly
  // must meet the same bar as one reaching the fresh path.
  const stockGuard = await checkStockItems(tenant, orgId, input);
  if (stockGuard) return stockGuard;

  const inserted = await insertLines(tenant, orgId, requestId, input);
  if (inserted) return inserted;
  return { status: "accepted", id: requestId };
}

/** Returns null when all lines landed; an outcome when the caller must stop. */
async function insertLines(
  tenant: unknown,
  orgId: string,
  requestId: string,
  input: MaterialRequestFormInput,
): Promise<OfflineWriteOutcome | null> {
  const { error } = await (
    (tenant as { from: (t: string) => unknown }).from(
      "material_request_lines",
    ) as InsertChain
  ).insert(
    input.lines.map((l, idx) => ({
      org_id: orgId,
      material_request_id: requestId,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      stock_item_id: l.stock_item_id ?? null,
      sort_order: idx,
    })),
  );
  if (!error) return null;
  if (error.code === OFFLINE_UNIQUE_VIOLATION) {
    // (material_request_id, sort_order) — a concurrent recovery won the race.
    // The lines exist; the ask is recorded ONCE. That is the index doing its
    // job, not a failure.
    return { status: "duplicate", id: requestId };
  }
  const permanent = error.code ? OFFLINE_PERMANENT_CODES[error.code] : undefined;
  if (permanent) {
    // Includes 23514 from the draft-only trigger: the user found the empty
    // draft and moved it on (cancelled/submitted) before recovery ran. The
    // queued item is RETAINED with its text, so nothing is silently lost —
    // and the request they interacted with stays exactly as they left it.
    return { status: "rejected", reason: permanent };
  }
  console.error("[offline-write] material request lines insert failed", error);
  return { status: "retry", reason: error.code ?? "lines_insert_failed" };
}

/** Returns null when every referenced catalogue item is in the active org. */
async function checkStockItems(
  tenant: unknown,
  orgId: string,
  input: MaterialRequestFormInput,
): Promise<OfflineWriteOutcome | null> {
  // THE APP-LAYER HALF OF THE DEFERRED-FK DEBT (20261066 note 2): stock_item_id
  // is a plain uuid with no database FK, so this check stands in for the
  // missing constraint — now for the queued replay as well as the form post.
  // Done inline rather than through isStockItemInOrg, whose boolean contract
  // folds "the read failed" into "not in this org" — acceptable for an
  // interactive form (the user just retries), but a queued item that gets a
  // permanent rejection is never retried, so here a failed READ must stay
  // transient and only a successful read of NOTHING may reject.
  for (const line of input.lines) {
    if (!line.stock_item_id) continue;
    const { data, error } = await (
      (tenant as { from: (t: string) => unknown }).from(
        "stock_items",
      ) as LinesProbeChain
    )
      .select("id")
      .eq("org_id", orgId) // ACTIVE-ORG PIN — the whole point of the check
      .eq("id", line.stock_item_id)
      .limit(1);
    if (error) {
      // The stock lane may legitimately not exist (the frozen cross-lane
      // contract) — then the field was never offered and any value present is
      // unverifiable either way; the movement seam treats this as "pending",
      // and a draft carrying an id nothing can resolve is harmless until the
      // lane lands. Anything else is a transient read failure.
      if (isStockModuleAbsent(error)) continue;
      return { status: "retry", reason: error.code ?? "stock_item_lookup_failed" };
    }
    if ((data ?? []).length === 0) {
      return { status: "rejected", reason: "stock_item_missing" };
    }
  }
  return null;
}
