"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";

const ACTIVE_ORG_COOKIE = "active_org_id";

/**
 * Set the active organisation for the signed-in user.
 *
 * Validates that the user is actually a member of the target org before
 * setting the cookie — we never trust the client to pick an org without
 * a server-side membership check. After setting, redirects to /dashboard
 * so every section of the app re-renders against the new org context.
 */
export async function setActiveOrg(formData: FormData) {
  const orgIdRaw = formData.get("org_id");
  if (typeof orgIdRaw !== "string" || !/^[0-9a-f-]{36}$/i.test(orgIdRaw)) {
    redirect("/dashboard?error=invalid_org");
  }
  const orgId = orgIdRaw as string;

  const user = await requireUser();
  const supabase = await createClient();

  // Membership check runs under the user's JWT → RLS already filters to
  // this user's rows. If the row exists, they're a member.
  const { data: membership, error } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[org-switch] membership lookup failed", error);
    redirect("/dashboard?error=switch_failed");
  }
  if (!membership) {
    redirect("/dashboard?error=not_a_member");
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  redirect("/dashboard");
}
