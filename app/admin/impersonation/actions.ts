"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import {
  IMPERSONATION_COOKIE,
  IMPERSONATION_MAX_HOURS,
  startImpersonationSession,
  endImpersonationSession,
  getActiveImpersonation,
} from "@/server/services/impersonation";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnUrgentHqAlert } from "@/lib/notifications/events";

/**
 * HQ-10 — Impersonation server actions.
 *
 * Every action:
 *   1. Re-checks isSuperAdminEmail.
 *   2. Writes admin_activity_log for the audit trail.
 *   3. Posts a high-visibility HQ notification on START so the
 *      whole HQ team sees the action.
 *
 * Cookie shape:
 *   cf_impersonation_session = <session_id>
 *   httpOnly, secure, SameSite=Lax, 24h
 *
 * Server-side every load re-validates the session row (see
 * server/services/impersonation.ts) so tampering with the cookie
 * never grants access.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    redirect("/dashboard");
  }
  return { id: user.id, email: user.email ?? "" };
}

// --------------------------------------------------------------------
// START
// --------------------------------------------------------------------

const startSchema = z.object({
  org_id: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(3, "Reason required (3+ chars)")
    .max(2000),
});

export async function startImpersonation(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = startSchema.safeParse({
    org_id: formData.get("org_id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(
      `/admin/impersonation?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "invalid_input")}`,
    );
  }

  // If an existing session is active, end it first so we don't leak
  // overlapping cookies.
  const existing = await getActiveImpersonation(admin.email);
  if (existing) {
    await endImpersonationSession(existing.session_id);
  }

  const started = await startImpersonationSession({
    admin_user_id: admin.id,
    admin_email: admin.email,
    target_org_id: parsed.data.org_id,
    reason: parsed.data.reason,
  });
  if ("error" in started) {
    redirect(`/admin/impersonation?error=${encodeURIComponent(started.error)}`);
  }

  // Set the cookie.
  const jar = await cookies();
  jar.set(IMPERSONATION_COOKIE, started.session_id, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: IMPERSONATION_MAX_HOURS * 3600,
  });

  // Audit + HQ notification (every impersonation start is loud).
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "impersonation.started",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: {
      session_id: started.session_id,
      reason: parsed.data.reason,
    },
  });
  await emitNotifications(
    notifyOnUrgentHqAlert({
      org_id: parsed.data.org_id,
      alert_label: `Impersonation started by ${admin.email}`,
      detail: parsed.data.reason,
      alert_url: `/admin/impersonation`,
    }),
  );

  // Drop the operator into the customer workspace so they
  // immediately see the impersonation state.
  redirect(`/dashboard?impersonation=started`);
}

// --------------------------------------------------------------------
// END
// --------------------------------------------------------------------

export async function endImpersonation(): Promise<void> {
  const admin = await requireAdmin();
  const active = await getActiveImpersonation(admin.email);

  const jar = await cookies();
  jar.delete(IMPERSONATION_COOKIE);

  if (active) {
    await endImpersonationSession(active.session_id);
    await recordAdminActivity({
      actorId: admin.id,
      actorEmail: admin.email,
      action: "impersonation.ended",
      targetTable: "organizations",
      targetId: active.target_org_id,
      metadata: {
        session_id: active.session_id,
        duration_seconds: Math.floor(
          (Date.now() - new Date(active.started_at).getTime()) / 1000,
        ),
      },
    });
  }

  redirect("/admin/impersonation?saved=ended");
}

// --------------------------------------------------------------------
// FORCE-END (HQ-side kill switch — end someone else's session)
// --------------------------------------------------------------------

const forceEndSchema = z.object({
  session_id: z.string().uuid(),
});

export async function forceEndImpersonation(
  formData: FormData,
): Promise<void> {
  const admin = await requireAdmin();
  const parsed = forceEndSchema.safeParse({
    session_id: formData.get("session_id"),
  });
  if (!parsed.success) redirect("/admin/impersonation?error=invalid_input");

  await endImpersonationSession(parsed.data.session_id);
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "impersonation.force_ended",
    targetTable: "impersonation_sessions",
    targetId: parsed.data.session_id,
    metadata: {},
  });
  redirect("/admin/impersonation?saved=force_ended");
}
