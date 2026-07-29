"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  adjustmentFormSchema,
  correctionFormSchema,
  friendlyStockError,
  issueFormSchema,
  receiveIntoStockSchema,
  stockIdSchema,
  stockItemFormSchema,
  transferFormSchema,
} from "@/lib/stock/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * OPERATIONAL STOCK — server actions.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. NOTHING in this file touches `finances`.       ║
 * ║  Purchased materials are already expensed by recordSupplierBill; issuing ║
 * ║  stock to a job records a QUANTITY MOVING and posts no new cost, because ║
 * ║  a second posting would double-count the same spend against the same     ║
 * ║  job. No form here collects a price. Stock valuation is CEO decision D1  ║
 * ║  and is UNDECIDED — see docs/operational-stock.md.                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * EVERY MOVEMENT GOES THROUGH AN RPC (20261065000000), never a client-side
 * insert. Three reasons, in order of importance:
 *
 *   1. CORRECTNESS UNDER CONCURRENCY. "Do we have enough?" is a read-then-write
 *      and is only sound under a per-(item, site) advisory lock. Two operators
 *      issuing the last 10 units otherwise both read "10 available" and both
 *      commit. No client sequence can take that lock.
 *   2. ATOMICITY. A transfer is TWO rows that must both exist or neither;
 *      client-side that is a window in which stock has left one depot and
 *      arrived nowhere.
 *   3. RLS STILL APPLIES. The RPCs are SECURITY INVOKER (the
 *      transfer_asset_assignment / post_goods_received_note precedent), so the
 *      caller's policies, every guard trigger and every composite FK are still
 *      in force. This is not a privileged back door.
 *
 * ACTIVE-ORG PINNING is the other invariant. RLS admits every org the caller
 * belongs to; `ctx.org.id` narrows that to the company they are WORKING IN. So
 * every RPC call passes `p_org_id: ctx.org.id` and every by-id write on
 * `stock_items` carries `.eq("org_id", ctx.org.id)` and is COUNT-GATED — a row
 * in the caller's other org matches zero rows and is reported identically to a
 * row that does not exist. __tests__/security/operational-stock.test.ts pins
 * that on source; __tests__/integration/rls/stock-isolation.test.ts proves it
 * against a real dual-org user.
 *
 * All writes use the tenant (user-JWT) client so RLS scopes them — never the
 * service-role client, which would bypass the admin-only adjustment gate.
 *
 * `stock_items` is newer than the generated Supabase types, so calls are cast
 * through minimal precise shapes (the assets / fleet / sites idiom).
 */

type ItemValues = Record<string, unknown>;

type InsertChain = {
  insert: (row: unknown) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  };
};
type UpdateChain = {
  update: (
    row: unknown,
    opts: { count: "exact" },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{
        error: { message: string; code?: string } | null;
        count: number | null;
      }>;
    };
  };
};

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/** The columns the item form owns. `active` is deliberately not one of them. */
function itemColumns(d: ReturnType<typeof stockItemFormSchema.parse>) {
  return {
    name: d.name,
    description: d.description ?? null,
    sku: d.sku ?? null,
    unit: d.unit,
    preferred_supplier_id: d.preferred_supplier_id ?? null,
    supplier_reference: d.supplier_reference ?? null,
    reorder_level: d.reorder_level ?? null,
    target_level: d.target_level ?? null,
    notes: d.notes ?? null,
  };
}

