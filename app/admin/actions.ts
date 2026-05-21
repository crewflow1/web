"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";

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

  revalidatePath("/admin/organizations");
  redirect(
    `/admin/organizations?saved=${encodeURIComponent(parsed.data.status)}`,
  );
}
