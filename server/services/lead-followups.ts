import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitNotifications } from "@/server/services/notifications-service";
import type { NotificationCreate } from "@/lib/notifications/types";

/**
 * Phase B — Smart lead follow-ups.
 *
 * Cron-driven (no automatic chasing — only reminders to the owner).
 *
 * Schedule per lead:
 *   - 72h after created_at + status='new' AND no last_activity_at
 *     past the 72h mark → fire `reminder_72h` (notification).
 *   - 7d after created_at + status='new' AND not yet acted →
 *     fire `reminder_7d` with HIGH priority.
 *
 * The owner can call/message/archive via existing lead actions; the
 * scheduler reads `lead_followup_state.acted_at` to stop firing.
 *
 * Idempotency: each stage stamps its own timestamp the first time it
 * fires; the cron's WHERE clause excludes already-fired rows.
 */

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type FollowupRunResult = {
  scanned: number;
  fired_72h: number;
  fired_7d: number;
  skipped_already_fired: number;
  skipped_acted: number;
  errors: number;
};

export async function runLeadFollowups(): Promise<FollowupRunResult> {
  const admin = createAdminClient();
  const now = Date.now();
  const cutoff72h = new Date(now - SEVENTY_TWO_HOURS_MS).toISOString();
  const cutoff7d = new Date(now - SEVEN_DAYS_MS).toISOString();

  const stats: FollowupRunResult = {
    scanned: 0,
    fired_72h: 0,
    fired_7d: 0,
    skipped_already_fired: 0,
    skipped_acted: 0,
    errors: 0,
  };

  // Candidates: any 'new' status lead older than 72h. The cron is
  // best-effort idempotent — we re-check state per row before firing.
  type LeadRow = {
    id: string;
    org_id: string;
    source: string;
    service: string | null;
    urgency: string | null;
    created_at: string;
    state: {
      reminder_72h_at: string | null;
      reminder_7d_at: string | null;
      acted_at: string | null;
    } | null;
  };
  const { data, error } = await admin
    .from("leads")
    .select(
      `
        id, org_id, source, service, urgency, created_at,
        state:lead_followup_state ( reminder_72h_at, reminder_7d_at, acted_at )
      `,
    )
    .eq("status", "new")
    .lte("created_at", cutoff72h)
    .limit(500);
  if (error) {
    console.error("[lead-followups] query failed", error);
    return { ...stats, errors: stats.errors + 1 };
  }
  const rows = (data ?? []) as unknown as LeadRow[];
  stats.scanned = rows.length;

  for (const lead of rows) {
    try {
      // If owner already acted on this lead, skip.
      if (lead.state?.acted_at) {
        stats.skipped_acted++;
        continue;
      }
      // Decide which stage to fire.
      const past7d = lead.created_at <= cutoff7d;
      const fired72h = !!lead.state?.reminder_72h_at;
      const fired7d = !!lead.state?.reminder_7d_at;

      if (past7d && !fired7d) {
        await ensureStateAndFire(admin, lead, "7d");
        stats.fired_7d++;
      } else if (!fired72h) {
        await ensureStateAndFire(admin, lead, "72h");
        stats.fired_72h++;
      } else {
        stats.skipped_already_fired++;
      }
    } catch (e) {
      console.error("[lead-followups] per-lead error", lead.id, e);
      stats.errors++;
    }
  }

  return stats;
}

async function ensureStateAndFire(
  admin: ReturnType<typeof createAdminClient>,
  lead: {
    id: string;
    org_id: string;
    source: string;
    service: string | null;
    urgency: string | null;
    created_at: string;
  },
  stage: "72h" | "7d",
): Promise<void> {
  const stampCol = stage === "72h" ? "reminder_72h_at" : "reminder_7d_at";

  // Upsert state row + stamp the stage.
  await (admin.from("lead_followup_state" as never) as unknown as {
    upsert: (row: unknown, opts?: { onConflict?: string }) => Promise<{
      error: { message: string } | null;
    }>;
  }).upsert(
    {
      lead_id: lead.id,
      org_id: lead.org_id,
      [stampCol]: new Date().toISOString(),
    },
    { onConflict: "lead_id" },
  );

  // Emit notification.
  const priority = stage === "7d" ? "high" : "medium";
  const note: NotificationCreate = {
    org_id: lead.org_id,
    user_id: null,
    audience: "customer",
    type: `lead.followup_${stage}`,
    category: "system",
    priority,
    title:
      stage === "7d"
        ? "Lead waiting 7+ days — high priority"
        : "Lead waiting 72h — time to follow up",
    body: `Source: ${lead.source}${lead.service ? ` · ${lead.service}` : ""}${lead.urgency ? ` · urgency: ${lead.urgency}` : ""}. Call / message / archive.`,
    action_url: `/leads/${lead.id}`,
    source_module: "lead_followup",
    source_id: lead.id,
    metadata: { stage },
  };
  await emitNotifications([note]).catch((e) =>
    console.error("[lead-followups] notify failed", e),
  );
}

/**
 * Owner-side acknowledgement. Marks the lead acted so no more
 * reminders fire. Called from existing /leads list actions.
 */
export async function markLeadActed(input: {
  lead_id: string;
  org_id: string;
  kind: "call" | "message" | "archive";
  acted_by_user_id: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  await (admin.from("lead_followup_state" as never) as unknown as {
    upsert: (row: unknown, opts?: { onConflict?: string }) => Promise<{
      error: { message: string } | null;
    }>;
  }).upsert(
    {
      lead_id: input.lead_id,
      org_id: input.org_id,
      acted_at: new Date().toISOString(),
      acted_kind: input.kind,
      acted_by: input.acted_by_user_id,
    },
    { onConflict: "lead_id" },
  );
}
