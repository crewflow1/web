import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  RETENTION_PURGEABLE_TABLES,
  assertRetentionSetsDisjoint,
  isExcluded,
  isPurgeable,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from "@/lib/retention/policy";

/**
 * DATA-RETENTION PURGE SERVICE — the orchestrator behind the retention cron and
 * the admin "preview" action.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES
 * ─────────────────────────────────────────────────────────────────────────────
 * The DB primitive `retention_purge_run` does the actual work for ONE org + ONE
 * table (tenant-pinned, allowlist-gated, dry-run or purge). This service:
 *   • `runRetentionPurge()` — the CRON entrypoint. Reads every ENABLED policy
 *     across all orgs and calls the primitive once per (org, table). Each call
 *     is independently tenant-scoped, so one org's purge can never reach
 *     another's rows.
 *   • `previewPolicy()` — a single dry-run for one org+table (the settings
 *     "Preview" button), returning the "what WOULD be purged" count.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DARK BY DEFAULT — FEATURE_RETENTION_PURGE (server-only env, default OFF).
 * ─────────────────────────────────────────────────────────────────────────────
 * While the flag is off — the default everywhere — the cron runs every enabled
 * policy in DRY-RUN: it records what WOULD be purged (audit rows with mode
 * 'dry_run') and deletes NOTHING. Turning the flag on makes the same enabled
 * policies purge for real. Activation is therefore a single config flip, and the
 * mechanism is fully observable while dark. `previewPolicy` is always a dry-run
 * regardless of the flag (it can never delete).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SERVICE-ROLE CLIENT
 * ─────────────────────────────────────────────────────────────────────────────
 * The primitive is service_role-only (a purge must be unreachable with the anon
 * key), and the cron acts across every tenant. The AUTHZ boundary for a manual
 * preview is the SERVER ACTION (admin + org from the session); the cron's
 * boundary is the Bearer secret on the route. RLS is not the boundary here.
 */

/** Server-only purge feature flag. DEFAULTS OFF → cron runs dry-run only. */
export function retentionPurgeEnabled(): boolean {
  return process.env.FEATURE_RETENTION_PURGE === "true";
}

export type RetentionRunSummary = {
  /** false when the destructive flag is off (every call was a dry-run). */
  purgeEnabled: boolean;
  policiesConsidered: number;
  orgsAffected: number;
  rowsMatched: number;
  rowsDeleted: number;
  errors: number;
};

export type PurgeActionResult = {
  orgId: string;
  targetTable: string;
  mode: "dry_run" | "purge";
  retentionDays: number;
  cutoff: string | null;
  rowsMatched: number;
  rowsDeleted: number;
  status: string;
};

type EnabledPolicyRow = {
  id: string;
  org_id: string;
  table_name: string;
  retention_days: number;
};

/** Loose RPC shape — types.ts predates this function (same idiom as gdpr-erase). */
type LooseRpc = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

function toActionResult(data: unknown): PurgeActionResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const mode = d.mode === "purge" ? "purge" : "dry_run";
  return {
    orgId: String(d.org_id ?? ""),
    targetTable: String(d.target_table ?? ""),
    mode,
    retentionDays: Number(d.retention_days ?? 0),
    cutoff: typeof d.cutoff === "string" ? d.cutoff : null,
    rowsMatched: Number(d.rows_matched ?? 0),
    rowsDeleted: Number(d.rows_deleted ?? 0),
    status: String(d.status ?? ""),
  };
}

/**
 * Run one policy through the primitive. Tenant isolation is the primitive's job
 * (it pins org_id); this only forwards the org+table+window it was handed.
 */
async function runOnePolicy(
  admin: LooseRpc,
  policy: EnabledPolicyRow,
  dryRun: boolean,
): Promise<PurgeActionResult> {
  // Belt-and-braces: never send an excluded / non-allowlisted table to the
  // primitive. The primitive refuses it anyway, but we fail fast and loud.
  if (!isPurgeable(policy.table_name) || isExcluded(policy.table_name)) {
    throw new Error(
      `retention purge: refusing non-purgeable target "${policy.table_name}"`,
    );
  }
  const { data, error } = await admin.rpc("retention_purge_run", {
    p_org_id: policy.org_id,
    p_target_table: policy.table_name,
    p_retention_days: policy.retention_days,
    p_dry_run: dryRun,
    p_policy_id: policy.id,
    p_requested_by: null,
  });
  if (error) {
    throw new Error(`retention purge ${policy.table_name}: ${error.message}`);
  }
  const result = toActionResult(data);
  if (!result) {
    throw new Error(`retention purge ${policy.table_name}: empty result`);
  }
  return result;
}

