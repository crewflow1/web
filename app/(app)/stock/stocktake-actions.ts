"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  countLineSchema,
  friendlyStocktakeError,
  openStocktakeSchema,
  stocktakeIdSchema,
} from "@/lib/stocktake/schema";
import { findStockItemByCode, type StocktakeClient } from "@/server/services/stocktake";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";

/**
 * STOCKTAKE / CYCLE-COUNT — server actions.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. NOTHING in this file touches `finances`. A     ║
 * ║  variance is a QUANTITY difference; posting it goes through              ║
 * ║  record_stock_adjustment (a quantity-only movement). No form here        ║
 * ║  collects a price. Stock valuation is CEO decision D1 and is UNDECIDED.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * EVERY MUTATION GOES THROUGH AN RPC (20261144000000/01), never a client-side
 * write on the stocktake tables — the RPCs own the snapshot consistency, the
 * lifecycle transitions, the admin-gated posting and the atomic all-or-nothing
 * post. They are SECURITY INVOKER, so the caller's RLS and every guard trigger
 * still apply — not a privileged back door.
 *
 * ACTIVE-ORG PINNING: every RPC call passes `p_org_id: ctx.org.id`, narrowing
 * RLS (which admits every org the caller belongs to) to the company being
 * worked in. Reads go through the org-pinned, loud service layer.
 *
 * Writes use the tenant (user-JWT) client so RLS scopes them and the admin-only
 * post gate applies — never the service-role client, which would bypass both.
 *
 * NO cache revalidation, and every success HARD-NAVIGATES — the same Next 15.5
 * deep-swap commit race documented at length in app/(app)/stock/actions.ts:
 * these routes are dynamic, so there is nothing to revalidate, and a revalidated
 * path in the action response stalls useActionState's commit.
 */

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

// ── open ─────────────────────────────────────────────────────────────────────

export async function openStocktakeSession(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = openStocktakeSchema.safeParse({
    site_id: formData.get("site_id") ?? "",
    reference: formData.get("reference") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the details and try again.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("open_stocktake_session", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_site_id: parsed.data.site_id,
    p_reference: parsed.data.reference ?? null,
    p_notes: parsed.data.notes ?? null,
  });

  if (error || typeof data !== "string") {
    console.error("[stocktake] open failed", error);
    return formError(friendlyStocktakeError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stocktake.opened",
    targetTable: "stocktake_sessions",
    targetId: data,
    metadata: { site_id: parsed.data.site_id, reference: parsed.data.reference ?? null },
  });

  return formSuccess({ redirectTo: `/stock/stocktake/${data}` });
}

// ── counting ─────────────────────────────────────────────────────────────────

export async function startStocktakeCounting(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const id = String(formData.get("session_id") ?? "");
  if (!stocktakeIdSchema.safeParse(id).success) redirect("/stock/stocktake?error=bad_id");

  const supabase = (await createClient()) as unknown as RpcClient;
  const { error } = await supabase.rpc("start_stocktake_counting", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_session_id: id,
  });
  if (error) {
    console.error("[stocktake] start counting failed", error);
    redirect(`/stock/stocktake/${id}?error=start`);
  }
  redirect(`/stock/stocktake/${id}?saved=counting`);
}

/**
 * Record one count. Returns FormState so the count panel shows an inline result
 * without leaving the page (the operator counts many lines in a row).
 */
export async function recordStocktakeCount(
  sessionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!stocktakeIdSchema.safeParse(sessionId).success) return formError("Invalid stocktake.");

  const parsed = countLineSchema.safeParse({
    stock_item_id: formData.get("stock_item_id") ?? "",
    counted_qty: formData.get("counted_qty") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Enter a count.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("record_stocktake_count", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_session_id: sessionId,
    p_stock_item_id: parsed.data.stock_item_id,
    p_counted_qty: parsed.data.counted_qty ?? null,
  });

  if (error || typeof data !== "string") {
    console.error("[stocktake] record count failed", error);
    return formError(friendlyStocktakeError(error?.code, error?.message));
  }

  return formSuccess({ successMessage: "Count saved.", redirectTo: `/stock/stocktake/${sessionId}` });
}

/**
 * Resolve a scanned/typed barcode to an item on this stocktake — scan-to-find.
 *
 * A plain server action (not a form action): the count panel calls it with the
 * decoded barcode and, on a hit, selects that item in the count form. The lookup
 * is org-pinned and loud; the value is never trusted beyond being matched.
 */
export async function resolveScannedItem(
  code: string,
): Promise<{ ok: boolean; itemId?: string; name?: string; message?: string }> {
  const { ctx } = await requireOrgContext();
  const trimmed = (code ?? "").trim();
  if (!trimmed) return { ok: false, message: "Nothing scanned." };

  const supabase = await createClient();
  let item;
  try {
    item = await findStockItemByCode(supabase as unknown as StocktakeClient, ctx.org.id, trimmed);
  } catch (e) {
    console.error("[stocktake] scan lookup failed", e);
    return { ok: false, message: "Couldn't look that up. Try again." };
  }
  if (!item) {
    return { ok: false, message: `No item matches “${trimmed}”. Add its barcode on the item first.` };
  }
  return { ok: true, itemId: item.id, name: item.name };
}

// ── post / cancel ─────────────────────────────────────────────────────────────

/**
 * Post the variances — ADMIN ONLY. The gate that matters is the database's
 * (post_stocktake_session checks is_org_admin, and record_stock_adjustment does
 * too); this early check only turns a raw refusal into a sentence.
 */
export async function postStocktakeSession(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("session_id") ?? "");
  if (!stocktakeIdSchema.safeParse(id).success) redirect("/stock/stocktake?error=bad_id");

  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) redirect(`/stock/stocktake/${id}?error=forbidden`);

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("post_stocktake_session", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_session_id: id,
  });
  if (error || typeof data !== "number") {
    console.error("[stocktake] post failed", error);
    redirect(`/stock/stocktake/${id}?error=post`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stocktake.posted",
    targetTable: "stocktake_sessions",
    targetId: id,
    metadata: { movements_posted: data },
  });

  redirect(`/stock/stocktake/${id}?saved=posted`);
}

export async function cancelStocktakeSession(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("session_id") ?? "");
  if (!stocktakeIdSchema.safeParse(id).success) redirect("/stock/stocktake?error=bad_id");
  const reason = String(formData.get("reason") ?? "");

  const supabase = (await createClient()) as unknown as RpcClient;
  const { error } = await supabase.rpc("cancel_stocktake_session", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_session_id: id,
    p_reason: reason.trim() ? reason.trim() : null,
  });
  if (error) {
    console.error("[stocktake] cancel failed", error);
    redirect(`/stock/stocktake/${id}?error=cancel`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stocktake.cancelled",
    targetTable: "stocktake_sessions",
    targetId: id,
    metadata: {},
  });

  redirect(`/stock/stocktake/${id}?saved=cancelled`);
}
