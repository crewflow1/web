"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findAuthUserByEmail } from "@/lib/supabase/auth-user-lookup";
import {
  sendStaffInvite,
  type StaffInviteMetadata,
} from "@/server/services/staff-invite";
import { requireOrgContext, type OrgContext } from "@/server/auth/session";
import { listUserShiftsOnDay, type RotaClient } from "@/server/services/rota";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  updateStaffProfileSchema,
  updateStaffRoleSchema,
  rotaEntryFormSchema,
  leaveRequestFormSchema,
  inviteStaffSchema,
} from "@/lib/staff/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";
import {
  notifyOwnersOfLeaveRequest,
  notifyStaffOfLeaveDecision,
} from "@/lib/email/send-leave";

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

function requireAdmin(ctx: OrgContext): void {
  // ctx.membership is the caller's OWN row in the ACTIVE org, resolved by
  // requireOrgContext with a user_id filter. Don't re-query memberships
  // unfiltered here: org members can read each other's rows, so
  // `.eq("org_id", …).single()` returns every member and errors in any org
  // with ≥2 members — locking every admin out of staff management.
  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") {
    redirect("/dashboard?error=forbidden");
  }
}

// -------------------------------------------------------------------------
// Staff CRUD
// -------------------------------------------------------------------------

export type InviteStaffResult =
  | { ok: true; outcome: "added" | "invite_sent"; message: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Invite a teammate. Returns a structured result so the modal can render
 * inline errors instead of relying on redirect-with-querystring.
 *
 * Flow:
 *   - Owner role refused.
 *   - Existing public.users row → membership created, profile pre-fill
 *     applied only to columns currently null (so we don't overwrite a
 *     user's existing data).
 *   - No public.users row → Supabase magic-link invite with the same
 *     pre-fill payload in user_metadata; /onboarding/join hydrates it.
 */
export async function inviteStaff(formData: FormData): Promise<InviteStaffResult> {
  const { ctx } = await requireOrgContext();
  requireAdmin(ctx);

  const parsed = inviteStaffSchema.safeParse({
    full_name: formData.get("full_name") ?? "",
    email: formData.get("email"),
    role: formData.get("role"),
    phone: formData.get("phone") ?? "",
    employment_type: formData.get("employment_type") ?? "",
    hourly_pay: formData.get("hourly_pay") ?? "",
    emergency_contact_name: formData.get("emergency_contact_name") ?? "",
    emergency_contact_phone: formData.get("emergency_contact_phone") ?? "",
    emergency_contact_relationship: formData.get("emergency_contact_relationship") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0];
      if (typeof k === "string" && !fieldErrors[k]) fieldErrors[k] = issue.message;
    }
    return { ok: false, error: "Fix the highlighted fields.", fieldErrors };
  }
  if (parsed.data.role === "owner") {
    return {
      ok: false,
      error: "Owner role can only be assigned during onboarding.",
      fieldErrors: { role: "Pick admin or staff." },
    };
  }
  const data = parsed.data;

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("users")
    .select("id, email, full_name, phone, hourly_pay, employment_type, emergency_contact")
    .eq("email", data.email)
    .maybeSingle();

  const emergencyContact = data.emergency_contact_name || data.emergency_contact_phone || data.emergency_contact_relationship
    ? {
        name: data.emergency_contact_name ?? null,
        phone: data.emergency_contact_phone ?? null,
        relationship: data.emergency_contact_relationship ?? null,
      }
    : null;

  // Case A — brand-new email. Send a branded magic-link (via Resend) with
  // metadata so /onboarding/join can hydrate the profile after they click.
  // generateLink + verifyOtp (not Supabase's PKCE-locked invite email) so
  // the link works cross-device — see server/services/staff-invite.ts.
  if (!existing) {
    const result = await sendStaffInvite({
      email: data.email,
      fullName: data.full_name ?? null,
      orgName: ctx.org.name ?? "your team",
      metadata: {
        invited_org_id: ctx.org.id,
        invited_role: data.role,
        invited_full_name: data.full_name ?? null,
        invited_phone: data.phone ?? null,
        invited_employment_type: data.employment_type ?? null,
        invited_hourly_pay: data.hourly_pay ?? null,
        invited_emergency_contact: emergencyContact,
        source: "staff_invite",
      },
    });
    if (!result.ok) {
      console.error("[staff] magic-link invite failed", result.reason);
      return {
        ok: false,
        error: "Couldn't send the invite email. Check the address and try again.",
      };
    }
    revalidatePath("/staff");
    return {
      ok: true,
      outcome: "invite_sent",
      message: `Invite emailed to ${data.email}. They'll click the magic link to set their name and join.`,
    };
  }

  // Case B — existing user. Already a member?
  const { data: dup } = await supabase
    .from("memberships")
    .select("id")
    .eq("org_id", ctx.org.id)
    .eq("user_id", existing.id)
    .maybeSingle();
  if (dup) {
    return {
      ok: false,
      error: "That person is already a member of this organisation.",
    };
  }

  const { error: memErr } = await supabase.from("memberships").insert({
    org_id: ctx.org.id,
    user_id: existing.id,
    role: data.role,
  });
  if (memErr) {
    console.error("[staff] invite failed", memErr);
    return { ok: false, error: "Couldn't add the member. Try again." };
  }

  // Pre-fill profile fields ONLY where the user currently has nothing —
  // never overwrite a user's existing data.
  type UserUpdate = {
    full_name?: string;
    phone?: string;
    hourly_pay?: number;
    employment_type?: string;
    emergency_contact?: { name: string | null; phone: string | null; relationship: string | null };
  };
  const profileUpdates: UserUpdate = {};
  if (!existing.full_name && data.full_name) profileUpdates.full_name = data.full_name;
  if (!existing.phone && data.phone) profileUpdates.phone = data.phone;
  if (existing.hourly_pay === null && data.hourly_pay !== undefined)
    profileUpdates.hourly_pay = data.hourly_pay;
  if (!existing.employment_type && data.employment_type)
    profileUpdates.employment_type = data.employment_type;
  if (!existing.emergency_contact && emergencyContact)
    profileUpdates.emergency_contact = emergencyContact;
  if (Object.keys(profileUpdates).length > 0) {
    const admin = createAdminClient();
    await admin.from("users").update(profileUpdates).eq("id", existing.id);
  }

  revalidatePath("/staff");
  return {
    ok: true,
    outcome: "added",
    message: `${data.full_name || data.email} added to ${ctx.org.name}.`,
  };
}

/**
 * Re-send a pending staff invite (H2). Admin-gated. Only ever resends to
 * an address that already has an UNCONFIRMED invite for THIS org — so an
 * admin can't spray invites at arbitrary addresses, and we never re-mail
 * someone who has already joined.
 */
export async function resendStaffInvite(email: string): Promise<InviteStaffResult> {
  const { ctx } = await requireOrgContext();
  requireAdmin(ctx);

  const parsedEmail = z.string().email().safeParse(email);
  if (!parsedEmail.success) return { ok: false, error: "Invalid email address." };
  const target = parsedEmail.data;

  const admin = createAdminClient();
  // Paginated lookup — a single listUsers({ perPage: 1000 }) page stopped
  // seeing pending invites once the auth base passed 1000 users.
  const lookup = await findAuthUserByEmail(admin, target);
  if (!lookup.ok) {
    console.error("[staff] resend invite — auth user lookup failed", lookup.reason);
    return { ok: false, error: "Couldn't reach the invite service. Try again." };
  }

  const existing = lookup.user;
  const meta = (existing?.user_metadata ?? {}) as Record<string, unknown>;
  if (!existing || meta.invited_org_id !== ctx.org.id || meta.source !== "staff_invite") {
    return { ok: false, error: "No pending invite found for that email." };
  }
  if (existing.email_confirmed_at) {
    return { ok: false, error: "That person has already joined this org." };
  }

  // Re-use the original invite metadata so the accept flow hydrates the
  // same profile pre-fill. sendStaffInvite's already-exists path refreshes
  // the metadata on the existing UNCONFIRMED user and re-sends a fresh
  // branded magic link (the email_confirmed_at guard above means we never
  // resend to a confirmed/joined account).
  const metadata: StaffInviteMetadata = {
    invited_org_id: ctx.org.id,
    invited_role: typeof meta.invited_role === "string" ? meta.invited_role : "staff",
    invited_full_name:
      typeof meta.invited_full_name === "string" ? meta.invited_full_name : null,
    invited_phone: typeof meta.invited_phone === "string" ? meta.invited_phone : null,
    invited_employment_type:
      typeof meta.invited_employment_type === "string"
        ? meta.invited_employment_type
        : null,
    invited_hourly_pay:
      typeof meta.invited_hourly_pay === "number" ? meta.invited_hourly_pay : null,
    invited_emergency_contact:
      (meta.invited_emergency_contact as StaffInviteMetadata["invited_emergency_contact"]) ??
      null,
    source: "staff_invite",
  };
  const result = await sendStaffInvite({
    email: target,
    fullName: metadata.invited_full_name,
    orgName: ctx.org.name ?? "your team",
    metadata,
  });
  if (!result.ok) {
    console.error("[staff] resend invite failed", result.reason);
    return { ok: false, error: "Couldn't resend the invite email. Try again." };
  }

  revalidatePath("/staff");
  return {
    ok: true,
    outcome: "invite_sent",
    message: `Invite re-sent to ${target}.`,
  };
}

export async function updateStaffRole(userId: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  requireAdmin(ctx);
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
  // Prevent demoting the last owner. Loud fail on either read: a failed target
  // read silently SKIPS this guard and could demote the last owner (org lockout).
  const { count: ownerCount, error: ownerCountError } = await supabase
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("org_id", ctx.org.id)
    .eq("role", "owner");
  if (ownerCountError) throw readFailure("staff: owner count guard", ownerCountError);
  const { data: target, error: targetError } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (targetError) throw readFailure("staff: role-change target", targetError);
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

export async function updateStaffProfile(
  userId: string,
  _prevState: FormState<Record<string, unknown>>,
  formData: FormData,
): Promise<FormState<Record<string, unknown>>> {
  const { ctx } = await requireOrgContext();
  requireAdmin(ctx);
  if (!uuid.safeParse(userId).success) {
    return formError("Invalid staff id.");
  }

  const result = validateFormData(formData, updateStaffProfileSchema);
  if (!result.ok) return result.state as FormState<Record<string, unknown>>;

  // Verify the target user is actually a member of this org.
  const supabase = await createClient();
  const { count: membershipCount } = await supabase
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId);
  if ((membershipCount ?? 0) === 0) {
    return formError("That user isn't a member of this organisation.");
  }

  const emergency =
    result.data.emergency_contact_name ||
    result.data.emergency_contact_phone ||
    result.data.emergency_contact_relationship
      ? {
          name: result.data.emergency_contact_name ?? null,
          phone: result.data.emergency_contact_phone ?? null,
          relationship: result.data.emergency_contact_relationship ?? null,
        }
      : null;

  const { error } = await supabase
    .from("users")
    .update({
      full_name: result.data.full_name ?? null,
      phone: result.data.phone ?? null,
      hourly_pay: result.data.hourly_pay ?? null,
      employment_type: result.data.employment_type ?? null,
      start_date: result.data.start_date ?? null,
      emergency_contact: emergency,
    })
    .eq("id", userId);
  if (error) {
    console.error("[staff] profile update failed", error);
    return formError(
      "Couldn't save changes. Try again.",
      result.data as Record<string, unknown>,
    );
  }

  revalidatePath(`/staff/${userId}`);
  revalidatePath("/staff");
  return formSuccess({ successMessage: "Profile saved." });
}

export async function removeStaff(userId: string) {
  const { ctx } = await requireOrgContext();
  requireAdmin(ctx);
  if (!uuid.safeParse(userId).success) redirect("/staff");

  const supabase = await createClient();
  const { data: target, error: targetError } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", ctx.org.id)
    .eq("user_id", userId)
    .maybeSingle();
  // Loud fail: on a failed read this guard silently passes and the OWNER
  // membership becomes deletable (org lockout).
  if (targetError) throw readFailure("staff: remove-target role", targetError);
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

export async function createRotaEntry(
  _prevState: FormState<Record<string, unknown>>,
  formData: FormData,
): Promise<FormState<Record<string, unknown>>> {
  const { ctx, user } = await requireOrgContext();
  requireAdmin(ctx);

  const result = validateFormData(formData, rotaEntryFormSchema);
  if (!result.ok) return result.state as FormState<Record<string, unknown>>;

  if (new Date(result.data.ends_at) <= new Date(result.data.starts_at)) {
    return formError(
      "End must be after start.",
      result.data as Record<string, unknown>,
    );
  }

  const supabase = await createClient();

  // Conflict check: does the assigned user already have an overlapping
  // shift on this day? Pull a window and compare in-process so we don't
  // require a Postgres range type. The read is pinned to the active org
  // (like deleteRotaEntry below): RLS returns every org the VIEWER belongs
  // to, so without the pin a shift in the user's other org would refuse a
  // legitimate shift here — and leak that the other org's rota exists.
  const dayStart = result.data.starts_at.slice(0, 10);
  const sameDay = await listUserShiftsOnDay(
    supabase as unknown as RotaClient,
    ctx.org.id,
    result.data.user_id,
    dayStart,
  );
  if (sameDay && sameDay.length > 0) {
    const ns = new Date(result.data.starts_at).getTime();
    const ne = new Date(result.data.ends_at).getTime();
    const hit = sameDay.find((s) => {
      const a = new Date(s.starts_at).getTime();
      const b = new Date(s.ends_at).getTime();
      return ns < b && a < ne;
    });
    if (hit) {
      return formError(
        "Conflict: this staff member already has an overlapping shift.",
        result.data as Record<string, unknown>,
      );
    }
  }

  const { error } = await supabase
    .from("rota_entries")
    .insert({
      org_id: ctx.org.id,
      user_id: result.data.user_id,
      job_id: result.data.job_id ?? null,
      starts_at: result.data.starts_at,
      ends_at: result.data.ends_at,
      notes: result.data.notes ?? null,
      created_by: user.id,
    });
  if (error) {
    console.error("[rota] insert failed", error);
    return formError(
      "Couldn't save the shift. Try again.",
      result.data as Record<string, unknown>,
    );
  }

  revalidatePath("/staff/rota");
  return formSuccess({ successMessage: "Shift added." });
}

export async function deleteRotaEntry(entryId: string) {
  const { ctx } = await requireOrgContext();
  requireAdmin(ctx);
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

export async function createLeaveRequest(
  _prevState: FormState<Record<string, unknown>>,
  formData: FormData,
): Promise<FormState<Record<string, unknown>>> {
  const { ctx, user } = await requireOrgContext();
  // Staff can submit their own — no admin gate.

  const result = validateFormData(formData, leaveRequestFormSchema);
  if (!result.ok) return result.state as FormState<Record<string, unknown>>;

  const supabase = await createClient();
  const { error } = await supabase
    .from("leave_requests")
    .insert({
      org_id: ctx.org.id,
      user_id: user.id,
      type: result.data.type,
      starts_at: result.data.starts_at,
      ends_at: result.data.ends_at,
      reason: result.data.reason ?? null,
      status: "pending",
    });
  if (error) {
    console.error("[leave] insert failed", error);
    return formError(
      "Couldn't submit the request. Try again.",
      result.data as Record<string, unknown>,
    );
  }

  // Email owners/admins (in-app notification is handled by DB triggers).
  await notifyOwnersOfLeaveRequest({
    orgId: ctx.org.id,
    orgName: ctx.org.name ?? "",
    requesterId: user.id,
    leave: {
      type: result.data.type,
      starts_at: result.data.starts_at,
      ends_at: result.data.ends_at,
      reason: result.data.reason ?? null,
    },
  });

  revalidatePath("/staff/leave");
  return formSuccess({ successMessage: "Leave request submitted." });
}

export async function reviewLeaveRequest(
  requestId: string,
  formData: FormData,
) {
  const { ctx, user } = await requireOrgContext();
  requireAdmin(ctx);
  if (!uuid.safeParse(requestId).success) redirect("/staff/leave");

  const decision = String(formData.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected") {
    redirect(`/staff/leave/${requestId}?error=invalid_decision`);
  }
  const note = String(formData.get("review_note") ?? "").trim() || null;

  const supabase = await createClient();
  const { data: updated, error, count } = await supabase
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
    .eq("status", "pending") // only review pending
    .select("user_id, type, starts_at, ends_at")
    .maybeSingle();
  if (error) {
    console.error("[leave] review failed", error);
    redirect(`/staff/leave/${requestId}?error=review_failed`);
  }
  if (count === 0 || !updated) {
    redirect(`/staff/leave/${requestId}?error=already_reviewed`);
  }

  // Email the requester (in-app notification handled by DB triggers).
  await notifyStaffOfLeaveDecision({
    requesterId: updated.user_id,
    orgName: ctx.org.name ?? "",
    decision,
    leave: {
      type: updated.type,
      starts_at: updated.starts_at,
      ends_at: updated.ends_at,
    },
    note,
  });

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
