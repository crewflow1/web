import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildAlertsSnapshot,
} from "@/server/services/hq-alerts-snapshot";
import {
  runAlertRules,
  ALERT_RULE_SEVERITY,
  ALERT_RULE_LABEL,
  type Alert,
} from "@/lib/hq/alert-rules";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnUrgentHqAlert } from "@/lib/notifications/events";

/**
 * Phase 3 — Alerts scheduler.
 *
 * Run from the nightly cron at /api/cron/alerts-poll.
 *
 * Flow:
 *   1. Build the live snapshot + run the deterministic rule engine.
 *      Reuses the existing HQ-5 pipeline — no duplication.
 *   2. For each fired alert, look up admin_alert_state by
 *      (rule_id, org_id).
 *      - No row → INSERT one with notified_at=now() and emit an HQ
 *        notification.
 *      - Existing row with notified_at IS NULL → UPDATE
 *        notified_at and emit.
 *      - Existing row with notified_at IS NOT NULL → SKIP (we've
 *        already told HQ about this).
 *      - Resolved or snoozed → SKIP (operator already handled it).
 *   3. Returns a per-run summary the cron can log.
 *
 * Service-role only.
 */

type AnyMutation = Promise<{
  data: unknown | null;
  error: { message: string } | null;
}>;

function adminTable(name: string) {
  const c = createAdminClient();
  return c.from(name as never) as unknown as {
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => AnyMutation;
        };
      };
    };
    upsert: (
      payload: unknown,
      opts?: { onConflict?: string },
    ) => AnyMutation;
  };
}

export type AlertsPollResult = {
  evaluated: number;
  newly_notified: number;
  skipped_already_notified: number;
  skipped_resolved: number;
  skipped_snoozed: number;
  errors: number;
  durationMs: number;
};

export async function runAlertsScheduler(): Promise<AlertsPollResult> {
  const startedAt = Date.now();
  const { snapshot, states } = await buildAlertsSnapshot();
  const alerts = runAlertRules(snapshot);

  let newlyNotified = 0;
  let skippedAlready = 0;
  let skippedResolved = 0;
  let skippedSnoozed = 0;
  let errors = 0;
  const nowMs = Date.now();

  for (const alert of alerts) {
    try {
      const state = states.get(alert.key);
      // Resolved → skip.
      if (state?.resolved_at) {
        skippedResolved++;
        continue;
      }
      // Currently snoozed → skip.
      if (
        state?.snoozed_until &&
        new Date(state.snoozed_until).getTime() > nowMs
      ) {
        skippedSnoozed++;
        continue;
      }
      // Already notified → skip.
      // (notified_at lives on the row itself; we need to fetch it
      // since the in-memory state map omits it. Cheap enough — one
      // query per fired alert per run.)
      const lookup = await adminTable("admin_alert_state")
        .select("notified_at")
        .eq("rule_id", alert.ruleId)
        .eq("org_id", alert.orgId)
        .maybeSingle();
      const existingNotifiedAt =
        (lookup.data as { notified_at?: string | null } | null)
          ?.notified_at ?? null;
      if (existingNotifiedAt) {
        skippedAlready++;
        continue;
      }

      // New: emit + UPSERT notified_at.
      await maybeEmitForAlert(alert);
      const upRes = await adminTable("admin_alert_state").upsert(
        {
          rule_id: alert.ruleId,
          org_id: alert.orgId,
          notified_at: new Date().toISOString(),
        },
        { onConflict: "rule_id,org_id" },
      );
      if (upRes.error) {
        console.error(
          "[alerts-scheduler] upsert state failed",
          alert.key,
          upRes.error.message,
        );
        errors++;
        continue;
      }
      newlyNotified++;
    } catch (e) {
      console.error(
        "[alerts-scheduler] alert processing failed",
        alert.key,
        e instanceof Error ? e.message : String(e),
      );
      errors++;
    }
  }

  return {
    evaluated: alerts.length,
    newly_notified: newlyNotified,
    skipped_already_notified: skippedAlready,
    skipped_resolved: skippedResolved,
    skipped_snoozed: skippedSnoozed,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Emit an HQ notification for a fired alert. Only critical alerts
 * fire a notification to keep email volume sane — warning / info
 * alerts surface on /admin/alerts but don't ping HQ.
 */
async function maybeEmitForAlert(alert: Alert): Promise<void> {
  if (ALERT_RULE_SEVERITY[alert.ruleId] !== "critical") return;
  await emitNotifications(
    notifyOnUrgentHqAlert({
      org_id: alert.orgId,
      org_name: alert.orgName,
      alert_label: ALERT_RULE_LABEL[alert.ruleId],
      detail: alert.reason.join(" · "),
      alert_url: `/admin/alerts`,
    }),
  );
}
