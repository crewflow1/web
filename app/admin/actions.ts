"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { env } from "@/lib/env";

/**
 * Super-admin organisation moderation actions.
 *
 * Each action re-checks `isSuperAdminEmail(user.email)` so the gate
 * applies even if a non-admin submits the form directly. Writes go
 * through the service-role admin client — RLS on `organizations`
 * doesn't currently allow cross-tenant writes via JWT.
 *
 * Activity is recorded into the existing activity_logs table via the
 * `_record_activity` SECURITY DEFINER RPC, keyed by org_id, so an org
 * owner can see when their status flipped.
 */

const ALLOWED_STATUSES = [
  "pending",
  "active",
  "trial",
  "suspended",
  "rejected",
] as const;

const setStatusSchema = z.object({
  org_id: z.string().uuid(),
  status: z.enum(ALLOWED_STATUSES),
  reason: z.string().trim().max(2000).optional(),
});

async function requireSuperAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    // 404, not 403 — we don't want to confirm the route exists to
    // anyone who isn't already on the allowlist.
    redirect("/dashboard");
  }
  return { id: user.id, email: user.email ?? "" };
}

export async function setOrganizationStatus(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const parsed = setStatusSchema.safeParse({
    org_id: formData.get("org_id"),
    status: formData.get("status"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    redirect("/admin/organizations?error=invalid_input");
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  type Update = {
    status: (typeof ALLOWED_STATUSES)[number];
    approved_at?: string | null;
    approved_by?: string | null;
    suspended_at?: string | null;
    rejection_reason?: string | null;
  };
  const update: Update = { status: parsed.data.status };

  if (parsed.data.status === "active" || parsed.data.status === "trial") {
    update.approved_at = now;
    update.approved_by = admin.id;
    update.suspended_at = null;
    update.rejection_reason = null;
  } else if (parsed.data.status === "suspended") {
    update.suspended_at = now;
  } else if (parsed.data.status === "rejected") {
    update.rejection_reason = parsed.data.reason ?? null;
  } else if (parsed.data.status === "pending") {
    // Reset back to pending — clear approval audit. Keep rejection_reason
    // because a re-pending after rejection still benefits from the context.
    update.approved_at = null;
    update.approved_by = null;
    update.suspended_at = null;
  }

  const { error } = await supabase
    .from("organizations")
    .update(update as never)
    .eq("id", parsed.data.org_id);

  if (error) {
    console.error("[admin] setOrganizationStatus failed", error);
    redirect("/admin/organizations?error=update_failed");
  }

  // Best-effort audit log via the existing SECURITY DEFINER helper.
  await supabase.rpc("_record_activity", {
    p_org_id: parsed.data.org_id,
    p_action: `org.status_${parsed.data.status}`,
    p_target_table: "organizations",
    p_target_id: parsed.data.org_id,
    p_metadata: {
      reason: parsed.data.reason ?? null,
      actor_email: admin.email,
    },
  } as never);

  // Best-effort notify the owner that their org status changed.
  // We email on the user-facing transitions only — pending→pending is
  // a no-op, suspended/rejected the customer needs to hear about, and
  // active/trial is the "you're in" moment. Failures are logged, never
  // thrown — the moderation action itself has already succeeded.
  if (parsed.data.status !== "pending") {
    await notifyOrgOwner(supabase, parsed.data.org_id, parsed.data.status);
  }

  revalidatePath("/admin/organizations");
  redirect(
    `/admin/organizations?saved=${encodeURIComponent(parsed.data.status)}`,
  );
}

type StatusTransition = "active" | "trial" | "suspended" | "rejected";

const STATUS_EMAIL: Record<
  StatusTransition,
  { subject: string; heading: string; body: string; cta: string | null }
> = {
  active: {
    subject: "Your CrewFlow access is live",
    heading: "You're in.",
    body: "Your CrewFlow workspace is approved and ready to use. Sign in and pick up where you left off.",
    cta: "Open CrewFlow",
  },
  trial: {
    subject: "Your CrewFlow trial is live",
    heading: "Trial unlocked.",
    body: "Your CrewFlow trial is active. Sign in and have a poke around — we'll be in touch before it ends to talk pricing.",
    cta: "Open CrewFlow",
  },
  suspended: {
    subject: "CrewFlow access paused",
    heading: "Access paused.",
    body: "We've temporarily paused access to your CrewFlow workspace. Reply to this email and we'll get it sorted.",
    cta: null,
  },
  rejected: {
    subject: "About your CrewFlow signup",
    heading: "Signup not approved.",
    body: "We weren't able to approve your CrewFlow signup. If you think this is a mistake, reply to this email and we'll take another look.",
    cta: null,
  },
};

async function notifyOrgOwner(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  status: string,
): Promise<void> {
  if (!(status in STATUS_EMAIL)) return;
  const copy = STATUS_EMAIL[status as StatusTransition];

  const { data: owner } = await supabase
    .from("memberships")
    .select("user:users ( email, full_name )")
    .eq("org_id", orgId)
    .eq("role", "owner")
    .maybeSingle();

  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) {
    console.warn("[admin] notifyOrgOwner: no owner email", { orgId, status });
    return;
  }

  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const ctaUrl = copy.cta ? `${appUrl}/dashboard` : null;
  const greeting = owner?.user?.full_name
    ? `Hi ${owner.user.full_name.split(" ")[0]},`
    : "Hi,";

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.55">
  <p>${greeting}</p>
  <h1 style="margin:16px 0;font-size:20px">${copy.heading}</h1>
  <p>${copy.body}</p>
  ${ctaUrl
    ? `<p style="margin:24px 0"><a href="${ctaUrl}" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">${copy.cta}</a></p>`
    : ""}
  <p style="color:#475569;font-size:12px;margin-top:32px">Reply to this email if you need anything — we read every one.</p>
</div>`;

  const result = await sendEmail({
    to: ownerEmail,
    subject: copy.subject,
    html,
  });
  if (!result.sent) {
    console.warn("[admin] notifyOrgOwner email skipped", {
      orgId,
      status,
      reason: result.reason,
    });
  }
}
