"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import {
  updateStaffProfileSchema,
  updateStaffRoleSchema,
  rotaEntryFormSchema,
  leaveRequestFormSchema,
} from "@/lib/staff/schema";

/**
 * Staff CRUD + rota + leave server actions.
 *
 * Permissions enforced at the DB via RLS (memberships.role checked by
 * is_org_admin / is_org_member helpers). We re-check role in the action
 * layer for clearer error responses + auditability.
 *
 * "Adding a new staff" today = inviting an existing-user-by-email into
 * the org by creating a memberships row. Magic-link signup is a future
 * polish; today the user must already exist in public.users.
 */

const uuid = z.string().uuid();

async function requireAdmin(orgId: string) {
  const supabase = await createClient();
  const { data: me } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .single();
  if (!me || (me.role !== "owner" && me.role !== "admin")) {
    redirect("/dashboard?error=forbidden");
  }
}

// -------------------------------------------------------------------------
// Staff CRUD
// -------------------------------------------------------------------------

export async function inviteStaff(formData: FormData) {
  const { ctx } = await requireOrgContext();
  await requireAdmin(ctx.org.id);

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "staff");
  const validatedRole = updateStaffRoleSchema.safeParse({ role });
  if (!validatedRole.success || email.length === 0) {
    redirect("/staff?error=invalid_input");
  }
  if (validatedRole.data.role === "owner") {
    redirect("/staff?error=owner_role_not_assignable");
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("users")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();

  // Case A — user does not exist in public.users yet. Send them a
  // Supabase magic-link invite carrying the org + role in user_metadata.
  // The onboarding flow will pick that up and provision the membership.
  if (!existing) {
    const admin = createAdminClient();
    try {
      await admin.auth.admin.inviteUserByEmail(email, {
        data: {
          invited_org_id: ctx.org.id,
          invited_role: validatedRole.data.role,
          source: "staff_invite",
        },
        redirectTo: process.env.NEXT_PUBLIC_APP_URL
          ? `${process.env.NEXT_PUBLIC_APP_URL}/onboarding/company?invited_org=${ctx.org.id}&invited_role=${validatedRole.data.role}`
          : undefined,
      });
      revalidatePath("/staff");
      redirect("/staff?saved=invite_sent");
    } catch (e) {
      console.error("[staff] magic-link invite failed", e);
      redirect("/staff?error=invite_email_failed");
    }
  }

  // Case B — user exists; check they aren't already a member.
  const { data: dup } = await supabase
    .from("memberships")
    .select("id")
    .eq("org_id", ctx.org.id)
    .eq("user_id", existing.id)
    .maybeSingle();
  if (dup) {
    redirect("/staff?error=already_member");
  }

  const { error } = await supabase.from("memberships").insert({
    org_id: ctx.org.id,
    user_id: existing.id,
    role: validatedRole.data.role,
  });
  if (error) {
    console.error("[staff] invite failed", error);
    redirect("/staff?error=invite_failed");
  }

  revalidatePath("/staff");
  redirect("/staff?saved=invited");
}

export async function updateStaffRole(userId: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  await requireAdmin(ctx.org.id);
  if (!uuid.safeParse(userId).success) redirect("/staff");

  const role = String(formData.get("role") ?? "");
  const parsed = updateStaffRoleSchema.safeParse({ role });
  if (!parsed.success) redirect(`/staff/${userId}?error=invalid_role`);
  if (parsed.data.role === "owner") {
    // Disallow promoting to owner via UI — onboarding flow is the only
    // path. Prevents accidental shared-ownership confusion.
    redirect(`/staff/${userId}?error=owner_role_not_assignable`);
  }

  const supabase = await createClient();
  // Prevent demoting the last owner.
  const { count: ownerCount } = await supabase
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("org_id", ctx.org.id)
    .eq("role", "owner");
  const { data: target } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (target?.role === "owner" && (ownerCount ?? 0) <= 1) {
    redirect(`/staff/${userId}?error=last_owner_lock`);
  }

  const { error, count } = await supabase
    .from("memberships")
    .update({ role: parsed.data.role }, { count: "exact" })
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId);
  if (error) {
    console.error("[staff] role update failed", error);
    redirect(`/staff/${userId}?error=update_failed`);
  }
  if (count === 0) redirect(`/staff/${userId}?error=update_denied`);

  revalidatePath("/staff");
  revalidatePath(`/staff/${userId}`);
  redirect(`/staff/${userId}?saved=role`);
}

