import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import type { OrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { gatherReportSources } from "@/server/services/site-report-sources";
import { defaultSelection } from "@/lib/site-reports/aggregate";
import type { CreateSiteReportInput, ReportContent } from "@/lib/site-reports/schema";
import {
  OFFLINE_PERMANENT_CODES,
  OFFLINE_UNIQUE_VIOLATION,
  type OfflineWriteOutcome,
} from "@/server/services/offline-writes";

/**
 * SITE REPORT — the shared write core (train "offl"). ONE write path for the
 * DRAFT create, used by BOTH:
 *   - app/(app)/site-reports/actions.ts → createSiteReport (online form post), and
 *   - server/services/offline-writes.ts → dispatchOfflineWrite (queued replay).
 *
 * Same contract as material-request-writes.ts: tenant (user-JWT) client, RLS,
 * active-org pin, the SHARED permanent-error allowlist, no service role, no
 * SECURITY DEFINER, no RPC. It lives in its own module because its write
 * legitimately includes two pre-existing read-only helpers the online action has
 * always used under the caller's JWT — `gatherReportSources` (aggregates the
 * period's diary/snag/toolbox rows to seed the draft) and `nextReportNumber` (a
 * per-org COSMETIC label) — while offline-writes.ts keeps its "no remote-procedure
 * surface" property. Neither helper is an RPC; both run under RLS.
 *
 * ── DRAFT ONLY, by design ────────────────────────────────────────────────────
 * This core writes status 'draft', revision 1, and nothing else. The lifecycle
 * (ready_for_review → approved → issued) is a chain of transitions with
 * server-pinned provenance (issued_at) and a customer-visible snapshot frozen at
 * issue; the ONLINE action layers those on AFTER this core, and the offline path
 * stops at the draft — stated in the form wording. The report NUMBER is allocated
 * HERE, at write time, never offline: it is a cosmetic per-org label
 * (nextReportNumber), so a sync-time collision just yields a duplicate label,
 * never a data-integrity fault — but minting it offline would still be dishonest
 * about when the document entered the sequence.
 *
 * ── Key-first, to avoid re-gathering on a replay ─────────────────────────────
 * Unlike the single-statement diary/snag cores, this one does a moderately
 * expensive source read before it writes, so — like the material-request core —
 * it looks the idempotency key up FIRST: a replay of an already-written draft
 * returns the existing id without re-reading sources or minting a number.
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
        maybeSingle: () => Promise<{
          data: { id: string; customer_id?: string | null } | null;
          error: PgError;
        }>;
      };
    };
  };
};
type CountChain = {
  select: (
    c: string,
    o: { count: "exact"; head: true },
  ) => { eq: (k: string, v: unknown) => Promise<{ count: number | null }> };
};

async function nextReportNumber(tenant: unknown, orgId: string): Promise<string> {
  // Per-org cosmetic label, identical to the online action's helper. A race just
  // yields a duplicate label (there is no unique constraint on report_number),
  // never a data-integrity problem — so no number-race disambiguation is needed.
  const { count } = await (
    (tenant as { from: (t: string) => unknown }).from("site_reports") as CountChain
  )
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  return `SR-${String((count ?? 0) + 1).padStart(4, "0")}`;
}

export async function createSiteReportDraftRecord(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  input: CreateSiteReportInput;
  /** Omit on the online path — one is minted so every row carries a key. */
  clientKey?: string;
  /** Device-clock authoring time; set only for a queued (offline-authored) write. */
  offlineAuthoredAt?: string | null;
}): Promise<OfflineWriteOutcome> {
  const orgId = args.ctx.org.id;
  const clientKey = args.clientKey ?? randomUUID();
  const tenant = await createClient();

  // ── 1. KEY-FIRST LOOKUP (org-pinned — a dual-org member can never be handed
  // the other company's row id). A hit means a prior attempt already wrote the
  // draft; this is a plain idempotent no-op.
  const { data: prior, error: priorErr } = await (
    tenant.from("site_reports" as never) as unknown as LookupChain
  )
    .select("id")
    .eq("org_id", orgId)
    .eq("client_write_key", clientKey)
    .maybeSingle();
  if (priorErr) {
    // A failed READ is not evidence of anything — retry, never reject.
    return { status: "retry", reason: priorErr.code ?? "key_lookup_failed" };
  }
  if (prior?.id) return { status: "duplicate", id: prior.id };

  // ── 2. CROSS-ORG JOB GUARD (org-pinned) + resolve the job's customer for
  // portal scoping, exactly as the online action does. A queued item authored
  // before an org switch, or a job deleted since, becomes a clean job_missing.
  const { data: job, error: jobErr } = await (
    tenant.from("jobs" as never) as unknown as LookupChain
  )
    .select("id, customer_id")
    .eq("id", args.input.job_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (jobErr) return { status: "retry", reason: jobErr.code ?? "job_lookup_failed" };
  if (!job) return { status: "rejected", reason: "job_missing" };

  // ── 3. Seed the draft: aggregate the period's sources and propose them all.
  // gatherReportSources reads under the caller's JWT (RLS-scoped); at replay
  // time it runs online exactly as it does for the form post.
  const sources = await gatherReportSources(
    args.input.job_id,
    args.input.period_start,
    args.input.period_end,
  );
  const content: ReportContent = { sources: defaultSelection(sources) };
  const reportNumber = await nextReportNumber(tenant, orgId);

  // ── 4. Insert the draft header.
  const id = randomUUID();
  const { error } = await (
    tenant.from("site_reports" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: orgId,
    job_id: args.input.job_id,
    customer_id: job.customer_id ?? null,
    report_number: reportNumber,
    title: args.input.title,
    period_start: args.input.period_start,
    period_end: args.input.period_end,
    status: "draft", // born draft — the lifecycle STARTS when the row lands
    revision: 1,
    content,
    prepared_by: args.user.id,
    client_write_key: clientKey,
    offline_authored_at: args.offlineAuthoredAt ?? null,
  });

  if (error) {
    // THE IDEMPOTENCY BRANCH — the only 23505 possible here is the
    // (org_id, client_write_key) index (report_number has no unique constraint),
    // so a concurrent replay of the SAME item is disambiguated by re-reading the
    // key, mirrored from the diary/snag/MR branch including the classified error.
    if (error.code === OFFLINE_UNIQUE_VIOLATION) {
      const { data: winner, error: winnerErr } = await (
        tenant.from("site_reports" as never) as unknown as LookupChain
      )
        .select("id")
        .eq("org_id", orgId)
        .eq("client_write_key", clientKey)
        .maybeSingle();
      if (winnerErr) {
        return { status: "retry", reason: winnerErr.code ?? "duplicate_lookup_failed" };
      }
      if (winner?.id) return { status: "duplicate", id: winner.id };
      return { status: "rejected", reason: "not_permitted" };
    }
    const permanent = error.code ? OFFLINE_PERMANENT_CODES[error.code] : undefined;
    if (permanent) return { status: "rejected", reason: permanent };
    console.error("[offline-write] site report insert failed", error);
    return { status: "retry", reason: error.code ?? "insert_failed" };
  }

  await recordAdminActivity({
    actorId: args.user.id,
    actorEmail: args.user.email ?? null,
    action: "site_report.created",
    targetTable: "site_reports",
    targetId: id,
    metadata: {
      job_id: args.input.job_id,
      period_start: args.input.period_start,
      period_end: args.input.period_end,
      // Provenance in the audit trail: was this authored with no signal?
      offline: Boolean(args.offlineAuthoredAt),
    },
  });

  return { status: "accepted", id };
}
