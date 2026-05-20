"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({
  org_id: z.string().uuid(),
  role: z.enum(["admin", "staff"]),
  full_name: z.string().trim().min(1).max(120),
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
    role: formData.get("role"),
    full_name: formData.get("full_name"),
  });
  if (!parsed.success) {
    redirect("/onboarding/join?error=invalid_input");
  }
  const { org_id, role, full_name } = parsed.data;

  // Sanity-check the metadata against the URL form. Don't trust the form
  // alone — only let users join orgs they were actually invited to.
  const meta = (user.user_metadata ?? {}) as {
    invited_org_id?: string;
    invited_role?: string;
  };
  if (meta.invited_org_id !== org_id) {
    redirect("/onboarding/join?error=invite_mismatch");
  }

  const admin = createAdminClient();

  // Update the user's display name.
  await admin.from("users").update({ full_name }).eq("id", user.id);

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

  // Clear the invited_org metadata so subsequent logins skip this page.
  await admin.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...(user.user_metadata ?? {}),
      invited_org_id: null,
      invited_role: null,
    },
  });

  revalidatePath("/", "layout");
  redirect("/dashboard");
}
