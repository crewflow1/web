import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitNotifications } from "@/server/services/notifications-service";
import type { NotificationCreate } from "@/lib/notifications/types";

/**
 * Phase E — Compliance document expiry reminders.
 *
 * Compliance docs (insurance, certificates, permits, contracts) have
 * explicit `expires_at` dates. The cron runs daily and fires three
 * reminder stages:
 *
 *   - 30 days before expiry: medium-priority notification
 *   - 7 days before expiry:  high-priority notification
 *   - On expiry day:         urgent notification
 *
 * Each stage stamps its own timestamp (`reminded_30d_at`,
 * `reminded_7d_at`, `reminded_today_at`) so the cron never spams.
 *
 * Non-compliance attachments (universal `tenant_attachments`) DO NOT
 * carry expiry. The directive is explicit: reminders are for
 * compliance docs only.
 */

export type ComplianceRunResult = {
  scanned: number;
  fired_30d: number;
  fired_7d: number;
  fired_today: number;
  errors: number;
};

const DAY_MS = 86_400_000;

export async function runComplianceExpiry(): Promise<ComplianceRunResult> {
  const admin = createAdminClient();
  const todayIso = new Date().toISOString().slice(0, 10);
  const stats: ComplianceRunResult = {
    scanned: 0,
    fired_30d: 0,
    fired_7d: 0,
    fired_today: 0,
    errors: 0,
  };

  // Pull docs that expire within 30 days and aren't fully reminded.
  const horizon = new Date(Date.now() + 31 * DAY_MS).toISOString().slice(0, 10);
  type Row = {
    id: string;
    org_id: string;
    kind: string;
    title: string;
    expires_at: string;
    reminded_30d_at: string | null;
    reminded_7d_at: string | null;
    reminded_today_at: string | null;
  };
  const { data, error } = await (
    admin.from("compliance_documents" as never) as unknown as {
      select: (cols: string) => {
        not: (k: string, op: string, v: unknown) => {
          lte: (k: string, v: string) => Promise<{
            data: Row[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select(
      "id, org_id, kind, title, expires_at, reminded_30d_at, reminded_7d_at, reminded_today_at",
    )
    .not("expires_at", "is", null)
    .lte("expires_at", horizon);
  if (error) {
    console.error("[compliance-expiry] query failed", error);
    return { ...stats, errors: stats.errors + 1 };
  }
  const rows = data ?? [];
  stats.scanned = rows.length;

  for (const doc of rows) {
    try {
      const daysToExpiry = Math.floor(
        (new Date(doc.expires_at).getTime() - new Date(todayIso).getTime()) / DAY_MS,
      );
      if (daysToExpiry === 0 && !doc.reminded_today_at) {
        await fire(admin, doc, "today", daysToExpiry);
        stats.fired_today++;
      } else if (daysToExpiry > 0 && daysToExpiry <= 7 && !doc.reminded_7d_at) {
        await fire(admin, doc, "7d", daysToExpiry);
        stats.fired_7d++;
      } else if (daysToExpiry > 7 && daysToExpiry <= 30 && !doc.reminded_30d_at) {
        await fire(admin, doc, "30d", daysToExpiry);
        stats.fired_30d++;
      }
    } catch (e) {
      console.error("[compliance-expiry] per-doc error", doc.id, e);
      stats.errors++;
    }
  }
  return stats;
}

async function fire(
  admin: ReturnType<typeof createAdminClient>,
  doc: { id: string; org_id: string; kind: string; title: string },
  stage: "30d" | "7d" | "today",
  daysToExpiry: number,
): Promise<void> {
  const column =
    stage === "30d"
      ? "reminded_30d_at"
      : stage === "7d"
        ? "reminded_7d_at"
        : "reminded_today_at";
  await (admin.from("compliance_documents" as never) as unknown as {
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  })
    .update({ [column]: new Date().toISOString() })
    .eq("id", doc.id);

  const priority =
    stage === "today" ? "urgent" : stage === "7d" ? "high" : "medium";
  const note: NotificationCreate = {
    org_id: doc.org_id,
    user_id: null,
    audience: "customer",
    type: `compliance.expires_${stage}`,
    category: "system",
    priority,
    title:
      stage === "today"
        ? `${doc.kind.replace(/^./, (c) => c.toUpperCase())} expires today — ${doc.title}`
        : stage === "7d"
          ? `${doc.kind.replace(/^./, (c) => c.toUpperCase())} expires in ${daysToExpiry} days — ${doc.title}`
          : `${doc.kind.replace(/^./, (c) => c.toUpperCase())} expires in ${daysToExpiry} days — ${doc.title}`,
    body: "Renew or replace before it lapses. Compliance reminders only fire once per stage.",
    action_url: `/documents/compliance/${doc.id}`,
    source_module: "compliance",
    source_id: doc.id,
    metadata: { stage, days_to_expiry: daysToExpiry, kind: doc.kind },
  };
  await emitNotifications([note]).catch((e) =>
    console.error("[compliance-expiry] notify failed", e),
  );
}
