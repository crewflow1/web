import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { computeNextRun, isValidCron } from "@/lib/automation/cron";
import { AUTOMATION_RULES } from "@/lib/automation/rules";
import { isKnownRuleKey } from "@/server/services/automation-rules";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import type { AutomationRule } from "@/lib/automation/events";

/**
 * Automation OS — time-triggered schedules (table automation_schedules, 20261096).
 *
 * A schedule is a cron expression bound to a catalogue rule. The drain cron
 * (/api/cron/automation-schedules-drain) fires every due occurrence, ORG-SCOPED,
 * through the SAME dispatcher every event uses — so a scheduled fire inherits
 * the engine's atomic claim, lease, per-action isolation and idempotency for
 * free. This service owns the schedule rows and the drain.
 *
 * ── CROSS-TENANT SAFETY (the #456 leak class) ────────────────────────────────
 * Every dispatch a drain performs carries the SCHEDULE'S OWN org_id as the
 * event's org context. The dispatcher pins its override lookup and every wired
 * action to `event.org_id`, so a schedule in org A can only ever act inside org
 * A. The drain reads across all orgs (service-role), but each schedule's work is
 * confined to its own tenant by construction.
 *
 * ── IDEMPOTENCY UNDER CONCURRENT DRAINS (two layers) ─────────────────────────
 *  1. THE SCHEDULE CLAIM. Advancing `next_run_at` is a CONDITIONAL update keyed
 *     on the exact value the drain observed: `... where id = ? and next_run_at =
 *     <observed>`. Two overlapping drains observe the same `next_run_at`; both
 *     attempt the update; Postgres serialises on the row; the first moves
 *     `next_run_at` forward, the second's predicate no longer matches and
 *     updates 0 rows — so only ONE drain dispatches this occurrence.
 *  2. THE DISPATCH CLAIM. Each fire carries a correlation id that encodes the
 *     occurrence instant (`<schedule_id>:<occurrence_iso>`), so even if two
 *     dispatches for the same occurrence were ever attempted, the dispatcher's
 *     atomic (rule_id, correlation_id) claim admits exactly one execution.
 *
 * ── NO CATCH-UP STORM ────────────────────────────────────────────────────────
 * A schedule overdue by many periods fires ONCE per drain and advances to the
 * next occurrence strictly after `now` — it does not replay every missed
 * period. This is deliberate: automations are notifications/side-effects, not a
 * ledger that must be reconstructed.
 *
 * automation_schedules is not in the generated Supabase types yet → the
 * loose-client cast idiom (job-budget / expense-budget). TypeScript-only.
 */

type Row = Record<string, unknown>;

export type AutomationScheduleRow = {
  id: string;
  org_id: string;
  rule_key: string;
  cron_expr: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type SelectBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => SelectBuilder;
  eq: (k: string, v: unknown) => SelectBuilder;
  lte: (k: string, v: unknown) => SelectBuilder;
  order: (k: string, o: { ascending: boolean }) => SelectBuilder;
  limit: (n: number) => SelectBuilder;
};
export type AutomationScheduleClient = { from: (t: string) => SelectBuilder };

const COLS =
  "id, org_id, rule_key, cron_expr, enabled, next_run_at, last_run_at, created_at, updated_at";

function ruleFor(key: string): AutomationRule | null {
  return AUTOMATION_RULES.find((r) => r.id === key) ?? null;
}

/**
 * A DETERMINISTIC uuid identifying one fired occurrence of a schedule.
 *
 * The dispatch's source_id must (a) be distinct per occurrence — so each period
 * is its own idempotent run rather than the schedule firing once ever — and (b)
 * be a valid UUID, because several actions pass source_id straight into
 * `activity_log.target_id`, which is `uuid not null` (create_alert /
 * add_internal_note / create_milestone). A composite `id:occurrence` string
 * satisfies (a) but not (b).
 *
 * SHA-1 over `${scheduleId}:${occurrenceIso}` (the UUIDv5 construction) gives a
 * stable 16-byte digest we format as a UUID: same occurrence → same id on every
 * machine, so concurrent drains that ever reached dispatch would collide on the
 * engine's (rule_id, correlation_id) claim and produce exactly one execution.
 */
