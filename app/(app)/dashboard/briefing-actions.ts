"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isBriefingItemKey, isDismissibleBriefingKey } from "@/lib/briefing/compose";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";

/**
 * Dismiss a Daily-Briefing item for the caller, for TODAY only.
 *
 * Idempotent (unique constraint + ignoreDuplicates); the item returns tomorrow
 * if the underlying condition still holds. Written on the TENANT client so RLS
 * is the authority — the insert pins `user_id = auth.uid()` and validates
 * `org_id ∈ current_org_ids()`, so a member can never dismiss for another user
 * or tenant. An unknown key is silently ignored (allowlist-validated).
 */
export async function dismissBriefingItem(formData: FormData): Promise<void> {
  const key = String(formData.get("item_key") ?? "");
  // Unknown keys and non-dismissible safety breaches are silently ignored — the
  // server never lets a critical safety item be snoozed even via a crafted POST.
  if (!isBriefingItemKey(key) || !isDismissibleBriefingKey(key)) return;

  const { user, ctx } = await requireOrgContext();
  const supabase = await createClient();
  const today = invoiceBusinessToday();

  await (
    supabase.from("briefing_dismissals" as never) as unknown as {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string; ignoreDuplicates: boolean },
      ) => PromiseLike<{ error: unknown }>;
    }
  ).upsert(
    { org_id: ctx.org.id, user_id: user.id, item_key: key, dismissed_on: today },
    { onConflict: "org_id,user_id,item_key,dismissed_on", ignoreDuplicates: true },
  );

  revalidatePath("/dashboard");
}