/**
 * THERE IS DELIBERATELY NO cache revalidation IN THIS FILE, AND IT IS NOT AN
 * OVERSIGHT. Two reasons, the second of which took a bisect to find:
 *
 *  1. IT WOULD BUY NOTHING. Every route this milestone touches is rendered on
 *     demand — `/stock`, `/stock/items`, `/stock/items/[id]` and
 *     `/stock/locations/[id]` all declare `export const dynamic =
 *     "force-dynamic"`, and `/purchase-orders/[id]` is dynamic too (it reads
 *     cookies; the build reports it as a dynamic route). There is no cache
 *     entry to invalidate. Every write below then ends in
 *     `window.location.assign`, a FULL DOCUMENT NAVIGATION that fetches the
 *     destination from the server regardless.
 *
 *  2. IT BROKE THE FORMS. Next re-renders the named routes INSIDE the
 *     server-action response. With them in the payload, `useActionState` on
 *     `/stock/items/[id]` never committed the returned state: the movement
 *     landed in the database, the POST came back 200, and the client sat on
 *     "Saving..." for ever — so an operator would issue the same stock twice.
 *     That is the Next 15.5 deep-swap commit race in its action-weight form.
 *     Bisected: three revalidated paths -> hang; one (the current route only)
 *     -> hang; none -> the whole journey green in 1.9s. e2e/stock.spec.ts
 *     drives that journey and fails if they come back.
 *
 * So: nothing is revalidated here, and every write hard-navigates. If a surface
 * here ever becomes statically cached it needs BOTH a cache strategy and a
 * refresh path that does not ride the action response.
 */

// ── the catalogue ────────────────────────────────────────────────────────────

export async function createStockItem(
  _prev: FormState<ItemValues>,
  formData: FormData,
): Promise<FormState<ItemValues>> {
  const { ctx, user } = await requireOrgContext();
  const result = validateFormData(formData, stockItemFormSchema);
  if (!result.ok) return result.state as FormState<ItemValues>;

  const supabase = await createClient();
  const { data, error } = await (
    supabase.from("stock_items" as never) as unknown as InsertChain
  )
    .insert({
      org_id: ctx.org.id,
      ...itemColumns(result.data),
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[stock] create item failed", error);
    return formError(
      friendlyStockError(error?.code, error?.message),
      result.data as ItemValues,
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stock_item.created",
    targetTable: "stock_items",
    targetId: data.id,
    metadata: { name: result.data.name, unit: result.data.unit },
  });

  return formSuccess({
    successMessage: "Item added.",
    redirectTo: `/stock/items/${data.id}`,
  });
}

export async function updateStockItem(
  id: string,
  _prev: FormState<ItemValues>,
  formData: FormData,
): Promise<FormState<ItemValues>> {
  const { ctx, user } = await requireOrgContext();
  if (!stockIdSchema.safeParse(id).success) return formError("Invalid item.");

  const result = validateFormData(formData, stockItemFormSchema);
  if (!result.ok) return result.state as FormState<ItemValues>;

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("stock_items" as never) as unknown as UpdateChain
  )
    .update(
      { ...itemColumns(result.data), updated_at: new Date().toISOString() },
      { count: "exact" },
    )
    .eq("id", id)
    // ACTIVE-ORG SCOPE. `stock_items: members can update` only proves the caller
    // is a member of the item's own org — for a dual-org member that passes for
    // BOTH, so without this an edit issued while working in company A could
    // land on company B's catalogue.
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[stock] update item failed", error);
    return formError(
      friendlyStockError(error.code, error.message),
      result.data as ItemValues,
    );
  }
  if (count === 0) {
    // Not in the ACTIVE org. Identical wording to a missing item on purpose.
    return formError(
      "That item isn't in this organisation any more.",
      result.data as ItemValues,
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stock_item.updated",
    targetTable: "stock_items",
    targetId: id,
    metadata: { name: result.data.name },
  });

  return formSuccess({ successMessage: "Item updated." });
}

/**
 * Retire / reinstate — the ORDINARY way an item leaves the catalogue.
 *
 * There is deliberately NO delete action. Once an item has moved, the ledger's
 * composite FK refuses the delete at commit anyway (append-only history must
 * survive), and a delete that works only for items nobody has ever used is a
 * button that fails exactly when it matters. Retiring drops it out of every
 * picker while leaving every movement readable.
 */