export function occurrenceId(scheduleId: string, occurrenceIso: string): string {
  const bytes = createHash("sha1")
    .update(`${scheduleId}:${occurrenceIso}`)
    .digest();
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Every schedule for an org — for Settings → Automations. LOUD, org-pinned. */
export async function listSchedulesForOrg(
  client: AutomationScheduleClient,
  orgId: string,
): Promise<AutomationScheduleRow[]> {
  const res = await client
    .from("automation_schedules")
    .select(COLS)
    .eq("org_id", orgId)
    .order("next_run_at", { ascending: true })
    .limit(200);
  if (res.error) throw readFailure("automation schedules: list", res.error);
  return (res.data ?? []) as unknown as AutomationScheduleRow[];
}

/**
 * Create a schedule. Validates the rule_key against the catalogue and the cron
 * expression via the pure parser, then computes the first `next_run_at`
 * deterministically. Org-pinned. Called from an admin-gated action; the
 * automation_schedules admin-write RLS policy is the real DB boundary.
 */
export async function createSchedule(
  client: AutomationScheduleClient,
  orgId: string,
  ruleKey: string,
  cronExpr: string,
  userId: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (!isKnownRuleKey(ruleKey)) {
    throw new Error(`unknown automation rule_key: ${ruleKey}`);
  }
  if (!isValidCron(cronExpr)) {
    throw new Error(`invalid cron expression: ${cronExpr}`);
  }
  const nextRunAt = computeNextRun(cronExpr, now).toISOString();
  const insert = (
    client.from("automation_schedules") as unknown as {
      insert: (row: unknown) => PromiseLike<{ error: { message: string } | null }>;
    }
  ).insert({
    org_id: orgId,
    rule_key: ruleKey,
    cron_expr: cronExpr,
    enabled: true,
    next_run_at: nextRunAt,
    created_by: userId,
  });
  const { error } = await insert;
  if (error) throw new Error(`schedule create failed: ${error.message}`);
}

/** Enable/disable a schedule. Org-pinned; RLS admin-write is the real boundary. */
export async function setScheduleEnabled(
  client: AutomationScheduleClient,
  orgId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  const upd = (
    client.from("automation_schedules") as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    }
  )
    .update({ enabled })
    .eq("id", scheduleId)
    .eq("org_id", orgId);
  const { error } = await upd;
  if (error) throw new Error(`schedule toggle failed: ${error.message}`);
}

/** Delete a schedule. Org-pinned; RLS admin-write is the real boundary. */
export async function deleteSchedule(
  client: AutomationScheduleClient,
  orgId: string,
  scheduleId: string,
): Promise<void> {
  const del = (
    client.from("automation_schedules") as unknown as {
      delete: () => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    }
  )
    .delete()
    .eq("id", scheduleId)
    .eq("org_id", orgId);
  const { error } = await del;
  if (error) throw new Error(`schedule delete failed: ${error.message}`);
}

export type DrainOutcome = {
  scanned: number;
  fired: number;
  skipped: number;
  results: ReadonlyArray<{
    schedule_id: string;
    org_id: string;
    rule_key: string;
    status: "fired" | "claim_lost" | "no_rule" | "advance_failed" | "cron_error";
  }>;
};

/**
 * Drain every due schedule ONCE. Service-role (reads across all orgs), but each
 * schedule's dispatch is pinned to its own org. Safe to run concurrently: the
 * per-schedule optimistic claim guarantees each occurrence dispatches at most
 * once. Bounded by `limit`.
 */
