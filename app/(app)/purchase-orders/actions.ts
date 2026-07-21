"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { computeTotals } from "@/lib/quotes/totals";
import {
  canTransitionPo,
  purchaseOrderFormSchema,
  PO_STATUSES,
  type PurchaseOrderFormInput,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders/schema";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";
import { z } from "zod";

/**
 * Purchase-order server actions (Programme C).
 *
 * RLS: members select/insert/update within their org; admins delete. A PO is
 * committed spend — it never posts to `finances` (that happens when a supplier
 * bill is recorded, a later slice), so there is no double-counting.
 *
 * purchase_orders / purchase_order_line_items are not yet in the generated
 * Supabase types — the writers are cast (`as never`), the established idiom.
 */

const idSchema = z.string().uuid();

function parsePoForm(formData: FormData) {
  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get("line_items") ?? "[]"));
  } catch {
    lines = [];
  }
  return purchaseOrderFormSchema.safeParse({
    supplier_id: formData.get("supplier_id") ?? "",
    job_id: formData.get("job_id") ?? "",
    supplier_reference: formData.get("supplier_reference") ?? "",
    expected_date: formData.get("expected_date") ?? "",
    notes: formData.get("notes") ?? "",
    line_items: lines,
  });
}

type PoLineInsert = {
  org_id: string;
  purchase_order_id: string;
  description: string;
  qty: number;
  unit: string;
  unit_price: number;
  vat_rate: number;
  line_total: number;
  sort_order: number;
};

async function insertLines(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  poId: string,
  data: PurchaseOrderFormInput,
): Promise<{ error: { message: string } | null }> {
  const totals = computeTotals(data.line_items);
  const rows: PoLineInsert[] = data.line_items.map((li, idx) => ({
    org_id: orgId,
    purchase_order_id: poId,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
    line_total: totals.lines[idx]?.line_total ?? 0,
    sort_order: idx,
  }));
  return (
    supabase.from("purchase_order_line_items" as never) as unknown as {
      insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert(rows);
}

export async function createPurchaseOrder(
  _prev: FormState<PurchaseOrderFormInput>,
  formData: FormData,
): Promise<FormState<PurchaseOrderFormInput>> {
  const { ctx, user } = await requireOrgContext();
  const parsed = parsePoForm(formData);
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the purchase order and try again.");
  }

  const supabase = await createClient();
  const totals = computeTotals(parsed.data.line_items);

  const { data: number } = await supabase.rpc("next_po_number" as never, {
    target_org: ctx.org.id,
  } as never);
  if (!number) return formError("Couldn't allocate a PO number. Try again.");

  const { data: po, error } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      insert: (v: unknown) => {
        select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> };
      };
    }
  )
    .insert({
      org_id: ctx.org.id,
      supplier_id: parsed.data.supplier_id ?? null,
      job_id: parsed.data.job_id ?? null,
      number: number as unknown as string,
      status: "draft",
      supplier_reference: parsed.data.supplier_reference ?? null,
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      notes: parsed.data.notes ?? null,
      expected_date: parsed.data.expected_date ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !po) {
    console.error("[purchase-orders] create failed", error);
    return formError("Couldn't save the purchase order. Try again.");
  }

  const { error: liErr } = await insertLines(supabase, ctx.org.id, po.id, parsed.data);
  if (liErr) {
    console.error("[purchase-orders] line items insert failed", liErr);
    return formError("Couldn't save the line items. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.created",
    targetTable: "purchase_orders",
    targetId: po.id,
    metadata: { number, total: totals.total, job_id: parsed.data.job_id ?? null },
  });

  revalidatePath("/purchase-orders");
  return formSuccess({ redirectTo: `/purchase-orders/${po.id}?saved=1` });
}

export async function updatePurchaseOrder(
  id: string,
  _prev: FormState<PurchaseOrderFormInput>,
  formData: FormData,
): Promise<FormState<PurchaseOrderFormInput>> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) return formError("Invalid purchase order id.");

  const parsed = parsePoForm(formData);
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the purchase order and try again.");
  }

  const supabase = await createClient();

  // Only draft/sent POs are editable — a received/cancelled PO is settled.
  const { data: existing } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: { status: string } | null }> };
      };
    }
  )
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return formError("Couldn't load the purchase order.");
  if (existing.status === "received" || existing.status === "cancelled") {
    return formError(`A ${existing.status} purchase order can't be edited.`);
  }

  const totals = computeTotals(parsed.data.line_items);
  const { error } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      update: (v: unknown) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
    }
  )
    .update({
      supplier_id: parsed.data.supplier_id ?? null,
      job_id: parsed.data.job_id ?? null,
      supplier_reference: parsed.data.supplier_reference ?? null,
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      notes: parsed.data.notes ?? null,
      expected_date: parsed.data.expected_date ?? null,
    })
    .eq("id", id);
  if (error) {
    console.error("[purchase-orders] update failed", error);
    return formError("Couldn't save changes. Try again.");
  }

  // Replace line items (delete + insert, as quotes do).
  await (
    supabase.from("purchase_order_line_items" as never) as unknown as {
      delete: () => { eq: (k: string, v: unknown) => Promise<{ error: unknown }> };
    }
  )
    .delete()
    .eq("purchase_order_id", id);
  const { error: liErr } = await insertLines(supabase, ctx.org.id, id, parsed.data);
  if (liErr) return formError("Couldn't save the line items. Try again.");

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.updated",
    targetTable: "purchase_orders",
    targetId: id,
    metadata: { total: totals.total },
  });

  revalidatePath(`/purchase-orders/${id}`);
  return formSuccess({ successMessage: "Saved." });
}

