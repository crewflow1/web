import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeHealthScore,
  type SetupFeeStatus,
} from "@/lib/hq/customer-financials";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnHealthDropped } from "@/lib/notifications/events";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";

/**
 * CrewFlow HQ — Health-score cache rebuild engine (HQ-6).
 *
 * Replaces the live-compute pattern used in HQ-3 / HQ-5 snapshots
 * with a CACHED value on organizations.health_score + a paired
 * history table (health_score_events).
 *
 * Triggers covered:
 *   - 'cron'             nightly catch-all
 *   - 'invoice_change'   billing webhook future-hook
 *   - 'payment_change'   billing webhook future-hook
 *   - 'migration_change' import commit / rollback
 *   - 'login_change'     auth callback future-hook
 *   - 'manual'           operator-pressed "Recompute now"
 *   - 'backfill'         one-shot historical rebuild
 *
 * Strategy:
 *   1. Read one org row + its onboarding/migration percents +
 *      setup_fee_status (already on the org row).
 *   2. Run the existing computeHealthScore.
 *   3. Compare with the cached value. If different, UPDATE
 *      organizations + INSERT health_score_events.
 *   4. Best-effort write to admin_activity_log so the change is
 *      surfaced on the per-customer timeline.
 *
 * The engine is idempotent — running it twice for the same org
 * with no underlying signal change writes nothing the second time.
 *
 * Service-role only.
 */

export const HEALTH_TRIGGERS = [
  "cron",
  "invoice_change",
  "payment_change",
  "migration_change",
  "login_change",
  "manual",
  "backfill",
] as const;
export type HealthTrigger = (typeof HEALTH_TRIGGERS)[number];

export type HealthRecomputeResult = {
  org_id: string;
  org_name: string;
  trigger: HealthTrigger;
  old_score: number | null;
  new_score: number;
  delta: number;
  changed: boolean;
  reasons: ReadonlyArray<string>;
};

export type RecomputeSummary = {
  trigger: HealthTrigger;
  processed: number;
  changed: number;
  errors: number;
  durationMs: number;
};

type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  maybeSingle: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
  range: (from: number, to: number) => PromiseLike<{
    data: unknown[] | null;
    error: unknown;
  }>;
};

type AnyMutation = {
  eq: (k: string, v: unknown) => Promise<{
    error: { message: string } | null;
  }>;
};

function untypedAdminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
    update: (payload: unknown) => AnyMutation;
    insert: (payload: unknown) => Promise<{
      error: { message: string } | null;
    }>;
  };
}

// ---------------------------------------------------------------------
// Snapshot row used by computeHealthScore
// ---------------------------------------------------------------------

type OrgHealthRow = {
  id: string;
  name: string;
  status: string;
  setup_fee_status: string | null;
  last_login_at: string | null;
  onboarding_percent: number | null;
  migration_percent: number | null;
  health_score: number | null;
};

// ---------------------------------------------------------------------
// Recompute for a single org
// ---------------------------------------------------------------------

export async function recomputeHealthForOrg(
  orgId: string,
  trigger: HealthTrigger,
  actor?: { id: string; email: string } | null,
): Promise<HealthRecomputeResult | null> {
  const res = await untypedAdminTable("organizations")
    .select(
      "id, name, status, setup_fee_status, last_login_at, onboarding_percent, migration_percent, health_score",
    )
    .eq("id", orgId)
    .maybeSingle();

  if (!res.data) return null;
  const row = res.data as OrgHealthRow;
  return processRow(row, trigger, actor ?? null);
}

// ---------------------------------------------------------------------
// Recompute every org
// ---------------------------------------------------------------------

