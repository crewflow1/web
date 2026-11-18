"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

/**
 * Settings → AI features — owner action. The org comes from the SESSION, never
 * the form. Owner is checked here AND inside ai_owner_set_ai_enabled (SECURITY
 * DEFINER, 42501 for a non-owner), which also writes the audit row.
 */
export async function setAiEnabledAction(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const enabled = formData.get("enabled") === "true";
  if (ctx.membership.role !== "owner") {
    redirect("/settings/ai-features?error=owner");
  }
  const supabase = await createClient();
  const { error } = await (
    supabase as unknown as {
      rpc(
        fn: string,
        args: Record<string, unknown>,
      ): PromiseLike<{ error: { message: string } | null }>;
    }
  ).rpc("ai_owner_set_ai_enabled", { p_org_id: ctx.org.id, p_enabled: enabled });
  if (error) {
    console.error("[settings/ai-features] set failed", error);
    redirect("/settings/ai-features?error=save");
  }
  revalidatePath("/settings/ai-features");
  redirect("/settings/ai-features?saved=1");
}