export async function setPurchaseOrderStatus(id: string, formData: FormData) {
  const { user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/purchase-orders");

  const to = String(formData.get("status") ?? "") as PurchaseOrderStatus;
  if (!(PO_STATUSES as readonly string[]).includes(to)) {
    redirect(`/purchase-orders/${id}?error=bad_status`);
  }

  const supabase = await createClient();
  const { data: existing } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: { status: string } | null }> };
      };
    }
  )
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) redirect("/purchase-orders?error=not_found");

  if (!canTransitionPo(existing.status as PurchaseOrderStatus, to)) {
    redirect(`/purchase-orders/${id}?error=bad_transition`);
  }

  const { error } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      update: (v: unknown) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
    }
  )
    .update({ status: to })
    .eq("id", id);
  if (error) {
    console.error("[purchase-orders] status change failed", error);
    redirect(`/purchase-orders/${id}?error=status_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `purchase_order.${to}`,
    targetTable: "purchase_orders",
    targetId: id,
    metadata: { from: existing.status, to },
  });

  revalidatePath(`/purchase-orders/${id}`);
  redirect(`/purchase-orders/${id}?saved=status`);
}

export async function deletePurchaseOrder(id: string) {
  const { user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/purchase-orders");

  const supabase = await createClient();
  const { error } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
    }
  )
    .delete()
    .eq("id", id);
  if (error) {
    // RLS filters non-admins → 0 rows, no error; treat as denied.
    console.error("[purchase-orders] delete failed", error);
    redirect(`/purchase-orders/${id}?error=delete_denied`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.deleted",
    targetTable: "purchase_orders",
    targetId: id,
    metadata: {},
  });

  revalidatePath("/purchase-orders");
  redirect("/purchase-orders?saved=deleted");
}

// ── Supplier bills (Financial Operations — closes committed → actual) ────────
// Recording a supplier's invoice against a PO posts the ACTUAL cost to
// `finances` (feeding job profitability) and closes the committed → actual loop.
// A bill IS a finances entry (no supplier_bills fork); the same-org guard trigger
// from 20261009 enforces tenancy at the database. It inherits the PO's job +
// supplier so the cost rolls up to the right job and against this PO.
const supplierBillSchema = z.object({
  amount: z.coerce.number().positive("Enter the bill amount").max(10_000_000),
  vat_rate: z.coerce
    .number()
    .refine((v) => [0, 5, 20].includes(v), "VAT must be 0, 5 or 20"),
  reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(120).optional(),
  ),
  bill_date: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  ),
  category: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(60).optional(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(2000).optional(),
  ),
});

export async function recordSupplierBill(
  purchaseOrderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(purchaseOrderId).success) {
    return formError("Invalid purchase order.");
  }

  const parsed = supplierBillSchema.safeParse({
    amount: formData.get("amount"),
    vat_rate: formData.get("vat_rate") ?? 20,
    reference: formData.get("reference") ?? "",
    bill_date: formData.get("bill_date") ?? "",
    category: formData.get("category") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the bill details.");
  }

  const supabase = await createClient();

  // Load the PO (RLS-scoped) — inherit its job + supplier.
  const { data: po } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: string) => {
          maybeSingle: () => Promise<{
            data: { id: string; job_id: string | null; supplier_id: string | null } | null;
          }>;
        };
      };
    }
  )
    .select("id, job_id, supplier_id")
    .eq("id", purchaseOrderId)
    .maybeSingle();

  if (!po) return formError("Purchase order not found.");

  const { error } = await (
    supabase.from("finances" as never) as unknown as {
      insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert({
    org_id: ctx.org.id,
    purchase_order_id: po.id,
    supplier_id: po.supplier_id,
    job_id: po.job_id,
    amount: parsed.data.amount,
    vat_rate: parsed.data.vat_rate,
    category: parsed.data.category ?? "Materials",
    reference: parsed.data.reference ?? null,
    bill_date: parsed.data.bill_date ?? null,
    notes: parsed.data.notes ?? null,
  });
  if (error) {
    console.error("[purchase-orders] record bill failed", error);
    return formError("Couldn't record the bill. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.bill_recorded",
    targetTable: "purchase_orders",
    targetId: po.id,
    metadata: {
      amount: parsed.data.amount,
      reference: parsed.data.reference ?? null,
      job_id: po.job_id,
    },
  });

  revalidatePath(`/purchase-orders/${po.id}`);
  if (po.job_id) revalidatePath(`/jobs/${po.job_id}`);
  revalidatePath("/finances");
  return formSuccess({ successMessage: "Bill recorded." });
}