/**
 * CRON entrypoint. Iterate every ENABLED policy across all orgs and run each.
 * When the destructive flag is off, every run is a dry-run (deletes nothing,
 * still audited). One failing policy is recorded and does not abort the rest.
 */
export async function runRetentionPurge(): Promise<RetentionRunSummary> {
  // Fail-closed invariant check before any destructive work: the two safety
  // layers must be disjoint. This can only throw on a coding error.
  assertRetentionSetsDisjoint();

  const purgeEnabled = retentionPurgeEnabled();
  const dryRun = !purgeEnabled;
  const admin = createAdminClient();

  // Read EVERY enabled policy across ALL orgs. This is a cross-tenant completeness
  // read: a bare .select() would SILENTLY TRUNCATE at the PostgREST cap once the
  // fleet crosses ~1000 enabled policies, so some orgs' policies would never run.
  // Page it in full (F-1) with a stable id order. types.ts predates migration
  // 20261184000000 — reach the new table via a loose cast (gdpr-erase idiom).
  const { data: policyData, error } = await fetchAllRows<EnabledPolicyRow>(
    (from, to) =>
      (
        admin.from("retention_policies" as never) as unknown as {
          select: (cols: string) => {
            eq: (
              k: string,
              v: unknown,
            ) => {
              order: (
                col: string,
                opts: { ascending: boolean },
              ) => {
                range: (f: number, t: number) => PromiseLike<PageResult<EnabledPolicyRow>>;
              };
            };
          };
        }
      )
        .select("id, org_id, table_name, retention_days")
        .eq("enabled", true)
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`retention purge: reading policies: ${message}`);
  }
  const policies = policyData;

  const summary: RetentionRunSummary = {
    purgeEnabled,
    policiesConsidered: policies.length,
    orgsAffected: 0,
    rowsMatched: 0,
    rowsDeleted: 0,
    errors: 0,
  };
  const orgs = new Set<string>();

  for (const policy of policies) {
    try {
      const result = await runOnePolicy(admin as unknown as LooseRpc, policy, dryRun);
      summary.rowsMatched += result.rowsMatched;
      summary.rowsDeleted += result.rowsDeleted;
      if (result.rowsMatched > 0 || result.rowsDeleted > 0) orgs.add(policy.org_id);
    } catch (e) {
      summary.errors += 1;
      console.error("[cron/retention-purge] policy failed", {
        org_id: policy.org_id,
        target_table: policy.table_name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  summary.orgsAffected = orgs.size;
  return summary;
}

/**
 * Dry-run PREVIEW for one org + table (the settings "Preview" button). ALWAYS a
 * dry-run — it can never delete. Caller (the server action) is responsible for
 * the admin + org-from-session gate; org_id is never taken from client input.
 */
export async function previewPolicy(params: {
  orgId: string;
  targetTable: string;
  retentionDays: number;
  policyId?: string | null;
  requestedBy?: string | null;
}): Promise<PurgeActionResult> {
  const { orgId, targetTable, retentionDays } = params;
  if (!isPurgeable(targetTable) || isExcluded(targetTable)) {
    throw new Error(`retention preview: "${targetTable}" is not purgeable`);
  }
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < MIN_RETENTION_DAYS ||
    retentionDays > MAX_RETENTION_DAYS
  ) {
    throw new Error("retention preview: window out of bounds");
  }
  const admin = createAdminClient() as unknown as LooseRpc;
  const { data, error } = await admin.rpc("retention_purge_run", {
    p_org_id: orgId,
    p_target_table: targetTable,
    p_retention_days: retentionDays,
    p_dry_run: true,
    p_policy_id: params.policyId ?? null,
    p_requested_by: params.requestedBy ?? null,
  });
  if (error) {
    throw new Error(`retention preview ${targetTable}: ${error.message}`);
  }
  const result = toActionResult(data);
  if (!result) throw new Error(`retention preview ${targetTable}: empty result`);
  return result;
}

/** The tables an org may configure — re-exported for the settings page. */
export const RETENTION_CONFIGURABLE_TABLES = RETENTION_PURGEABLE_TABLES;
