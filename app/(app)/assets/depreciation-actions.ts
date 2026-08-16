"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  depreciationPolicySchema,
  friendlyDepreciationError,
} from "@/lib/assets/depreciation";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Depreciation policy actions (P3W2) — one row per asset governing the computed
 * net book value. Finance policy ⇒ admin-only at RLS AND here (dual gate),
 * matching asset_service_schedules. NBV itself is never written: it is derived
 * on read by lib/assets/depreciation.ts from the policy saved here.
 *
 * Returns `FormState` and navigates via `redirectTo` through <StateForm> (a full
 * document load), never `redirect()`: a same-route ?saved= redirect back to
 * /assets/[id] swaps the page segment and loses the Next 15.5 stranded-commit
 * race. No revalidatePath — these surfaces render per-request (cookie-authed).
 */

function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

type UpsertOne = {
  upsert: (
    row: unknown,
    opts: { onConflict: string },
  ) => Promise<{ error: { message: string; code?: string } | null }>;
};
type DeleteChain = {
  delete: (opts?: { count?: string }) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};

export async function saveDepreciationSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  if (!isAdmin(ctx.membership.role)) return formError("Only an owner or admin can do that.");

  const parsed = depreciationPolicySchema.safeParse({
    asset_id: assetId,
    method: formData.get("method"),
    cost: formData.get("cost"),
    salvage_value: formData.get("salvage_value"),
    start_date: formData.get("start_date"),
    useful_life_months: formData.get("useful_life_months"),
    annual_rate_pct: formData.get("annual_rate_pct"),
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Please check the depreciation settings.");
  }
  const d = parsed.data;

  const tenant = await createClient();
  // Composite FK (asset_id, org_id) → assets(id, org_id) enforces same-org; the
  // org_id we write is always the ACTIVE org, so a policy can never anchor onto
  // another tenant's asset.
  const { error } = await (
    tenant.from("asset_depreciation_settings" as never) as unknown as UpsertOne
  ).upsert(
    {
      asset_id: assetId,
      org_id: ctx.org.id,
      method: d.method,
      cost: d.cost,
      salvage_value: d.salvage_value,
      start_date: d.start_date,
      useful_life_months: d.method === "straight_line" ? d.useful_life_months : null,
      annual_rate_pct: d.method === "reducing_balance" ? d.annual_rate_pct : null,
      created_by: user.id,
      updated_by: user.id,
    },
    { onConflict: "asset_id" },
  );
  if (error) {
    console.error("[asset-depreciation] save failed", error);
    return formError(friendlyDepreciationError(error.code, error.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.depreciation_saved",
    targetTable: "asset_depreciation_settings",
    targetId: assetId,
    metadata: { asset_id: assetId, method: d.method },
  });
  return formSuccess({ redirectTo: `/assets/${assetId}?saved=depreciation` });
}

export async function clearDepreciationSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  if (!isAdmin(ctx.membership.role)) return formError("Only an owner or admin can do that.");

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_depreciation_settings" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("asset_id", assetId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[asset-depreciation] clear failed", error);
    return formError("Couldn't clear the depreciation settings. Try again.");
  }
  if (!count) return formError("No depreciation settings to clear.");

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.depreciation_cleared",
    targetTable: "asset_depreciation_settings",
    targetId: assetId,
    metadata: { asset_id: assetId },
  });
  return formSuccess({ redirectTo: `/assets/${assetId}?saved=depreciation_cleared` });
}
