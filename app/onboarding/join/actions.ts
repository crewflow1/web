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

  // Sanity-check the metadata against the URL form. Don't trust the form
  // alone — only let users join orgs they were actually invited to.
  const meta = (user.user_metadata ?? {}) as {
    invited_org_id?: string;
    invited_role?: string;
  };
  if (meta.invited_org_id !== org_id) {
    redirect("/onboarding/join?error=invite_mismatch");
  }

  // SECURITY: the membership role is taken from the server-set invite metadata
  // (user_metadata.invited_role), NEVER the hidden `role` form field. That
  // field is client-controllable, so trusting it let a staff invitee POST
  // role=admin and self-promote past the role they were actually invited as —
  // the invited_org_id check above still passed. Mirror the page's derivation
  // (app/onboarding/join/page.tsx); owner is never grantable via invite-accept
  // (bootstrap-only, same rule as inviteStaff in app/(app)/staff/actions.ts).
  const role = meta.invited_role === "admin" ? "admin" : "staff";

  const admin = createAdminClient();

  // Hydrate the public.users row from the form + the invite metadata.
  // Profile pre-fill only writes columns that are currently null/empty so
  // we never overwrite something the user set themselves.
  const metaInvitee = (user.user_metadata ?? {}) as {
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

  // Clear the invited_* metadata so subsequent logins skip this page.
  await admin.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...(user.user_metadata ?? {}),
      invited_org_id: null,
      invited_role: null,
      invited_full_name: null,
      invited_employment_type: null,
      invited_hourly_pay: null,
      invited_emergency_contact: null,
    },
  });

  revalidatePath("/", "layout");
  redirect("/dashboard");
}