export async function updateStaffProfile(userId: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  await requireAdmin(ctx.org.id);
  if (!uuid.safeParse(userId).success) redirect("/staff");

  const parsed = updateStaffProfileSchema.safeParse({
    full_name: formData.get("full_name") ?? "",
    phone: formData.get("phone") ?? "",
    hourly_pay: formData.get("hourly_pay") ?? "",
    employment_type: formData.get("employment_type") ?? "",
    start_date: formData.get("start_date") ?? "",
    emergency_contact_name: formData.get("emergency_contact_name") ?? "",
    emergency_contact_phone: formData.get("emergency_contact_phone") ?? "",
    emergency_contact_relationship: formData.get("emergency_contact_relationship") ?? "",
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/staff/${userId}?error=${encodeURIComponent(msg)}`);
  }

  // Verify the target user is actually a member of this org.
  const supabase = await createClient();
  const { count: membershipCount } = await supabase
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId);
  if ((membershipCount ?? 0) === 0) {
    redirect(`/staff?error=not_a_member`);
  }

  const emergency =
    parsed.data.emergency_contact_name ||
    parsed.data.emergency_contact_phone ||
    parsed.data.emergency_contact_relationship
      ? {
          name: parsed.data.emergency_contact_name ?? null,
          phone: parsed.data.emergency_contact_phone ?? null,
          relationship: parsed.data.emergency_contact_relationship ?? null,
        }
      : null;

  const { error } = await supabase
    .from("users")
    .update({
      full_name: parsed.data.full_name ?? null,
      phone: parsed.data.phone ?? null,
      hourly_pay: parsed.data.hourly_pay ?? null,
      employment_type: parsed.data.employment_type ?? null,
      start_date: parsed.data.start_date ?? null,
      emergency_contact: emergency,
    })
    .eq("id", userId);
  if (error) {
    console.error("[staff] profile update failed", error);
    redirect(`/staff/${userId}?error=update_failed`);
  }

  revalidatePath(`/staff/${userId}`);
  revalidatePath("/staff");
  redirect(`/staff/${userId}?saved=profile`);
}

export async function removeStaff(userId: string) {
  const { ctx } = await requireOrgContext();
  await requireAdmin(ctx.org.id);
  if (!uuid.safeParse(userId).success) redirect("/staff");

  const supabase = await createClient();
  const { data: target } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (target?.role === "owner") {
    redirect(`/staff/${userId}?error=cannot_remove_owner`);
  }

  const { error, count } = await supabase
    .from("memberships")
    .delete({ count: "exact" })
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId);
  if (error) {
    console.error("[staff] remove failed", error);
    redirect(`/staff/${userId}?error=remove_failed`);
  }
  if (count === 0) redirect(`/staff/${userId}?error=remove_denied`);

  revalidatePath("/staff");
  redirect("/staff?saved=removed");
}

// -------------------------------------------------------------------------
// Rota
// -------------------------------------------------------------------------

export async function createRotaEntry(formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  await requireAdmin(ctx.org.id);

  const parsed = rotaEntryFormSchema.safeParse({
    user_id: formData.get("user_id") ?? "",
    starts_at: formData.get("starts_at") ?? "",
    ends_at: formData.get("ends_at") ?? "",
    job_id: formData.get("job_id") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid shift";
    redirect(`/staff/rota?error=${encodeURIComponent(msg)}`);
  }
  if (new Date(parsed.data.ends_at) <= new Date(parsed.data.starts_at)) {
    redirect(`/staff/rota?error=${encodeURIComponent("End must be after start")}`);
  }

  const supabase = await createClient();

  // Conflict check: does the assigned user already have an overlapping
  // shift on this day? Pull a window and compare in-process so we don't
  // require a Postgres range type.
  const dayStart = parsed.data.starts_at.slice(0, 10);
  const { data: sameDay } = await supabase
    .from("rota_entries")
    .select("starts_at, ends_at")
    .eq("user_id", parsed.data.user_id)
    .gte("starts_at", `${dayStart}T00:00:00Z`)
    .lte("starts_at", `${dayStart}T23:59:59Z`);
  if (sameDay && sameDay.length > 0) {
    const ns = new Date(parsed.data.starts_at).getTime();
    const ne = new Date(parsed.data.ends_at).getTime();
    const hit = sameDay.find((s) => {
      const a = new Date(s.starts_at).getTime();
      const b = new Date(s.ends_at).getTime();
      return ns < b && a < ne;
    });
    if (hit) {
      redirect(`/staff/rota?error=${encodeURIComponent("Conflict: this staff member already has an overlapping shift")}`);
    }
  }

  const { error } = await supabase
    .from("rota_entries")
    .insert({
      org_id: ctx.org.id,
      user_id: parsed.data.user_id,
      job_id: parsed.data.job_id ?? null,
      starts_at: parsed.data.starts_at,
      ends_at: parsed.data.ends_at,
      notes: parsed.data.notes ?? null,
      created_by: user.id,
    });
  if (error) {
    console.error("[rota] insert failed", error);
    redirect(`/staff/rota?error=create_failed`);
  }

  revalidatePath("/staff/rota");
  redirect("/staff/rota?saved=created");
}

export async function deleteRotaEntry(entryId: string) {
  const { ctx } = await requireOrgContext();
  await requireAdmin(ctx.org.id);
  if (!uuid.safeParse(entryId).success) redirect("/staff/rota");

  const supabase = await createClient();
  const { error } = await supabase
    .from("rota_entries")
    .delete()
    .eq("id", entryId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[rota] delete failed", error);
    redirect("/staff/rota?error=delete_failed");
  }
  revalidatePath("/staff/rota");
  redirect("/staff/rota?saved=removed");
}

// -------------------------------------------------------------------------
// Leave requests
// -------------------------------------------------------------------------

export async function createLeaveRequest(formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  // Staff can submit their own — no admin gate.

  const parsed = leaveRequestFormSchema.safeParse({
    type: formData.get("type") ?? "",
    starts_at: formData.get("starts_at") ?? "",
    ends_at: formData.get("ends_at") ?? "",
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid request";
    redirect(`/staff/leave?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("leave_requests")
    .insert({
      org_id: ctx.org.id,
      user_id: user.id,
      type: parsed.data.type,
      starts_at: parsed.data.starts_at,
      ends_at: parsed.data.ends_at,
      reason: parsed.data.reason ?? null,
      status: "pending",
    });
  if (error) {
    console.error("[leave] insert failed", error);
    redirect(`/staff/leave?error=create_failed`);
  }

  revalidatePath("/staff/leave");
  redirect("/staff/leave?saved=requested");
}

export async function reviewLeaveRequest(
  requestId: string,
  formData: FormData,
) {
  const { ctx, user } = await requireOrgContext();
  await requireAdmin(ctx.org.id);
  if (!uuid.safeParse(requestId).success) redirect("/staff/leave");

  const decision = String(formData.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected") {
    redirect(`/staff/leave/${requestId}?error=invalid_decision`);
  }
  const note = String(formData.get("review_note") ?? "").trim() || null;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("leave_requests")
    .update(
      {
        status: decision,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        review_note: note,
      },
      { count: "exact" },
    )
    .eq("id", requestId)
    .eq("org_id", ctx.org.id)
    .eq("status", "pending"); // only review pending
  if (error) {
    console.error("[leave] review failed", error);
    redirect(`/staff/leave/${requestId}?error=review_failed`);
  }
  if (count === 0) {
    redirect(`/staff/leave/${requestId}?error=already_reviewed`);
  }

  revalidatePath("/staff/leave");
  revalidatePath(`/staff/leave/${requestId}`);
  redirect(`/staff/leave?saved=${decision}`);
}

export async function cancelLeaveRequest(requestId: string) {
  const { ctx, user } = await requireOrgContext();
  if (!uuid.safeParse(requestId).success) redirect("/staff/leave");

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("leave_requests")
    .update({ status: "cancelled" }, { count: "exact" })
    .eq("id", requestId)
    .eq("org_id", ctx.org.id)
    .eq("user_id", user.id)
    .eq("status", "pending");
  if (error) {
    console.error("[leave] cancel failed", error);
    redirect(`/staff/leave/${requestId}?error=cancel_failed`);
  }
  if (count === 0) {
    redirect(`/staff/leave/${requestId}?error=cannot_cancel`);
  }

  revalidatePath("/staff/leave");
  redirect("/staff/leave?saved=cancelled");
}