export async function recomputeAllOrgs(
  trigger: HealthTrigger,
  actor?: { id: string; email: string } | null,
): Promise<RecomputeSummary> {
  const startedAt = Date.now();
  // PAGED (F-1): recompute must touch EVERY org; a bare read is silently clamped
  // at max_rows=1000, so past 1000 orgs the tail never gets its health score
  // rebuilt. Stable total order (created_at, id).
  const res = await fetchAllRows<OrgHealthRow>(
    (from, to) =>
      untypedAdminTable("organizations")
        .select(
          "id, name, status, setup_fee_status, last_login_at, onboarding_percent, migration_percent, health_score",
        )
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<OrgHealthRow>>,
  );
  const rows = res.data;

  let changed = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const out = await processRow(row, trigger, actor ?? null);
      if (out?.changed) changed++;
    } catch (e) {
      errors++;
      console.error(
        "[hq-health-recompute] org failed",
        row.id,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return {
    trigger,
    processed: rows.length,
    changed,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------
// Core: process one row (write-only when changed)
// ---------------------------------------------------------------------

async function processRow(
  row: OrgHealthRow,
  trigger: HealthTrigger,
  actor: { id: string; email: string } | null,
): Promise<HealthRecomputeResult> {
  const result = computeHealthScore({
    status: row.status,
    setupFeeStatus: (row.setup_fee_status ?? "pending") as SetupFeeStatus,
    lastLoginAt: row.last_login_at,
    onboardingPercent: Number(row.onboarding_percent ?? 0),
    migrationPercent: Number(row.migration_percent ?? 0),
  });

  const oldScore = row.health_score;
  const newScore = result.score;
  const changed = oldScore !== newScore;
  const delta = oldScore === null ? newScore : newScore - oldScore;
  const now = new Date().toISOString();

  if (changed) {
    // 1. Update the cached column.
    const upd = await untypedAdminTable("organizations")
      .update({
        health_score: newScore,
        health_recomputed_at: now,
      })
      .eq("id", row.id);
    if (upd.error) {
      console.error(
        "[hq-health-recompute] update failed",
        row.id,
        upd.error.message,
      );
    }

    // 2. Append a history row.
    const evt = await untypedAdminTable("health_score_events").insert({
      org_id: row.id,
      trigger,
      old_score: oldScore,
      new_score: newScore,
      reasons: result.reasons,
      recomputed_at: now,
    });
    if (evt.error) {
      console.error(
        "[hq-health-recompute] insert event failed",
        row.id,
        evt.error.message,
      );
    }

    // 3. Audit trail — best-effort, never breaks the recompute.
    await recordAdminActivity({
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action: "health.recomputed",
      targetTable: "organizations",
      targetId: row.id,
      metadata: {
        trigger,
        old_score: oldScore,
        new_score: newScore,
        delta,
        reasons: result.reasons,
      },
    });

    // 4. HQ notification when health drops. Only fire when there's
    //    an old score to compare against (skip first-ever score).
    if (oldScore !== null && newScore < oldScore) {
      await emitNotifications(
        notifyOnHealthDropped({
          org_id: row.id,
          org_name: row.name,
          old_score: oldScore,
          new_score: newScore,
        }),
      );
    }
  }

  return {
    org_id: row.id,
    org_name: row.name,
    trigger,
    old_score: oldScore,
    new_score: newScore,
    delta,
    changed,
    reasons: result.reasons,
  };
}

// ---------------------------------------------------------------------
// Recent events (analytics page surface)
// ---------------------------------------------------------------------

export type HealthEventRow = {
  id: string;
  org_id: string;
  trigger: HealthTrigger;
  old_score: number | null;
  new_score: number;
  delta: number | null;
  reasons: ReadonlyArray<string>;
  recomputed_at: string;
};

export async function listRecentHealthEvents(
  limit = 25,
): Promise<HealthEventRow[]> {
  const res = await untypedAdminTable("health_score_events")
    .select("id, org_id, trigger, old_score, new_score, delta, reasons, recomputed_at")
    .order("recomputed_at", { ascending: false });
  const rows = (res.data ?? []) as unknown as HealthEventRow[];
  return rows.slice(0, limit);
}
