"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { generateOpaqueToken } from "@/lib/assets/qr-token";
import { assetIdSchema } from "@/lib/assets/schema";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Asset QR identity actions. Generation/regeneration goes through the atomic
 * rotate RPC (revoke-old + insert-new in one txn); the one-active partial index
 * is the real gate. The token is crypto-random and minted here.
 *
 * These actions return `FormState` (the client navigates via `redirectTo`
 * through <StateForm>, a full document load) instead of calling `redirect()`:
 * a Server-Action redirect back to /assets/[id] swaps the page segment itself
 * and loses the Next 15.5 stranded-commit race (upstream vercel/next.js#83386):
 * the row is written but the URL never changes and no error surfaces. See
 * components/forms/StateForm.tsx. No revalidatePath, deliberately: these
 * surfaces render per-request (cookie-authed reads, no Next data cache), so
 * revalidating only added weight to the racy action response.
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

export async function generateOrRegenerateQr(
  assetId: string,
  _prev: FormState, _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!assetIdSchema.safeParse(assetId).success) return formError("Invalid asset.");

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
    return formError("Couldn't update the QR identity. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.qr_generated",
    targetTable: "assets",
    targetId: assetId,
    metadata: {},
  });

  return formSuccess({ redirectTo: `/assets/${assetId}?saved=qr` });
}

export async function revokeQr(
  assetId: string,
  _prev: FormState, _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!assetIdSchema.safeParse(assetId).success) return formError("Invalid asset.");

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
    return formError("Couldn't update the QR identity. Try again.");
  }
  if (!count) return formError("This asset has no active QR identity.");

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.qr_revoked",
    targetTable: "assets",
    targetId: assetId,
    metadata: {},
  });

  return formSuccess({ redirectTo: `/assets/${assetId}?saved=qr_revoked` });
}
