"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createOverrideSchema,
  friendlyOverrideError,
  revokeOverrideSchema,
} from "@/lib/assets/inspection-override";

/**
 * Safety-override actions (M4d). ADMIN-ONLY at the action AND at RLS (the
 * dual-gate pattern) — ordinary staff fail server-side. An override never
 * touches the inspection it bypasses; expiry re-blocks purely by the guard's
 * time predicate (no cron, no state flip); revocation is write-once.
 */

function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

type InsertOne = {
  insert: (row: unknown) => {
    select: (c: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  };
};
type RevokeChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        is: (
          k: string,
          v: null,
        ) => Promise<{ error: { message: string; code?: string } | null; count: number | null }>;
      };
    };
  };
};

export async function createInspectionOverride(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const parsed = createOverrideSchema.safeParse({
    asset_id: assetId,
    inspection_id: formData.get("inspection_id"),
    reason: formData.get("reason"),
    expires_at: formData.get("expires_at")
      ? new Date(String(formData.get("expires_at"))).toISOString()
      : undefined,
  });
  if (!parsed.success) redirect(`/assets/${assetId}?error=override_invalid`);

  const tenant = await createClient();
  const { data, error } = await (
    tenant.from("asset_inspection_overrides" as never) as unknown as InsertOne
  )
    .insert({
      org_id: ctx.org.id,
      asset_id: assetId,
      inspection_id: parsed.data.inspection_id,
      reason: parsed.data.reason,
      expires_at: parsed.data.expires_at ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-override] create failed", error);
    redirect(
      `/assets/${assetId}?error=${encodeURIComponent(friendlyOverrideError(error?.code, error?.message))}`,
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_override_created",
    targetTable: "asset_inspection_overrides",
    targetId: data.id,
    metadata: {
      asset_id: assetId,
      inspection_id: parsed.data.inspection_id,
      expires_at: parsed.data.expires_at ?? null,
    },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=override`);
}

export async function revokeInspectionOverride(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const parsed = revokeOverrideSchema.safeParse({
    override_id: formData.get("override_id"),
    revoke_reason: formData.get("revoke_reason"),
  });
  if (!parsed.success) redirect(`/assets/${assetId}?error=override_invalid`);

  const tenant = await createClient();
  // Write-once: only an un-revoked row matches; a repeat is a friendly no-op.
  const { error, count } = await (
    tenant.from("asset_inspection_overrides" as never) as unknown as RevokeChain
  )
    .update(
      {
        revoked_at: new Date().toISOString(),
        revoked_by: user.id,
        revoke_reason: parsed.data.revoke_reason ?? null,
      },
      { count: "exact" },
    )
    .eq("id", parsed.data.override_id)
    .eq("org_id", ctx.org.id)
    .is("revoked_at", null);
  if (error) {
    console.error("[asset-override] revoke failed", error);
    redirect(`/assets/${assetId}?error=override_failed`);
  }
  if (!count) redirect(`/assets/${assetId}?error=override_already_revoked`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_override_revoked",
    targetTable: "asset_inspection_overrides",
    targetId: parsed.data.override_id,
    metadata: { asset_id: assetId },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=override_revoked`);
}
