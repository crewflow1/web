"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({
  org_id: z.string().uuid(),
  full_name: z.string().trim().min(1).max(120),
  // NOTE: `role` is intentionally NOT parsed from the form. The membership
  // role is derived below from the server-set invite metadata, never from
  // client-supplied input — see the SECURITY note in acceptOrgInvite.
});

/**
 * Accept a staff invite by inserting the membership and (if the public.users
 * row is empty) populating it. Service-role write because the new user
 * doesn't yet have any RLS-eligible relationship to the org.
 */
export async function acceptOrgInvite(formData: FormData) {
  const user = await requireUser();
  const parsed = schema.safeParse({
    org_id: formData.get("org_id"),
    full_name: formData.get("full_name"),
  });
  if (!parsed.success) {
    redirect("/onboarding/join?error=invalid_input");
  }
  const { org_id, full_name } = parsed.data;

  // SECURITY: the invite's org + role come from `app_metadata` — the admin-only
  // (service-role-only) metadata bucket set by sendStaffInvite. They are
  // DELIBERATELY NOT read from `user_metadata`: that bucket is writable by the
  // user themselves via supabase.auth.updateUser({ data }), so anchoring authz
  // there let a self-signed-up attacker set invited_org_id=<victim-org> +
  // invited_role=admin on their OWN metadata and join any org as admin. Only
  // app_metadata is out of the user's reach, so it is the authority here.
  const authz = (user.app_metadata ?? {}) as {
    invited_org_id?: string;
    invited_role?: string;
  };
  if (authz.invited_org_id !== org_id) {
    redirect("/onboarding/join?error=invite_mismatch");
  }
  // Role from the admin-only invite anchor, never the client `role` form field
  // and never user_metadata. Owner is never grantable via invite-accept
  // (bootstrap-only, same rule as inviteStaff in app/(app)/staff/actions.ts).
  const role = authz.invited_role === "admin" ? "admin" : "staff";

  const admin = createAdminClient();

  // Hydrate the public.users row from the form + the invite metadata.
  // Profile pre-fill only writes columns that are currently null/empty so
  // we never overwrite something the user set themselves.
  // Profile pre-fill also comes from the admin-only app_metadata (invited_* are
  // all admin-set at invite time; keeping them out of user_metadata stops an
  // invitee seeding their own hourly_pay etc.).
  const metaInvitee = (user.app_metadata ?? {}) as {
    invited_full_name?: string | null;
    invited_employment_type?: string | null;
    invited_hourly_pay?: number | null;
    invited_emergency_contact?: {
      name?: string | null;
      phone?: string | null;
      relationship?: string | null;
    } | null;
  };
  const { data: profile } = await admin
    .from("users")
    .select("full_name, hourly_pay, employment_type, emergency_contact")
    .eq("id", user.id)
    .maybeSingle();
  type UserUpdate = {
    full_name: string;
    hourly_pay?: number;
    employment_type?: string;
    emergency_contact?: {
      name?: string | null;
      phone?: string | null;
      relationship?: string | null;
    };
  };
  const profileUpdates: UserUpdate = { full_name };
  if (profile && profile.hourly_pay === null && typeof metaInvitee.invited_hourly_pay === "number") {
    profileUpdates.hourly_pay = metaInvitee.invited_hourly_pay;
  }
  if (profile && !profile.employment_type && metaInvitee.invited_employment_type) {
    profileUpdates.employment_type = metaInvitee.invited_employment_type;
  }
  if (profile && !profile.emergency_contact && metaInvitee.invited_emergency_contact) {
    profileUpdates.emergency_contact = metaInvitee.invited_emergency_contact;
  }
  await admin.from("users").update(profileUpdates).eq("id", user.id);

  // Create the membership (or no-op if it already exists).
  const { data: existing } = await admin
    .from("memberships")
    .select("id")
    .eq("org_id", org_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!existing) {
    const { error } = await admin
      .from("memberships")
      .insert({ org_id, user_id: user.id, role });
    if (error) {
      console.error("[onboarding/join] insert failed", error);
      redirect("/onboarding/join?error=join_failed");
    }
  }

  // Clear the invited_* anchor (now in app_metadata) so subsequent logins skip
  // this page and the one-time invite cannot be replayed.
  await admin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...(user.app_metadata ?? {}),
      invited_org_id: null,
      invited_role: null,
      invited_full_name: null,
      invited_phone: null,
      invited_employment_type: null,
      invited_hourly_pay: null,
      invited_emergency_contact: null,
      source: null,
    },
  });

  revalidatePath("/", "layout");
  redirect("/dashboard");
}