export async function drainDueSchedules(
  now: Date = new Date(),
  limit = 100,
): Promise<DrainOutcome> {
  const admin = createAdminClient();
  const nowIso = now.toISOString();

  // Due = enabled AND next_run_at <= now. Read across all orgs; each fire is
  // org-scoped below.
  const due = await (
    admin.from("automation_schedules" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          lte: (k: string, v: unknown) => {
            order: (k: string, o: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: Row[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    }
  )
    .select(COLS)
    .eq("enabled", true)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (due.error) {
    console.error("[automation-schedules] due scan failed", due.error.message);
    return { scanned: 0, fired: 0, skipped: 0, results: [] };
  }

  const rows = (due.data ?? []) as unknown as AutomationScheduleRow[];
  const results: Array<DrainOutcome["results"][number]> = [];
  let fired = 0;
  let skipped = 0;

  for (const row of rows) {
    const rule = ruleFor(row.rule_key);
    if (!rule) {
      // A schedule bound to a rule the catalogue no longer defines. Leave it
      // untouched (an operator can delete it); never dispatch an unknown rule.
      skipped++;
      results.push({
        schedule_id: row.id,
        org_id: row.org_id,
        rule_key: row.rule_key,
        status: "no_rule",
      });
      continue;
    }

    // Compute the next occurrence BEFORE claiming, so a cron that has become
    // invalid fails loudly here rather than after a partial write.
    let nextRunAt: string;
    try {
      nextRunAt = computeNextRun(row.cron_expr, now).toISOString();
    } catch (e) {
      console.error("[automation-schedules] cron compute failed", {
        schedule_id: row.id,
        cron_expr: row.cron_expr,
        error: e instanceof Error ? e.message : String(e),
      });
      skipped++;
      results.push({
        schedule_id: row.id,
        org_id: row.org_id,
        rule_key: row.rule_key,
        status: "cron_error",
      });
      continue;
    }

    // THE SCHEDULE CLAIM. Advance next_run_at ONLY if it still equals the value
    // we observed — the optimistic lock that makes concurrent drains safe. The
    // winner (rows updated > 0) owns this occurrence.
    const claim = await (
      admin.from("automation_schedules" as never) as unknown as {
        update: (row: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              select: (c: string) => Promise<{
                data: Array<{ id: string }> | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      }
    )
      .update({ next_run_at: nextRunAt, last_run_at: nowIso })
      .eq("id", row.id)
      .eq("next_run_at", row.next_run_at)
      .select("id");

    if (claim.error) {
      console.error("[automation-schedules] claim failed", {
        schedule_id: row.id,
        error: claim.error.message,
      });
      skipped++;
      results.push({
        schedule_id: row.id,
        org_id: row.org_id,
        rule_key: row.rule_key,
        status: "advance_failed",
      });
      continue;
    }
    if ((claim.data?.length ?? 0) === 0) {
      // Another drain advanced it first — this occurrence is theirs.
      skipped++;
      results.push({
        schedule_id: row.id,
        org_id: row.org_id,
        rule_key: row.rule_key,
        status: "claim_lost",
      });
      continue;
    }

    // We own the occurrence. Dispatch org-scoped, with a correlation id that
    // encodes the fired occurrence so each period is a distinct, idempotent run.
    await dispatchAutomation({
      type: rule.trigger,
      org_id: row.org_id,
      source_table: "automation_schedules",
      // A deterministic per-occurrence uuid: distinct per period (so each fire is
      // its own idempotent run) AND a valid uuid (some actions write it to
      // activity_log.target_id, which is uuid not null).
      source_id: occurrenceId(row.id, row.next_run_at),
      payload: {
        scheduled: true,
        schedule_id: row.id,
        rule_key: row.rule_key,
        cron_expr: row.cron_expr,
        occurrence: row.next_run_at,
      },
    }).catch((e) => {
      // dispatchAutomation never throws, but guard anyway — a dispatch failure
      // must not abort the rest of the drain. next_run_at is already advanced,
      // so the schedule keeps ticking rather than wedging on one bad fire.
      console.error("[automation-schedules] dispatch failed", {
        schedule_id: row.id,
        error: e instanceof Error ? e.message : String(e),
      });
    });

    fired++;
    results.push({
      schedule_id: row.id,
      org_id: row.org_id,
      rule_key: row.rule_key,
      status: "fired",
    });
  }

  return { scanned: rows.length, fired, skipped, results };
}

/** Human-readable label for a schedule's rule (for the UI). */
export function scheduleRuleLabel(ruleKey: string): string {
  return ruleFor(ruleKey)?.label ?? ruleKey;
}

/**
 * Every catalogue rule is schedulable — a schedule fires the rule's actions on a
 * clock instead of on its domain event.
 */
export function schedulableRules(): ReadonlyArray<AutomationRule> {
  return AUTOMATION_RULES;
}
