"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  formError,
  formSuccess,
  type FormState,
} from "@/lib/forms/state";
import { parseRetentionPolicyInput } from "@/lib/retention/policy";
import { previewPolicy } from "@/server/services/retention-purge";

/**
 * Settings → Data retention — admin actions.
 *
 *   saveRetentionPolicy — upsert one (org, table) policy (window + enabled).
 *   previewRetentionPolicy — dry-run the primitive for one table and report the
 *                            "what WOULD be purged" count (deletes nothing).
 *
 * AUTHORISATION. org_id ALWAYS comes from requireOrgContext (the session), never
 * from client input. Admin (owner/admin) is enforced here AND at the DB —
 * retention_policies RLS is admin-write (is_org_admin) — so a non-admin calling
 * the action directly is refused twice. Route depth is 2 (/settings), so
 * returning a FormState (no redirect) is safe.
 *
 * The target table is validated against the POSITIVE ALLOWLIST in
 * lib/retention/policy.ts before any write; a non-purgeable / protected table is
 * rejected before touching the DB (and the CHECK + primitive would reject it too).
 */

type RetentionValues = {
  target_table?: string;
  retention_days?: string;
  enabled?: string;
  rows_matched?: number;
  cutoff?: string | null;
};

async function requireAdmin() {
  const { ctx, user } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  return { ctx, user, isAdmin };
}

export async function saveRetentionPolicy(
  _prev: FormState<RetentionValues>,
  formData: FormData,
): Promise<FormState<RetentionValues>> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!isAdmin) {
    return formError("Only admins/owners can change data-retention policies.");
  }

  const parsed = parseRetentionPolicyInput({
    targetTable: formData.get("target_table"),
    retentionDays: formData.get("retention_days"),
    enabled: formData.get("enabled"),
  });
  if (!parsed.ok) {
    return formError(parsed.error, {
      target_table: String(formData.get("target_table") ?? ""),
      retention_days: String(formData.get("retention_days") ?? ""),
    });
  }

  const supabase = await createClient();
  // Upsert the single (org, table) row. RLS admin-write is the second gate: even
  // if the role check above were bypassed, a non-admin's upsert writes zero rows.
  // types.ts predates migration 20261184000000, so reach the new table through a
  // loose cast (the same idiom settings/page.tsx uses for ai_receptionist_setups).
  const { error } = await (
    supabase.from("retention_policies" as never) as unknown as {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => Promise<{ error: { message: string } | null }>;
    }
  ).upsert(
    {
      org_id: ctx.org.id,
      table_name: parsed.value.targetTable,
      retention_days: parsed.value.retentionDays,
      enabled: parsed.value.enabled,
      created_by: user.id,
    },
    { onConflict: "org_id,table_name" },
  );
  if (error) {
    return formError("Couldn't save that policy. Try again.");
  }

  revalidatePath("/settings/data-retention");
  return formSuccess({
    successMessage: parsed.value.enabled
      ? "Retention policy saved and enabled."
      : "Retention policy saved (disabled — nothing will be purged).",
    values: {
      target_table: parsed.value.targetTable,
      retention_days: String(parsed.value.retentionDays),
      enabled: parsed.value.enabled ? "on" : "",
    },
  });
}

export async function previewRetentionPolicy(
  _prev: FormState<RetentionValues>,
  formData: FormData,
): Promise<FormState<RetentionValues>> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!isAdmin) {
    return formError("Only admins/owners can preview data-retention purges.");
  }

  const parsed = parseRetentionPolicyInput({
    targetTable: formData.get("target_table"),
    retentionDays: formData.get("retention_days"),
    // Preview doesn't care about enabled; pass a stable value so validation
    // focuses on the table + window.
    enabled: "on",
  });
  if (!parsed.ok) {
    return formError(parsed.error, {
      target_table: String(formData.get("target_table") ?? ""),
      retention_days: String(formData.get("retention_days") ?? ""),
    });
  }

  try {
    const result = await previewPolicy({
      orgId: ctx.org.id,
      targetTable: parsed.value.targetTable,
      retentionDays: parsed.value.retentionDays,
      requestedBy: user.id,
    });
    revalidatePath("/settings/data-retention");
    return formSuccess({
      successMessage:
        result.rowsMatched === 0
          ? "Preview: no rows are older than this window yet — nothing would be purged."
          : `Preview: ${result.rowsMatched.toLocaleString()} row${result.rowsMatched === 1 ? "" : "s"} would be purged (older than ${parsed.value.retentionDays} days).`,
      values: {
        target_table: parsed.value.targetTable,
        retention_days: String(parsed.value.retentionDays),
        rows_matched: result.rowsMatched,
        cutoff: result.cutoff,
      },
    });
  } catch {
    return formError("Couldn't run the preview. Try again.");
  }
}
