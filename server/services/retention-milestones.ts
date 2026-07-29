import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitNotifications } from "@/server/services/notifications-service";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  milestoneById,
  reachedMilestones,
  type MilestoneId,
  type RetentionSignals,
} from "@/lib/retention/signals";
import type { NotificationCreate } from "@/lib/notifications/types";

/**
 * Phase 2 — milestone notification + audit emitter.
 *
 * When the customer crosses a milestone for the first time:
 *   1. Insert a customer-audience notification (rendered on the
 *      tenant /notifications page + the in-app bell)
 *   2. Record an admin_activity_log row so HQ can see "Acme Roofing
 *      crossed 10 customers on 2026-05-25"
 *   3. Add the milestone id to onboarding_state.notified_milestones[]
 *      so the side effect runs ONCE per milestone per org
 *
 * Note: the existing `celebrated_milestones` set tracks "user clicked
 * Got it on the dashboard banner". This new `notified_milestones`
 * set tracks "we've already fired the side effects". Two sets so
 * the banner re-renders until the user dismisses, but the
 * notification + audit only fire once.
 *
 * Idempotent. Best-effort — errors are logged + swallowed; the
 * dashboard never crashes because of a milestone side-effect failure.
 *
 * The caller (dashboard server-render) passes the RetentionSignals
 * blob; we read & write organizations.onboarding_state directly.
 */

const NOTIFIED_KEY = "notified_milestones" as const;

export async function ensureMilestoneNotifications(
  orgId: string,
  signals: RetentionSignals,
  actor: { id: string | null; email: string | null },
): Promise<{ emitted: ReadonlyArray<MilestoneId> }> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("organizations")
      .select("onboarding_state")
      .eq("id", orgId)
      .maybeSingle();
    if (error) {
      // A failed read must NOT proceed with an empty previouslyNotified set —
      // that would re-fire every already-notified milestone. Log and emit
      // nothing this render; the next successful read resumes normally.
      console.error("[retention-milestones] onboarding_state read failed", {
        org_id: orgId,
        err: error.message,
      });
      return { emitted: [] };
    }
    const state =
      ((data?.onboarding_state ?? {}) as Record<string, unknown>) ?? {};
    const previouslyNotified = new Set<MilestoneId>(
      Array.isArray(state[NOTIFIED_KEY])
        ? (state[NOTIFIED_KEY] as MilestoneId[])
        : [],
    );

    const reached = reachedMilestones(signals);
    const toEmit = reached.filter((id) => !previouslyNotified.has(id));
    if (toEmit.length === 0) {
      return { emitted: [] };
    }

    // Build the notification batch + the audit-log batch.
    const notifications: NotificationCreate[] = toEmit.map((id) => {
      const m = milestoneById(id);
      return {
        org_id: orgId,
        user_id: null,
        audience: "customer",
        type: `milestone.${id}`,
        category: "system",
        priority: "low",
        title: `${m.emoji} ${m.title}`,
        body: m.body,
        action_url: "/dashboard",
        source_module: "retention",
        source_id: id,
        metadata: { milestone_id: id },
      };
    });

    // Fire-and-forget — emitNotifications is itself try/catch
    // wrapped so even if the queue write fails the dashboard render
    // continues. Awaited only so failures show in our local catch.
    await emitNotifications(notifications).catch((e: unknown) => {
      console.error("[retention-milestones] emit failed", {
        org_id: orgId,
        err: e instanceof Error ? e.message : String(e),
      });
    });

    // Audit log per milestone (cheap, useful for HQ "first 10
    // customers crossed on X date" queries).
    for (const id of toEmit) {
      await recordAdminActivity({
        actorId: actor.id,
        actorEmail: actor.email,
        action: `milestone.${id}`,
        targetTable: "organizations",
        targetId: orgId,
        metadata: { milestone_id: id, source: "retention.dashboard" },
      });
    }

    // Persist the notified set so the side effects don't repeat.
    const nextNotified = [...previouslyNotified, ...toEmit];
    const admin = createAdminClient();
    const nextState = { ...state, [NOTIFIED_KEY]: nextNotified };
    await admin
      .from("organizations")
      .update({ onboarding_state: nextState as never })
      .eq("id", orgId);

    return { emitted: toEmit };
  } catch (e) {
    console.error("[retention-milestones] ensure failed", {
      org_id: orgId,
      err: e instanceof Error ? e.message : String(e),
    });
    return { emitted: [] };
  }
}
