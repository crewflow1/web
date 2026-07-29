"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";

/**
 * Goods-received server actions (Warehouse M1).
 *
 * BOTH writes go through SECURITY INVOKER RPCs — post_goods_received_note and
 * void_goods_received_note (migration 20261060000000) — rather than a sequence
 * of client statements. Three reasons, in order of importance:
 *
 *   1. ATOMICITY. A delivery is a note PLUS its lines PLUS the order's status.
 *      Done from the client that is three round trips with two windows in which
 *      a crash leaves a note with no lines, or lines nobody counted. A function
 *      body is one transaction.
 *   2. CORRECTNESS UNDER CONCURRENCY. The over-receipt check is a
 *      read-then-write, so it is only sound if posts against one order are
 *      serialised. The RPC takes pg_advisory_xact_lock on the purchase order;
 *      no client-side sequence can.
 *   3. RLS STILL APPLIES. SECURITY INVOKER (the transfer_asset_assignment
 *      precedent) means the caller's policies, every guard trigger and both
 *      composite FKs are still in force — this is not a privileged back door.
 *
 * ACTIVE-ORG PINNING: every call passes ctx.org.id and every read carries
 * `.eq("org_id", ctx.org.id)`. RLS admits every org the user belongs to, so for
 * a dual-org member RLS alone would let a delivery be booked against the OTHER
 * company's order. The pin is what makes "the company I am working in" real.
 *
 * NOTHING HERE TOUCHES `finances`. Receiving is operational; the cost still
 * lands exactly once, when recordSupplierBill posts the supplier's invoice.
 *
 * goods_received_notes / goods_received_lines are not in the generated Supabase
 * types yet — readers and writers are cast (`as never`), the established idiom.
 */

const idSchema = z.string().uuid();

const receiveLineSchema = z.object({
  line_item_id: z.string().uuid(),
  qty_received: z.coerce.number().positive().max(9_999_999),
});

const receiveSchema = z.object({
  delivery_date: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  ),
  delivery_note_reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(120).optional(),
  ),
  delivery_location: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(200).optional(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(2000).optional(),
  ),
  lines: z.array(receiveLineSchema).min(1, "Enter what arrived on at least one line"),
});

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
};

/**
 * Postgres RAISE messages from the receiving functions are written for the
 * person standing at the lorry, so they are surfaced as-is for the checks we
 * own. Anything unrecognised falls back to a generic line — a raw driver error
 * must never reach the yard.
 */
function receivingErrorMessage(message: string | undefined): string {
  const m = (message ?? "").trim();
  if (!m) return "Couldn't record the delivery. Try again.";
  if (m.includes("over-receipt")) {
    return `More arrived than was ordered — ${m.replace(/^.*over-receipt:\s*/, "")}. Split the delivery or amend the order.`;
  }
  if (m.includes("purchase order not found") || m.includes("goods received note not found")) {
    return "That purchase order isn't in the company you're working in.";
  }
  if (m.includes("cannot take a delivery")) {
    return "Send this order to the supplier before booking a delivery against it.";
  }
  if (m.includes("appears twice")) return "The same line is listed twice — combine it into one row.";
  if (m.includes("above zero")) return "Enter a quantity above zero for every line you're receiving.";
  if (m.includes("needs a reason")) return "Say why you're voiding this delivery.";
  if (m.includes("already been voided")) return "This delivery has already been voided.";
  if (m.includes("is not on this purchase order")) return "That line isn't on this order.";
  return "Couldn't record the delivery. Try again.";
}

export async function receiveDelivery(
  purchaseOrderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(purchaseOrderId).success) {
    return formError("Invalid purchase order.");
  }

  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    lines = [];
  }

  const parsed = receiveSchema.safeParse({
    delivery_date: formData.get("delivery_date") ?? "",
    delivery_note_reference: formData.get("delivery_note_reference") ?? "",
    delivery_location: formData.get("delivery_location") ?? "",
    notes: formData.get("notes") ?? "",
    lines,
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the delivery and try again.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("post_goods_received_note", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_purchase_order_id: purchaseOrderId,
    p_delivery_date: parsed.data.delivery_date ?? null,
    p_delivery_note_reference: parsed.data.delivery_note_reference ?? null,
    p_delivery_location: parsed.data.delivery_location ?? null,
    p_notes: parsed.data.notes ?? null,
    p_received_by: user.id,
    p_lines: parsed.data.lines,
  });

  if (error || typeof data !== "string") {
    console.error("[purchase-orders] receive delivery failed", error);
    return formError(receivingErrorMessage(error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.delivery_received",
    targetTable: "goods_received_notes",
    targetId: data,
    metadata: {
      purchase_order_id: purchaseOrderId,
      lines: parsed.data.lines.length,
      reference: parsed.data.delivery_note_reference ?? null,
    },
  });

  revalidatePath(`/purchase-orders/${purchaseOrderId}`);
  revalidatePath("/purchase-orders");
  return formSuccess({
    // Land back on the order with the new note expanded, so the delivery-note
    // photo can go straight onto the record that was just created.
    redirectTo: `/purchase-orders/${purchaseOrderId}?received=${data}`,
  });
}

export async function voidDelivery(
  grnId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(grnId).success) return formError("Invalid delivery.");

  const reason = String(formData.get("void_reason") ?? "").trim();
  if (!reason) return formError("Say why you're voiding this delivery.");
  if (reason.length > 500) return formError("Keep the reason under 500 characters.");

  const supabase = (await createClient()) as unknown as RpcClient;
  const { error } = await supabase.rpc("void_goods_received_note", {
    p_grn_id: grnId,
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_reason: reason,
  });
  if (error) {
    console.error("[purchase-orders] void delivery failed", error);
    return formError(receivingErrorMessage(error.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.delivery_voided",
    targetTable: "goods_received_notes",
    targetId: grnId,
    metadata: { reason },
  });

  const poId = String(formData.get("purchase_order_id") ?? "");
  if (idSchema.safeParse(poId).success) revalidatePath(`/purchase-orders/${poId}`);
  revalidatePath("/purchase-orders");
  return formSuccess({ successMessage: "Delivery voided." });
}