export async function setStockItemActive(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  if (!stockIdSchema.safeParse(id).success) redirect("/stock/items?error=bad_id");
  const active = String(formData.get("active") ?? "") === "true";

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("stock_items" as never) as unknown as UpdateChain
  )
    .update({ active, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id); // ACTIVE-ORG SCOPE

  if (error) {
    console.error("[stock] setStockItemActive failed", error);
    redirect(`/stock/items/${id}?error=save_failed`);
  }
  // Count-gated: an RLS refusal returns no error and zero rows, so a silent
  // no-op must be reported as a refusal rather than as success.
  if (!count) redirect(`/stock/items/${id}?error=forbidden`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: active ? "stock_item.reinstated" : "stock_item.retired",
    targetTable: "stock_items",
    targetId: id,
    metadata: { active },
  });

  redirect(`/stock/items/${id}?saved=${active ? "reinstated" : "retired"}`);
}

// ── movements ───────────────────────────────────────────────────────────────

export async function issueStock(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = issueFormSchema.safeParse({
    stock_item_id: formData.get("stock_item_id") ?? "",
    site_id: formData.get("site_id") ?? "",
    qty: formData.get("qty") ?? "",
    job_id: formData.get("job_id") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the details and try again.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("record_stock_issue", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_item_id: parsed.data.stock_item_id,
    p_site_id: parsed.data.site_id,
    p_qty: parsed.data.qty,
    p_job_id: parsed.data.job_id ?? null,
    // THE FROZEN CONTRACT with the M4 material-requests lane. Always sent, even
    // as null, so the named-argument shape this surface uses is the same one
    // M4 will call — a signature that is only ever exercised with the parameter
    // omitted is a signature nobody has tested.
    p_material_request_line_id: null,
    p_notes: parsed.data.notes ?? null,
  });

  if (error || typeof data !== "string") {
    console.error("[stock] issue failed", error);
    return formError(friendlyStockError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stock.issued",
    targetTable: "stock_movements",
    targetId: data,
    metadata: {
      stock_item_id: parsed.data.stock_item_id,
      site_id: parsed.data.site_id,
      qty: parsed.data.qty,
      job_id: parsed.data.job_id ?? null,
    },
  });

  return formSuccess({
    redirectTo: `/stock/items/${parsed.data.stock_item_id}?saved=issued`,
  });
}

export async function transferStock(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = transferFormSchema.safeParse({
    stock_item_id: formData.get("stock_item_id") ?? "",
    from_site_id: formData.get("from_site_id") ?? "",
    to_site_id: formData.get("to_site_id") ?? "",
    qty: formData.get("qty") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the details and try again.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("record_stock_transfer", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_item_id: parsed.data.stock_item_id,
    p_from_site_id: parsed.data.from_site_id,
    p_to_site_id: parsed.data.to_site_id,
    p_qty: parsed.data.qty,
    p_notes: parsed.data.notes ?? null,
  });

  if (error || typeof data !== "string") {
    console.error("[stock] transfer failed", error);
    return formError(friendlyStockError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stock.transferred",
    targetTable: "stock_movements",
    targetId: data,
    metadata: {
      stock_item_id: parsed.data.stock_item_id,
      from_site_id: parsed.data.from_site_id,
      to_site_id: parsed.data.to_site_id,
      qty: parsed.data.qty,
    },
  });

  return formSuccess({
    redirectTo: `/stock/items/${parsed.data.stock_item_id}?saved=transferred`,
  });
}

/**
 * ADMIN ONLY — and the gate that matters is the database's
 * (`record_stock_adjustment` checks `is_org_admin`), not this one. The check
 * below exists so a member sees a sentence instead of a raw refusal; removing
 * it would change the message, never the outcome.
 */
export async function adjustStock(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) {
    return formError("Only an owner or admin can adjust stock.");
  }

  const parsed = adjustmentFormSchema.safeParse({
    stock_item_id: formData.get("stock_item_id") ?? "",
    site_id: formData.get("site_id") ?? "",
    delta: formData.get("delta") ?? "",
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the details and try again.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("record_stock_adjustment", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_item_id: parsed.data.stock_item_id,
    p_site_id: parsed.data.site_id,
    p_delta: parsed.data.delta,
    p_reason: parsed.data.reason,
  });

  if (error || typeof data !== "string") {
    console.error("[stock] adjustment failed", error);
    return formError(friendlyStockError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stock.adjusted",
    targetTable: "stock_movements",
    targetId: data,
    metadata: {
      stock_item_id: parsed.data.stock_item_id,
      site_id: parsed.data.site_id,
      delta: parsed.data.delta,
      reason: parsed.data.reason,
    },
  });

  return formSuccess({
    redirectTo: `/stock/items/${parsed.data.stock_item_id}?saved=adjusted`,
  });
}

/**
 * Reverse one movement, in full, with a reason.
 *
 * The ONLY way an existing movement is undone — the ledger is append-only, so
 * this writes a NEW row and the original stays visible for ever.
 */
export async function correctStockMovement(
  itemId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = correctionFormSchema.safeParse({
    movement_id: formData.get("movement_id") ?? "",
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Say why this is being reversed.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("record_stock_correction", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_movement_id: parsed.data.movement_id,
    p_reason: parsed.data.reason,
  });

  if (error || typeof data !== "string") {
    console.error("[stock] correction failed", error);
    return formError(friendlyStockError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stock.corrected",
    targetTable: "stock_movements",
    targetId: data,
    metadata: { corrects: parsed.data.movement_id, reason: parsed.data.reason },
  });

  const safeItemId = stockIdSchema.safeParse(itemId).success ? itemId : undefined;
  return formSuccess({
    successMessage: "Movement reversed.",
    redirectTo: safeItemId ? `/stock/items/${safeItemId}?saved=corrected` : "/stock",
  });
}

/**
 * Take a POSTED delivery line into stock — the GRN → stock bridge, called from
 * the purchase-order surface.
 *
 * THE HUMAN PICKS THE ITEM AND THE SITE. Purchase-order lines are FREE TEXT
 * (20261006000000), so "Cement 25kg bags x40" is not a stock identity and
 * nothing here tries to infer one. Guessing wrong does not produce a
 * slightly-off report — it produces a balance for the wrong product that
 * somebody later counts against and cannot reconcile. Nothing speculative is
 * persisted: no draft mapping, no remembered guess.
 *
 * The QUANTITY is not sent: the RPC reads it from the posted delivery line, so
 * what goes into stock is exactly what the evidence says arrived.
 */
export async function receiveIntoStock(
  purchaseOrderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = receiveIntoStockSchema.safeParse({
    grn_line_id: formData.get("grn_line_id") ?? "",
    stock_item_id: formData.get("stock_item_id") ?? "",
    site_id: formData.get("site_id") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Pick an item and a place.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("record_stock_receipt_from_grn", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_grn_line_id: parsed.data.grn_line_id,
    p_item_id: parsed.data.stock_item_id,
    p_site_id: parsed.data.site_id,
    p_notes: null,
  });

  if (error || typeof data !== "string") {
    console.error("[stock] receive into stock failed", error);
    return formError(friendlyStockError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stock.received",
    targetTable: "stock_movements",
    targetId: data,
    metadata: {
      grn_line_id: parsed.data.grn_line_id,
      stock_item_id: parsed.data.stock_item_id,
      site_id: parsed.data.site_id,
    },
  });

  const poId = stockIdSchema.safeParse(purchaseOrderId).success ? purchaseOrderId : null;
  return formSuccess({
    successMessage: "Added to stock.",
    redirectTo: poId ? `/purchase-orders/${poId}?stocked=${data}` : "/stock",
  });
}
