"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { generateOpaqueToken } from "@/lib/assets/qr";
import { assetIdSchema } from "@/lib/assets/schema";

/**
 * Asset QR identity actions. Generation/regeneration goes through the atomic
 * rotate RPC (revoke-old + insert-new in one txn); the one-active partial index
 * is the real gate. The token is crypto-random and minted here.
 */

type UpdateActiveChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ error: { message: string } | null; count: number | null }>;
      };
    };
  };
};

export async function generateOrRegenerateQr(assetId: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!assetIdSchema.safeParse(assetId).success) redirect(`/assets?error=bad_id`);

  const tenant = await createClient();
  const token = generateOpaqueToken();
  const { error } = await (
    tenant as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ error: { message: string } | null }>;
    }
  ).rpc("rotate_asset_qr_identity", {
    p_asset_id: assetId,
    p_org_id: ctx.org.id,
    p_token: token,
    p_generated_by: user.id,
  });
  if (error) {
    console.error("[asset-qr] rotate failed", error);
    redirect(`/assets/${assetId}?error=qr_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.qr_generated",
    targetTable: "assets",
    targetId: assetId,
    metadata: {},
  });

  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=qr`);
}

export async function revokeQr(assetId: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!assetIdSchema.safeParse(assetId).success) redirect(`/assets?error=bad_id`);

  const tenant = await createClient();
  // Revoke the current active identity. status='active' filter makes a repeat a
  // no-op (count 0), and old printed labels stop resolving immediately.
  const { error, count } = await (
    tenant.from("asset_qr_identities" as never) as unknown as UpdateActiveChain
  )
    .update(
      { active: false, revoked_at: new Date().toISOString(), revoked_by: user.id, revocation_reason: "revoked" },
      { count: "exact" },
    )
    .eq("asset_id", assetId)
    .eq("org_id", ctx.org.id)
    .eq("active", true);
  if (error) {
    console.error("[asset-qr] revoke failed", error);
    redirect(`/assets/${assetId}?error=qr_failed`);
  }
  if (!count) redirect(`/assets/${assetId}?error=no_active_qr`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.qr_revoked",
    targetTable: "assets",
    targetId: assetId,
    metadata: {},
  });

  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=qr_revoked`);
}
