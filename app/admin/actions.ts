"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireHq } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { env } from "@/lib/env";

/**
 * Super-admin organisation moderation actions.
 *
 * Each action calls the single HQ gate `requireHq()` so the gate
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
  "cancelled",
] as const;

const setStatusSchema = z.object({
  org_id: z.string().uuid(),
  status: z.enum(ALLOWED_STATUSES),
  reason: z.string().trim().max(2000).optional(),
});

const TRIAL_DAYS = 14;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

const setDemoStatusSchema = z.object({
  demo_id: z.string().uuid(),
  status: z.enum(["pending_demo", "demo_booked", "approved", "rejected", "cancelled"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function setOrganizationStatus(formData: FormData): Promise<void> {
  const admin = await requireHq();
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
    trial_ends_at?: string | null;
    cancelled_at?: string | null;
  };
  const update: Update = { status: parsed.data.status };

  if (parsed.data.status === "trial") {
    // The directive's headline approve flow: 14-day trial, end-date
    // anchored on the click. trial_ends_at gives the operator a clear
    // countdown in Settings and the panel both.
    update.approved_at = now;
    update.approved_by = admin.id;
    update.suspended_at = null;
    update.cancelled_at = null;
    update.rejection_reason = null;
    update.trial_ends_at = new Date(Date.now() + TRIAL_MS).toISOString();
  } else if (parsed.data.status === "active") {
    update.approved_at = now;
    update.approved_by = admin.id;
    update.suspended_at = null;
    update.cancelled_at = null;
    update.rejection_reason = null;
    // Promoting from trial → active clears the trial countdown.
    update.trial_ends_at = null;
  } else if (parsed.data.status === "suspended") {
    update.suspended_at = now;
  } else if (parsed.data.status === "cancelled") {
    update.cancelled_at = now;
  } else if (parsed.data.status === "rejected") {
    update.rejection_reason = parsed.data.reason ?? null;
  } else if (parsed.data.status === "pending") {
    // Reset back to pending — clear approval audit. Keep rejection_reason
    // because a re-pending after rejection still benefits from the context.
    update.approved_at = null;
    update.approved_by = null;
    update.suspended_at = null;
    update.cancelled_at = null;
    update.trial_ends_at = null;
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

type StatusTransition = "active" | "trial" | "suspended" | "rejected" | "cancelled";

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
  cancelled: {
    subject: "CrewFlow access cancelled",
    heading: "Workspace cancelled.",
    body: "Your CrewFlow workspace has been cancelled. If this is unexpected, reply to this email.",
    cta: null,
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
    // Same notify@ pattern as the demo flow: distinct From mailbox so
    // Gmail/Workspace don't drop the message as a self-loop.
    from:
      process.env.RESEND_NOTIFICATIONS_FROM ||
      "CrewFlow Notifications <notify@crewflow.uk>",
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

// ----------------------------------------------------------------------
// Demo-request lifecycle (pre-signup intake).
// ----------------------------------------------------------------------
//
// A demo_request is the row the landing-page form inserts; it has no
// organisation or user yet. The CEO panel exposes:
//
//   pending_demo → demo_booked → approved → (prospect signs up; their
//                                            new org auto-trials)
//                              ↘ rejected
//                              ↘ cancelled
//
// Approving a demo_request sends the prospect an email and marks the
// row as approved. The auto-trial wiring in createOrgWithOwner picks up
// the approved row on signup and sets trial_ends_at = now + 14 days.

const DEMO_EMAIL: Record<
  "approved" | "rejected" | "demo_booked",
  { subject: string; heading: string; body: string; cta: string | null }
> = {
  approved: {
    subject: "Your CrewFlow access is approved",
    heading: "You're in — 14-day trial unlocked.",
    body: "We've approved your CrewFlow signup. Sign in at crewflow.uk/login with this email and we'll set up your 14-day trial immediately — no credit card required during trial.",
    cta: "Sign in to CrewFlow",
  },
  demo_booked: {
    subject: "Your CrewFlow demo is scheduled",
    heading: "Demo booked.",
    body: "We've got your demo on the calendar. You'll get a separate calendar invite shortly. Reply to this email if anything changes.",
    cta: null,
  },
  rejected: {
    subject: "About your CrewFlow demo request",
    heading: "We can't proceed right now.",
    body: "Thanks for your interest — we're not able to onboard you onto CrewFlow at this time. If you think this is a mistake, reply to this email.",
    cta: null,
  },
};

export async function setDemoRequestStatus(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = setDemoStatusSchema.safeParse({
    demo_id: formData.get("demo_id"),
    status: formData.get("status"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    redirect("/admin/organizations?error=invalid_input");
  }
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Pull email for the post-update notification.
  const { data: row } = await supabase
    .from("demo_requests")
    .select("id, name, email, company, status")
    .eq("id", parsed.data.demo_id)
    .maybeSingle();
  if (!row) {
    redirect("/admin/organizations?error=demo_not_found");
  }

  type DemoUpdate = {
    status: string;
    approved_at?: string | null;
    reviewed_by?: string | null;
    rejection_reason?: string | null;
  };
  const update: DemoUpdate = { status: parsed.data.status };
  if (parsed.data.status === "approved") {
    update.approved_at = now;
    update.reviewed_by = admin.id;
    update.rejection_reason = null;
  } else if (parsed.data.status === "rejected") {
    update.rejection_reason = parsed.data.reason ?? null;
    update.reviewed_by = admin.id;
  } else if (parsed.data.status === "demo_booked") {
    update.reviewed_by = admin.id;
  }

  const { error } = await supabase
    .from("demo_requests")
    .update(update as never)
    .eq("id", parsed.data.demo_id);
  if (error) {
    console.error("[admin] setDemoRequestStatus failed", error);
    redirect("/admin/organizations?error=update_failed");
  }

  // Audit log keyed by demo_id (no org_id yet). We use a synthetic
  // null-uuid for p_org_id since the demo isn't bound to an org yet —
  // the activity_logs row still captures actor + transition.
  await supabase.rpc("_record_activity", {
    p_org_id: "00000000-0000-0000-0000-000000000000",
    p_action: `demo.status_${parsed.data.status}`,
    p_target_table: "demo_requests",
    p_target_id: parsed.data.demo_id,
    p_metadata: {
      reason: parsed.data.reason ?? null,
      actor_email: admin.email,
      prospect_email: row?.email ?? null,
      prospect_company: row?.company ?? null,
    },
  } as never);

  // Best-effort: email the prospect.
  if (
    (parsed.data.status === "approved" ||
      parsed.data.status === "rejected" ||
      parsed.data.status === "demo_booked") &&
    row?.email
  ) {
    await notifyDemoProspect(parsed.data.status, row);
  }

  revalidatePath("/admin/organizations");
  redirect(
    `/admin/organizations?saved=demo_${encodeURIComponent(parsed.data.status)}`,
  );
}

async function notifyDemoProspect(
  status: "approved" | "rejected" | "demo_booked",
  row: { id: string; name: string; email: string; company: string },
): Promise<void> {
  const copy = DEMO_EMAIL[status];
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const ctaUrl = copy.cta ? `${appUrl}/login` : null;
  const firstName = row.name?.split(" ")[0] ?? "there";

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.55">
  <p>Hi ${firstName},</p>
  <h1 style="margin:16px 0;font-size:20px">${copy.heading}</h1>
  <p>${copy.body}</p>
  ${ctaUrl
    ? `<p style="margin:24px 0"><a href="${ctaUrl}" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">${copy.cta}</a></p>`
    : ""}
  <p style="color:#475569;font-size:12px;margin-top:32px">Reply to this email if you need anything — we read every one.</p>
</div>`;

  const result = await sendEmail({
    to: row.email,
    from:
      process.env.RESEND_NOTIFICATIONS_FROM ||
      "CrewFlow Notifications <notify@crewflow.uk>",
    subject: copy.subject,
    html,
  });
  if (!result.sent) {
    console.warn("[admin] notifyDemoProspect skipped", {
      demo_id: row.id,
      status,
      reason: result.reason,
    });
  }
}
